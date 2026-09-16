#!/usr/bin/env node
// Focused coverage for the guarded publication path's GitHub transport.
//
// The behaviours under test are the ones the publication contract depends on,
// not the ones an HTTP client usually gets tested for:
//
//   * the absence of the GitHub CLI is no longer fatal when a credential exists;
//   * duplicate/open-PR detection is fail-closed — a lookup that could not be
//     answered throws, and is never reported as "no open PR";
//   * PR creation is draft-only, verified draft-only, and carries no merge,
//     auto-merge, or deploy capability;
//   * the absence of any authentication fails visibly rather than degrading to
//     an unauthenticated request;
//   * the credential never reaches argv.
//
// No test in this file contacts the network, and none of them uses a real
// publication packet.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TRANSPORT_API,
  TRANSPORT_GH,
  createDraftPullRequest,
  githubToken,
  listOpenPullRequests,
  parseRepositorySlug,
  resolveExecutable,
  selectTransport
} from './lib/github-pr-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'scripts', 'lib', 'github-api-request.mjs');
const REPOSITORY = 'jasonlamardjones/aprasa-site';
const BRANCH = 'feature/transport-test';
const TOKEN = 'test-only-not-a-real-credential';
const results = [];

function record(name, fn, group = 'transport') {
  try {
    fn();
    results.push({ name, group, status: 'PASS' });
  } catch (error) {
    results.push({ name, group, status: 'FAIL', reason: error.message });
  }
}

function expectThrow(fn, pattern) {
  try {
    fn();
  } catch (error) {
    if (pattern.test(error.message)) return error;
    throw new Error(`wrong failure: ${error.message}`);
  }
  throw new Error('operation unexpectedly succeeded');
}

function assertEqual(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** A spawnSync stand-in that records every call and replays a scripted answer. */
function fakeSpawn(answer) {
  const calls = [];
  const impl = (executable, args, options) => {
    calls.push({ executable, args, options });
    return typeof answer === 'function' ? answer({ executable, args, options }) : answer;
  };
  impl.calls = calls;
  return impl;
}

/** An API-transport answer: the worker envelope the client will parse. */
function apiAnswer(status, payload) {
  return { status: 0, stdout: JSON.stringify({ ok: true, status, body: JSON.stringify(payload) }), stderr: '' };
}

const apiTransport = { transport: TRANSPORT_API, reason: 'TEST', executable: null };
const ghTransport = { transport: TRANSPORT_GH, reason: 'TEST', executable: '/usr/bin/gh' };
const env = { PATH: '', GITHUB_TOKEN: TOKEN };

// --- transport selection ---------------------------------------------------

record('a credential selects the authenticated API transport', () => {
  const selection = selectTransport({ env: { PATH: '', GITHUB_TOKEN: TOKEN } });
  if (selection.transport !== TRANSPORT_API) throw new Error(`expected API transport, got ${selection.transport}`);
});

record('GH_TOKEN is accepted as the credential when GITHUB_TOKEN is absent', () => {
  if (githubToken({ GH_TOKEN: TOKEN }) !== TOKEN) throw new Error('GH_TOKEN fallback was not honoured');
  if (githubToken({ GITHUB_TOKEN: '   ' }) !== null) throw new Error('a blank credential was treated as present');
  if (githubToken({}) !== null) throw new Error('an absent credential was treated as present');
});

record('an absent gh CLI is not fatal while a credential is present', () => {
  // This is the blocker this tranche exists to remove: PATH deliberately
  // contains no gh, and selection still resolves to a usable transport.
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-no-gh-'));
  try {
    if (resolveExecutable('gh', { PATH: emptyPath }) !== null) throw new Error('probe found a gh that does not exist');
    const selection = selectTransport({ env: { PATH: emptyPath, GITHUB_TOKEN: TOKEN } });
    if (selection.transport !== TRANSPORT_API) throw new Error('a missing gh still blocked transport selection');
  } finally {
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
});

record('a present gh CLI is still used when no credential exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-fake-gh-'));
  try {
    const fake = path.join(dir, 'gh');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fake, 0o755);
    const selection = selectTransport({ env: { PATH: dir } });
    if (selection.transport !== TRANSPORT_GH) throw new Error(`expected gh transport, got ${selection.transport}`);
    if (selection.executable !== fake) throw new Error('gh transport did not resolve the executable it found');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

record('no credential and no gh CLI fails visibly and closed', () => {
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-no-auth-'));
  try {
    expectThrow(() => selectTransport({ env: { PATH: emptyPath } }), /GITHUB_AUTH_UNAVAILABLE/);
    // The same refusal reaches the callers, so neither operation can proceed
    // unauthenticated.
    expectThrow(
      () => listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env: { PATH: emptyPath } }),
      /GITHUB_AUTH_UNAVAILABLE/
    );
    expectThrow(
      () => createDraftPullRequest({ repository: REPOSITORY, base: 'main', head: BRANCH, title: 't', body: 'b', env: { PATH: emptyPath } }),
      /GITHUB_AUTH_UNAVAILABLE/
    );
  } finally {
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
});

record('a malformed repository slug is rejected before any request', () => {
  for (const bad of ['', 'no-slash', 'a/b/c', null, 42]) {
    expectThrow(() => parseRepositorySlug(bad), /GITHUB_REPOSITORY_INVALID/);
  }
  assertEqual(parseRepositorySlug(REPOSITORY), { owner: 'jasonlamardjones', repo: 'aprasa-site' }, 'slug parse');
});

// --- open-PR detection stays fail-closed -----------------------------------

record('an empty open-PR result is reported as genuinely empty', () => {
  const spawnImpl = fakeSpawn(apiAnswer(200, []));
  assertEqual(
    listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env, spawnImpl, transport: apiTransport }),
    [],
    'empty open-PR list'
  );
});

record('an open PR is normalised to the incumbent shape', () => {
  const spawnImpl = fakeSpawn(apiAnswer(200, [{
    html_url: 'https://github.com/jasonlamardjones/aprasa-site/pull/7',
    draft: true,
    number: 7,
    head: { sha: 'a'.repeat(40) }
  }]));
  const found = listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env, spawnImpl, transport: apiTransport });
  assertEqual(found, [{
    url: 'https://github.com/jasonlamardjones/aprasa-site/pull/7',
    isDraft: true,
    headRefOid: 'a'.repeat(40),
    number: 7
  }], 'normalised pull request');
});

record('the open-PR query is scoped to this branch and to open state', () => {
  const spawnImpl = fakeSpawn(apiAnswer(200, []));
  listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env, spawnImpl, transport: apiTransport });
  const sent = JSON.parse(spawnImpl.calls[0].options.input);
  if (!sent.url.includes('state=open')) throw new Error(`query was not restricted to open PRs: ${sent.url}`);
  if (!sent.url.includes(encodeURIComponent(`jasonlamardjones:${BRANCH}`))) {
    throw new Error(`query was not restricted to this branch head: ${sent.url}`);
  }
  if (sent.method !== 'GET') throw new Error(`open-PR detection used ${sent.method}`);
});

record('an unanswerable open-PR lookup throws instead of reporting no PR', () => {
  // Every one of these once degraded to `null`/`[]` somewhere in the incumbent
  // recovery code. On the gate that guards the write they must all throw.
  const httpError = fakeSpawn({ status: 0, stdout: JSON.stringify({ ok: true, status: 403, body: '{"message":"Forbidden"}' }), stderr: '' });
  expectThrow(() => listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env, spawnImpl: httpError, transport: apiTransport }), /GITHUB_PR_QUERY_FAILED.*403/);

  const transportError = fakeSpawn({ status: 0, stdout: JSON.stringify({ ok: false, error: 'timeout after 20000ms' }), stderr: '' });
  expectThrow(() => listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env, spawnImpl: transportError, transport: apiTransport }), /GITHUB_API_TRANSPORT_FAILED/);

  const crashed = fakeSpawn({ status: 1, stdout: '', stderr: 'boom' });
  expectThrow(() => listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env, spawnImpl: crashed, transport: apiTransport }), /GITHUB_API_TRANSPORT_FAILED/);

  const garbage = fakeSpawn({ status: 0, stdout: 'not json', stderr: '' });
  expectThrow(() => listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env, spawnImpl: garbage, transport: apiTransport }), /GITHUB_API_TRANSPORT_FAILED/);

  const notAList = fakeSpawn(apiAnswer(200, { message: 'unexpected' }));
  expectThrow(() => listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env, spawnImpl: notAList, transport: apiTransport }), /GITHUB_PR_QUERY_FAILED/);
});

record('an open-PR lookup without a branch is refused', () => {
  const spawnImpl = fakeSpawn(apiAnswer(200, []));
  expectThrow(() => listOpenPullRequests({ repository: REPOSITORY, branch: '', env, spawnImpl, transport: apiTransport }), /GITHUB_PR_QUERY_INVALID/);
  if (spawnImpl.calls.length) throw new Error('an invalid query still reached the transport');
});

record('the incumbent gh open-PR query is preserved and still fail-closed', () => {
  const ok = fakeSpawn({ status: 0, stdout: JSON.stringify([{ url: 'https://example.invalid/pull/3', isDraft: true, headRefOid: 'b'.repeat(40) }]), stderr: '' });
  const found = listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env: {}, spawnImpl: ok, transport: ghTransport });
  assertEqual(found.map((pull) => pull.isDraft), [true], 'gh draft flag');
  assertEqual(ok.calls[0].args, ['pr', 'list', '--repo', REPOSITORY, '--head', BRANCH, '--state', 'open', '--json', 'url,isDraft,headRefOid'], 'gh argv');

  const failed = fakeSpawn({ status: 1, stdout: '', stderr: 'gh: not authenticated' });
  expectThrow(() => listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env: {}, spawnImpl: failed, transport: ghTransport }), /GITHUB_PR_QUERY_FAILED/);
});

// --- draft PR creation stays bounded ---------------------------------------

const DRAFT_RESPONSE = {
  html_url: 'https://github.com/jasonlamardjones/aprasa-site/pull/9',
  draft: true,
  number: 9
};

record('PR creation requests a draft and nothing else', () => {
  const spawnImpl = fakeSpawn(apiAnswer(201, DRAFT_RESPONSE));
  const url = createDraftPullRequest({
    repository: REPOSITORY, base: 'main', head: BRANCH, title: 'Publish approved event: T', body: 'report body', env, spawnImpl, transport: apiTransport
  });
  if (url !== DRAFT_RESPONSE.html_url) throw new Error(`unexpected PR url: ${url}`);
  const sent = JSON.parse(spawnImpl.calls[0].options.input);
  const body = JSON.parse(sent.body);
  if (body.draft !== true) throw new Error('PR creation did not request a draft');
  assertEqual(Object.keys(body).sort(), ['base', 'body', 'draft', 'head', 'title'], 'PR creation payload keys');
  if (sent.method !== 'POST') throw new Error(`PR creation used ${sent.method}`);
  // No merge, auto-merge, or deploy capability is reachable from here.
  const wire = JSON.stringify(sent).toLowerCase();
  for (const forbidden of ['merge', 'auto_merge', 'deploy', 'workflow']) {
    if (wire.includes(forbidden)) throw new Error(`PR creation payload referenced ${forbidden}`);
  }
});

record('a pull request that comes back non-draft is reported as a violation', () => {
  const spawnImpl = fakeSpawn(apiAnswer(201, { ...DRAFT_RESPONSE, draft: false }));
  expectThrow(() => createDraftPullRequest({
    repository: REPOSITORY, base: 'main', head: BRANCH, title: 't', body: 'b', env, spawnImpl, transport: apiTransport
  }), /DRAFT_PR_NOT_DRAFT.*pull\/9/);
});

record('a refused PR creation throws rather than reporting success', () => {
  const rejected = fakeSpawn(apiAnswer(422, { message: 'Validation Failed' }));
  expectThrow(() => createDraftPullRequest({
    repository: REPOSITORY, base: 'main', head: BRANCH, title: 't', body: 'b', env, spawnImpl: rejected, transport: apiTransport
  }), /GITHUB_PR_CREATE_FAILED.*422/);

  const noUrl = fakeSpawn(apiAnswer(201, { draft: true }));
  expectThrow(() => createDraftPullRequest({
    repository: REPOSITORY, base: 'main', head: BRANCH, title: 't', body: 'b', env, spawnImpl: noUrl, transport: apiTransport
  }), /GITHUB_PR_CREATE_FAILED/);
});

record('PR creation refuses incomplete arguments before any request', () => {
  const spawnImpl = fakeSpawn(apiAnswer(201, DRAFT_RESPONSE));
  for (const missing of [{ base: '' }, { head: '' }, { title: '' }]) {
    expectThrow(() => createDraftPullRequest({
      repository: REPOSITORY, base: 'main', head: BRANCH, title: 't', body: 'b', env, spawnImpl, transport: apiTransport, ...missing
    }), /GITHUB_PR_CREATE_INVALID/);
  }
  if (spawnImpl.calls.length) throw new Error('an invalid creation still reached the transport');
});

record('the incumbent gh PR creation stays draft-only', () => {
  const ok = fakeSpawn({ status: 0, stdout: 'https://example.invalid/pull/4\n', stderr: '' });
  const url = createDraftPullRequest({
    repository: REPOSITORY, base: 'main', head: BRANCH, title: 'Publish approved event: T', body: 'report body', env: {}, spawnImpl: ok, transport: ghTransport
  });
  if (url !== 'https://example.invalid/pull/4') throw new Error(`unexpected gh PR url: ${url}`);
  const args = ok.calls[0].args;
  if (!args.includes('--draft')) throw new Error('gh PR creation did not request a draft');
  for (const forbidden of ['--merge', '--auto', '--squash', '--rebase']) {
    if (args.includes(forbidden)) throw new Error(`gh PR creation passed ${forbidden}`);
  }
  if (ok.calls[0].options.input !== 'report body') throw new Error('the report body did not reach gh');
});

// --- credential handling ---------------------------------------------------

record('the credential never reaches argv', () => {
  const spawnImpl = fakeSpawn(apiAnswer(200, []));
  listOpenPullRequests({ repository: REPOSITORY, branch: BRANCH, env, spawnImpl, transport: apiTransport });
  const call = spawnImpl.calls[0];
  if (JSON.stringify(call.args).includes(TOKEN)) throw new Error('the credential was placed in argv');
  if (call.executable !== process.execPath) throw new Error('the request worker was not invoked with this Node runtime');
  // It travels on stdin, where a process listing cannot observe it.
  if (!String(call.options.input).includes(TOKEN)) throw new Error('the credential did not reach the request worker');
  if (call.options.env.NODE_USE_ENV_PROXY !== '1') throw new Error('the worker was not told to honour the environment proxy');
});

// --- the request worker itself ---------------------------------------------

function runWorker(request) {
  const probe = spawnSync(process.execPath, [WORKER], { input: JSON.stringify(request), encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`worker exited ${probe.status}: ${probe.stderr}`);
  return JSON.parse(probe.stdout);
}

record('the request worker refuses any origin other than the GitHub API', () => {
  for (const url of ['https://example.invalid/repos/x/y/pulls', 'http://api.github.com/x', 'not-a-url']) {
    const answer = runWorker({ url, method: 'GET' });
    if (answer.ok !== false || !/refusing/.test(answer.error)) {
      throw new Error(`worker did not refuse ${url}: ${JSON.stringify(answer)}`);
    }
  }
}, 'request-worker');

record('the request worker refuses methods outside GET and POST', () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const answer = runWorker({ url: 'https://api.github.com/repos/x/y/pulls', method });
    if (answer.ok !== false || !/refusing method/.test(answer.error)) {
      throw new Error(`worker did not refuse ${method}: ${JSON.stringify(answer)}`);
    }
  }
}, 'request-worker');

record('the request worker reports an unreadable request instead of crashing', () => {
  const probe = spawnSync(process.execPath, [WORKER], { input: 'not json', encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`worker exited ${probe.status}`);
  const answer = JSON.parse(probe.stdout);
  if (answer.ok !== false || !/unreadable request envelope/.test(answer.error)) {
    throw new Error(`unexpected worker answer: ${probe.stdout}`);
  }
}, 'request-worker');

for (const result of results) {
  console.log(`${result.status} — ${result.name}${result.reason ? `: ${result.reason}` : ''}`);
}
const failures = results.filter((result) => result.status === 'FAIL');
console.log(`\nGitHub publication transport tests: ${results.length - failures.length}/${results.length} passed.`);
if (failures.length) process.exit(1);
console.log('GITHUB_PR_CLIENT_OK');
