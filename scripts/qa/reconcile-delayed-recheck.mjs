#!/usr/bin/env node
// Decides whether a delayed post-deployment recheck is due right now.
//
// The delayed check must land roughly 30-90 minutes after a deployment. Parking
// a GitHub Actions runner in `sleep` for an hour to achieve that would be an
// hour of billed idle time per publication, so instead a cheap reconciler runs
// on a short schedule and answers one question.
//
// The question is deliberately narrow: *is the commit that is currently the
// head of main deployed, successfully, inside the delayed window, and not yet
// validly rechecked?* Everything about that sentence matters.
//
//   - It starts from current main, not from "the newest deployment that
//     happens to have succeeded". Scanning the deployment list for a success
//     will happily pick a commit from two publications ago while the commit
//     that is actually live-or-becoming-live is pending or failed, and then
//     run a QA pass that reports on content nobody is serving any more.
//   - It requires the deployment SHA to equal current main *exactly*. No
//     nearest match, no fallback to an older success just because that older
//     success is still inside the age window.
//   - If current main is undeployed, PENDING, FAILED or unreadable, the answer
//     is "do not run", not "run against something else". A conservative
//     no-run is always available and always correct.
//   - Dedupe is by completion marker, never by evidence artifact. See
//     verify-delayed-completion.mjs: an evidence artifact can exist because a
//     runner crashed, and treating that as "already rechecked" would cancel
//     the very recheck the crash made necessary.
//
// Read-only: it lists commits, deployments and artifacts, and prints a decision.

const API_ROOT = 'https://api.github.com';
const WINDOW_START_MS = 30 * 60 * 1000;
// The upper bound is generous on purpose: GitHub's scheduled triggers are
// best-effort and can be delayed, and a recheck that lands slightly late is far
// better than one that is silently skipped.
const WINDOW_END_MS = 180 * 60 * 1000;

/** Evidence artifact: uploaded whatever happens, never a dedupe signal. */
export const ARTIFACT_PREFIX = 'post-publication-qa-delayed-';
/** Completion marker: published only after a valid final report. */
export const COMPLETION_MARKER_PREFIX = 'post-publication-qa-complete-';

export function completionMarkerName(sha, mode = 'DELAYED_RECHECK') {
  return `${COMPLETION_MARKER_PREFIX}${mode}-${sha}`;
}

async function githubJson(pathname, token, fetchImpl) {
  const response = await fetchImpl(`${API_ROOT}${pathname}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'aprasa-post-publication-qa/1.0',
    },
  });
  if (!response.ok) {
    const error = new Error(`GitHub API ${pathname} -> ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/**
 * The authoritative head of the repository's default branch. This is the only
 * SHA a delayed recheck is ever allowed to target.
 */
async function resolveCurrentMain({ repo, token, fetchImpl }) {
  let repository;
  try {
    repository = await githubJson(`/repos/${repo}`, token, fetchImpl);
  } catch (error) {
    return { sha: null, branch: null, error: `REPOSITORY_UNREADABLE: ${error.message ?? error}` };
  }
  const branch = repository?.default_branch;
  if (!branch) return { sha: null, branch: null, error: 'DEFAULT_BRANCH_UNKNOWN' };

  let commit;
  try {
    commit = await githubJson(`/repos/${repo}/commits/${encodeURIComponent(branch)}`, token, fetchImpl);
  } catch (error) {
    return { sha: null, branch, error: `MAIN_HEAD_UNREADABLE: ${error.message ?? error}` };
  }
  const sha = commit?.sha ?? null;
  if (!sha) return { sha: null, branch, error: 'MAIN_HEAD_MISSING_SHA' };
  return { sha, branch, error: null };
}

/** Latest github-pages deployment state for one exact SHA. */
async function deploymentStateFor({ repo, token, fetchImpl, sha }) {
  let deployments;
  try {
    deployments = await githubJson(
      `/repos/${repo}/deployments?environment=github-pages&sha=${encodeURIComponent(sha)}&per_page=20`,
      token,
      fetchImpl
    );
  } catch (error) {
    return { state: 'UNREADABLE', detail: String(error.message ?? error) };
  }
  if (!Array.isArray(deployments)) return { state: 'UNREADABLE', detail: 'unexpected deployments payload shape' };

  // Belt and braces: the sha query parameter is applied server-side, but a
  // client-side equality check is what actually enforces the rule, so a change
  // in API behaviour can never widen the target.
  const mine = deployments.filter((deployment) => deployment.sha === sha);
  if (mine.length === 0) return { state: 'NOT_DEPLOYED', detail: null };

  const deployment = mine[0];
  let statuses;
  try {
    statuses = await githubJson(`/repos/${repo}/deployments/${deployment.id}/statuses?per_page=20`, token, fetchImpl);
  } catch (error) {
    return { state: 'UNREADABLE', detail: String(error.message ?? error), deployment };
  }
  const list = Array.isArray(statuses) ? statuses : [];
  const latest = list.length ? list[0].state : null;
  const success = list.find((status) => status.state === 'success');

  if (latest === 'success' && success) {
    return { state: 'SUCCESS', deployment, successAt: success.created_at ?? deployment.created_at, detail: null };
  }
  if (latest === 'failure' || latest === 'error') return { state: 'FAILED', deployment, detail: latest };
  if (latest === 'queued' || latest === 'pending' || latest === 'in_progress') {
    return { state: 'PENDING', deployment, detail: latest };
  }
  return { state: 'UNKNOWN', deployment, detail: latest };
}

/**
 * A completion marker counts only if it is present, unexpired and non-empty.
 * An expired artifact is no longer inspectable, so it cannot be evidence of
 * anything; treating it as proof would let retention silently become policy.
 */
async function hasCompletionMarker({ repo, token, fetchImpl, name }) {
  const payload = await githubJson(
    `/repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
    token,
    fetchImpl
  );
  const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
  // Strictly positive evidence only: an unexpired, non-empty artifact must
  // actually be listed. If the payload is unreadable or empty the answer is
  // "not rechecked", which errs towards running an extra recheck. That costs a
  // couple of runner minutes; the opposite error silently cancels the recheck
  // a deployment needed, which is the failure this whole mechanism exists to
  // prevent.
  return artifacts.some((artifact) => artifact.expired !== true && (artifact.size_in_bytes ?? 1) > 0);
}

export async function decideDelayedRecheck({ repo, token, now = Date.now(), fetchImpl = fetch }) {
  if (!repo || !token) return { run: false, reason: 'NO_METADATA_ACCESS' };

  const main = await resolveCurrentMain({ repo, token, fetchImpl });
  if (!main.sha) return { run: false, reason: 'CURRENT_MAIN_UNREADABLE', detail: main.error };

  const deployment = await deploymentStateFor({ repo, token, fetchImpl, sha: main.sha });
  const base = { sha: main.sha, branch: main.branch };

  if (deployment.state === 'UNREADABLE') {
    return { run: false, reason: 'CURRENT_MAIN_DEPLOYMENT_UNREADABLE', detail: deployment.detail, ...base };
  }
  if (deployment.state === 'NOT_DEPLOYED') {
    return { run: false, reason: 'CURRENT_MAIN_NOT_DEPLOYED', ...base };
  }
  if (deployment.state === 'PENDING') {
    return { run: false, reason: 'CURRENT_MAIN_DEPLOYMENT_PENDING', detail: deployment.detail, ...base };
  }
  if (deployment.state === 'FAILED') {
    return { run: false, reason: 'CURRENT_MAIN_DEPLOYMENT_FAILED', detail: deployment.detail, ...base };
  }
  if (deployment.state !== 'SUCCESS') {
    return { run: false, reason: 'CURRENT_MAIN_DEPLOYMENT_UNKNOWN', detail: deployment.detail, ...base };
  }

  const age = now - Date.parse(deployment.successAt);
  if (!Number.isFinite(age)) return { run: false, reason: 'CURRENT_MAIN_DEPLOYMENT_UNKNOWN', detail: 'unparseable success timestamp', ...base };
  if (age < WINDOW_START_MS) return { run: false, reason: 'TOO_SOON', age_ms: age, ...base };
  if (age > WINDOW_END_MS) return { run: false, reason: 'WINDOW_PASSED', age_ms: age, ...base };

  const marker = completionMarkerName(main.sha);
  let deduped;
  try {
    deduped = await hasCompletionMarker({ repo, token, fetchImpl, name: marker });
  } catch (error) {
    return { run: false, reason: 'ARTIFACTS_UNREADABLE', detail: String(error.message ?? error), marker, ...base };
  }
  if (deduped) return { run: false, reason: 'ALREADY_RECHECKED', marker, ...base };

  return {
    run: true,
    reason: 'DELAYED_RECHECK_DUE',
    age_ms: age,
    artifact: `${ARTIFACT_PREFIX}${main.sha}`,
    marker,
    ...base,
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('reconcile-delayed-recheck.mjs');
if (invokedDirectly) {
  const decision = await decideDelayedRecheck({
    repo: process.env.GITHUB_REPOSITORY ?? null,
    token: process.env.GITHUB_TOKEN ?? null,
  });
  console.log(JSON.stringify(decision, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `run=${decision.run}`,
      `sha=${decision.sha ?? ''}`,
      `artifact=${decision.artifact ?? ''}`,
      `marker=${decision.marker ?? ''}`,
      `reason=${decision.reason}`,
      '',
    ].join('\n'));
  }
}
