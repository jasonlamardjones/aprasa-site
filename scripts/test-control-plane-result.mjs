// Acceptance + adversarial regression suite for provider-neutral control-plane
// task-result records: construction, schema/semantic validation, content
// addressing, persistence, and exact-SHA staleness for review outcomes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarness } from './lib/ttd-test-harness.mjs';
import {
  buildResult,
  computeResultId,
  DEFAULT_RESULTS_REF,
  fetchResultsRef,
  isResultCurrent,
  listPersistedResults,
  publishResult,
  readPersistedResult,
  resolveAuthoritativeRemoteTip,
  RESULT_TYPES,
  resultRelativePath,
  validateResult,
  writeResult
} from './lib/control-plane-result.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harness = createHarness('CONTROL_PLANE_RESULT');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DIGEST_A = 'a'.repeat(64);

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/**
 * A real, throwaway git repository with one commit on its default branch,
 * carrying the schema file writeResult/validateResult need to read. Returns
 * {dir, candidateBranch, candidateSha}. Callers are responsible for cleanup.
 */
function initSandboxRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-result-test-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  fs.mkdirSync(path.join(dir, 'automation', 'control-plane'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'automation', 'control-plane', 'task-result.schema.json'),
    path.join(dir, 'automation', 'control-plane', 'task-result.schema.json')
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'candidate baseline']);
  const candidateSha = git(dir, ['rev-parse', 'main']);
  return { dir, candidateBranch: 'main', candidateSha };
}

function schemaOnlyClone(bareDir) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-result-clone-'));
  const dir = path.join(parent, 'repo');
  const clone = spawnSync('git', ['clone', '-q', bareDir, dir], { encoding: 'utf8' });
  if (clone.status !== 0) throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  return dir;
}

/**
 * A bare "GitHub" remote plus two independent clones of it, both already
 * carrying the same candidate commit and both with `origin` configured —
 * exactly the shape of two real workers checking out the same reviewed
 * candidate. Returns {bareDir, writer1, writer2, candidateSha}. Callers are
 * responsible for cleanup of every returned directory's parent.
 */
function initTwoWriterSandbox() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-result-bare-'));
  fs.rmSync(bareDir, { recursive: true, force: true });
  const init = spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bareDir], { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`git init --bare failed: ${init.stderr || init.stdout}`);

  const writer1 = schemaOnlyClone(bareDir);
  git(writer1, ['checkout', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(writer1, 'automation', 'control-plane'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'automation', 'control-plane', 'task-result.schema.json'),
    path.join(writer1, 'automation', 'control-plane', 'task-result.schema.json')
  );
  git(writer1, ['add', '-A']);
  git(writer1, ['commit', '-q', '-m', 'candidate baseline']);
  const candidateSha = git(writer1, ['rev-parse', 'main']);
  git(writer1, ['push', '-q', 'origin', 'main']);

  const writer2 = schemaOnlyClone(bareDir);
  git(writer2, ['checkout', '-q', 'main']);

  return { bareDir, writer1, writer2, candidateSha };
}

function baseFields(overrides = {}) {
  return {
    candidateId: 'TTD-SYNTHETIC-0001',
    repositorySha: SHA_A,
    reason: 'Synthetic acceptance-run fixture reason.',
    requiredInput: 'Synthetic required input.',
    evidenceDigest: DIGEST_A,
    upstreamRefs: [{ kind: 'AUDIT_RECORD', ref: 'synthetic:audit:0001' }],
    ...overrides
  };
}

// --- Positive construction: one per result_type ---------------------------

harness.equal('RESULT_TYPES has exactly the five founder-scoped outcomes', [...RESULT_TYPES].sort(), [
  'NEEDS_EVIDENCE_VERIFICATION',
  'NEEDS_PROJECT_03_DECISION',
  'REVIEW_FAILED',
  'REVIEW_PASSED',
  'TECHNICAL_VALIDATION_FAILED'
].sort());

for (const resultType of RESULT_TYPES) {
  const reviewer = ['REVIEW_PASSED', 'REVIEW_FAILED'].includes(resultType)
    ? { role: 'INDEPENDENT_REVIEWER', identity: 'Synthetic acceptance-run reviewer' }
    : null;
  const record = buildResult({ resultType, ...baseFields(), reviewer });
  harness.ok(`${resultType}: builds without error`, record !== null);
  harness.equal(`${resultType}: schema_version is 1.0.0`, record.schema_version, '1.0.0');
  harness.equal(`${resultType}: grants_publication_authority is false`, record.grants_publication_authority, false);
  harness.equal(`${resultType}: validates cleanly`, validateResult(record, { root: ROOT }), []);
  harness.equal(`${resultType}: result_id matches recomputed digest`, record.result_id, computeResultId(record));
}

// Per-type fixed shape, read back rather than asserted by construction alone.
harness.equal('NEEDS_EVIDENCE_VERIFICATION: status/owner/resume_point',
  (() => {
    const r = buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields() });
    return [r.status, r.owner, r.resume_point];
  })(),
  ['HOLD', 'EVIDENCE_VERIFIER', { next_role: 'EVIDENCE_VERIFIER', next_status: 'HOLD' }]);

harness.equal('NEEDS_PROJECT_03_DECISION: status/owner/resume_point',
  (() => {
    const r = buildResult({ resultType: 'NEEDS_PROJECT_03_DECISION', ...baseFields() });
    return [r.status, r.owner, r.resume_point];
  })(),
  ['ESCALATED', 'PROJECT_03', { next_role: 'HUMAN_ESCALATION', next_status: 'ESCALATED' }]);

harness.equal('TECHNICAL_VALIDATION_FAILED: status/owner/resume_point',
  (() => {
    const r = buildResult({ resultType: 'TECHNICAL_VALIDATION_FAILED', ...baseFields({ taskId: 'TTD-2026-EXAMPLE-001', candidateId: null }) });
    return [r.status, r.owner, r.resume_point];
  })(),
  ['BLOCKED', 'PROJECT_04', { next_role: 'PUBLICATION_WRITER', next_status: 'BLOCKED' }]);

harness.equal('REVIEW_PASSED: status/owner/resume_point is null (founder-only merge gate)',
  (() => {
    const r = buildResult({
      resultType: 'REVIEW_PASSED',
      ...baseFields(),
      reviewer: { role: 'INDEPENDENT_REVIEWER', identity: 'Codex exact-SHA review' }
    });
    return [r.status, r.owner, r.resume_point];
  })(),
  ['REVIEWED', 'INDEPENDENT_REVIEWER', null]);

harness.equal('REVIEW_FAILED: status/owner/resume_point',
  (() => {
    const r = buildResult({
      resultType: 'REVIEW_FAILED',
      ...baseFields(),
      reviewer: { role: 'INDEPENDENT_REVIEWER', identity: 'Codex exact-SHA review' }
    });
    return [r.status, r.owner, r.resume_point];
  })(),
  ['BLOCKED', 'INDEPENDENT_REVIEWER', { next_role: 'PUBLICATION_WRITER', next_status: 'HOLD' }]);

// --- Construction-time fail-closed regressions -----------------------------

harness.throws('buildResult rejects an unknown result_type',
  () => buildResult({ resultType: 'NOT_A_REAL_TYPE', ...baseFields() }));

harness.throws('buildResult rejects both taskId and candidateId null',
  () => buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields({ candidateId: null }) }));

harness.throws('buildResult rejects a malformed repositorySha',
  () => buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields({ repositorySha: 'not-a-sha' }) }));

harness.throws('buildResult rejects a malformed evidenceDigest',
  () => buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields({ evidenceDigest: 'not-a-digest' }) }));

harness.throws('buildResult rejects a missing evidenceDigest',
  () => buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields({ evidenceDigest: undefined }) }));

harness.throws('buildResult rejects empty upstreamRefs',
  () => buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields({ upstreamRefs: [] }) }));

harness.throws('buildResult rejects REVIEW_PASSED without a reviewer',
  () => buildResult({ resultType: 'REVIEW_PASSED', ...baseFields() }));

harness.throws('buildResult rejects REVIEW_FAILED without a reviewer',
  () => buildResult({ resultType: 'REVIEW_FAILED', ...baseFields() }));

harness.throws('buildResult rejects a reviewer on a non-review result_type',
  () => buildResult({
    resultType: 'NEEDS_EVIDENCE_VERIFICATION',
    ...baseFields(),
    reviewer: { role: 'INDEPENDENT_REVIEWER', identity: 'Should not be accepted here' }
  }));

// --- Post-construction tamper regressions (validateResult must catch each) -

function tampered(overrides) {
  const record = buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields() });
  return { ...record, ...overrides };
}

harness.ok('validateResult rejects a tampered result_id',
  validateResult(tampered({ result_id: 'f'.repeat(64) }), { root: ROOT }).length > 0);

harness.ok('validateResult rejects a status that contradicts result_type',
  validateResult(tampered({ status: 'REVIEWED' }), { root: ROOT }).length > 0);

harness.ok('validateResult rejects an owner that contradicts result_type',
  validateResult(tampered({ owner: 'PROJECT_03' }), { root: ROOT }).length > 0);

harness.ok('validateResult rejects a resume_point that contradicts result_type',
  validateResult(tampered({ resume_point: { next_role: 'HUMAN_ESCALATION', next_status: 'ESCALATED' } }), { root: ROOT }).length > 0);

harness.ok('validateResult rejects grants_publication_authority: true',
  validateResult(tampered({ grants_publication_authority: true }), { root: ROOT }).length > 0);

harness.ok('validateResult rejects an unresolved task_ref (both null)',
  validateResult(tampered({ task_ref: { task_id: null, candidate_id: null } }), { root: ROOT }).length > 0);

harness.ok('validateResult rejects a reviewer injected onto a non-review type',
  validateResult(tampered({ reviewer: { role: 'INDEPENDENT_REVIEWER', identity: 'injected' } }), { root: ROOT }).length > 0);

harness.ok('validateResult rejects a dangerous __proto__ key without throwing',
  validateResult(JSON.parse('{"__proto__": {"polluted": true}, "x": 1}'), { root: ROOT }).length > 0);

harness.ok('validateResult rejects an additional unknown top-level property',
  validateResult(tampered({ unexpected_field: 'no' }), { root: ROOT }).length > 0);

harness.throws('writeResult refuses to persist a record that fails validation',
  () => writeResult(ROOT, tampered({ status: 'REVIEWED' })));

// --- isResultCurrent: exact-SHA binding for review results -----------------

const reviewPassed = buildResult({
  resultType: 'REVIEW_PASSED',
  ...baseFields(),
  reviewer: { role: 'INDEPENDENT_REVIEWER', identity: 'Codex exact-SHA review' }
});
harness.equal('a REVIEW_PASSED result at the same SHA is current', isResultCurrent(reviewPassed, SHA_A), true);
harness.equal('a REVIEW_PASSED result becomes stale once the SHA moves', isResultCurrent(reviewPassed, SHA_B), false);

const reviewFailed = buildResult({
  resultType: 'REVIEW_FAILED',
  ...baseFields(),
  reviewer: { role: 'INDEPENDENT_REVIEWER', identity: 'Codex exact-SHA review' }
});
harness.equal('a REVIEW_FAILED result becomes stale once the SHA moves', isResultCurrent(reviewFailed, SHA_B), false);

const founderEscalatedReview = buildResult({
  resultType: 'REVIEW_PASSED',
  ...baseFields(),
  reviewer: { role: 'HUMAN_ESCALATION', identity: 'Founder-level escalation review' }
});
harness.equal('reviewer.role HUMAN_ESCALATION is an accepted alternate to INDEPENDENT_REVIEWER',
  validateResult(founderEscalatedReview, { root: ROOT }), []);

const needsEvidence = buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields() });
harness.equal('a non-review result type is never marked stale by SHA drift', isResultCurrent(needsEvidence, SHA_B), true);

// --- Persistence: content-addressed ref, idempotent, collision-refusing ---

{
  const { dir } = initSandboxRepo();
  try {
    const record = buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields() });
    const expectedRelPath = resultRelativePath(record);

    const first = writeResult(dir, record);
    harness.equal('first write reports written:true', first.written, true);
    harness.equal('first write lands at the content-addressed relative path', first.path, expectedRelPath);
    harness.equal('first write targets the default results ref', first.ref, DEFAULT_RESULTS_REF);
    harness.ok('a commit now exists on the results ref', /^[a-f0-9]{40}$/.test(first.commit));
    harness.equal('the record round-trips exactly from the results ref',
      readPersistedResult(dir, record.result_id), record);

    const beforeSecondTip = git(dir, ['rev-parse', DEFAULT_RESULTS_REF]);
    const second = writeResult(dir, record);
    harness.equal('re-writing identical content is idempotent (written:false)', second.written, false);
    harness.equal('idempotent re-write creates no new commit', git(dir, ['rev-parse', DEFAULT_RESULTS_REF]), beforeSecondTip);

    // Fabricate a genuine same-path/different-content collision directly at
    // the git-object layer (the only way one can occur, since result_id is
    // itself the content digest) and confirm it is refused, not overwritten.
    const tip = git(dir, ['rev-parse', DEFAULT_RESULTS_REF]);
    const tree = git(dir, ['rev-parse', `${tip}^{tree}`]);
    const tmpIndex = path.join(dir, '.git', 'tmp-index-for-collision-test');
    const blobSha = spawnSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: dir, encoding: 'utf8', input: `${JSON.stringify({ ...record, reason: 'corrupted' }, null, 2)}\n`
    }).stdout.trim();
    spawnSync('git', ['read-tree', tree], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
    spawnSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blobSha},${expectedRelPath}`], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: tmpIndex }
    });
    const collidedTree = spawnSync('git', ['write-tree'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: tmpIndex } }).stdout.trim();
    const collidedCommit = spawnSync('git', ['commit-tree', collidedTree, '-p', tip, '-m', 'induced collision'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid'
      }
    }).stdout.trim();
    git(dir, ['update-ref', `refs/heads/${DEFAULT_RESULTS_REF}`, collidedCommit, tip]);
    fs.rmSync(tmpIndex, { force: true });

    harness.throws('writing different content at the same content-addressed path is refused',
      () => writeResult(dir, record));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Blocker 1 proof: persisting review evidence never moves the reviewed --
// --- candidate's own SHA, because it lands on a separate ref entirely. -----

{
  const { dir, candidateBranch, candidateSha } = initSandboxRepo();
  try {
    const review = buildResult({
      resultType: 'REVIEW_PASSED',
      candidateId: `${candidateBranch}`,
      repositorySha: candidateSha,
      reason: 'Independent exact-head review found no defects.',
      requiredInput: 'None; ready for founder approval.',
      evidenceDigest: DIGEST_A,
      upstreamRefs: [{ kind: 'GITHUB_SHA', ref: candidateSha }],
      reviewer: { role: 'INDEPENDENT_REVIEWER', identity: 'Blocker-1 proof reviewer' }
    });

    writeResult(dir, review);

    const candidateShaAfter = git(dir, ['rev-parse', candidateBranch]);
    harness.equal('persisting REVIEW_PASSED does not move the reviewed candidate branch',
      candidateShaAfter, candidateSha);

    const resultsRefTip = git(dir, ['rev-parse', DEFAULT_RESULTS_REF]);
    harness.ok('the results ref is a distinct commit from the candidate branch',
      resultsRefTip !== candidateSha);

    const rereadReview = readPersistedResult(dir, review.result_id);
    harness.equal('the persisted review still binds to the unmoved candidate sha',
      rereadReview.repository.sha, candidateShaAfter);
    harness.equal('re-checking the persisted review against the (unmoved) live candidate sha reports current',
      isResultCurrent(rereadReview, candidateShaAfter), true);

    // Simulate ordinary further work continuing on the candidate branch after
    // the review was persisted — the review then correctly goes stale, but
    // only because the candidate itself changed, never because of anything
    // the review's own persistence did.
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'further candidate work\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'further candidate work']);
    const candidateShaAfterFurtherWork = git(dir, ['rev-parse', candidateBranch]);
    harness.ok('a later, unrelated candidate commit does move the candidate branch (control)',
      candidateShaAfterFurtherWork !== candidateSha);
    harness.equal('the review is correctly stale against genuinely new candidate work',
      isResultCurrent(rereadReview, candidateShaAfterFurtherWork), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Blocker 2 proof: identity is stable across a retry at a later instant,
// --- proven through the real buildResult + writeResult + CLI path. --------

{
  const t1 = '2026-09-15T00:00:00Z';
  const t2 = '2026-09-15T01:00:00Z'; // a later instant: simulates wall-clock advancing between retries
  const first = buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields(), createdAt: t1 });
  const retry = buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields(), createdAt: t2 });
  harness.ok('two builds of the same logical event have different created_at', first.created_at !== retry.created_at);
  harness.equal('two builds of the same logical event share one result_id regardless of created_at',
    first.result_id, retry.result_id);

  const changed = buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields({ reason: 'A genuinely different reason.' }), createdAt: t2 });
  harness.ok('a genuinely different event still gets a different result_id', changed.result_id !== first.result_id);

  const { dir } = initSandboxRepo();
  try {
    const firstWrite = writeResult(dir, first);
    harness.equal('the first occurrence is written', firstWrite.written, true);

    const retryWrite = writeResult(dir, retry);
    harness.equal('replaying the same logical event at a later instant is a no-op', retryWrite.written, false);
    harness.equal('no second commit is created by the replay', retryWrite.commit, firstWrite.commit);

    const persisted = readPersistedResult(dir, first.result_id);
    harness.equal('the persisted record keeps the first occurrence\'s created_at, not the retry\'s',
      persisted.created_at, t1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The same replay proof through the actual CLI entrypoint, not just the
// library call — this is what "through the real writer/build path" means:
// two separate process invocations of write-control-plane-result.mjs against
// the identical logical draft, each naturally producing its own real
// new Date().toISOString() for created_at, must still collapse to one result.
{
  const { dir } = initSandboxRepo();
  const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-result-cli-draft-'));
  try {
    const draftPath = path.join(draftDir, 'draft.json');
    fs.writeFileSync(draftPath, JSON.stringify({
      resultType: 'TECHNICAL_VALIDATION_FAILED',
      taskId: 'TTD-2026-CLI-REPLAY-001',
      repositorySha: SHA_A,
      reason: 'CLI replay regression fixture reason.',
      requiredInput: 'CLI replay regression fixture required input.',
      evidenceDigest: DIGEST_A,
      upstreamRefs: [{ kind: 'AUDIT_RECORD', ref: 'synthetic:cli-replay:0001' }]
    }, null, 2));

    const writerScript = path.join(ROOT, 'scripts', 'write-control-plane-result.mjs');
    function runCli() {
      const result = spawnSync(process.execPath, [writerScript, `--draft=${draftPath}`, `--root=${dir}`], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`CLI writer failed: ${result.stderr || result.stdout}`);
      return JSON.parse(result.stdout);
    }

    const firstRun = runCli();
    const secondRun = runCli(); // a genuine second process, its own new Date() call, a later instant
    harness.equal('the CLI reports WRITTEN on first invocation', firstRun.status, 'WRITTEN');
    harness.equal('the CLI reports ALREADY_PRESENT on the retry, not a second WRITTEN', secondRun.status, 'ALREADY_PRESENT');
    harness.equal('both CLI invocations agree on result_id despite the elapsed wall-clock time',
      firstRun.result_id, secondRun.result_id);
    harness.equal('the retry does not advance the results ref', secondRun.commit, firstRun.commit);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(draftDir, { recursive: true, force: true });
  }
}

// --- Committed example fixtures: one per result_type, must stay valid ------

const exampleDir = path.join(ROOT, 'automation', 'control-plane', 'fixtures', 'task-result-examples');
const exampleFiles = fs.readdirSync(exampleDir).filter((name) => name.endsWith('.json'));
harness.equal('one committed example fixture exists per result_type', exampleFiles.length, RESULT_TYPES.length);
for (const file of exampleFiles) {
  const record = JSON.parse(fs.readFileSync(path.join(exampleDir, file), 'utf8'));
  harness.equal(`fixture ${file}: validates cleanly`, validateResult(record, { root: ROOT }), []);
}

// --- Remote durability proof: one candidate repo, one bare fake origin, ---
// --- two independent writer clones. Requirements A-G from the second ------
// --- independent review, in order. ------------------------------------

{
  const { bareDir, writer1, writer2, candidateSha } = initTwoWriterSandbox();
  const cleanupDirs = [path.dirname(writer1), path.dirname(writer2), bareDir];
  try {
    // A. Writer 1 publishes REVIEW_PASSED for candidate SHA A to the
    //    dedicated remote results ref.
    const review = buildResult({
      resultType: 'REVIEW_PASSED',
      candidateId: 'main',
      repositorySha: candidateSha,
      reason: 'Independent exact-head review found no defects (remote-durability proof).',
      requiredInput: 'None; ready for founder approval.',
      evidenceDigest: DIGEST_A,
      upstreamRefs: [{ kind: 'GITHUB_SHA', ref: candidateSha }],
      reviewer: { role: 'INDEPENDENT_REVIEWER', identity: 'Remote-durability proof reviewer' }
    });
    const publishA = publishResult(writer1, review);
    harness.equal('A: writer 1 publishes REVIEW_PASSED (published:true)', publishA.published, true);
    harness.ok('A: publish reports a real remote tip commit', /^[a-f0-9]{40}$/.test(publishA.remote_tip));

    // B. Candidate branch SHA A remains unchanged — checked on the bare
    //    remote itself, not just writer 1's local view of it.
    const candidateOnRemoteAfterA = git(bareDir, ['rev-parse', 'main']);
    harness.equal('B: the candidate branch on the remote is unchanged by the publish', candidateOnRemoteAfterA, candidateSha);

    // C. Writer 2, starting from another checkout that has never seen the
    //    results ref, fetches and reads the same persisted result.
    const fetchedTip = fetchResultsRef(writer2);
    harness.equal('C: writer 2 fetches the same tip writer 1 published', fetchedTip, publishA.remote_tip);
    const readBack = readPersistedResult(writer2, review.result_id);
    harness.equal('C: writer 2 reads back the exact record writer 1 published', readBack, review);
    harness.equal('C: writer 2 independently validates the fetched record', validateResult(readBack, { root: writer2 }), []);

    // D. Retrying the same logical result from writer 2 is idempotent and
    //    creates no duplicate result or commit.
    const remoteTipBeforeD = git(bareDir, ['rev-parse', DEFAULT_RESULTS_REF]);
    const retryFromWriter2 = buildResult({
      resultType: 'REVIEW_PASSED',
      candidateId: 'main',
      repositorySha: candidateSha,
      reason: 'Independent exact-head review found no defects (remote-durability proof).',
      requiredInput: 'None; ready for founder approval.',
      evidenceDigest: DIGEST_A,
      upstreamRefs: [{ kind: 'GITHUB_SHA', ref: candidateSha }],
      reviewer: { role: 'INDEPENDENT_REVIEWER', identity: 'Remote-durability proof reviewer' },
      createdAt: '2099-01-01T00:00:00Z' // a much later instant; identity must still match
    });
    harness.equal('D: the retry shares the original result_id despite a different created_at', retryFromWriter2.result_id, review.result_id);
    const publishD = publishResult(writer2, retryFromWriter2);
    harness.equal('D: replaying the same logical result from writer 2 is a no-op (published:false)', publishD.published, false);
    harness.equal('D: the remote results ref does not advance on replay', git(bareDir, ['rev-parse', DEFAULT_RESULTS_REF]), remoteTipBeforeD);

    // E. A genuinely new result appends safely.
    const secondResult = buildResult({
      resultType: 'NEEDS_EVIDENCE_VERIFICATION',
      candidateId: 'TTD-REMOTE-PROOF-0002',
      repositorySha: candidateSha,
      reason: 'A genuinely different, second logical event (remote-durability proof).',
      requiredInput: 'Corroborating source.',
      evidenceDigest: DIGEST_A,
      upstreamRefs: [{ kind: 'AUDIT_RECORD', ref: 'synthetic:audit:remote-proof-0002' }]
    });
    const publishE = publishResult(writer2, secondResult);
    harness.equal('E: a genuinely new result publishes (published:true)', publishE.published, true);
    harness.ok('E: the remote tip advances past the previous tip', publishE.remote_tip !== remoteTipBeforeD);
    fetchResultsRef(writer1); // writer 1 catches up
    const bothFromWriter1 = listPersistedResults(writer1);
    harness.equal('E: both results are present after the append (nothing was replaced)', bothFromWriter1.length, 2);

    // F. A simulated concurrent stale writer cannot overwrite the newer
    //    remote results-ref tip. Writer 3 reads the SAME tip writer 2 read
    //    before E (i.e. before E was published), builds its own genuinely
    //    different third result on top of that now-stale tip using the same
    //    writeResult primitive real writers use, then attempts a plain,
    //    non-forced push after E has already moved the remote past it.
    const writer3 = schemaOnlyClone(bareDir);
    cleanupDirs.push(path.dirname(writer3));
    git(writer3, ['checkout', '-q', 'main']);
    git(writer3, ['update-ref', `refs/heads/${DEFAULT_RESULTS_REF}`, remoteTipBeforeD]); // writer 3's stale starting point
    const staleWriterResult = buildResult({
      resultType: 'TECHNICAL_VALIDATION_FAILED',
      taskId: 'TTD-2026-REMOTE-PROOF-STALE',
      repositorySha: candidateSha,
      reason: 'A third, concurrently-built result from a stale base (remote-durability proof).',
      requiredInput: 'N/A.',
      evidenceDigest: DIGEST_A,
      upstreamRefs: [{ kind: 'AUDIT_RECORD', ref: 'synthetic:audit:remote-proof-stale' }]
    });
    const staleLocalCommit = writeResult(writer3, staleWriterResult).commit;
    const remoteTipBeforeStalePush = git(bareDir, ['rev-parse', DEFAULT_RESULTS_REF]);
    const stalePush = spawnSync('git', ['push', 'origin', `${staleLocalCommit}:refs/heads/${DEFAULT_RESULTS_REF}`], { cwd: writer3, encoding: 'utf8' });
    harness.ok('F: the stale writer\'s plain (non-forced) push is rejected', stalePush.status !== 0);
    harness.equal('F: the remote results ref is unchanged by the rejected stale push', git(bareDir, ['rev-parse', DEFAULT_RESULTS_REF]), remoteTipBeforeStalePush);
    harness.equal('F: the remote results ref still matches writer 2\'s successful publish from E', remoteTipBeforeStalePush, publishE.remote_tip);

    // G. No candidate branch or main is pushed/moved as a side effect, across
    //    the entire scenario above.
    harness.equal('G: the candidate branch on the bare remote is still exactly A', git(bareDir, ['rev-parse', 'main']), candidateSha);
  } finally {
    for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Remote reachability failure is distinguished from "ref absent" -------

{
  const { dir } = initSandboxRepo();
  try {
    git(dir, ['remote', 'add', 'origin', '/nonexistent/not-a-real-remote']);
    harness.throws('resolveAuthoritativeRemoteTip fails closed on an unreachable remote rather than treating it as absent',
      () => resolveAuthoritativeRemoteTip(dir, {}));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

harness.finish([`result_types=${RESULT_TYPES.length}`, `example_fixtures=${exampleFiles.length}`]);
