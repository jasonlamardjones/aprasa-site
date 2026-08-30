#!/usr/bin/env node
// Decides whether a delayed post-deployment recheck is due right now.
//
// The delayed check must land roughly 30-90 minutes after a deployment. Parking
// a GitHub Actions runner in `sleep` for an hour to achieve that would be an
// hour of billed idle time per publication, so instead a cheap reconciler runs
// on a short schedule, looks at the most recent successful github-pages
// deployment, and answers one question: is that deployment inside the delayed
// window and not already rechecked?
//
// Dedupe uses the delayed run's own evidence artifact as its marker
// (post-publication-qa-delayed-<sha>). That keeps all state inside GitHub's own
// artifact store: nothing is written to the repository, and no routine QA
// result is ever committed to main.
//
// Read-only: it lists deployments and artifacts and prints a decision.

const API_ROOT = 'https://api.github.com';
const WINDOW_START_MS = 30 * 60 * 1000;
// The upper bound is generous on purpose: GitHub's scheduled triggers are
// best-effort and can be delayed, and a recheck that lands slightly late is far
// better than one that is silently skipped.
const WINDOW_END_MS = 180 * 60 * 1000;

export const ARTIFACT_PREFIX = 'post-publication-qa-delayed-';

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

export async function decideDelayedRecheck({ repo, token, now = Date.now(), fetchImpl = fetch }) {
  if (!repo || !token) return { run: false, reason: 'NO_METADATA_ACCESS' };

  let deployments;
  try {
    deployments = await githubJson(`/repos/${repo}/deployments?environment=github-pages&per_page=10`, token, fetchImpl);
  } catch (error) {
    return { run: false, reason: 'DEPLOYMENTS_UNREADABLE', detail: String(error.message ?? error) };
  }
  if (!Array.isArray(deployments) || deployments.length === 0) return { run: false, reason: 'NO_DEPLOYMENTS' };

  for (const deployment of deployments) {
    let statuses;
    try {
      statuses = await githubJson(`/repos/${repo}/deployments/${deployment.id}/statuses?per_page=10`, token, fetchImpl);
    } catch {
      continue;
    }
    const success = (Array.isArray(statuses) ? statuses : []).find((status) => status.state === 'success');
    if (!success) continue;

    const age = now - Date.parse(success.created_at ?? deployment.created_at);
    if (age < WINDOW_START_MS) return { run: false, reason: 'TOO_SOON', sha: deployment.sha, age_ms: age };
    if (age > WINDOW_END_MS) return { run: false, reason: 'WINDOW_PASSED', sha: deployment.sha, age_ms: age };

    const artifactName = `${ARTIFACT_PREFIX}${deployment.sha}`;
    let artifacts;
    try {
      artifacts = await githubJson(`/repos/${repo}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=1`, token, fetchImpl);
    } catch (error) {
      return { run: false, reason: 'ARTIFACTS_UNREADABLE', detail: String(error.message ?? error) };
    }
    if ((artifacts?.total_count ?? 0) > 0) {
      return { run: false, reason: 'ALREADY_RECHECKED', sha: deployment.sha, artifact: artifactName };
    }
    return { run: true, reason: 'DELAYED_RECHECK_DUE', sha: deployment.sha, age_ms: age, artifact: artifactName };
  }

  return { run: false, reason: 'NO_SUCCESSFUL_DEPLOYMENT' };
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
      `reason=${decision.reason}`,
      '',
    ].join('\n'));
  }
}
