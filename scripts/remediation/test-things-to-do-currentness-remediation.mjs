import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessDuplicateState,
  assertBoundedWriteSet,
  assertDriftShapeUnchanged,
  assertIdempotentChanges,
  assertSchemaValidation,
  assertValidatorResults,
  assertWorkflowArtifactProvenance,
  authorizeReport,
  capeVerdeDate,
  expectedWriteSetForIds,
  parseObservedDriftIds,
  parseOpenPrProbe,
  parseRemoteBranchProbe,
  parseValidatorDriftIds,
} from './lib/things-to-do-currentness-remediation.mjs';

const SHA = 'd5e017484bcd15514cc2ec46f870babe54febfa6';
const OTHER_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = new Date('2026-08-31T10:00:00Z');

function validReport() {
  return {
    schema: 'aprasa-post-publication-qa-report',
    version: '1.1.0',
    mode: 'IMMEDIATE_POST_DEPLOY',
    run: { run_id: '33359059956', run_attempt: '1' },
    target: {
      environment: 'production', base_url: 'https://aprasa.org', expected_main_sha: SHA,
      observed_deployment_sha: SHA, deployment_state: 'DEPLOYMENT_VERIFIED',
      deployment_evidence: { latest_status_state: 'success', live_home_matches_checked_out_bytes: true },
    },
    started_at: '2026-08-31T05:01:38.159Z', completed_at: '2026-08-31T05:04:20.828Z',
    issues: [{
      code: 'SOURCE_CURRENTNESS_DRIFT', severity: 'WARNING', domain: 'SOURCE_VALIDATION',
      observed: '- mon-pikenin: expired 2026-08-29 but still appears\n- oficina-contemporanea-lata: expired 2026-08-29 but still appears',
      deterministic: true, auto_remediation_candidate: true, validator_id: 'things_to_do_currentness',
    }],
  };
}

function expectDenied(mutator, code) {
  const report = validReport();
  mutator(report);
  assert.throws(() => authorizeReport(report, { now: NOW, remoteMainSha: SHA }), new RegExp(code));
}

assert.equal(capeVerdeDate('2026-09-01T00:30:00Z'), '2026-08-31');
assert.deepEqual(parseObservedDriftIds('- b-x: x\n- a-y: y\n- b-x: z'), ['a-y', 'b-x']);
assert.deepEqual(parseValidatorDriftIds('Things to Do currentness errors:\n- b-x: x\n- a-y: y'), ['a-y', 'b-x']);

const authorized = authorizeReport(validReport(), { now: NOW, remoteMainSha: SHA });
assert.equal(authorized.status, 'AUTHORIZED');
assert.equal(authorized.asOf, '2026-08-31');
assert.deepEqual(authorized.reportedIds, ['mon-pikenin', 'oficina-contemporanea-lata']);
assert.match(authorized.branch, /^feature\/phase2b-currentness-2026-08-31-[a-f0-9]{10}$/);
const corroborated = validReport();
corroborated.issues.push(
  { domain: 'LIVE_HTTP_VALIDATION', code: 'TTD_CURRENTNESS_DRIFT', route: '/', locale: 'en', observed: 'mon-pikenin ended 2026-08-29 but is still on Home', deterministic: true, auto_remediation_candidate: true },
  { domain: 'LIVE_HTTP_VALIDATION', code: 'TTD_CURRENTNESS_DRIFT', route: '/', locale: 'en', observed: 'oficina-contemporanea-lata ended 2026-08-29 but is still on Home', deterministic: true, auto_remediation_candidate: true },
);
assert.equal(authorizeReport(corroborated, { now: NOW, remoteMainSha: SHA }).status, 'AUTHORIZED');
assert.doesNotThrow(() => assertWorkflowArtifactProvenance(authorized, { runId: '33359059956', runAttempt: '1', headSha: SHA }));
assert.throws(() => assertWorkflowArtifactProvenance(authorized, { runId: 'x', runAttempt: '1', headSha: SHA }), /RUN_ID_MISMATCH/);
assert.throws(() => assertWorkflowArtifactProvenance(authorized, { runId: '33359059956', runAttempt: '2', headSha: SHA }), /RUN_ATTEMPT_MISMATCH/);
assert.throws(() => assertWorkflowArtifactProvenance(authorized, { runId: '33359059956', runAttempt: '1', headSha: OTHER_SHA }), /HEAD_SHA_MISMATCH/);
const badCorroboration = validReport();
badCorroboration.issues.push({ domain: 'LIVE_HTTP_VALIDATION', code: 'TTD_CURRENTNESS_DRIFT', route: '/', locale: 'en', observed: 'other-event ended but is still on Home', deterministic: true, auto_remediation_candidate: true });
assert.throws(() => authorizeReport(badCorroboration, { now: NOW, remoteMainSha: SHA }), /CORROBORATION_SHAPE_MISMATCH/);
assert.equal(authorizeReport({ ...validReport(), issues: [] }, { now: NOW, remoteMainSha: SHA }).status, 'NO_AUTHORIZED_FINDING');

expectDenied((r) => { r.issues[0].code = 'OTHER_CODE'; r.issues.push({ ...validReport().issues[0], auto_remediation_candidate: true }); }, 'UNAUTHORIZED_AUTO_REMEDIATION');
expectDenied((r) => { r.issues[0].validator_id = 'training_opportunities_currentness'; }, 'UNAUTHORIZED_AUTO_REMEDIATION');
expectDenied((r) => { r.issues[0].domain = 'LIVE_HTTP_VALIDATION'; }, 'UNAUTHORIZED_AUTO_REMEDIATION');
expectDenied((r) => { r.issues[0].deterministic = false; }, 'NON_DETERMINISTIC_FINDING_REFUSED');
expectDenied((r) => { r.issues[0].auto_remediation_candidate = false; }, 'AUTO_REMEDIATION_NOT_AUTHORIZED');
expectDenied((r) => { r.version = '1.0.0'; }, 'UNSUPPORTED_REPORT_VERSION');
expectDenied((r) => { r.target.observed_deployment_sha = OTHER_SHA; }, 'DEPLOYMENT_SHA_MISMATCH');
expectDenied((r) => { r.target.deployment_state = 'DEPLOYMENT_PENDING'; }, 'DEPLOYMENT_NOT_VERIFIED');
expectDenied((r) => { r.target.deployment_evidence.latest_status_state = 'failure'; }, 'DEPLOYMENT_STATUS_NOT_SUCCESS');
expectDenied((r) => { r.target.deployment_evidence.live_home_matches_checked_out_bytes = false; }, 'LIVE_PROVENANCE_NOT_BYTE_VERIFIED');
expectDenied((r) => { r.completed_at = '2026-08-29T00:00:00Z'; }, 'STALE_REPORT');
assert.throws(() => authorizeReport(validReport(), { now: NOW, remoteMainSha: OTHER_SHA }), /MAIN_MOVED/);
expectDenied((r) => { r.issues[0].severity = 'ERROR'; }, 'UNRELATED_BLOCKER_PRESENT');
expectDenied((r) => { r.issues[0].observed = 'unparseable drift'; }, 'REPORTED_DRIFT_SHAPE_UNREADABLE');

assert.doesNotThrow(() => assertDriftShapeUnchanged(['b', 'a'], ['a', 'b']));
assert.throws(() => assertDriftShapeUnchanged(['a'], []), /DRIFT_DISAPPEARED/);
assert.throws(() => assertDriftShapeUnchanged(['a'], ['b']), /DRIFT_CHANGED_SHAPE/);

const allowed = expectedWriteSetForIds(['foo-bar']);
assert(allowed.includes('things-to-do/foo-bar/index.html'));
assert(allowed.includes('pt/things-to-do/foo-bar/index.html'));
assert.deepEqual(
  assertBoundedWriteSet(['index.html', 'pt/index.html', 'things-to-do/foo-bar/index.html'], allowed),
  ['index.html', 'pt/index.html', 'things-to-do/foo-bar/index.html'],
);
assert.throws(() => assertBoundedWriteSet(['index.html', 'pt/index.html', 'unrelated.txt'], allowed), /UNEXPECTED_FILE_CHANGE/);
assert.throws(() => assertBoundedWriteSet(['pt/index.html'], allowed), /EN_HOME_NOT_REPAIRED/);
assert.throws(() => assertBoundedWriteSet(['index.html'], allowed), /PT_HOME_NOT_REPAIRED/);

assert.doesNotThrow(() => assertValidatorResults([{ step: 'ok', status: 0 }]));
assert.throws(() => assertValidatorResults([{ step: 'bad', status: 1 }]), /INCUMBENT_VALIDATOR_FAILED/);
assert.doesNotThrow(() => assertIdempotentChanges([]));
assert.throws(() => assertIdempotentChanges(['index.html']), /NON_IDEMPOTENT_GENERATION/);
assert.doesNotThrow(() => assertSchemaValidation([]));
assert.throws(() => assertSchemaValidation(['/schema: required']), /MALFORMED_REPORT/);

assert.equal(assessDuplicateState({}), 'CLEAR');
assert.equal(assessDuplicateState({ remoteBranchSha: SHA, draftPr: { isDraft: true, headRefOid: SHA } }), 'EQUIVALENT_DRAFT_PR_EXISTS');
assert.equal(assessDuplicateState({ remoteBranchSha: SHA }), 'ORPHAN_REMOTE_REPAIR_BRANCH');
assert.equal(assessDuplicateState({ draftPr: { isDraft: true, headRefOid: SHA } }), 'AMBIGUOUS_DUPLICATE_STATE');

const BRANCH = 'feature/phase2b-currentness-2026-08-31-0123456789';
const branchProbe = (overrides) => ({ status: 0, stdout: '', stderr: '', ...overrides });
const prProbe = (overrides) => ({ status: 0, stdout: '[]', stderr: '', ...overrides });

// A branch probe must prove the remote state; a failed probe is never "absent".
assert.equal(parseRemoteBranchProbe(branchProbe({}), BRANCH), null);
assert.equal(parseRemoteBranchProbe(branchProbe({ stdout: `${SHA}\trefs/heads/${BRANCH}\n` }), BRANCH), SHA);
assert.throws(() => parseRemoteBranchProbe(branchProbe({ status: 128, stderr: 'fatal: could not read Username' }), BRANCH), /PHASE2B_BRANCH_PROBE_FAILED/);
assert.throws(() => parseRemoteBranchProbe(branchProbe({ status: null, stderr: 'spawn ENOENT' }), BRANCH), /PHASE2B_BRANCH_PROBE_FAILED/);
assert.throws(() => parseRemoteBranchProbe(undefined, BRANCH), /PHASE2B_BRANCH_PROBE_FAILED/);
assert.throws(() => parseRemoteBranchProbe(branchProbe({ stdout: 'not-a-sha\trefs/heads/' + BRANCH }), BRANCH), /PHASE2B_BRANCH_PROBE_UNREADABLE/);
assert.throws(() => parseRemoteBranchProbe(branchProbe({ stdout: SHA }), BRANCH), /PHASE2B_BRANCH_PROBE_UNREADABLE/);
assert.throws(() => parseRemoteBranchProbe(branchProbe({ stdout: `${SHA}\trefs/heads/${BRANCH}\textra` }), BRANCH), /PHASE2B_BRANCH_PROBE_UNREADABLE/);
assert.throws(() => parseRemoteBranchProbe(branchProbe({ stdout: `${SHA}\trefs/heads/${BRANCH}\n${OTHER_SHA}\trefs/heads/${BRANCH}\n` }), BRANCH), /PHASE2B_BRANCH_PROBE_AMBIGUOUS/);
assert.throws(() => parseRemoteBranchProbe(branchProbe({ stdout: `${SHA}\trefs/heads/other-branch` }), BRANCH), /PHASE2B_BRANCH_PROBE_REF_MISMATCH/);

// The same contract applies to the pull-request probe.
const openPr = { url: 'https://github.com/o/r/pull/1', isDraft: true, headRefOid: SHA };
assert.equal(parseOpenPrProbe(prProbe({}), { repository: 'o/r', branch: BRANCH }), null);
assert.deepEqual(parseOpenPrProbe(prProbe({ stdout: JSON.stringify([openPr]) }), { repository: 'o/r', branch: BRANCH }), openPr);
assert.deepEqual(
  parseOpenPrProbe(prProbe({ stdout: JSON.stringify([{ ...openPr, isDraft: false }]) }), { repository: 'o/r', branch: BRANCH }),
  { ...openPr, isDraft: false },
);
assert.throws(() => parseOpenPrProbe(prProbe({ status: 1, stderr: 'gh: HTTP 502' }), { repository: 'o/r', branch: BRANCH }), /PHASE2B_PR_PROBE_FAILED/);
assert.throws(() => parseOpenPrProbe(prProbe({ status: null, stderr: 'spawn ENOENT' }), { repository: 'o/r', branch: BRANCH }), /PHASE2B_PR_PROBE_FAILED/);
assert.throws(() => parseOpenPrProbe(undefined, { repository: 'o/r', branch: BRANCH }), /PHASE2B_PR_PROBE_FAILED/);
assert.throws(() => parseOpenPrProbe(prProbe({ stdout: 'not json' }), { repository: 'o/r', branch: BRANCH }), /PHASE2B_PR_PROBE_UNREADABLE/);
assert.throws(() => parseOpenPrProbe(prProbe({ stdout: '' }), { repository: 'o/r', branch: BRANCH }), /PHASE2B_PR_PROBE_UNREADABLE/);
assert.throws(() => parseOpenPrProbe(prProbe({ stdout: '{"url":"x"}' }), { repository: 'o/r', branch: BRANCH }), /PHASE2B_PR_PROBE_UNREADABLE/);
assert.throws(() => parseOpenPrProbe(prProbe({ stdout: '[null]' }), { repository: 'o/r', branch: BRANCH }), /PHASE2B_PR_PROBE_UNREADABLE/);
assert.throws(() => parseOpenPrProbe(prProbe({ stdout: JSON.stringify([{ isDraft: true, headRefOid: SHA }]) }), { repository: 'o/r', branch: BRANCH }), /PHASE2B_PR_PROBE_UNREADABLE/);
assert.throws(() => parseOpenPrProbe(prProbe({ stdout: JSON.stringify([{ ...openPr, isDraft: 'true' }]) }), { repository: 'o/r', branch: BRANCH }), /PHASE2B_PR_PROBE_UNREADABLE/);
assert.throws(() => parseOpenPrProbe(prProbe({ stdout: JSON.stringify([{ ...openPr, headRefOid: 'short' }]) }), { repository: 'o/r', branch: BRANCH }), /PHASE2B_PR_PROBE_UNREADABLE/);
assert.throws(() => parseOpenPrProbe(prProbe({ stdout: JSON.stringify([openPr, { ...openPr, url: 'https://github.com/o/r/pull/2' }]) }), { repository: 'o/r', branch: BRANCH }), /PHASE2B_PR_PROBE_AMBIGUOUS/);

// Validated probe results still drive the unchanged duplicate-state semantics.
assert.equal(assessDuplicateState({
  remoteBranchSha: parseRemoteBranchProbe(branchProbe({}), BRANCH),
  draftPr: parseOpenPrProbe(prProbe({}), { repository: 'o/r', branch: BRANCH }),
}), 'CLEAR');
assert.equal(assessDuplicateState({
  remoteBranchSha: parseRemoteBranchProbe(branchProbe({ stdout: `${SHA}\trefs/heads/${BRANCH}` }), BRANCH),
  draftPr: parseOpenPrProbe(prProbe({ stdout: JSON.stringify([openPr]) }), { repository: 'o/r', branch: BRANCH }),
}), 'EQUIVALENT_DRAFT_PR_EXISTS');
assert.equal(assessDuplicateState({
  remoteBranchSha: parseRemoteBranchProbe(branchProbe({ stdout: `${SHA}\trefs/heads/${BRANCH}` }), BRANCH),
  draftPr: parseOpenPrProbe(prProbe({}), { repository: 'o/r', branch: BRANCH }),
}), 'ORPHAN_REMOTE_REPAIR_BRANCH');
assert.equal(assessDuplicateState({
  remoteBranchSha: parseRemoteBranchProbe(branchProbe({ stdout: `${OTHER_SHA}\trefs/heads/${BRANCH}` }), BRANCH),
  draftPr: parseOpenPrProbe(prProbe({ stdout: JSON.stringify([openPr]) }), { repository: 'o/r', branch: BRANCH }),
}), 'AMBIGUOUS_DUPLICATE_STATE');

// The root checkout must carry repository-local commit identity before the authorized repair commit.
const runnerSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-things-to-do-currentness-remediation.mjs'),
  'utf8',
);
const rootNameConfig = runnerSource.indexOf("git(root, ['config', 'user.name', 'A PRASA Phase 2B Automation']);");
const rootEmailConfig = runnerSource.indexOf("git(root, ['config', 'user.email', 'automation@aprasa.org']);");
const rootCommit = runnerSource.indexOf("git(root, ['commit', '-m',");
assert.ok(rootNameConfig > -1, 'root checkout must configure user.name');
assert.ok(rootEmailConfig > -1, 'root checkout must configure user.email');
assert.ok(rootCommit > -1, 'root repair commit must exist');
assert.ok(rootNameConfig < rootCommit && rootEmailConfig < rootCommit, 'identity must precede the repair commit');

// The staging clone keeps its own unchanged repository-local identity.
assert.ok(runnerSource.includes("git(stagingRoot, ['config', 'user.name', 'A PRASA Phase 2B Automation']);"));
assert.ok(runnerSource.includes("git(stagingRoot, ['config', 'user.email', 'automation@aprasa.org']);"));

// Identity is never written to global Git configuration.
assert.ok(!/--global|--system|GIT_CONFIG_GLOBAL/.test(runnerSource), 'no global/system git config writes');
for (const call of runnerSource.match(/\['config',[^\]]*\]/g) ?? []) {
  assert.ok(/^\['config', 'user\.(name|email)', '[^']+'\]$/.test(call), `unexpected git config call: ${call}`);
}

console.log('Phase 2B currentness remediation unit tests passed.');
