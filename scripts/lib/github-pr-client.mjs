// The two GitHub pull-request operations the guarded publication path needs.
//
// Why this module exists
// ----------------------
// The real-write path shelled out to the GitHub CLI for exactly two things:
// asking whether an open PR already exists for the candidate branch, and
// opening the draft PR after a successful guarded write. `gh` is not present in
// the ephemeral worker the automation actually runs in, so a genuinely approved
// packet would clear every governance gate, build a correct candidate, and then
// fail on a missing binary. That is an execution-environment defect, not a
// publication decision, and it must not become a founder relay.
//
// What changed and what did not
// -----------------------------
// Only the transport. The operations, their argument shapes, their return
// shapes, and — most importantly — their failure semantics are the incumbent
// ones:
//
//   * a failed open-PR query throws, so duplicate detection stays fail-closed
//     and can never be read as "no PR exists";
//   * PR creation is draft-only and is verified to be draft-only; this module
//     has no merge, auto-merge, or deploy capability of any kind;
//   * nothing here writes to the repository, the candidate branch, or main.
//
// Transport selection
// -------------------
// 1. An authenticated REST call, when a GitHub credential is present in the
//    environment under the names this repository already uses everywhere else
//    (GITHUB_TOKEN, falling back to GH_TOKEN — see .github/workflows and
//    scripts/qa). No new environment variable is introduced.
// 2. The incumbent `gh` invocation, when no credential is present but the CLI
//    is. An environment where `gh` carried its own stored credentials keeps
//    working exactly as before.
// 3. Otherwise: refuse. Missing authentication fails visibly and closed rather
//    than degrading to an unauthenticated request.
//
// Credentials are read, passed to the request worker over stdin, and never
// logged, echoed, persisted, or placed in argv.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GITHUB_API_ROOT = 'https://api.github.com';
export const TRANSPORT_API = 'github-rest-api';
export const TRANSPORT_GH = 'gh-cli';

const USER_AGENT = 'aprasa-publication-automation/1.0';
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_WORKER = fileURLToPath(new URL('./github-api-request.mjs', import.meta.url));
const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function parseRepositorySlug(repository) {
  if (typeof repository !== 'string' || !SLUG.test(repository)) {
    throw new Error(`GITHUB_REPOSITORY_INVALID: ${JSON.stringify(repository)} is not an owner/repo slug`);
  }
  const [owner, repo] = repository.split('/');
  return { owner, repo };
}

/**
 * The credential, or null. Deliberately returns the value rather than a
 * boolean because the single caller hands it straight to the request worker;
 * no other code path ever sees it.
 */
export function githubToken(env = process.env) {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '';
  return String(token).trim() ? String(token) : null;
}

/**
 * PATH lookup done by inspection rather than by shelling out, so probing for
 * one missing executable cannot itself depend on another one being installed.
 */
export function resolveExecutable(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this directory; keep looking.
    }
  }
  return null;
}

export function selectTransport({ env = process.env } = {}) {
  if (githubToken(env)) {
    return { transport: TRANSPORT_API, reason: 'GITHUB_CREDENTIAL_PRESENT', executable: null };
  }
  const executable = resolveExecutable('gh', env);
  if (executable) {
    return { transport: TRANSPORT_GH, reason: 'NO_CREDENTIAL_GH_CLI_PRESENT', executable };
  }
  throw new Error(
    'GITHUB_AUTH_UNAVAILABLE: no GITHUB_TOKEN or GH_TOKEN credential and no gh CLI on PATH; '
    + 'refusing to contact GitHub unauthenticated'
  );
}

function apiRequest({ method, pathname, body = null, env, spawnImpl = spawnSync, worker = REQUEST_WORKER }) {
  const payload = JSON.stringify({
    url: `${GITHUB_API_ROOT}${pathname}`,
    method,
    token: githubToken(env),
    userAgent: USER_AGENT,
    timeoutMs: REQUEST_TIMEOUT_MS,
    body: body === null ? null : JSON.stringify(body)
  });
  const probe = spawnImpl(process.execPath, [worker], {
    input: payload,
    encoding: 'utf8',
    // Node's built-in fetch bypasses HTTPS_PROXY unless this is set; an
    // environment that brokers outbound HTTPS must not be silently bypassed.
    env: { ...env, NODE_USE_ENV_PROXY: '1' },
    maxBuffer: 8 * 1024 * 1024
  });
  if (probe.status !== 0) {
    throw new Error(`GITHUB_API_TRANSPORT_FAILED: request worker exited ${probe.status ?? 'without status'}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(probe.stdout);
  } catch {
    throw new Error('GITHUB_API_TRANSPORT_FAILED: request worker produced an unreadable response');
  }
  if (envelope?.ok !== true) {
    throw new Error(`GITHUB_API_TRANSPORT_FAILED: ${envelope?.error ?? 'unspecified transport failure'}`);
  }
  return envelope;
}

function requireStatus(envelope, expected, context) {
  if (!expected.includes(envelope.status)) {
    const detail = String(envelope.body ?? '').trim().slice(0, 300);
    throw new Error(`${context}: GitHub API returned HTTP ${envelope.status}${detail ? ` — ${detail}` : ''}`);
  }
  try {
    return JSON.parse(envelope.body);
  } catch {
    throw new Error(`${context}: GitHub API response was not JSON`);
  }
}

/**
 * One pull request, reduced to the three fields the guarded path reasons about.
 * Both transports are normalised to this shape so callers cannot accidentally
 * depend on which one ran.
 */
function normalizeApiPull(pull) {
  return {
    url: pull?.html_url ?? null,
    isDraft: pull?.draft === true,
    headRefOid: pull?.head?.sha ?? null,
    number: Number.isInteger(pull?.number) ? pull.number : null
  };
}

function normalizeGhPull(pull) {
  return {
    url: pull?.url ?? null,
    isDraft: pull?.isDraft === true,
    headRefOid: pull?.headRefOid ?? null,
    number: Number.isInteger(pull?.number) ? pull.number : null
  };
}

function ghCommand({ executable, args, cwd, env, input = undefined, spawnImpl = spawnSync }) {
  return spawnImpl(executable ?? 'gh', args, { cwd, encoding: 'utf8', env, input });
}

/**
 * Open pull requests whose head is `branch`.
 *
 * Fail-closed: any transport failure, non-success status, or unparseable
 * payload throws. An empty array means GitHub answered and there is genuinely
 * no open PR — it is never the residue of a failed lookup.
 */
export function listOpenPullRequests({
  repository,
  branch,
  cwd = process.cwd(),
  env = process.env,
  spawnImpl = spawnSync,
  transport = null
}) {
  const { owner, repo } = parseRepositorySlug(repository);
  if (typeof branch !== 'string' || !branch.trim()) {
    throw new Error('GITHUB_PR_QUERY_INVALID: a branch name is required');
  }
  const selection = transport ?? selectTransport({ env });

  if (selection.transport === TRANSPORT_GH) {
    const probe = ghCommand({
      executable: selection.executable,
      args: ['pr', 'list', '--repo', repository, '--head', branch, '--state', 'open', '--json', 'url,isDraft,headRefOid'],
      cwd,
      env,
      spawnImpl
    });
    if (probe.status !== 0) {
      const detail = [probe.stdout, probe.stderr].filter(Boolean).join('\n').trim();
      throw new Error(`GITHUB_PR_QUERY_FAILED: gh pr list exited ${probe.status ?? 'without status'}${detail ? ` — ${detail}` : ''}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(probe.stdout);
    } catch {
      throw new Error('GITHUB_PR_QUERY_FAILED: gh pr list produced an unreadable response');
    }
    if (!Array.isArray(parsed)) throw new Error('GITHUB_PR_QUERY_FAILED: gh pr list did not return a list');
    return parsed.map(normalizeGhPull);
  }

  const head = encodeURIComponent(`${owner}:${branch}`);
  const envelope = apiRequest({
    method: 'GET',
    pathname: `/repos/${owner}/${repo}/pulls?state=open&per_page=100&head=${head}`,
    env,
    spawnImpl
  });
  const payload = requireStatus(envelope, [200], 'GITHUB_PR_QUERY_FAILED');
  if (!Array.isArray(payload)) throw new Error('GITHUB_PR_QUERY_FAILED: GitHub API did not return a list');
  return payload.map(normalizeApiPull);
}

/**
 * Open the draft pull request for an already-committed candidate.
 *
 * Draft is not a default that a caller can override: it is set here and then
 * verified in the response. A pull request that came back non-draft is a
 * violation of the publication contract and is reported as one, with its URL,
 * so the post-commit recovery record stays actionable. Nothing in this function
 * merges, enables auto-merge, or deploys.
 */
export function createDraftPullRequest({
  repository,
  base,
  head,
  title,
  body,
  cwd = process.cwd(),
  env = process.env,
  spawnImpl = spawnSync,
  transport = null
}) {
  const { owner, repo } = parseRepositorySlug(repository);
  for (const [name, value] of [['base', base], ['head', head], ['title', title]]) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`GITHUB_PR_CREATE_INVALID: ${name} is required`);
    }
  }
  const selection = transport ?? selectTransport({ env });

  if (selection.transport === TRANSPORT_GH) {
    const probe = ghCommand({
      executable: selection.executable,
      // `--body-file -` reads the body from stdin, so the incumbent report text
      // reaches gh without this module needing to know where it lives on disk.
      args: ['pr', 'create', '--repo', repository, '--draft', '--base', base, '--head', head, '--title', title, '--body-file', '-'],
      cwd,
      env,
      input: String(body ?? ''),
      spawnImpl
    });
    if (probe.status !== 0) {
      const detail = [probe.stdout, probe.stderr].filter(Boolean).join('\n').trim();
      throw new Error(`GITHUB_PR_CREATE_FAILED: gh pr create exited ${probe.status ?? 'without status'}${detail ? ` — ${detail}` : ''}`);
    }
    const url = String(probe.stdout ?? '').trim();
    if (!url) throw new Error('GITHUB_PR_CREATE_FAILED: gh pr create reported no pull request URL');
    return url;
  }

  const envelope = apiRequest({
    method: 'POST',
    pathname: `/repos/${owner}/${repo}/pulls`,
    body: { title, head, base, body: String(body ?? ''), draft: true },
    env,
    spawnImpl
  });
  const payload = requireStatus(envelope, [201], 'GITHUB_PR_CREATE_FAILED');
  const url = payload?.html_url ?? null;
  if (!url) throw new Error('GITHUB_PR_CREATE_FAILED: GitHub API reported no pull request URL');
  if (payload?.draft !== true) {
    throw new Error(`DRAFT_PR_NOT_DRAFT: GitHub created a non-draft pull request at ${url}; it must not be merged`);
  }
  return url;
}

/** The dependency bundle the guarded write path injects, so it can be faked in tests. */
export const defaultPullRequestClient = Object.freeze({
  list: listOpenPullRequests,
  createDraft: createDraftPullRequest
});
