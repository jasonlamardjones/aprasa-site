import crypto from 'node:crypto';
import { THINGS_TO_DO_HUB_PUBLIC, homePreviewIds, hubOutputPath } from '../../lib/things-to-do-collection.mjs';
import { currentnessState } from '../../lib/things-to-do-currentness.mjs';

export const PHASE2B_CONTRACT = Object.freeze({
  reportSchema: 'aprasa-post-publication-qa-report',
  reportVersion: '1.1.0',
  domain: 'SOURCE_VALIDATION',
  code: 'SOURCE_CURRENTNESS_DRIFT',
  validatorId: 'things_to_do_currentness',
  environment: 'production',
  baseUrl: 'https://aprasa.org',
  maxReportAgeMs: 24 * 60 * 60 * 1000,
});

function requireString(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`PHASE2B_INVALID_${name.toUpperCase()}`);
  return value;
}

export function capeVerdeDate(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error('PHASE2B_INVALID_REPORT_TIME');
  // Cabo Verde is UTC-1 year-round. Convert the instant to the local calendar
  // date without depending on runner locale or host timezone configuration.
  return new Date(ms - 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function parseObservedDriftIds(observed) {
  if (typeof observed !== 'string') return [];
  const ids = [];
  for (const line of observed.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+([a-z0-9]+(?:-[a-z0-9]+)*):\s/);
    if (match) ids.push(match[1]);
  }
  return [...new Set(ids)].sort();
}

export function parseValidatorDriftIds(stderr) {
  if (typeof stderr !== 'string') return [];
  const ids = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+([a-z0-9]+(?:-[a-z0-9]+)*):\s/);
    if (match) ids.push(match[1]);
  }
  return [...new Set(ids)].sort();
}

function authorizedIssue(issue) {
  return issue?.domain === PHASE2B_CONTRACT.domain
    && issue?.code === PHASE2B_CONTRACT.code
    && issue?.validator_id === PHASE2B_CONTRACT.validatorId
    && issue?.deterministic === true
    && issue?.auto_remediation_candidate === true;
}

export function authorizeReport(report, {
  now = new Date(),
  remoteMainSha = null,
} = {}) {
  if (report?.schema !== PHASE2B_CONTRACT.reportSchema) throw new Error('PHASE2B_UNSUPPORTED_REPORT_SCHEMA');
  if (report?.version !== PHASE2B_CONTRACT.reportVersion) throw new Error('PHASE2B_UNSUPPORTED_REPORT_VERSION');
  if (report?.target?.environment !== PHASE2B_CONTRACT.environment) throw new Error('PHASE2B_NON_PRODUCTION_REPORT');
  if (report?.target?.base_url !== PHASE2B_CONTRACT.baseUrl) throw new Error('PHASE2B_WRONG_BASE_URL');
  if (report?.target?.deployment_state !== 'DEPLOYMENT_VERIFIED') throw new Error('PHASE2B_DEPLOYMENT_NOT_VERIFIED');

  const expectedMain = requireString(report?.target?.expected_main_sha, 'expected_main_sha');
  const observedDeployment = requireString(report?.target?.observed_deployment_sha, 'observed_deployment_sha');
  if (!/^[a-f0-9]{40}$/.test(expectedMain) || !/^[a-f0-9]{40}$/.test(observedDeployment)) {
    throw new Error('PHASE2B_INVALID_PROVENANCE_SHA');
  }
  if (expectedMain !== observedDeployment) throw new Error('PHASE2B_DEPLOYMENT_SHA_MISMATCH');
  if (remoteMainSha !== null && expectedMain !== remoteMainSha) throw new Error('PHASE2B_MAIN_MOVED');

  const deploymentEvidence = report.target.deployment_evidence ?? {};
  if (deploymentEvidence.latest_status_state !== 'success') throw new Error('PHASE2B_DEPLOYMENT_STATUS_NOT_SUCCESS');
  if (deploymentEvidence.live_home_matches_checked_out_bytes !== true) {
    throw new Error('PHASE2B_LIVE_PROVENANCE_NOT_BYTE_VERIFIED');
  }

  const completedMs = Date.parse(report?.completed_at);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(completedMs) || !Number.isFinite(nowMs)) throw new Error('PHASE2B_INVALID_REPORT_TIME');
  const ageMs = nowMs - completedMs;
  if (ageMs < -5 * 60 * 1000) throw new Error('PHASE2B_REPORT_FROM_FUTURE');
  if (ageMs > PHASE2B_CONTRACT.maxReportAgeMs) throw new Error('PHASE2B_STALE_REPORT');

  const issues = Array.isArray(report.issues) ? report.issues : [];
  const relevantIdentityIssues = issues.filter((issue) =>
    issue?.domain === PHASE2B_CONTRACT.domain
      && issue?.code === PHASE2B_CONTRACT.code
      && issue?.validator_id === PHASE2B_CONTRACT.validatorId);
  for (const issue of relevantIdentityIssues) {
    if (issue.deterministic !== true) throw new Error('PHASE2B_NON_DETERMINISTIC_FINDING_REFUSED');
    if (issue.auto_remediation_candidate !== true) throw new Error('PHASE2B_AUTO_REMEDIATION_NOT_AUTHORIZED');
  }

  const candidates = issues.filter(authorizedIssue);
  const misroutedOrUnauthorizedSourceCandidates = issues.filter((issue) =>
    issue?.auto_remediation_candidate === true
      && !authorizedIssue(issue)
      && (issue?.domain === PHASE2B_CONTRACT.domain
        || issue?.code === PHASE2B_CONTRACT.code
        || issue?.validator_id === PHASE2B_CONTRACT.validatorId));
  if (misroutedOrUnauthorizedSourceCandidates.length) throw new Error('PHASE2B_UNAUTHORIZED_AUTO_REMEDIATION_FINDING');
  if (candidates.length === 0) return Object.freeze({ status: 'NO_AUTHORIZED_FINDING' });
  if (candidates.length !== 1) throw new Error('PHASE2B_AMBIGUOUS_AUTHORIZED_FINDINGS');

  const finding = candidates[0];
  const reportedIds = parseObservedDriftIds(finding.observed);
  if (!reportedIds.length) throw new Error('PHASE2B_REPORTED_DRIFT_SHAPE_UNREADABLE');

  // Phase 2A can emit live-HTTP corroboration for the same source drift. Those
  // findings never authorize mutation independently, but they also should not
  // make a valid source-authorized repair ambiguous. Permit only the incumbent
  // TTD_CURRENTNESS_DRIFT shape and require its record IDs to be an exact subset
  // of the source validator's reported IDs. Any other auto-remediation metadata
  // remains fail-closed.
  const nonSourceAuto = issues.filter((issue) => issue?.domain !== PHASE2B_CONTRACT.domain && issue?.auto_remediation_candidate === true);
  const corroboratingIds = [];
  for (const issue of nonSourceAuto) {
    if (issue.domain !== 'LIVE_HTTP_VALIDATION' || issue.code !== 'TTD_CURRENTNESS_DRIFT'
      || issue.deterministic !== true || issue.route !== '/' || issue.locale !== 'en') {
      throw new Error('PHASE2B_UNAUTHORIZED_AUTO_REMEDIATION_FINDING');
    }
    const match = typeof issue.observed === 'string'
      ? issue.observed.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)\s/)
      : null;
    if (!match || !reportedIds.includes(match[1])) throw new Error('PHASE2B_CORROBORATION_SHAPE_MISMATCH');
    corroboratingIds.push(match[1]);
  }
  if (corroboratingIds.length && JSON.stringify([...new Set(corroboratingIds)].sort()) !== JSON.stringify(reportedIds)) {
    throw new Error('PHASE2B_CORROBORATION_SHAPE_MISMATCH');
  }

  const blockers = issues.filter((issue) => ['ERROR', 'CRITICAL'].includes(issue?.severity));
  if (blockers.length) throw new Error('PHASE2B_UNRELATED_BLOCKER_PRESENT');

  const asOf = capeVerdeDate(report.started_at);
  const repairIdentity = crypto.createHash('sha256')
    .update(`phase2b:${PHASE2B_CONTRACT.validatorId}:${asOf}:${expectedMain}`)
    .digest('hex');
  const branch = `feature/phase2b-currentness-${asOf}-${repairIdentity.slice(0, 10)}`;

  return Object.freeze({
    status: 'AUTHORIZED',
    finding,
    expectedMain,
    observedDeployment,
    asOf,
    reportedIds,
    repairIdentity,
    branch,
    reportRunId: report?.run?.run_id ?? null,
    reportRunAttempt: report?.run?.run_attempt ?? null,
    completedAt: report.completed_at,
  });
}

export function assertWorkflowArtifactProvenance(auth, { runId, runAttempt, headSha }) {
  if (!runId || String(auth.reportRunId) !== String(runId)) throw new Error('PHASE2B_WORKFLOW_RUN_ID_MISMATCH');
  if (!runAttempt || String(auth.reportRunAttempt) !== String(runAttempt)) throw new Error('PHASE2B_WORKFLOW_RUN_ATTEMPT_MISMATCH');
  if (!/^[a-f0-9]{40}$/.test(headSha ?? '') || auth.expectedMain !== headSha) {
    throw new Error('PHASE2B_WORKFLOW_HEAD_SHA_MISMATCH');
  }
}

export function assertDriftShapeUnchanged(reportedIds, currentIds) {
  const a = [...reportedIds].sort();
  const b = [...currentIds].sort();
  if (!b.length) throw new Error('PHASE2B_DRIFT_DISAPPEARED');
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`PHASE2B_DRIFT_CHANGED_SHAPE: reported=[${a.join(',')}] current=[${b.join(',')}]`);
  }
}

// --- Derived bounded write set -------------------------------------------
//
// The allowed write set is DERIVED from the lifecycle transition this repair
// represents, never from a remembered file count. The Eclipse audit case
// happened to settle on five files; that was a property of that one
// transition, not the contract.
//
// Authority is split, because the two kinds of surface are reached by
// different things:
//
//   HOME (index.html, pt/index.html) is reached by a CHANGE in preview
//   membership. An expiry inside the three-card preview promotes the next
//   eligible record, and the promoted record's Home slot must be backfilled —
//   the exact case drift-id-only generation could not cover. File-level
//   permission is not enough here: canonical generation rewrites both Home
//   files in full, so a Home file that had drifted outside its
//   generated-event regions would have that unrelated correction admitted by a
//   file-level check alone. Home is therefore additionally bounded at REGION
//   level by assertHomeRegionChangeBounded() below: content outside the
//   generated-event regions must not move at all, and the only regions that
//   may move are the drift IDs plus the records that ENTER or LEAVE the
//   preview. A record retained on both sides is excluded, because
//   renderHomeArticle() reads only its canonical record and so cannot change
//   for a lifecycle reason — see homeRegionAuthorizedIds().
//
//   DETAIL PAGES are reached by a record's OWN rendered currentness state,
//   which is what their markup depends on. Preview membership is a Home-only
//   concept — a promoted record normally stays CURRENT across the transition
//   and has no lifecycle-driven detail change — so admitting a detail page
//   merely for entering or leaving the preview would let unrelated drift in
//   that record's page ride along. Detail authority is therefore limited to
//   records whose state actually moves: the reported drift IDs, plus any
//   record whose currentnessState() differs between the two dates. Drift IDs
//   are unioned in rather than derived, because a record already EXPIRED at
//   the tracked as_of has no state CHANGE and is still exactly what needs
//   regenerating.
//
// Generator-owned shared surfaces are admitted only where the transition can
// actually reach them:
//
//   data/things-to-do-currentness.json  the as_of the repair advances.
//   the collection hub, both locales    a whole-collection currentness
//                                       projection — admitted ONLY while
//                                       THINGS_TO_DO_HUB_PUBLIC, since a
//                                       dormant hub is not written at all.
//
// sitemap.xml is deliberately NOT admitted. It is derived from record
// existence, not from currentness, so a lifecycle transition cannot move it;
// if it moves, that is unrelated repository drift and must fail closed.
// Likewise every other file canonical generation touches (locale data, the
// remaining derived PT pages, Mindelo Essentials): reachable by the builders,
// unreachable by this transition, therefore refused.

/**
 * What a currentness transition moves: Home preview membership either side,
 * and the records whose own rendered currentness state changes.
 */
export function resolvePreviewTransition({ records = [], fromAsOf, toAsOf } = {}) {
  if (typeof fromAsOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fromAsOf)) {
    throw new Error('PHASE2B_PREVIEW_BASELINE_AS_OF_UNREADABLE');
  }
  if (typeof toAsOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(toAsOf)) {
    throw new Error('PHASE2B_PREVIEW_TARGET_AS_OF_UNREADABLE');
  }
  const stateChangedIds = (records ?? [])
    .filter((record) => currentnessState(record, fromAsOf) !== currentnessState(record, toAsOf))
    .map((record) => record.id)
    .sort();
  return Object.freeze({
    previewBefore: [...homePreviewIds(records, fromAsOf)].sort(),
    previewAfter: [...homePreviewIds(records, toAsOf)].sort(),
    stateChangedIds,
  });
}

function assertReadableIds(ids, what) {
  for (const id of ids) {
    if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`PHASE2B_${what}_ID_UNREADABLE: ${String(id)}`);
    }
  }
  return ids;
}

/**
 * Records whose Home slot this transition may legitimately rewrite: the
 * reported drift IDs plus the SYMMETRIC DIFFERENCE of preview membership — the
 * records that enter or leave the preview — never the full union.
 *
 * renderHomeArticle(record, loc) takes no asOf and reads only record fields, so
 * a record's rendered Home slot is a pure function of its canonical record. A
 * record retained in the preview on BOTH sides therefore has no
 * lifecycle-driven reason for its slot to move, and admitting it would let
 * unrelated drift inside that slot ride along on a repair — the whole-collection
 * build rewrites every slot, so the correction would pass unnoticed.
 *
 * Drift IDs are unioned in because a drifted record may be outside the preview
 * on both sides (already expired at the tracked as_of) and still need its slot
 * emptied.
 */
export function homeRegionAuthorizedIds({ driftIds = [], previewBefore = [], previewAfter = [] } = {}) {
  const before = new Set(previewBefore);
  const after = new Set(previewAfter);
  const entered = [...after].filter((id) => !before.has(id));
  const left = [...before].filter((id) => !after.has(id));
  const ids = [...new Set([...driftIds, ...entered, ...left])].sort();
  if (!ids.length) throw new Error('PHASE2B_WRITE_SET_TRANSITION_EMPTY');
  return assertReadableIds(ids, 'WRITE_SET');
}

/** Records whose detail pages this transition may legitimately rewrite. */
export function detailAuthorizedIds({ driftIds = [], stateChangedIds = [] } = {}) {
  const ids = [...new Set([...driftIds, ...stateChangedIds])].sort();
  if (!ids.length) throw new Error('PHASE2B_WRITE_SET_TRANSITION_EMPTY');
  return assertReadableIds(ids, 'WRITE_SET');
}

export function expectedWriteSetForTransition({
  driftIds = [],
  previewBefore = [],
  previewAfter = [],
  stateChangedIds = [],
} = {}) {
  // Validates the Home side too, so an unreadable preview ID is refused even
  // though preview membership contributes no detail path of its own.
  homeRegionAuthorizedIds({ driftIds, previewBefore, previewAfter });
  const allowed = new Set([
    'data/things-to-do-currentness.json',
    'index.html',
    'pt/index.html',
  ]);
  if (THINGS_TO_DO_HUB_PUBLIC) {
    allowed.add(hubOutputPath('en'));
    allowed.add(hubOutputPath('pt'));
  }
  for (const id of detailAuthorizedIds({ driftIds, stateChangedIds })) {
    allowed.add(`things-to-do/${id}/index.html`);
    allowed.add(`pt/things-to-do/${id}/index.html`);
  }
  return [...allowed].sort();
}

// --- Home region containment ----------------------------------------------
//
// Home's generated-event regions are the ONLY part of a Home surface this
// repair has authority over. Everything else on the page — chrome, prose,
// hreflang, nav, the Home call to action — is hand-authored or owned by the
// static-page localizer, and canonical generation rewriting a whole Home file
// must not become a way to commit changes to it.

const GENERATED_EVENT_REGION = /<!-- BEGIN GENERATED EVENT: ([a-z0-9]+(?:-[a-z0-9]+)*) -->[\s\S]*?<!-- END GENERATED EVENT: \1 -->/g;

function regionMap(html) {
  const regions = new Map();
  for (const match of String(html ?? '').matchAll(GENERATED_EVENT_REGION)) {
    if (regions.has(match[1])) throw new Error(`PHASE2B_HOME_REGION_DUPLICATED: ${match[1]}`);
    regions.set(match[1], match[0]);
  }
  return regions;
}

function outsideRegions(html) {
  return String(html ?? '').replace(GENERATED_EVENT_REGION, '<!-- GENERATED EVENT REGION: $1 -->');
}

/**
 * Which generated-event regions moved between two Home revisions, and whether
 * anything outside them moved. Pure, so the containment rule is testable
 * without running a build.
 */
export function homeRegionChange(before, after) {
  const beforeRegions = regionMap(before);
  const afterRegions = regionMap(after);
  const ids = [...new Set([...beforeRegions.keys(), ...afterRegions.keys()])].sort();
  return Object.freeze({
    changedIds: ids.filter((id) => beforeRegions.get(id) !== afterRegions.get(id)),
    outsideChanged: outsideRegions(before) !== outsideRegions(after),
  });
}

export function assertHomeRegionChangeBounded(before, after, authorizedIds, label = 'index.html') {
  const { changedIds, outsideChanged } = homeRegionChange(before, after);
  if (outsideChanged) throw new Error(`PHASE2B_HOME_CHANGE_OUTSIDE_GENERATED_REGIONS: ${label}`);
  const allowed = new Set(authorizedIds);
  const unauthorized = changedIds.filter((id) => !allowed.has(id));
  if (unauthorized.length) {
    throw new Error(`PHASE2B_HOME_REGION_CHANGE_UNAUTHORIZED: ${label}: ${unauthorized.join(', ')}`);
  }
  return changedIds;
}

export function assertBoundedWriteSet(actualFiles, allowedFiles) {
  const actual = [...new Set(actualFiles)].sort();
  const allowed = new Set(allowedFiles);
  if (!actual.length) throw new Error('PHASE2B_EMPTY_REPAIR_DIFF');
  const unexpected = actual.filter((file) => !allowed.has(file));
  if (unexpected.length) throw new Error(`PHASE2B_UNEXPECTED_FILE_CHANGE: ${unexpected.join(', ')}`);
  if (!actual.includes('index.html')) throw new Error('PHASE2B_EN_HOME_NOT_REPAIRED');
  if (!actual.includes('pt/index.html')) throw new Error('PHASE2B_PT_HOME_NOT_REPAIRED');
  return actual;
}

export function assertValidatorResults(results) {
  const failed = results.filter((item) => item.status !== 0);
  if (failed.length) {
    throw new Error(`PHASE2B_INCUMBENT_VALIDATOR_FAILED: ${failed.map((item) => `${item.step} (exit ${item.status})`).join('; ')}`);
  }
}

export function assertIdempotentChanges(changes) {
  if (changes.length) throw new Error(`PHASE2B_NON_IDEMPOTENT_GENERATION: ${changes.join(', ')}`);
}

export function assertSchemaValidation(errors) {
  if (errors.length) throw new Error(`PHASE2B_MALFORMED_REPORT: ${errors.join('; ')}`);
}

const SHA_PATTERN = /^[a-f0-9]{40}$/;

function probeDetail(probe) {
  const detail = [probe?.stderr, probe?.stdout].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim();
  return detail ? `: ${detail.slice(0, 200)}` : '';
}

// Duplicate-state probes are dedupe authority, so a probe that did not
// demonstrably succeed must never be read as "nothing exists remotely".
export function parseRemoteBranchProbe(probe, branch) {
  const ref = `refs/heads/${requireString(branch, 'branch')}`;
  if (!probe || probe.status !== 0) {
    throw new Error(`PHASE2B_BRANCH_PROBE_FAILED: git ls-remote ${ref} exit ${probe?.status ?? 'unknown'}${probeDetail(probe)}`);
  }
  if (typeof probe.stdout !== 'string') throw new Error('PHASE2B_BRANCH_PROBE_UNREADABLE: no probe output');
  const lines = probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (lines.length > 1) throw new Error(`PHASE2B_BRANCH_PROBE_AMBIGUOUS: ${lines.length} records for ${ref}`);
  const fields = lines[0].split(/\s+/);
  if (fields.length !== 2) throw new Error(`PHASE2B_BRANCH_PROBE_UNREADABLE: ${lines[0]}`);
  const [sha, observedRef] = fields;
  if (!SHA_PATTERN.test(sha)) throw new Error(`PHASE2B_BRANCH_PROBE_UNREADABLE: ${lines[0]}`);
  if (observedRef !== ref) throw new Error(`PHASE2B_BRANCH_PROBE_REF_MISMATCH: expected ${ref}, observed ${observedRef}`);
  return sha;
}

// Same contract for the pull-request probe: only a successful command with a
// well-formed result may report "no open pull request".
export function parseOpenPrProbe(probe, { repository = null, branch = null } = {}) {
  const scope = `${repository ?? 'origin'}#${branch ?? 'unknown'}`;
  if (!probe || probe.status !== 0) {
    throw new Error(`PHASE2B_PR_PROBE_FAILED: gh pr list ${scope} exit ${probe?.status ?? 'unknown'}${probeDetail(probe)}`);
  }
  if (typeof probe.stdout !== 'string') throw new Error('PHASE2B_PR_PROBE_UNREADABLE: no probe output');
  let parsed;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    throw new Error(`PHASE2B_PR_PROBE_UNREADABLE: gh pr list ${scope} did not return JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`PHASE2B_PR_PROBE_UNREADABLE: expected a JSON array for ${scope}`);
  if (!parsed.length) return null;
  if (parsed.length > 1) throw new Error(`PHASE2B_PR_PROBE_AMBIGUOUS: ${parsed.length} open pull requests for ${scope}`);
  const record = parsed[0];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`PHASE2B_PR_PROBE_UNREADABLE: malformed pull-request record for ${scope}`);
  }
  if (typeof record.url !== 'string' || !record.url) throw new Error(`PHASE2B_PR_PROBE_UNREADABLE: missing url for ${scope}`);
  if (typeof record.isDraft !== 'boolean') throw new Error(`PHASE2B_PR_PROBE_UNREADABLE: missing isDraft for ${scope}`);
  if (typeof record.headRefOid !== 'string' || !SHA_PATTERN.test(record.headRefOid)) {
    throw new Error(`PHASE2B_PR_PROBE_UNREADABLE: missing headRefOid for ${scope}`);
  }
  return record;
}

export function assessDuplicateState({ remoteBranchSha = null, draftPr = null } = {}) {
  if (!remoteBranchSha && !draftPr) return 'CLEAR';
  if (remoteBranchSha && draftPr?.isDraft === true && draftPr?.headRefOid === remoteBranchSha) return 'EQUIVALENT_DRAFT_PR_EXISTS';
  if (remoteBranchSha && !draftPr) return 'ORPHAN_REMOTE_REPAIR_BRANCH';
  return 'AMBIGUOUS_DUPLICATE_STATE';
}
