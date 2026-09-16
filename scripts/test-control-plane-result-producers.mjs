#!/usr/bin/env node
// Regression suite for the control-plane task-result PRODUCERS: authority
// classification, replay identity, review-input guards, and the
// non-negotiable property that recording a result never moves, merges, or
// authorizes anything.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarness } from './lib/ttd-test-harness.mjs';
import {
  DEFAULT_RESULTS_REF,
  fetchResultsRef,
  isResultCurrent,
  listPersistedResults,
  readPersistedResult,
  validateResult
} from './lib/control-plane-result.mjs';
import {
  classifyDeclaredOwner,
  classifyPacketPreflight,
  emitProducerResult,
  packetPreflightIntent,
  redactVolatilePaths,
  resolveHeadSha,
  stableRef,
  technicalFailureIntent,
  assertExactCandidateSha,
  assertReviewerIsIndependent
} from './lib/control-plane-result-producers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harness = createHarness('CONTROL_PLANE_RESULT_PRODUCERS');
const cleanups = [];

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/**
 * A bare "GitHub" plus a working clone carrying the schema, a `main` branch
 * and a separate candidate branch — the real shape a producer runs against.
 */
function initSandbox() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-producer-test-'));
  cleanups.push(parent);
  const bare = path.join(parent, 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { encoding: 'utf8' });

  const repo = path.join(parent, 'repo');
  spawnSync('git', ['clone', '-q', bare, repo], { encoding: 'utf8' });
  git(repo, ['config', 'user.name', 'Producer Test']);
  git(repo, ['config', 'user.email', 'producer-test@example.invalid']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'automation', 'control-plane'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'automation', 'control-plane', 'task-result.schema.json'),
    path.join(repo, 'automation', 'control-plane', 'task-result.schema.json')
  );
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'baseline']);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  const mainSha = git(repo, ['rev-parse', 'main']);

  git(repo, ['checkout', '-q', '-b', 'feature/candidate']);
  fs.writeFileSync(path.join(repo, 'candidate.txt'), 'candidate work\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'candidate change']);
  git(repo, ['push', '-q', '-u', 'origin', 'feature/candidate']);
  const candidateSha = git(repo, ['rev-parse', 'HEAD']);

  return { parent, bare, repo, mainSha, candidateSha };
}

const PACKET = Object.freeze({ event: { id: 'ttd-producer-fixture-0001', title: 'Producer Fixture Event' } });

function failureIntent(sandbox, detail, overrides = {}) {
  return technicalFailureIntent({
    root: sandbox.repo,
    packet: PACKET,
    packetPath: path.join(sandbox.repo, 'automation', 'packet.json'),
    producer: 'prepare-event-publication',
    stage: 'DRY_RUN_VALIDATION_FAILED',
    detail,
    repositorySha: sandbox.candidateSha,
    ...overrides
  });
}

// --- 1. A real eligible technical failure produces TECHNICAL_VALIDATION_FAILED

const sandbox = initSandbox();

const firstEmission = emitProducerResult(sandbox.repo, failureIntent(sandbox, 'validate-things-to-do-events.mjs failed (1)'), { publish: false });

harness.equal(
  'an eligible technical failure produces TECHNICAL_VALIDATION_FAILED',
  firstEmission.record.result_type,
  'TECHNICAL_VALIDATION_FAILED'
);
harness.equal('the technical result is owned by PROJECT_04', firstEmission.record.owner, 'PROJECT_04');
harness.equal('the technical result is BLOCKED', firstEmission.record.status, 'BLOCKED');
harness.ok('the technical result was actually persisted', firstEmission.outcome.written === true);
harness.equal('a persisted producer result validates', validateResult(firstEmission.record, { root: sandbox.repo }), []);

// --- 2. Replay of the same failure is logically idempotent -----------------
//
// Replayed at a later instant AND from a different mkdtemp root, which is the
// realistic retry: the temp path differs, the logical outcome does not.

const replay = emitProducerResult(
  sandbox.repo,
  failureIntent(sandbox, 'validate-things-to-do-events.mjs failed (1)'),
  { publish: false }
);

harness.equal('replayed identical failure keeps the same result_id', replay.record.result_id, firstEmission.record.result_id);
harness.ok('replayed identical failure writes no second record', replay.outcome.written === false);
harness.equal('replay leaves exactly one persisted result', listPersistedResults(sandbox.repo).length, 1);

const volatileA = `${os.tmpdir()}/aprasa-real-write-AAAAAA/staging failed`;
const volatileB = `${os.tmpdir()}/aprasa-real-write-BBBBBB/staging failed`;
const volatileFirst = emitProducerResult(sandbox.repo, failureIntent(sandbox, volatileA), { publish: false });
const volatileSecond = emitProducerResult(sandbox.repo, failureIntent(sandbox, volatileB), { publish: false });

harness.equal(
  'the same failure from a different temp root stays one logical result',
  volatileSecond.record.result_id,
  volatileFirst.record.result_id
);
harness.ok('the volatile temp root is redacted out of the recorded reason', volatileFirst.record.reason.includes('<temp-root>'));
harness.ok('a repository-relative path is NOT redacted', redactVolatilePaths('data/things-to-do-events.json') === 'data/things-to-do-events.json');

// --- 3. A genuinely changed failure appends a new durable result ------------

const changed = emitProducerResult(sandbox.repo, failureIntent(sandbox, 'validate-card-media.mjs failed (1)'), { publish: false });

harness.ok('a genuinely different failure gets a new result_id', changed.record.result_id !== firstEmission.record.result_id);
harness.ok('a genuinely different failure is actually written', changed.outcome.written === true);
harness.ok('the earlier result is still readable after the new one', readPersistedResult(sandbox.repo, firstEmission.record.result_id) !== null);

// --- Authority classification ----------------------------------------------

harness.equal(
  'a Project 04 owned issue maps to TECHNICAL_VALIDATION_FAILED',
  classifyDeclaredOwner('Project 04').resultType,
  'TECHNICAL_VALIDATION_FAILED'
);
harness.equal(
  'the declared Project 03 boundary maps to NEEDS_PROJECT_03_DECISION',
  classifyDeclaredOwner('Project 03 / owning Project').resultType,
  'NEEDS_PROJECT_03_DECISION'
);
harness.ok('a Project 09 localization boundary is refused', classifyDeclaredOwner('Project 09').eligible === false);
harness.equal('the Project 09 refusal names localization authority', classifyDeclaredOwner('Project 09').refusal, 'PROJECT_09_LOCALIZATION_AUTHORITY');
harness.ok('a media-rights boundary is refused', classifyDeclaredOwner('Owning Project').eligible === false);
harness.equal('the media refusal names media-rights authority', classifyDeclaredOwner('Owning Project').refusal, 'MEDIA_RIGHTS_AUTHORITY');
harness.ok('a founder-owned issue is refused', classifyDeclaredOwner('Founder').eligible === false);
harness.ok('an unknown owner is refused rather than guessed', classifyDeclaredOwner('Some New Project').eligible === false);

// Classification follows the contract's OWN primary-issue precedence, and a
// BLOCKED_MEDIA issue owned by Project 04 is technical while the same code
// owned by the owning Project is not. This is the distinction that makes
// owner-based (not state-based) classification load-bearing.
harness.equal(
  'a technically-owned BLOCKED_MEDIA issue is a Project 04 technical failure',
  classifyPacketPreflight({
    ok: false,
    state: 'BLOCKED_MEDIA',
    issues: [{ code: 'BLOCKED_MEDIA', owner: 'Project 04', reason: 'Local media asset does not exist', required_input: 'Valid existing local asset', resume_from: 'READY_FOR_IMPLEMENTATION' }]
  }).resultType,
  'TECHNICAL_VALIDATION_FAILED'
);
harness.ok(
  'a rights-owned BLOCKED_MEDIA issue is NOT claimed as a technical failure',
  classifyPacketPreflight({
    ok: false,
    state: 'BLOCKED_MEDIA',
    issues: [{ code: 'BLOCKED_MEDIA', owner: 'Owning Project', reason: 'Media rights unresolved', required_input: 'Approved media disposition', resume_from: 'GOVERNANCE_CHECKED' }]
  }).eligible === false
);

const project03Intent = packetPreflightIntent({
  root: sandbox.repo,
  packet: PACKET,
  packetPath: path.join(sandbox.repo, 'automation', 'packet.json'),
  preflight: {
    ok: false,
    state: 'BLOCKED_OWNER_APPROVAL',
    issues: [{ code: 'BLOCKED_OWNER_APPROVAL', owner: 'Project 03 / owning Project', reason: 'Publication/factual approval is not complete', required_input: 'Approved publication packet', resume_from: 'GOVERNANCE_CHECKED' }]
  },
  repositorySha: sandbox.candidateSha
});
const project03 = emitProducerResult(sandbox.repo, project03Intent.intent, { publish: false });

harness.equal('a reached Project 03 boundary records NEEDS_PROJECT_03_DECISION', project03.record.result_type, 'NEEDS_PROJECT_03_DECISION');
harness.equal('the Project 03 record escalates rather than deciding', project03.record.status, 'ESCALATED');
harness.equal('the Project 03 record routes to human escalation', project03.record.resume_point.next_role, 'HUMAN_ESCALATION');
harness.equal('the Project 03 record grants nothing', project03.record.grants_publication_authority, false);

// --- 6/7/8. Recording a result moves nothing and authorizes nothing ---------

const mainBefore = git(sandbox.repo, ['rev-parse', 'main']);
const candidateBefore = git(sandbox.repo, ['rev-parse', 'feature/candidate']);
const remoteMainBefore = git(sandbox.repo, ['ls-remote', 'origin', 'refs/heads/main']);
const remoteCandidateBefore = git(sandbox.repo, ['ls-remote', 'origin', 'refs/heads/feature/candidate']);

const published = emitProducerResult(
  sandbox.repo,
  failureIntent(sandbox, 'a published technical failure'),
  { publish: true }
);

harness.ok('publishing a result reaches the remote', published.outcome.published === true);
harness.equal('publishing a result does not move local main', git(sandbox.repo, ['rev-parse', 'main']), mainBefore);
harness.equal('publishing a result does not move the candidate branch', git(sandbox.repo, ['rev-parse', 'feature/candidate']), candidateBefore);
harness.equal('publishing a result does not move remote main', git(sandbox.repo, ['ls-remote', 'origin', 'refs/heads/main']), remoteMainBefore);
harness.equal('publishing a result does not move the remote candidate branch', git(sandbox.repo, ['ls-remote', 'origin', 'refs/heads/feature/candidate']), remoteCandidateBefore);
harness.equal('the reviewed candidate SHA is still exactly what was recorded', published.record.repository.sha, sandbox.candidateSha);
harness.equal('no producer result ever grants publication authority', published.record.grants_publication_authority, false);
harness.ok('the results ref is not the candidate branch', published.outcome.ref !== 'feature/candidate');
harness.equal('the results ref is the dedicated control-plane ref', published.outcome.ref, DEFAULT_RESULTS_REF);

// The working tree is untouched by persistence: nothing is staged or dirtied.
harness.equal('recording a result leaves the working tree clean', git(sandbox.repo, ['status', '--porcelain']), '');

// --- 9. A later worker fetches, reads and validates -------------------------

const laterWorker = path.join(sandbox.parent, 'later-worker');
spawnSync('git', ['clone', '-q', sandbox.bare, laterWorker], { encoding: 'utf8' });
git(laterWorker, ['config', 'user.name', 'Later Worker']);
git(laterWorker, ['config', 'user.email', 'later@example.invalid']);

const fetchedTip = fetchResultsRef(laterWorker);
harness.ok('a later worker can fetch the results ref', /^[a-f0-9]{40}$/.test(fetchedTip ?? ''));

const laterRecord = readPersistedResult(laterWorker, published.record.result_id);
harness.ok('a later worker can read the published result', laterRecord !== null);
harness.equal('the later worker sees identical content', laterRecord.result_id, published.record.result_id);
harness.equal('the later worker can validate it', validateResult(laterRecord, { root: laterWorker }), []);

// A fresh checkout at a DIFFERENT filesystem path must reproduce the same
// logical identity — otherwise "idempotent across workers" would be false.
const laterReplay = emitProducerResult(
  laterWorker,
  technicalFailureIntent({
    root: laterWorker,
    packet: PACKET,
    packetPath: path.join(laterWorker, 'automation', 'packet.json'),
    producer: 'prepare-event-publication',
    stage: 'DRY_RUN_VALIDATION_FAILED',
    detail: 'a published technical failure',
    repositorySha: sandbox.candidateSha
  }),
  { publish: true }
);
harness.equal('a fresh checkout replays to the same logical result', laterReplay.record.result_id, published.record.result_id);
harness.ok('a fresh checkout does not duplicate the record', laterReplay.outcome.written === false);
harness.ok('repo-relative refs are path-independent', stableRef(laterWorker, path.join(laterWorker, 'automation', 'packet.json')) === 'automation/packet.json');

// --- 10. Failure to persist a required result fails visibly ----------------

const unreachable = initSandbox();
git(unreachable.repo, ['remote', 'set-url', 'origin', path.join(unreachable.parent, 'does-not-exist.git')]);

harness.throws('an unreachable remote makes required publication fail loudly', () => {
  emitProducerResult(unreachable.repo, failureIntent(unreachable, 'failure that cannot be published'), { publish: true });
});
harness.equal(
  'a failed publication leaves no half-published record on the remote',
  listPersistedResults(unreachable.repo).length,
  0
);

// An invalid intent must fail closed at construction, never persist partially.
harness.throws('an intent with no task reference is refused', () => {
  emitProducerResult(sandbox.repo, { ...failureIntent(sandbox, 'x'), candidateId: null }, { publish: false });
});
harness.throws('an intent without an exact repository SHA is refused', () => {
  emitProducerResult(sandbox.repo, { ...failureIntent(sandbox, 'x'), repositorySha: 'not-a-sha' }, { publish: false });
});

// --- 4/5. Review results require exact SHA and reviewer identity ------------

harness.throws('a review without a reviewer identity is refused', () => assertReviewerIsIndependent(''));
harness.throws('a review with a whitespace-only reviewer is refused', () => assertReviewerIsIndependent('   '));
harness.throws('the producing automation identity cannot review its own work', () => assertReviewerIsIndependent('A PRASA Control Plane'));
harness.throws('the automation email cannot review its own work', () => assertReviewerIsIndependent('automation@aprasa.org'));
harness.throws('a self-declared reviewer is refused', () => assertReviewerIsIndependent('self'));
harness.equal('a genuine reviewer identity is accepted', assertReviewerIsIndependent('codex-independent-review'), 'codex-independent-review');

harness.throws('a review without a candidate SHA is refused', () => assertExactCandidateSha(null));
harness.throws('a short candidate SHA is refused', () => assertExactCandidateSha('abc123'));
harness.throws('an uppercase candidate SHA is refused', () => assertExactCandidateSha('A'.repeat(40)));
harness.equal('an exact candidate SHA is accepted', assertExactCandidateSha('a'.repeat(40)), 'a'.repeat(40));

function runReviewCli(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'record-review-result.mjs'), ...args], { encoding: 'utf8' });
}

const reviewBase = [
  `--root=${sandbox.repo}`,
  '--local-only',
  '--candidate-id=ttd-producer-fixture-0001',
  '--reason=Independent review of the exact candidate.',
  '--required-input=Founder decision; no automatic merge.'
];

const missingReviewer = runReviewCli(['--outcome=passed', `--candidate-sha=${sandbox.candidateSha}`, ...reviewBase]);
harness.ok('REVIEW_PASSED without a reviewer identity exits non-zero', missingReviewer.status !== 0);
harness.ok('REVIEW_PASSED without a reviewer names the missing identity', missingReviewer.stderr.includes('REVIEWER_IDENTITY_REQUIRED'));

const missingSha = runReviewCli(['--outcome=passed', '--reviewer-identity=codex-independent-review', ...reviewBase]);
harness.ok('REVIEW_PASSED without an exact SHA exits non-zero', missingSha.status !== 0);
harness.ok('REVIEW_PASSED without an exact SHA names the missing binding', missingSha.stderr.includes('EXACT_CANDIDATE_SHA_REQUIRED'));

const selfCertified = runReviewCli(['--outcome=passed', `--candidate-sha=${sandbox.candidateSha}`, '--reviewer-identity=A PRASA Control Plane', ...reviewBase]);
harness.ok('a self-certified REVIEW_PASSED is refused', selfCertified.status !== 0);
harness.ok('the self-certification refusal is explicit', selfCertified.stderr.includes('SELF_CERTIFIED_REVIEW_REFUSED'));

const failedMissingReviewer = runReviewCli(['--outcome=failed', `--candidate-sha=${sandbox.candidateSha}`, ...reviewBase]);
harness.ok('REVIEW_FAILED without a reviewer identity exits non-zero', failedMissingReviewer.status !== 0);
const failedMissingSha = runReviewCli(['--outcome=failed', '--reviewer-identity=codex-independent-review', ...reviewBase]);
harness.ok('REVIEW_FAILED without an exact SHA exits non-zero', failedMissingSha.status !== 0);

const passedRun = runReviewCli(['--outcome=passed', `--candidate-sha=${sandbox.candidateSha}`, '--reviewer-identity=codex-independent-review', ...reviewBase]);
harness.ok('a complete REVIEW_PASSED succeeds', passedRun.status === 0);
const passedReport = JSON.parse(passedRun.stdout);
harness.equal('the review record is REVIEW_PASSED', passedReport.result_type, 'REVIEW_PASSED');
harness.equal('REVIEW_PASSED binds the exact candidate SHA', passedReport.candidate_sha, sandbox.candidateSha);
harness.equal('REVIEW_PASSED carries the supplied reviewer', passedReport.reviewer.identity, 'codex-independent-review');
harness.equal('REVIEW_PASSED grants no publication authority', passedReport.grants_publication_authority, false);
harness.equal('REVIEW_PASSED never implies merge', passedReport.merge_allowed, false);

const passedRecord = readPersistedResult(sandbox.repo, passedReport.result_id);
harness.equal('the persisted REVIEW_PASSED validates', validateResult(passedRecord, { root: sandbox.repo }), []);
harness.equal('REVIEW_PASSED has no automatic resume route', passedRecord.resume_point, null);
harness.ok('REVIEW_PASSED is current against the SHA it reviewed', isResultCurrent(passedRecord, sandbox.candidateSha) === true);
harness.ok('REVIEW_PASSED is stale against any other SHA', isResultCurrent(passedRecord, 'f'.repeat(40)) === false);

const passedReplay = runReviewCli(['--outcome=passed', `--candidate-sha=${sandbox.candidateSha}`, '--reviewer-identity=codex-independent-review', ...reviewBase]);
harness.equal('replaying the same review is idempotent', JSON.parse(passedReplay.stdout).result_id, passedReport.result_id);
harness.equal('replaying the same review writes nothing new', JSON.parse(passedReplay.stdout).status, 'ALREADY_PRESENT');

const failedRun = runReviewCli(['--outcome=failed', `--candidate-sha=${sandbox.candidateSha}`, '--reviewer-identity=codex-independent-review', ...reviewBase]);
harness.ok('a complete REVIEW_FAILED succeeds', failedRun.status === 0);
const failedReport = JSON.parse(failedRun.stdout);
harness.equal('the review record is REVIEW_FAILED', failedReport.result_type, 'REVIEW_FAILED');
harness.equal('REVIEW_FAILED grants no publication authority', failedReport.grants_publication_authority, false);
harness.ok('REVIEW_FAILED is a distinct record from REVIEW_PASSED', failedReport.result_id !== passedReport.result_id);

const failedRecord = readPersistedResult(sandbox.repo, failedReport.result_id);
harness.equal('REVIEW_FAILED returns work to the publication writer', failedRecord.resume_point.next_role, 'PUBLICATION_WRITER');

// Recording reviews still moved nothing.
harness.equal('review recording did not move main', git(sandbox.repo, ['rev-parse', 'main']), mainBefore);
harness.equal('review recording did not move the candidate branch', git(sandbox.repo, ['rev-parse', 'feature/candidate']), candidateBefore);

// --- resolveHeadSha -------------------------------------------------------

harness.equal('resolveHeadSha reports the exact checked-out commit', resolveHeadSha(sandbox.repo), candidateBefore);

for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });

harness.finish([`producers=3`, `result_types_wired=3`]);
