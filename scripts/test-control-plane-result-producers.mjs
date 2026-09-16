#!/usr/bin/env node
// Regression suite for the task-result PRODUCER wiring.
//
// scripts/test-control-plane-result.mjs already proves the merged result layer
// itself (schema, semantic invariants, content addressing, the dedicated ref,
// remote reconciliation). This suite proves the layer above it: that real
// workflow outcomes reach that contract, that they reach it only when Project
// 04 actually owns the outcome, that replaying one does not duplicate it, and
// that persisting one never moves the work it reports on.
//
// Two sandboxes are used, deliberately:
//
//   * a LIGHT sandbox (a throwaway git repo carrying only the result schema,
//     plus a bare "GitHub" remote and a second clone) for the review adapter,
//     the isolation and authority guards, later-worker read-back, and the
//     fail-closed persistence path;
//
//   * one FULL sandbox (a real copy of this repository with a bare remote) in
//     which the real guarded publication entrypoint is executed end to end and
//     fails for real, so the TECHNICAL_VALIDATION_FAILED assertions are made
//     against a genuine production failure rather than a hand-written one.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarness } from './lib/ttd-test-harness.mjs';
import {
  DEFAULT_RESULTS_REF,
  fetchResultsRef,
  listPersistedResults,
  readPersistedResult,
  validateResult
} from './lib/control-plane-result.mjs';
import {
  MAX_DETAIL_CHARS,
  PRODUCERS,
  PRODUCER_REF_PREFIX,
  assertResolvableCommit,
  assertResultsRefIsolated,
  assertTechnicallyOwned,
  buildReviewResultInputs,
  buildTechnicalValidationFailedInputs,
  emitResult,
  normalizeFailureDetail,
  technicalFailureReasonCode
} from './lib/control-plane-result-producers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harness = createHarness('CONTROL_PLANE_RESULT_PRODUCERS');
const cleanups = [];

function cleanup() {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort; the OS temp dir is reclaimed anyway
    }
  }
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function node(cwd, args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Light sandbox: schema-only repo + bare remote + a second "later worker" clone
// ---------------------------------------------------------------------------

function initLightSandbox() {
  const bareDir = tempDir('cp-producer-bare-');
  fs.rmSync(bareDir, { recursive: true, force: true });
  git(path.dirname(bareDir), ['init', '--bare', '-q', '-b', 'main', bareDir]);

  const workerParent = tempDir('cp-producer-worker-');
  const worker = path.join(workerParent, 'repo');
  fs.mkdirSync(worker, { recursive: true });
  git(worker, ['init', '-q', '-b', 'main']);
  git(worker, ['config', 'user.name', 'Producer Test']);
  git(worker, ['config', 'user.email', 'producer-test@example.invalid']);
  fs.mkdirSync(path.join(worker, 'automation', 'control-plane'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'automation', 'control-plane', 'task-result.schema.json'),
    path.join(worker, 'automation', 'control-plane', 'task-result.schema.json')
  );
  git(worker, ['add', '-A']);
  git(worker, ['commit', '-q', '-m', 'candidate baseline']);
  git(worker, ['remote', 'add', 'origin', bareDir]);
  git(worker, ['push', '-q', '-u', 'origin', 'main']);
  const candidateBranch = 'feature/reviewed-candidate';
  git(worker, ['switch', '-q', '-c', candidateBranch]);
  git(worker, ['push', '-q', '-u', 'origin', candidateBranch]);
  const candidateSha = git(worker, ['rev-parse', 'HEAD']);
  return { bareDir, worker, candidateBranch, candidateSha };
}

function laterWorkerClone(bareDir) {
  const parent = tempDir('cp-producer-later-');
  const dir = path.join(parent, 'repo');
  const clone = spawnSync('git', ['clone', '-q', bareDir, dir], { encoding: 'utf8' });
  if (clone.status !== 0) throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
  git(dir, ['config', 'user.name', 'Later Worker']);
  git(dir, ['config', 'user.email', 'later-worker@example.invalid']);
  return dir;
}

// ---------------------------------------------------------------------------
// A. Deterministic failure-detail normalization (what makes replay idempotent)
// ---------------------------------------------------------------------------

{
  const tmp = os.tmpdir();
  const detailA = `NON_IDEMPOTENT_GENERATION: ${tmp}/aprasa-real-write-Ab3XyZ/data/x.json\r\n${process.execPath} scripts/build.mjs failed   `;
  const detailB = `NON_IDEMPOTENT_GENERATION: ${tmp}/aprasa-real-write-QQ99zz/data/x.json\n${process.execPath} scripts/build.mjs failed`;
  harness.equal(
    'two runs whose only difference is the mkdtemp suffix normalize identically',
    normalizeFailureDetail(detailA, { root: ROOT }),
    normalizeFailureDetail(detailB, { root: ROOT })
  );
  harness.ok(
    'the normalized detail carries no run-scoped temp path',
    !normalizeFailureDetail(detailA, { root: ROOT }).includes('Ab3XyZ')
  );
  harness.ok(
    'the normalized detail carries no absolute node executable path',
    !normalizeFailureDetail(detailA, { root: ROOT }).includes(process.execPath)
  );
  harness.equal(
    'the repository root is rewritten to a stable placeholder',
    normalizeFailureDetail(`failed at ${ROOT}/scripts/x.mjs`, { root: ROOT }),
    'failed at <ROOT>/scripts/x.mjs'
  );
  harness.ok(
    'a genuinely different failure still normalizes differently',
    normalizeFailureDetail('UNEXPECTED_CHANGED_FILE_SCOPE: a', { root: ROOT })
      !== normalizeFailureDetail('UNEXPECTED_CHANGED_FILE_SCOPE: b', { root: ROOT })
  );
  const long = normalizeFailureDetail(`X: ${'y'.repeat(MAX_DETAIL_CHARS * 2)}`, { root: ROOT });
  harness.ok('an unbounded validator dump is truncated deterministically', long.length < MAX_DETAIL_CHARS + 64);
  harness.equal(
    'truncation is stable across repeats',
    normalizeFailureDetail(`X: ${'y'.repeat(MAX_DETAIL_CHARS * 2)}`, { root: ROOT }),
    long
  );

  harness.equal('the failure\'s own leading code is read, not invented',
    technicalFailureReasonCode('STALE_BRANCH_REFUSED: feature branch is not at expected main'),
    'STALE_BRANCH_REFUSED');
  harness.equal('a failure with no leading code yields null rather than a fabricated one',
    technicalFailureReasonCode('git push failed (128)'), null);
  harness.equal('a lowercase prefix is not treated as a reason code',
    technicalFailureReasonCode('stale_branch: nope'), null);
}

// ---------------------------------------------------------------------------
// B. Authority boundary: a pre-governance failure is never relabelled technical
// ---------------------------------------------------------------------------

harness.throws('assertTechnicallyOwned refuses a failure that has not cleared the governance gate',
  () => assertTechnicallyOwned({ governancePassed: false }));
harness.throws('assertTechnicallyOwned refuses a missing governance verdict',
  () => assertTechnicallyOwned({}));
harness.throws('buildTechnicalValidationFailedInputs refuses to build for a non-technical failure',
  () => buildTechnicalValidationFailedInputs({
    root: ROOT,
    governancePassed: false,
    candidateId: 'example-event',
    repositorySha: 'a'.repeat(40),
    detail: 'BLOCKED_OWNER_APPROVAL: Publication/factual approval is not complete'
  }));

// ---------------------------------------------------------------------------
// C. Results-ref isolation: persisting evidence must not move the work
// ---------------------------------------------------------------------------

{
  const { worker, candidateBranch } = initLightSandbox();
  harness.throws('a results ref equal to the candidate branch is refused',
    () => assertResultsRefIsolated(worker, candidateBranch, { candidateRef: candidateBranch }));
  harness.throws('a results ref equal to the checked-out branch is refused',
    () => assertResultsRefIsolated(worker, candidateBranch));
  harness.throws('a results ref of main is refused', () => assertResultsRefIsolated(worker, 'main'));
  harness.throws('a results ref of refs/heads/main is refused', () => assertResultsRefIsolated(worker, 'refs/heads/main'));
  harness.equal('the dedicated results ref is accepted',
    assertResultsRefIsolated(worker, DEFAULT_RESULTS_REF), DEFAULT_RESULTS_REF);
}

// ---------------------------------------------------------------------------
// D. REVIEW_PASSED / REVIEW_FAILED: exact SHA and reviewer identity are required
// ---------------------------------------------------------------------------

const reviewSandbox = initLightSandbox();

{
  const { worker, candidateSha, candidateBranch } = reviewSandbox;
  const base = {
    root: worker,
    candidateSha,
    candidateRef: candidateBranch,
    candidateId: candidateBranch,
    reviewerIdentity: 'Independent reviewer (named human)',
    reason: 'Independent exact-head review found no correctness, scope, or authority defect.',
    requiredInput: 'None; the candidate is ready for the founder merge decision.',
    evidenceDigest: 'c'.repeat(64)
  };

  harness.throws('REVIEW_PASSED requires a candidate sha',
    () => buildReviewResultInputs({ ...base, outcome: 'PASSED', candidateSha: null }));
  harness.throws('REVIEW_PASSED refuses an abbreviated sha',
    () => buildReviewResultInputs({ ...base, outcome: 'PASSED', candidateSha: candidateSha.slice(0, 7) }));
  harness.throws('REVIEW_PASSED refuses a well-formed sha this repository cannot resolve',
    () => buildReviewResultInputs({ ...base, outcome: 'PASSED', candidateSha: 'a'.repeat(40) }));
  harness.throws('REVIEW_PASSED requires a reviewer identity',
    () => buildReviewResultInputs({ ...base, outcome: 'PASSED', reviewerIdentity: undefined }));
  harness.throws('REVIEW_PASSED refuses a blank reviewer identity',
    () => buildReviewResultInputs({ ...base, outcome: 'PASSED', reviewerIdentity: '   ' }));
  harness.throws('REVIEW_PASSED refuses the control-plane automation as its own reviewer',
    () => buildReviewResultInputs({ ...base, outcome: 'PASSED', reviewerIdentity: 'A PRASA Control Plane' }));
  harness.throws('REVIEW_PASSED refuses a self-referential reviewer identity',
    () => buildReviewResultInputs({ ...base, outcome: 'PASSED', reviewerIdentity: 'self' }));
  harness.throws('REVIEW_PASSED refuses an unknown reviewer role',
    () => buildReviewResultInputs({ ...base, outcome: 'PASSED', reviewerRole: 'PUBLICATION_WRITER' }));

  harness.throws('REVIEW_FAILED requires a candidate sha',
    () => buildReviewResultInputs({ ...base, outcome: 'FAILED', candidateSha: null }));
  harness.throws('REVIEW_FAILED refuses an unresolvable sha',
    () => buildReviewResultInputs({ ...base, outcome: 'FAILED', candidateSha: 'b'.repeat(40) }));
  harness.throws('REVIEW_FAILED requires a reviewer identity',
    () => buildReviewResultInputs({ ...base, outcome: 'FAILED', reviewerIdentity: null }));
  harness.throws('REVIEW_FAILED refuses the writing process as its own reviewer',
    () => buildReviewResultInputs({ ...base, outcome: 'FAILED', reviewerIdentity: 'implementation worker' }));
  harness.throws('an unknown review outcome is refused',
    () => buildReviewResultInputs({ ...base, outcome: 'APPROVED' }));

  const passedInputs = buildReviewResultInputs({ ...base, outcome: 'PASSED' });
  harness.equal('a valid REVIEW_PASSED binds to the exact reviewed sha', passedInputs.repositorySha, candidateSha);
  harness.equal('a valid REVIEW_PASSED carries the supplied reviewer',
    passedInputs.reviewer, { role: 'INDEPENDENT_REVIEWER', identity: 'Independent reviewer (named human)' });
  harness.ok('the review record traces back to its producer',
    passedInputs.upstreamRefs.some((item) => item.ref === `${PRODUCER_REF_PREFIX}${PRODUCERS.INDEPENDENT_REVIEW_ADAPTER}`));

  harness.equal('assertResolvableCommit accepts the real candidate commit',
    assertResolvableCommit(worker, candidateSha), candidateSha);
}

// ---------------------------------------------------------------------------
// E. The review adapter CLI never derives reviewer identity from the process
// ---------------------------------------------------------------------------

{
  const { worker, candidateSha, candidateBranch } = reviewSandbox;
  const cli = path.join(ROOT, 'scripts', 'record-independent-review.mjs');
  const common = [
    cli,
    `--root=${worker}`,
    `--candidate-sha=${candidateSha}`,
    `--candidate-id=${candidateBranch}`,
    `--candidate-ref=${candidateBranch}`,
    '--reason=Independent exact-head review of the candidate.',
    '--required-input=None; founder merge decision only.',
    `--evidence-digest=${'d'.repeat(64)}`
  ];
  const impersonationEnv = {
    GIT_AUTHOR_NAME: 'Implementation Worker',
    GIT_COMMITTER_NAME: 'Implementation Worker',
    GITHUB_ACTOR: 'implementation-worker',
    USER: 'implementation-worker',
    REVIEWER_IDENTITY: 'Implementation Worker'
  };

  const withoutReviewer = node(worker, [...common, '--outcome=PASSED'], impersonationEnv);
  harness.equal('the review CLI refuses to run without an explicit reviewer identity', withoutReviewer.status, 2);
  harness.ok('the refusal names the missing reviewer identity rather than deriving one from the environment',
    withoutReviewer.stderr.includes('--reviewer-identity'));

  const withoutSha = node(worker, [
    cli, `--root=${worker}`, '--outcome=PASSED', `--candidate-id=${candidateBranch}`,
    '--reviewer-identity=Named Independent Reviewer',
    '--reason=x', '--required-input=y', `--evidence-digest=${'d'.repeat(64)}`
  ]);
  harness.equal('the review CLI refuses to run without an explicit candidate sha', withoutSha.status, 2);
  harness.ok('the refusal names the missing candidate sha', withoutSha.stderr.includes('--candidate-sha'));

  const selfCertified = node(worker, [...common, '--outcome=PASSED', '--reviewer-identity=A PRASA Control Plane'], impersonationEnv);
  harness.equal('the review CLI refuses a self-certified review', selfCertified.status, 1);
  harness.ok('the self-certification refusal is explicit',
    (parseJson(selfCertified.stderr)?.reason ?? '').includes('REVIEWER_IDENTITY_NOT_INDEPENDENT'));

  const wrongSha = node(worker, [
    ...common.filter((arg) => !arg.startsWith('--candidate-sha=')),
    `--candidate-sha=${'e'.repeat(40)}`,
    '--outcome=FAILED',
    '--reviewer-identity=Named Independent Reviewer'
  ]);
  harness.equal('the review CLI refuses a candidate sha it cannot resolve', wrongSha.status, 1);
  harness.ok('the unresolvable-sha refusal is explicit',
    (parseJson(wrongSha.stderr)?.reason ?? '').includes('CANDIDATE_SHA_UNRESOLVABLE'));

  const shaBefore = git(worker, ['rev-parse', candidateBranch]);
  const mainBefore = git(worker, ['rev-parse', 'main']);
  const passed = node(worker, [...common, '--outcome=PASSED', '--reviewer-identity=Named Independent Reviewer', '--publish'], impersonationEnv);
  const passedReport = parseJson(passed.stdout);
  harness.equal('the review CLI publishes a REVIEW_PASSED result', passed.status, 0);
  harness.equal('the published record is a REVIEW_PASSED', passedReport?.result_type, 'REVIEW_PASSED');
  harness.equal('the published review names the explicitly supplied reviewer, not the process identity',
    passedReport?.reviewer, { role: 'INDEPENDENT_REVIEWER', identity: 'Named Independent Reviewer' });
  harness.equal('the published review binds to the exact candidate sha', passedReport?.repository_sha, candidateSha);
  harness.equal('a published review grants no publication authority', passedReport?.grants_publication_authority, false);
  harness.equal('a published review grants no merge authority', passedReport?.merge_allowed, false);
  harness.equal('a published review grants no deploy authority', passedReport?.deploy_allowed, false);
  harness.equal('publishing a review does not move the candidate branch', git(worker, ['rev-parse', candidateBranch]), shaBefore);
  harness.equal('publishing a review does not move main', git(worker, ['rev-parse', 'main']), mainBefore);

  const replay = node(worker, [...common, '--outcome=PASSED', '--reviewer-identity=Named Independent Reviewer', '--publish'], impersonationEnv);
  const replayReport = parseJson(replay.stdout);
  harness.equal('replaying the identical review is a no-op', replayReport?.status, 'REMOTE_ALREADY_PRESENT');
  harness.equal('the replayed review keeps the same logical identity', replayReport?.result_id, passedReport?.result_id);

  const failed = node(worker, [
    ...common.filter((arg) => !arg.startsWith('--reason=') && !arg.startsWith('--required-input=')),
    '--outcome=FAILED',
    '--reviewer-identity=Named Independent Reviewer',
    '--reason=Independent review found a scope defect that must be repaired.',
    '--required-input=Repair the reported scope defect and obtain a fresh independent review.',
    '--publish'
  ], impersonationEnv);
  const failedReport = parseJson(failed.stdout);
  harness.equal('the review CLI publishes a REVIEW_FAILED result', failed.status, 0);
  harness.equal('the published record is a REVIEW_FAILED', failedReport?.result_type, 'REVIEW_FAILED');
  harness.equal('a published REVIEW_FAILED grants no publication authority', failedReport?.grants_publication_authority, false);
  harness.ok('REVIEW_FAILED is a genuinely distinct record from REVIEW_PASSED',
    failedReport?.result_id !== passedReport?.result_id);
  harness.equal('publishing a failed review still does not move the candidate branch',
    git(worker, ['rev-parse', candidateBranch]), shaBefore);

  // Later worker: a fresh checkout that has never seen the results ref.
  const later = laterWorkerClone(reviewSandbox.bareDir);
  const fetchedTip = fetchResultsRef(later);
  harness.ok('a later worker can fetch the results ref it never had', /^[a-f0-9]{40}$/.test(fetchedTip ?? ''));
  const readBack = readPersistedResult(later, passedReport.result_id);
  harness.equal('a later worker reads back the exact published review', readBack?.result_id, passedReport.result_id);
  harness.equal('a later worker independently validates the fetched review',
    validateResult(readBack, { root: later }), []);
  harness.equal('both published reviews are present for the later worker',
    listPersistedResults(later).length, 2);
  harness.equal('the later worker\'s candidate branch is still exactly the reviewed sha',
    git(later, ['rev-parse', `origin/${candidateBranch}`]), candidateSha);

  // Fail-closed persistence: an unreachable remote must not degrade to success.
  harness.throws('emitResult fails closed when the results remote is unreachable', () => {
    const inputs = buildReviewResultInputs({
      root: worker,
      outcome: 'FAILED',
      candidateSha,
      candidateRef: candidateBranch,
      candidateId: candidateBranch,
      reviewerIdentity: 'Named Independent Reviewer',
      reason: 'A review whose result cannot be persisted must not report success.',
      requiredInput: 'Restore access to the results remote and re-record the review.',
      evidenceDigest: 'f'.repeat(64)
    });
    emitResult(worker, inputs, { publish: true, remote: 'no-such-remote' });
  });
  const unreachable = node(worker, [
    ...common.filter((arg) => !arg.startsWith('--reason=') && !arg.startsWith('--required-input=')),
    '--outcome=FAILED',
    '--reviewer-identity=Named Independent Reviewer',
    '--reason=A review whose result cannot be persisted must not report success.',
    '--required-input=Restore access to the results remote and re-record the review.',
    '--publish', '--remote=no-such-remote'
  ], impersonationEnv);
  harness.equal('the review CLI exits non-zero when the result cannot be persisted', unreachable.status, 1);
  harness.ok('the persistence failure is reported explicitly, never silently skipped',
    (parseJson(unreachable.stderr)?.reason ?? '').includes('TASK_RESULT_PERSISTENCE_FAILED'));

  harness.throws('emitResult refuses to persist onto the candidate branch', () => {
    const inputs = buildReviewResultInputs({
      root: worker,
      outcome: 'PASSED',
      candidateSha,
      candidateRef: candidateBranch,
      candidateId: candidateBranch,
      reviewerIdentity: 'Named Independent Reviewer',
      reason: 'x',
      requiredInput: 'y',
      evidenceDigest: '1'.repeat(64)
    });
    emitResult(worker, inputs, { ref: candidateBranch, candidateRef: candidateBranch });
  });
}

// ---------------------------------------------------------------------------
// F. A real guarded publication failure produces a durable, idempotent record
// ---------------------------------------------------------------------------

const FIXTURE = 'automation/things-to-do/fixtures/ready-write.json';

function initFullSandbox() {
  const parent = tempDir('cp-producer-full-');
  const root = path.join(parent, 'repo');
  fs.cpSync(ROOT, root, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
  const remote = path.join(parent, 'remote.git');

  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Producer Test']);
  git(root, ['config', 'user.email', 'producer-test@example.invalid']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'test baseline']);
  git(parent, ['init', '--bare', '-q', '-b', 'main', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  const baseline = git(root, ['rev-parse', 'HEAD']);

  const packet = JSON.parse(fs.readFileSync(path.join(root, FIXTURE), 'utf8'));
  packet.control.expected_main_sha = baseline;
  packet.control.as_of = JSON.parse(fs.readFileSync(path.join(root, 'data', 'things-to-do-currentness.json'), 'utf8')).as_of;
  const packetPath = path.join(root, '.git', 'producer-packet.json');
  fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);

  const branch = 'feature/producer-guarded-write';
  git(root, ['switch', '-q', '-c', branch]);

  // A `gh` that answers "no open PR for this branch" without touching the
  // network, so the guarded entrypoint reaches its real repository checks.
  const binDir = path.join(parent, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const ghShim = path.join(binDir, 'gh');
  fs.writeFileSync(ghShim, '#!/bin/sh\necho "[]"\n');
  fs.chmodSync(ghShim, 0o755);

  return { root, remote, baseline, branch, packet, packetPath, binDir };
}

function remoteBranches(remote) {
  return git(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).split('\n').filter(Boolean).sort();
}

{
  const sandbox = initFullSandbox();
  const { root, remote, baseline, branch, packetPath, binDir } = sandbox;
  const env = { PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
  const cli = path.join(root, 'scripts', 'write-event-publication.mjs');

  // A real, eligible technical failure: the packet is governance-approved and
  // real-write authorized, but the feature branch has moved past the exact main
  // SHA the authorization is bound to. assertRealWriteSafety refuses it.
  git(root, ['commit', '-q', '--allow-empty', '-m', 'unrelated later commit']);
  const candidateBefore = git(root, ['rev-parse', 'HEAD']);
  const mainBefore = git(root, ['rev-parse', 'main']);
  const remoteMainBefore = git(remote, ['rev-parse', 'main']);
  const branchesBefore = remoteBranches(remote);

  const first = node(root, [cli, `--packet=${packetPath}`], env);
  const firstReport = parseJson(first.stderr);
  harness.equal('the guarded entrypoint still fails closed on a real technical refusal', first.status, 1);
  harness.equal('the real failure is the expected guarded-write refusal',
    (firstReport?.reason ?? '').split(':')[0], 'STALE_BRANCH_REFUSED');
  harness.equal('a real eligible technical failure emits a durable result',
    firstReport?.task_result?.emitted, true);
  harness.equal('the emitted result is TECHNICAL_VALIDATION_FAILED',
    firstReport?.task_result?.result_type, 'TECHNICAL_VALIDATION_FAILED');
  harness.equal('the emitted result is published to the remote results ref',
    firstReport?.task_result?.status, 'PUBLISHED');
  harness.equal('the emitted result targets the dedicated results ref',
    firstReport?.task_result?.ref, DEFAULT_RESULTS_REF);
  harness.equal('the emitted result grants no publication authority',
    firstReport?.task_result?.grants_publication_authority, false);
  harness.equal('the guarded entrypoint still reports no merge authority', firstReport?.merge_allowed, false);

  // 6/7/8: publication of the result moved nothing it reports on.
  harness.equal('result publication does not move the candidate branch', git(root, ['rev-parse', 'HEAD']), candidateBefore);
  harness.equal('result publication does not move local main', git(root, ['rev-parse', 'main']), mainBefore);
  harness.equal('result publication does not move main on the remote', git(remote, ['rev-parse', 'main']), remoteMainBefore);
  harness.equal('result publication does not push the candidate branch',
    remoteBranches(remote), [...branchesBefore, `refs/heads/${DEFAULT_RESULTS_REF}`].sort());
  harness.equal('main on the remote is still exactly the authorized baseline', git(remote, ['rev-parse', 'main']), baseline);

  const persisted = readPersistedResult(root, firstReport.task_result.result_id);
  harness.equal('the persisted technical record validates on its own terms', validateResult(persisted, { root }), []);
  harness.equal('the persisted technical record is owned by Project 04', persisted?.owner, 'PROJECT_04');
  harness.equal('the persisted technical record carries the failure\'s own reason code',
    persisted?.reason_code, 'STALE_BRANCH_REFUSED');
  harness.equal('the persisted technical record names its producer',
    persisted?.upstream_refs?.some((item) => item.ref === `${PRODUCER_REF_PREFIX}${PRODUCERS.GUARDED_EVENT_PUBLICATION}`), true);
  harness.equal('the persisted technical record binds to the branch head it failed at',
    persisted?.repository?.sha, candidateBefore);
  harness.equal('the persisted technical record resumes at the publication writer, not at a governance owner',
    persisted?.resume_point, { next_role: 'PUBLICATION_WRITER', next_status: 'BLOCKED' });
  harness.equal('the persisted technical record carries no reviewer', persisted?.reviewer, null);

  // 2: replaying the identical failure is logically idempotent.
  const remoteTipAfterFirst = git(remote, ['rev-parse', DEFAULT_RESULTS_REF]);
  const replay = node(root, [cli, `--packet=${packetPath}`], env);
  const replayReport = parseJson(replay.stderr);
  harness.equal('replaying the same technical failure still fails closed', replay.status, 1);
  harness.equal('the replay reports the same logical result id',
    replayReport?.task_result?.result_id, firstReport?.task_result?.result_id);
  harness.equal('the replay creates no second record',
    replayReport?.task_result?.status, 'REMOTE_ALREADY_PRESENT');
  harness.equal('the replay does not advance the remote results ref',
    git(remote, ['rev-parse', DEFAULT_RESULTS_REF]), remoteTipAfterFirst);
  harness.equal('the replay still leaves the candidate branch untouched', git(root, ['rev-parse', 'HEAD']), candidateBefore);

  // 3: a genuinely different technical failure appends a genuinely new record.
  fs.writeFileSync(path.join(root, 'producer-test-dirty.txt'), 'uncommitted\n');
  const changed = node(root, [cli, `--packet=${packetPath}`], env);
  const changedReport = parseJson(changed.stderr);
  harness.equal('a changed technical failure still fails closed', changed.status, 1);
  harness.equal('the changed failure is a genuinely different refusal',
    (changedReport?.reason ?? '').split(':')[0], 'DIRTY_WORKTREE_REFUSED');
  harness.equal('a changed technical failure publishes a new record',
    changedReport?.task_result?.status, 'PUBLISHED');
  harness.ok('a changed technical failure has a genuinely new logical identity',
    changedReport?.task_result?.result_id !== firstReport?.task_result?.result_id);
  harness.ok('the remote results ref advances for the genuinely new record',
    git(remote, ['rev-parse', DEFAULT_RESULTS_REF]) !== remoteTipAfterFirst);
  harness.equal('nothing was replaced: both technical records are present',
    listPersistedResults(root).length, 2);
  fs.rmSync(path.join(root, 'producer-test-dirty.txt'));

  // 10: a required result that cannot be persisted fails visibly.
  const unreachable = node(root, [cli, `--packet=${packetPath}`, '--result-remote=no-such-remote'], env);
  const unreachableReport = parseJson(unreachable.stderr);
  harness.equal('an unpersistable required result still exits non-zero', unreachable.status, 1);
  harness.equal('an unpersistable required result is never reported as emitted',
    unreachableReport?.task_result?.emitted, false);
  harness.equal('an unpersistable required result names the persistence failure',
    unreachableReport?.task_result?.reason, 'TASK_RESULT_PERSISTENCE_FAILED');
  harness.ok('the original technical failure is still reported alongside it',
    (unreachableReport?.reason ?? '').startsWith('STALE_BRANCH_REFUSED'));

  // A governance failure is NOT relabelled as a technical validation failure.
  const governancePacket = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  governancePacket.governance.publication_authorized = false;
  const governancePath = path.join(root, '.git', 'producer-governance-packet.json');
  fs.writeFileSync(governancePath, `${JSON.stringify(governancePacket, null, 2)}\n`);
  const resultsBeforeGovernance = listPersistedResults(root).length;
  const governanceRun = node(root, [cli, `--packet=${governancePath}`], env);
  const governanceReport = parseJson(governanceRun.stderr);
  harness.equal('a governance refusal still fails closed', governanceRun.status, 1);
  harness.equal('a governance refusal emits no technical validation result',
    governanceReport?.task_result?.emitted, false);
  harness.equal('a governance refusal is explicitly reported as not technically owned',
    governanceReport?.task_result?.reason, 'NOT_TECHNICALLY_OWNED');
  harness.equal('a governance refusal names the owning gate that stopped it',
    governanceReport?.task_result?.preflight_state, 'BLOCKED_OWNER_APPROVAL');
  harness.equal('a governance refusal creates no record at all',
    listPersistedResults(root).length, resultsBeforeGovernance);

  // An explicit opt-out is reported, never silent.
  const optedOut = node(root, [cli, `--packet=${packetPath}`, '--no-task-result'], env);
  const optedOutReport = parseJson(optedOut.stderr);
  harness.equal('an explicit opt-out still fails closed', optedOut.status, 1);
  harness.equal('an explicit opt-out is reported rather than applied silently',
    optedOutReport?.task_result, { emitted: false, reason: 'DISABLED_BY_FLAG', flag: '--no-task-result' });

  // 9: a later worker fetches, reads, and validates what this run published.
  const later = laterWorkerClone(remote);
  const laterTip = fetchResultsRef(later);
  harness.equal('a later worker fetches exactly the published results tip',
    laterTip, git(remote, ['rev-parse', DEFAULT_RESULTS_REF]));
  const laterRead = readPersistedResult(later, firstReport.task_result.result_id);
  harness.equal('a later worker reads back the exact technical record', laterRead, persisted);
  harness.equal('a later worker independently validates the technical record',
    validateResult(laterRead, { root: later }), []);
  const laterValidate = node(later, [path.join(later, 'scripts', 'validate-control-plane-result.mjs'), '--fetch']);
  harness.equal('the incumbent validator passes over every published record from a later checkout',
    parseJson(laterValidate.stdout)?.status, 'PASS');
  harness.equal('the later worker validates both published records',
    parseJson(laterValidate.stdout)?.checked, 2);
  harness.equal('a later worker\'s main is still exactly the authorized baseline',
    git(later, ['rev-parse', 'origin/main']), baseline);
  harness.equal('the candidate branch was never published by the result layer',
    remoteBranches(remote).includes(`refs/heads/${branch}`), false);
}

cleanup();
harness.finish([
  `producers=${Object.keys(PRODUCERS).length}`
]);
