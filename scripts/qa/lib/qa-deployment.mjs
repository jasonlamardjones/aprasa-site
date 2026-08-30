// Deployment provenance resolution.
//
// The single rule this file exists to enforce: never claim "SHA X is live"
// unless GitHub's own deployment metadata says so. The site itself carries no
// build stamp (Phase 2A must not alter public HTML to add one), so the only
// honest source of deployed identity is the GitHub Pages deployment record.
// When that is unavailable or ambiguous we report DEPLOYMENT_UNKNOWN rather
// than inferring from a live fetch.

const API_ROOT = 'https://api.github.com';
const DEFAULT_PROPAGATION_WINDOW_MS = 15 * 60 * 1000;

async function githubJson(pathname, token, { fetchImpl = fetch } = {}) {
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

function latestStatusState(statuses) {
  // The statuses endpoint returns newest first.
  return statuses.length ? statuses[0].state : null;
}

/**
 * Resolve the deployment state of `expectedSha` in the github-pages
 * environment.
 *
 * States:
 *   DEPLOYMENT_VERIFIED - GitHub reports a successful github-pages deployment
 *                         whose SHA is exactly the expected SHA.
 *   DEPLOYMENT_PENDING  - a deployment for that SHA exists and is queued/in
 *                         progress, or no deployment exists yet but the commit
 *                         is still inside the propagation window.
 *   DEPLOYMENT_FAILED   - the deployment for that SHA reports failure or error.
 *   DEPLOYMENT_UNKNOWN  - no token, no metadata access, no expected SHA, or a
 *                         result we cannot interpret conservatively.
 *
 * Note on what VERIFIED means: it asserts that GitHub finished publishing that
 * commit, not that every CDN edge already serves it. That is the strongest
 * claim the available metadata supports, and it is recorded as such.
 */
export async function resolveDeploymentProvenance({
  repo,
  expectedSha,
  token,
  commitTimestamp = null,
  propagationWindowMs = DEFAULT_PROPAGATION_WINDOW_MS,
  now = Date.now(),
  fetchImpl = fetch,
} = {}) {
  const evidence = { environment: 'github-pages', source: 'github-deployments-api' };

  if (!expectedSha) {
    return {
      state: 'DEPLOYMENT_UNKNOWN',
      observedSha: null,
      reason: 'NO_EXPECTED_SHA',
      evidence: { ...evidence, detail: 'runner was not given an expected main SHA' },
    };
  }
  if (!token || !repo) {
    return {
      state: 'DEPLOYMENT_UNKNOWN',
      observedSha: null,
      reason: 'NO_DEPLOYMENT_METADATA_ACCESS',
      evidence: { ...evidence, detail: 'no GitHub token or repository available to read deployment metadata' },
    };
  }

  let deployments;
  try {
    deployments = await githubJson(
      `/repos/${repo}/deployments?environment=github-pages&per_page=30`,
      token,
      { fetchImpl }
    );
  } catch (error) {
    return {
      state: 'DEPLOYMENT_UNKNOWN',
      observedSha: null,
      reason: 'DEPLOYMENT_METADATA_UNREADABLE',
      evidence: { ...evidence, detail: String(error.message ?? error) },
    };
  }

  if (!Array.isArray(deployments)) {
    return {
      state: 'DEPLOYMENT_UNKNOWN',
      observedSha: null,
      reason: 'DEPLOYMENT_METADATA_UNREADABLE',
      evidence: { ...evidence, detail: 'unexpected deployments payload shape' },
    };
  }

  const mine = deployments.filter((deployment) => deployment.sha === expectedSha);
  const newest = deployments[0] ?? null;

  if (mine.length === 0) {
    const age = commitTimestamp ? now - Date.parse(commitTimestamp) : null;
    const insideWindow = age !== null && age >= 0 && age <= propagationWindowMs;
    return {
      state: insideWindow ? 'DEPLOYMENT_PENDING' : 'DEPLOYMENT_UNKNOWN',
      observedSha: newest?.sha ?? null,
      reason: insideWindow ? 'NO_DEPLOYMENT_YET_INSIDE_WINDOW' : 'NO_DEPLOYMENT_FOR_EXPECTED_SHA',
      evidence: {
        ...evidence,
        expected_sha: expectedSha,
        newest_deployment_sha: newest?.sha ?? null,
        newest_deployment_created_at: newest?.created_at ?? null,
        commit_age_ms: age,
        propagation_window_ms: propagationWindowMs,
      },
    };
  }

  // Newest matching deployment wins; a re-run supersedes an earlier attempt.
  const deployment = mine[0];
  let statuses;
  try {
    statuses = await githubJson(`/repos/${repo}/deployments/${deployment.id}/statuses?per_page=20`, token, { fetchImpl });
  } catch (error) {
    return {
      state: 'DEPLOYMENT_UNKNOWN',
      observedSha: null,
      reason: 'DEPLOYMENT_STATUS_UNREADABLE',
      evidence: { ...evidence, deployment_id: deployment.id, detail: String(error.message ?? error) },
    };
  }

  const state = latestStatusState(Array.isArray(statuses) ? statuses : []);
  const baseEvidence = {
    ...evidence,
    deployment_id: deployment.id,
    deployment_created_at: deployment.created_at,
    latest_status_state: state,
    status_count: Array.isArray(statuses) ? statuses.length : 0,
    verified_claim: 'GitHub reports this commit published to github-pages; CDN edge propagation is not separately proven',
  };

  if (state === 'success') {
    return { state: 'DEPLOYMENT_VERIFIED', observedSha: deployment.sha, reason: 'PAGES_DEPLOYMENT_SUCCESS', evidence: baseEvidence };
  }
  if (state === 'failure' || state === 'error') {
    return { state: 'DEPLOYMENT_FAILED', observedSha: deployment.sha, reason: `PAGES_DEPLOYMENT_${state.toUpperCase()}`, evidence: baseEvidence };
  }
  if (state === 'queued' || state === 'pending' || state === 'in_progress') {
    return { state: 'DEPLOYMENT_PENDING', observedSha: deployment.sha, reason: `PAGES_DEPLOYMENT_${state.toUpperCase()}`, evidence: baseEvidence };
  }
  return { state: 'DEPLOYMENT_UNKNOWN', observedSha: deployment.sha, reason: 'PAGES_DEPLOYMENT_STATE_UNRECOGNISED', evidence: baseEvidence };
}

/**
 * Independent corroboration only. If the live bytes of a route match the bytes
 * committed at the expected SHA, that is recorded as supporting evidence — it
 * never upgrades the provenance state on its own, because identical bytes do
 * not prove which commit produced them.
 */
export function corroborateByContent(liveBody, repoBody) {
  if (typeof liveBody !== 'string' || typeof repoBody !== 'string') return null;
  return liveBody.trim() === repoBody.trim();
}
