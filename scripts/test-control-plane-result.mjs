// Acceptance + adversarial regression suite for provider-neutral control-plane
// task-result records: construction, schema/semantic validation, content
// addressing, persistence, and exact-SHA staleness for review outcomes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './lib/ttd-test-harness.mjs';
import {
  buildResult,
  computeResultId,
  isResultCurrent,
  RESULT_TYPES,
  resultPath,
  validateResult,
  writeResult
} from './lib/control-plane-result.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harness = createHarness('CONTROL_PLANE_RESULT');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DIGEST_A = 'a'.repeat(64);

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

// --- Persistence: content-addressed, idempotent, collision-refusing -------

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-result-test-'));
try {
  fs.mkdirSync(path.join(sandbox, 'automation', 'control-plane'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'automation', 'control-plane', 'task-result.schema.json'),
    path.join(sandbox, 'automation', 'control-plane', 'task-result.schema.json')
  );

  const record = buildResult({ resultType: 'NEEDS_EVIDENCE_VERIFICATION', ...baseFields() });
  const expectedPath = resultPath(sandbox, record);

  const first = writeResult(sandbox, record);
  harness.equal('first write reports written:true', first.written, true);
  harness.ok('first write lands at the content-addressed path', first.path === expectedPath);
  harness.ok('the file now exists on disk', fs.existsSync(expectedPath));

  const second = writeResult(sandbox, record);
  harness.equal('re-writing identical content is idempotent (written:false)', second.written, false);

  fs.writeFileSync(expectedPath, JSON.stringify({ ...record, reason: 'corrupted on disk' }, null, 2));
  harness.throws('writing different content at the same content-addressed path is refused',
    () => writeResult(sandbox, record));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

// --- Committed example fixtures: one per result_type, must stay valid ------

const exampleDir = path.join(ROOT, 'automation', 'control-plane', 'fixtures', 'task-result-examples');
const exampleFiles = fs.readdirSync(exampleDir).filter((name) => name.endsWith('.json'));
harness.equal('one committed example fixture exists per result_type', exampleFiles.length, RESULT_TYPES.length);
for (const file of exampleFiles) {
  const record = JSON.parse(fs.readFileSync(path.join(exampleDir, file), 'utf8'));
  harness.equal(`fixture ${file}: validates cleanly`, validateResult(record, { root: ROOT }), []);
}

harness.finish([`result_types=${RESULT_TYPES.length}`, `example_fixtures=${exampleFiles.length}`]);
