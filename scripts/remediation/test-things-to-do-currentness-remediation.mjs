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
  assertHomeRegionChangeBounded,
  assertWorkflowArtifactProvenance,
  authorizeReport,
  capeVerdeDate,
  detailAuthorizedIds,
  detailRenderingChanged,
  expectedWriteSetForTransition,
  homeRegionAuthorizedIds,
  homeRegionChange,
  parseObservedDriftIds,
  parseOpenPrProbe,
  parseRemoteBranchProbe,
  parseValidatorDriftIds,
  resolvePreviewTransition,
} from './lib/things-to-do-currentness-remediation.mjs';
import { THINGS_TO_DO_HUB_PUBLIC, hubOutputPath } from '../lib/things-to-do-collection.mjs';
import {
  FAILURE_SIGNAL,
  buildIssueBody,
  buildRecurrenceComment,
  classifyFailure,
  detectPostCommitRecovery,
  decideFailureSignal,
  failureIssueTitle,
  failureSignalKey,
  keyMarker,
  parseOpenFailureIssueProbe,
  recordedCommits,
} from './lib/phase2b-failure-signal.mjs';

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

// --- Derived bounded write set --------------------------------------------
// The write set is derived from the lifecycle transition. A preview-boundary
// expiry promotes a record, and the promoted record's surfaces must be
// permitted even though it is not a drift ID — that omission is what made the
// incumbent repair abort.
const previewRecords = [
  { id: 'active-one', kind: 'dated-event', end_date: '2026-12-31' },
  { id: 'expiring-two', kind: 'dated-event', end_date: '2026-10-01' },
  { id: 'retained-three', kind: 'dated-event', end_date: '2026-12-31' },
  { id: 'promoted-four', kind: 'dated-event', end_date: '2026-12-31' },
  { id: 'beyond-five', kind: 'dated-event', end_date: '2026-12-31' },
];
const transition = resolvePreviewTransition({ records: previewRecords, fromAsOf: '2026-10-01', toAsOf: '2026-10-02' });
assert.deepEqual(transition.previewBefore, ['active-one', 'expiring-two', 'retained-three']);
assert.deepEqual(transition.previewAfter, ['active-one', 'promoted-four', 'retained-three']);
// Only the expiring record's own state moves; the promoted record stays CURRENT.
assert.deepEqual(transition.stateChangedIds, ['expiring-two']);
assert.deepEqual(transition.detailRenderingChangedIds, ['expiring-two']);

// Rendered currentness is NARROWER than currentness state. renderDetailPage()
// consults isExpired() alone, so CURRENT <-> REVIEW_DUE renders identically and
// must not carry detail authority; only crossing into or out of EXPIRED can.
const monthPrecision = {
  id: 'month-precision-one',
  kind: 'dated-event',
  start_date: '2026-01-01',
  end_precision: 'month',
  end_month: '2026-11',
  end_date: null,
};
const reviewDueTransition = resolvePreviewTransition({
  records: [monthPrecision],
  fromAsOf: '2026-10-31',
  toAsOf: '2026-11-01',
});
assert.deepEqual(reviewDueTransition.stateChangedIds, ['month-precision-one'],
  'the month boundary must register as a state change');
assert.deepEqual(reviewDueTransition.detailRenderingChangedIds, [],
  'CURRENT -> REVIEW_DUE renders no differently, so it carries no detail authority');
assert.equal(detailRenderingChanged(monthPrecision, '2026-10-31', '2026-11-01'), false);
const dayPrecision = { id: 'day-one', kind: 'dated-event', start_date: '2026-01-01', end_date: '2026-10-01' };
assert.equal(detailRenderingChanged(dayPrecision, '2026-10-01', '2026-10-02'), true,
  'crossing into EXPIRED does change detail rendering');
assert.equal(detailRenderingChanged(dayPrecision, '2026-10-02', '2026-10-03'), false,
  'already expired on both sides crosses nothing');
// A non-rendering state move must not authorize that detail page.
const reviewDueAllowed = expectedWriteSetForTransition({
  driftIds: ['expiring-two'],
  previewBefore: ['expiring-two'],
  previewAfter: [],
  detailRenderingChangedIds: reviewDueTransition.detailRenderingChangedIds,
});
assert.ok(!reviewDueAllowed.includes('things-to-do/month-precision-one/index.html'),
  'a CURRENT -> REVIEW_DUE record must not gain detail authority');
assert.throws(() => resolvePreviewTransition({ records: previewRecords, fromAsOf: 'nope', toAsOf: '2026-10-02' }), /PREVIEW_BASELINE_AS_OF_UNREADABLE/);
assert.throws(() => resolvePreviewTransition({ records: previewRecords, fromAsOf: '2026-10-01', toAsOf: null }), /PREVIEW_TARGET_AS_OF_UNREADABLE/);

const allowed = expectedWriteSetForTransition({
  driftIds: ['expiring-two'],
  previewBefore: transition.previewBefore,
  previewAfter: transition.previewAfter,
  detailRenderingChangedIds: transition.detailRenderingChangedIds,
});
// Authority is SPLIT. Detail pages follow a record's own rendered currentness
// state, because that is what their markup depends on; preview membership is a
// Home-only concept, so entering or leaving the preview must not by itself
// authorize a detail page — otherwise unrelated drift in a promoted record's
// page would ride along on a repair.
assert(allowed.includes('things-to-do/expiring-two/index.html'));
assert(allowed.includes('pt/things-to-do/expiring-two/index.html'));
for (const id of ['active-one', 'retained-three', 'promoted-four', 'beyond-five']) {
  assert(!allowed.includes(`things-to-do/${id}/index.html`), `${id} keeps its state: no EN detail authority`);
  assert(!allowed.includes(`pt/things-to-do/${id}/index.html`), `${id} keeps its state: no PT detail authority`);
}
// A record already EXPIRED at both dates has no state CHANGE, yet is exactly
// what needs regenerating — hence drift IDs are unioned in, not derived.
assert.deepEqual(detailAuthorizedIds({ driftIds: ['stale-one'], detailRenderingChangedIds: [] }), ['stale-one']);
assert.deepEqual(detailAuthorizedIds({ driftIds: ['b-two'], detailRenderingChangedIds: ['a-one', 'b-two'] }), ['a-one', 'b-two']);
// Shared surfaces the transition cannot reach stay out.
assert(!allowed.includes('sitemap.xml'));
assert(!allowed.includes('data/locales/locale-data.generated.json'));
assert(allowed.includes('data/things-to-do-currentness.json'));
assert(allowed.includes('index.html') && allowed.includes('pt/index.html'));
// The hub is a whole-collection currentness projection, so it is admitted
// exactly while it is published and never while dormant.
assert.equal(allowed.includes(hubOutputPath('en')), THINGS_TO_DO_HUB_PUBLIC);
assert.equal(allowed.includes(hubOutputPath('pt')), THINGS_TO_DO_HUB_PUBLIC);
// The audit's five-file Eclipse result is a property of one transition, not the
// contract: a transition that moves more records' state derives a wider set.
assert(expectedWriteSetForTransition({ driftIds: ['expiring-two'], detailRenderingChangedIds: ['expiring-two', 'another-one'] }).length
  > expectedWriteSetForTransition({ driftIds: ['expiring-two'], detailRenderingChangedIds: ['expiring-two'] }).length);
assert.throws(() => expectedWriteSetForTransition({}), /WRITE_SET_TRANSITION_EMPTY/);
assert.throws(() => expectedWriteSetForTransition({ driftIds: ['Bad_Id'] }), /WRITE_SET_ID_UNREADABLE/);
assert.throws(() => expectedWriteSetForTransition({ driftIds: ['../escape'] }), /WRITE_SET_ID_UNREADABLE/);
// Preview membership is load-bearing, and bounded to a CHANGE in membership:
// the records that enter or leave, never the ones retained on both sides.
// renderHomeArticle(record, loc) takes no asOf and reads only record fields, so
// a retained member's slot cannot move for a lifecycle reason — admitting it
// would let unrelated drift inside that slot ride along.
assert.deepEqual(
  homeRegionAuthorizedIds({ driftIds: ['expiring-two'], previewBefore: transition.previewBefore, previewAfter: transition.previewAfter }),
  ['expiring-two', 'promoted-four'],
);
for (const retained of ['active-one', 'retained-three']) {
  assert.ok(!homeRegionAuthorizedIds({ driftIds: ['expiring-two'], previewBefore: transition.previewBefore, previewAfter: transition.previewAfter }).includes(retained),
    `${retained} is retained on both sides, so its Home slot must NOT be authorized`);
}
// A drifted record outside the preview on both sides still needs its slot
// emptied, which is why drift IDs are unioned in rather than derived.
assert.deepEqual(
  homeRegionAuthorizedIds({ driftIds: ['long-gone'], previewBefore: ['a-one'], previewAfter: ['a-one'] }),
  ['long-gone'],
);
// A shrinking preview (a record leaves with nothing eligible to promote) is a
// legitimate transition, not an error.
assert.deepEqual(
  homeRegionAuthorizedIds({ driftIds: ['leaver-one'], previewBefore: ['keeper-one', 'leaver-one'], previewAfter: ['keeper-one'] }),
  ['leaver-one'],
);
assert.throws(() => homeRegionAuthorizedIds({}), /WRITE_SET_TRANSITION_EMPTY/);
// A transition where membership does not move at all still refuses nothing-to-do.
assert.throws(() => homeRegionAuthorizedIds({ previewBefore: ['a-one'], previewAfter: ['a-one'] }), /WRITE_SET_TRANSITION_EMPTY/);

// --- Home bounded at region level ------------------------------------------
// Canonical generation rewrites both Home files in full, so a file-level check
// alone would admit a Home surface's unrelated drift. Content outside the
// generated-event regions must not move, and the regions that do move must
// belong to this transition.
const homeHtml = (slots, chrome = 'chrome') => [
  `<main id="main"><p>${chrome}</p>`,
  ...Object.entries(slots).map(([id, body]) =>
    `<!-- BEGIN GENERATED EVENT: ${id} -->${body}<!-- END GENERATED EVENT: ${id} -->`),
  '</main>',
].join('\n');

const homeWas = homeHtml({ 'expiring-two': 'card-expiring', 'promoted-four': '' });
const homeNow = homeHtml({ 'expiring-two': '', 'promoted-four': 'card-promoted' });
assert.deepEqual(homeRegionChange(homeWas, homeNow), { changedIds: ['expiring-two', 'promoted-four'], outsideChanged: false });
assert.deepEqual(homeRegionChange(homeWas, homeWas), { changedIds: [], outsideChanged: false });
assert.deepEqual(
  assertHomeRegionChangeBounded(homeWas, homeNow, ['expiring-two', 'promoted-four'], 'index.html'),
  ['expiring-two', 'promoted-four'],
);
// Drift outside the regions is refused however small.
const homeChrome = homeHtml({ 'expiring-two': '', 'promoted-four': 'card-promoted' }, 'hand-edited chrome');
assert.equal(homeRegionChange(homeWas, homeChrome).outsideChanged, true);
assert.throws(() => assertHomeRegionChangeBounded(homeWas, homeChrome, ['expiring-two', 'promoted-four'], 'pt/index.html'),
  /PHASE2B_HOME_CHANGE_OUTSIDE_GENERATED_REGIONS: pt\/index\.html/);
// A slot belonging to a record outside the transition is refused too.
assert.throws(() => assertHomeRegionChangeBounded(homeWas, homeNow, ['expiring-two'], 'index.html'),
  /PHASE2B_HOME_REGION_CHANGE_UNAUTHORIZED: index\.html: promoted-four/);
// A retained member's slot moving is unrelated drift, and is now refused
// because retained records carry no region authority.
const homeRetainedDrift = homeHtml({ 'expiring-two': '', 'promoted-four': 'card-promoted', 'retained-three': 'edited' });
const homeRetainedWas = homeHtml({ 'expiring-two': 'card-expiring', 'promoted-four': '', 'retained-three': 'card-retained' });
assert.throws(() => assertHomeRegionChangeBounded(homeRetainedWas, homeRetainedDrift, ['expiring-two', 'promoted-four'], 'index.html'),
  /PHASE2B_HOME_REGION_CHANGE_UNAUTHORIZED: index\.html: retained-three/);
// A duplicated region makes membership ambiguous, so it fails closed.
assert.throws(() => homeRegionChange(`${homeWas}\n${homeWas}`, homeNow), /PHASE2B_HOME_REGION_DUPLICATED/);

// assertBoundedWriteSet itself is unchanged: exact enforcement, both Homes
// required, anything unlisted refused.
const simple = expectedWriteSetForTransition({ driftIds: ['foo-bar'] });
assert(simple.includes('things-to-do/foo-bar/index.html'));
assert(simple.includes('pt/things-to-do/foo-bar/index.html'));
assert.deepEqual(
  assertBoundedWriteSet(['index.html', 'pt/index.html', 'things-to-do/foo-bar/index.html'], simple),
  ['index.html', 'pt/index.html', 'things-to-do/foo-bar/index.html'],
);
assert.throws(() => assertBoundedWriteSet(['index.html', 'pt/index.html', 'unrelated.txt'], simple), /UNEXPECTED_FILE_CHANGE/);
assert.throws(() => assertBoundedWriteSet(['pt/index.html'], simple), /EN_HOME_NOT_REPAIRED/);
assert.throws(() => assertBoundedWriteSet(['index.html'], simple), /PT_HOME_NOT_REPAIRED/);
assert.throws(() => assertBoundedWriteSet([], simple), /EMPTY_REPAIR_DIFF/);

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

// --- Failure visibility ----------------------------------------------------
// No GitHub call appears anywhere in this suite: the decision is a pure
// function, so a simulated failure is proved without creating a real issue.

// The failure class is the adapter's own refusal code, not an incidental line.
assert.equal(classifyFailure('PHASE2B_INCUMBENT_VALIDATOR_FAILED: surface equivalence (exit 1)'), 'PHASE2B_INCUMBENT_VALIDATOR_FAILED');
assert.equal(classifyFailure('Error: something\n  at x\nPHASE2B_MAIN_MOVED\n'), 'PHASE2B_MAIN_MOVED');
assert.equal(classifyFailure('node: command not found'), FAILURE_SIGNAL.unclassified);
assert.equal(classifyFailure(''), FAILURE_SIGNAL.unclassified);
assert.equal(classifyFailure(null), FAILURE_SIGNAL.unclassified);
// POST_COMMIT_RECOVERY is guidance appended to a real failure, never the class.
assert.equal(
  classifyFailure('PHASE2B_POST_COMMIT_RECOVERY: Candidate ... \nPHASE2B_UNEXPECTED_FILE_CHANGE: x'),
  'PHASE2B_UNEXPECTED_FILE_CHANGE',
);
assert.equal(classifyFailure('PHASE2B_POST_COMMIT_RECOVERY only'), FAILURE_SIGNAL.unclassified);
// A canonical-generation refusal keys on its own class, not on the raw command
// failure build-all would otherwise report.
assert.equal(
  classifyFailure('PHASE2B_CANONICAL_GENERATION_FAILED: node scripts/build-all.mjs --as-of=2026-09-13 failed (1)'),
  'PHASE2B_CANONICAL_GENERATION_FAILED',
);

// The dedupe key is stable per failure class and distinct across classes.
const failKey = failureSignalKey('PHASE2B_INCUMBENT_VALIDATOR_FAILED');
assert.equal(failKey, failureSignalKey('PHASE2B_INCUMBENT_VALIDATOR_FAILED'));
assert.notEqual(failKey, failureSignalKey('PHASE2B_MAIN_MOVED'));
assert.throws(() => failureSignalKey('not a class'), /FAILURE_CLASS_UNREADABLE/);

const failContext = { log: 'PHASE2B_INCUMBENT_VALIDATOR_FAILED: surface equivalence', commit: SHA, runId: '4242', runAttempt: '1' };
const otherCommitContext = { ...failContext, commit: OTHER_SHA, runId: '4243' };

// 9. FAILURE SIGNAL — a simulated failure with nothing open creates one issue.
const created = decideFailureSignal({ issue: null, context: failContext });
assert.equal(created.action, 'CREATE');
assert.equal(created.failureClass, 'PHASE2B_INCUMBENT_VALIDATOR_FAILED');
assert.equal(created.key, failKey);

const issueBody = buildIssueBody(failContext, { repository: 'o/r', key: failKey });
assert(issueBody.includes(keyMarker(failKey)), 'the issue must carry its dedupe marker');
assert(issueBody.includes(SHA), 'the issue must carry commit context');
assert(issueBody.includes('4242'), 'the issue must carry run context');
assert(issueBody.includes('PHASE2B_INCUMBENT_VALIDATOR_FAILED'), 'the issue must carry the failure class');
assert(issueBody.includes('https://github.com/o/r/actions/runs/4242'));
assert.equal(failureIssueTitle(created.failureClass), 'Phase 2B remediation failed: PHASE2B_INCUMBENT_VALIDATOR_FAILED');
// A pre-commit refusal may say nothing was created; a POST-COMMIT failure may
// not, because a candidate branch can already be pushed and telling an
// investigator otherwise invites a rerun on top of it.
assert.equal(detectPostCommitRecovery('PHASE2B_POST_COMMIT_RECOVERY: Candidate abc is already pushed on feature/x'),
  'Candidate abc is already pushed on feature/x');
assert.equal(detectPostCommitRecovery('PHASE2B_MAIN_MOVED'), null);
assert.equal(detectPostCommitRecovery(null), null);
assert.ok(issueBody.includes('no branch, no commit and no draft'),
  'a pre-commit refusal states the clean no-op plainly');
const recoveryBody = buildIssueBody(
  { ...failContext, log: 'PHASE2B_UNEXPECTED_FILE_CHANGE: x\nPHASE2B_POST_COMMIT_RECOVERY: Candidate abc is already pushed on feature/x; create/inspect one draft PR only.' },
  { repository: 'o/r', key: failKey },
);
assert.ok(!recoveryBody.includes('no branch, no commit'),
  'a post-commit failure must NOT assert that no branch or commit exists');
assert.ok(recoveryBody.includes('may already exist on the'), 'it must warn a candidate may exist remotely');
assert.ok(recoveryBody.includes('Do not rerun the repair before inspecting'), 'it must warn against a blind rerun');
assert.ok(recoveryBody.includes('Candidate abc is already pushed'), 'it must carry the adapter recovery detail');
assert.ok(recoveryBody.includes('`main` was'), 'it must still state that main is untouched');
// The recurrence comment carries the same warning when applicable.
const recoveryComment = buildRecurrenceComment(
  { ...otherCommitContext, log: 'PHASE2B_POST_COMMIT_RECOVERY: Candidate def was committed locally but not safely published.' },
  { repository: 'o/r' },
);
assert.ok(recoveryComment.includes('Inspect before rerunning.'));
assert.ok(!buildRecurrenceComment(otherCommitContext, { repository: 'o/r' }).includes('Inspect before rerunning.'));

// The signal mutates no public content: it never names a generated surface,
// a canonical record file, a branch or a pull request.
for (const token of ['index.html', 'data/things-to-do-events.json', 'feature/phase2b-currentness-', 'pull/']) {
  assert(!issueBody.includes(token), `the failure signal must not reference ${token}`);
}

// 7-repeat. DUPLICATE SUPPRESSION for the signal: the same class on a commit
// already recorded does nothing at all.
const openIssue = { number: 7, url: 'https://github.com/o/r/issues/7', body: issueBody, comments: [] };
assert.equal(decideFailureSignal({ issue: openIssue, context: failContext }).action, 'NONE');
assert.equal(decideFailureSignal({ issue: openIssue, context: { ...failContext, runId: '9999', runAttempt: '3' } }).action, 'NONE',
  'a retry of the same failure on the same commit must not add anything');

// A new failing commit adds exactly one comment, then suppresses further ones.
const recurrence = decideFailureSignal({ issue: openIssue, context: otherCommitContext });
assert.equal(recurrence.action, 'COMMENT');
const comment = buildRecurrenceComment(otherCommitContext, { repository: 'o/r' });
assert(comment.includes(OTHER_SHA));
const updatedIssue = { ...openIssue, comments: [comment] };
assert.equal(decideFailureSignal({ issue: updatedIssue, context: otherCommitContext }).action, 'NONE');
assert.deepEqual(recordedCommits(updatedIssue), [SHA, OTHER_SHA].sort());
// A different failure class is a different signal, so it opens its own issue.
const otherClass = decideFailureSignal({ issue: null, context: { ...failContext, log: 'PHASE2B_MAIN_MOVED' } });
assert.equal(otherClass.action, 'CREATE');
assert.notEqual(otherClass.key, failKey);

// Context that cannot be read is refused rather than guessed at.
assert.throws(() => decideFailureSignal({ context: { ...failContext, commit: 'short' } }), /FAILURE_COMMIT_UNREADABLE/);
assert.throws(() => decideFailureSignal({ context: { ...failContext, runId: null } }), /FAILURE_RUN_CONTEXT_UNREADABLE/);

// The open-issue probe is dedupe authority, so it is fail-closed exactly like
// the branch and pull-request probes: a probe that did not demonstrably succeed
// must never read as "no issue exists".
const issueProbe = (overrides) => ({ status: 0, stdout: '[]', stderr: '', ...overrides });
assert.equal(parseOpenFailureIssueProbe(issueProbe({}), { key: failKey }), null);
assert.throws(() => parseOpenFailureIssueProbe(issueProbe({ status: 1, stderr: 'gh: HTTP 502' }), { key: failKey }), /FAILURE_SIGNAL_PROBE_FAILED/);
assert.throws(() => parseOpenFailureIssueProbe(issueProbe({ status: null, stderr: 'spawn ENOENT' }), { key: failKey }), /FAILURE_SIGNAL_PROBE_FAILED/);
assert.throws(() => parseOpenFailureIssueProbe(undefined, { key: failKey }), /FAILURE_SIGNAL_PROBE_FAILED/);
assert.throws(() => parseOpenFailureIssueProbe(issueProbe({ stdout: 'not json' }), { key: failKey }), /FAILURE_SIGNAL_PROBE_UNREADABLE/);
assert.throws(() => parseOpenFailureIssueProbe(issueProbe({ stdout: '{}' }), { key: failKey }), /FAILURE_SIGNAL_PROBE_UNREADABLE/);
// An issue carrying another class's marker is not this signal.
assert.equal(
  parseOpenFailureIssueProbe(issueProbe({ stdout: JSON.stringify([{ number: 3, url: 'u', body: keyMarker(otherClass.key), comments: [] }]) }), { key: failKey }),
  null,
);
const found = parseOpenFailureIssueProbe(
  issueProbe({ stdout: JSON.stringify([{ number: 7, url: 'https://github.com/o/r/issues/7', body: issueBody, comments: [{ body: comment }] }]) }),
  { key: failKey },
);
assert.equal(found.number, 7);
assert.deepEqual(found.comments, [comment]);
assert.deepEqual(recordedCommits(found), [SHA, OTHER_SHA].sort());
assert.throws(() => parseOpenFailureIssueProbe(
  issueProbe({ stdout: JSON.stringify([{ number: 7, url: 'u', body: issueBody, comments: [] }, { number: 8, url: 'u2', body: issueBody, comments: [] }]) }),
  { key: failKey },
), /FAILURE_SIGNAL_AMBIGUOUS/);
assert.throws(() => parseOpenFailureIssueProbe(
  issueProbe({ stdout: JSON.stringify([{ url: 'u', body: issueBody, comments: [] }]) }), { key: failKey },
), /FAILURE_SIGNAL_PROBE_UNREADABLE/);
assert.throws(() => parseOpenFailureIssueProbe(issueProbe({}), {}), /FAILURE_SIGNAL_KEY_REQUIRED/);
// `gh issue list --limit N` caps how many issues are FETCHED, so a full page is
// not proof that no older issue carries this marker. A truncated result is
// refused rather than read as absence, which is how a duplicate would be born.
const filler = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: i + 1, url: `u${i}`, body: 'unrelated', comments: [] })));
assert.throws(() => parseOpenFailureIssueProbe(issueProbe({ stdout: filler(100) }), { key: failKey, limit: 100 }), /FAILURE_SIGNAL_PROBE_TRUNCATED/);
assert.equal(parseOpenFailureIssueProbe(issueProbe({ stdout: filler(99) }), { key: failKey, limit: 100 }), null);

// 10. HEALTHY RUN — the signal is reachable only from the workflow's
// `if: failure()` step, so a green run cannot produce a notification. Proved on
// the workflow source, since that gate is the mechanism.
const remediationWorkflow = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'phase-2b-things-to-do-currentness.yml'),
  'utf8',
);
assert.ok(remediationWorkflow.includes('report-phase2b-failure.mjs'), 'the workflow must invoke the failure signal');
const signalStep = remediationWorkflow.slice(remediationWorkflow.indexOf('Record durable Phase 2B failure signal'));
assert.ok(signalStep.includes('if: failure()'), 'the failure signal must be gated on failure()');
assert.ok(
  signalStep.indexOf('if: failure()') < signalStep.indexOf('report-phase2b-failure.mjs'),
  'the failure gate must precede the signal invocation',
);
// The gate is the ONLY way in: nothing else in the workflow runs it.
assert.equal(remediationWorkflow.split('report-phase2b-failure.mjs').length - 1, 1);
// Issue text is the whole of the added authority.
assert.ok(remediationWorkflow.includes('issues: write'));
for (const forbidden of ['pages: write', 'deployments: write', 'packages: write', 'id-token: write']) {
  assert.ok(!remediationWorkflow.includes(forbidden), `the workflow must not take ${forbidden}`);
}
const signalSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'report-phase2b-failure.mjs'),
  'utf8',
);
// The signal reporter touches issues only — no git, no branch, no pull request.
assert.ok(!/spawnSync\('git'/.test(signalSource) && !signalSource.includes("'git',"), 'the failure signal must not run git');
for (const forbidden of ['pr', 'push', 'merge']) {
  assert.ok(!signalSource.includes(`'${forbidden}',`), `the failure signal must not invoke gh ${forbidden}`);
}
assert.ok(!/writeFileSync/.test(signalSource), 'the failure signal must not write repository files');
// The reporter must pass its own probe limit through, or the guard is inert.
assert.ok(/limit: PROBE_LIMIT/.test(signalSource), 'the reporter must hand its probe limit to the parser');
assert.ok(/'--limit', String\(PROBE_LIMIT\)/.test(signalSource), 'the reporter must use one limit for gh and the parser');

console.log('Phase 2B currentness remediation unit tests passed.');
