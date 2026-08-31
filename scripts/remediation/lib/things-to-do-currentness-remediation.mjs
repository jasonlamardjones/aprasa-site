import crypto from 'node:crypto';

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

export function expectedWriteSetForIds(ids) {
  const allowed = new Set([
    'data/things-to-do-currentness.json',
    'index.html',
    'pt/index.html',
  ]);
  for (const id of ids) {
    allowed.add(`things-to-do/${id}/index.html`);
    allowed.add(`pt/things-to-do/${id}/index.html`);
  }
  return [...allowed].sort();
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

export function assessDuplicateState({ remoteBranchSha = null, draftPr = null } = {}) {
  if (!remoteBranchSha && !draftPr) return 'CLEAR';
  if (remoteBranchSha && draftPr?.isDraft === true && draftPr?.headRefOid === remoteBranchSha) return 'EQUIVALENT_DRAFT_PR_EXISTS';
  if (remoteBranchSha && !draftPr) return 'ORPHAN_REMOTE_REPAIR_BRANCH';
  return 'AMBIGUOUS_DUPLICATE_STATE';
}
