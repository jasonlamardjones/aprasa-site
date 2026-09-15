// Provider-neutral control-plane task-result records.
//
// A task result persists exactly one of five outcomes that stop autonomous
// progression: NEEDS_EVIDENCE_VERIFICATION, NEEDS_PROJECT_03_DECISION,
// TECHNICAL_VALIDATION_FAILED, REVIEW_PASSED, REVIEW_FAILED. It never grants
// publication, merge, or deploy authority (grants_publication_authority is a
// schema const false), and it is content-addressed: result_id is the SHA-256
// digest of the record with result_id itself removed, so identical content
// always resolves to the same id and the same persistence path.
//
// The repository carries no JSON Schema library, so structural validation is
// a small hand-rolled subset (matching the existing duplicated validator in
// scripts/validate-control-plane-contracts.mjs and
// scripts/validate-orchestration-contract.mjs). Cross-field invariants — the
// fixed status/owner/resume_point/reviewer shape for each result_type — are
// not expressible in that subset (no if/then/else, no allOf) and are checked
// separately here, the same split the policy validator already uses for the
// Things-to-Do policy document.

import fs from 'node:fs';
import path from 'node:path';
import { assertNoDangerousKeys, canonicalize, digest } from './ttd-canonical-json.mjs';

export const RESULT_TYPES = Object.freeze([
  'NEEDS_EVIDENCE_VERIFICATION',
  'NEEDS_PROJECT_03_DECISION',
  'TECHNICAL_VALIDATION_FAILED',
  'REVIEW_PASSED',
  'REVIEW_FAILED'
]);

// The fixed mapping from result_type to status/owner/resume_point and whether
// a reviewer is required. This is the single source of truth for both
// construction (buildResult) and verification (semanticInvariantErrors); nothing
// downstream may override it per instance.
const RESULT_TYPE_INVARIANTS = Object.freeze({
  NEEDS_EVIDENCE_VERIFICATION: {
    status: 'HOLD',
    owner: 'EVIDENCE_VERIFIER',
    resume_point: { next_role: 'EVIDENCE_VERIFIER', next_status: 'HOLD' },
    reviewer_required: false
  },
  NEEDS_PROJECT_03_DECISION: {
    status: 'ESCALATED',
    owner: 'PROJECT_03',
    resume_point: { next_role: 'HUMAN_ESCALATION', next_status: 'ESCALATED' },
    reviewer_required: false
  },
  TECHNICAL_VALIDATION_FAILED: {
    status: 'BLOCKED',
    owner: 'PROJECT_04',
    resume_point: { next_role: 'PUBLICATION_WRITER', next_status: 'BLOCKED' },
    reviewer_required: false
  },
  // REVIEW_PASSED has no automatic resume_point: merge/deploy authority is
  // founder-only and is deliberately never expressed as an automatic route,
  // matching the task-envelope convention that a null route means "no
  // automatic downstream route for that outcome" rather than "unspecified".
  REVIEW_PASSED: {
    status: 'REVIEWED',
    owner: 'INDEPENDENT_REVIEWER',
    resume_point: null,
    reviewer_required: true
  },
  REVIEW_FAILED: {
    status: 'BLOCKED',
    owner: 'INDEPENDENT_REVIEWER',
    resume_point: { next_role: 'PUBLICATION_WRITER', next_status: 'HOLD' },
    reviewer_required: true
  }
});

export function invariantsFor(resultType) {
  const invariants = RESULT_TYPE_INVARIANTS[resultType];
  if (!invariants) throw new Error(`unknown result_type ${resultType}`);
  return invariants;
}

const RESULTS_DIR = path.join('automation', 'control-plane', 'results');
const SCHEMA_PATH = path.join('automation', 'control-plane', 'task-result.schema.json');

export function resultsDir(root = process.cwd()) {
  return path.join(root, RESULTS_DIR);
}

export function loadResultSchema(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, SCHEMA_PATH), 'utf8'));
}

// --- Structural (JSON Schema subset) validator ---------------------------
// Deliberately the same subset as the existing control-plane/orchestration
// validators: $ref, oneOf, const, enum, type, minLength, pattern, format
// (uri/date-time), minItems, uniqueItems, items, minProperties, required,
// properties, additionalProperties. No if/then/else, allOf, or not.

function resolveRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported external $ref ${ref}`);
  return ref.slice(2).split('/').reduce((node, part) => node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], rootSchema);
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

export function validateAgainstSchema(value, schema, rootSchema = schema, at = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return [`${at}: invalid schema node`];

  if (schema.$ref) {
    const target = resolveRef(rootSchema, schema.$ref);
    if (!target) return [`${at}: unresolved $ref ${schema.$ref}`];
    return validateAgainstSchema(value, target, rootSchema, at);
  }

  if (schema.oneOf) {
    const branches = schema.oneOf.map((branch) => validateAgainstSchema(value, branch, rootSchema, at));
    const passing = branches.filter((branchErrors) => branchErrors.length === 0).length;
    if (passing !== 1) errors.push(`${at}: must match exactly one oneOf branch; matched ${passing}`);
    return errors;
  }

  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${at}: must equal const ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${at}: value ${JSON.stringify(value)} not in enum`);
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${at}: expected type ${types.join('|')}`);
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: string shorter than minLength ${schema.minLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${at}: does not match pattern ${schema.pattern}`);
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${at}: invalid date-time`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateAgainstSchema(item, schema.items, rootSchema, `${at}[${index}]`)));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${at}: fewer than ${schema.minProperties} properties`);
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) errors.push(`${at}: missing required property ${required}`);
    }
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) errors.push(...validateAgainstSchema(child, properties[key], rootSchema, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`);
    }
  }

  return errors;
}

// --- Semantic invariants (cross-field, not expressible in the schema) -----

function deepEqualPlain(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function semanticInvariantErrors(record) {
  const errors = [];
  const invariants = RESULT_TYPE_INVARIANTS[record?.result_type];
  if (!invariants) {
    errors.push(`result_type ${JSON.stringify(record?.result_type)} has no known invariants`);
    return errors;
  }
  if (record.status !== invariants.status) {
    errors.push(`status must be ${invariants.status} for ${record.result_type}, got ${JSON.stringify(record.status)}`);
  }
  if (record.owner !== invariants.owner) {
    errors.push(`owner must be ${invariants.owner} for ${record.result_type}, got ${JSON.stringify(record.owner)}`);
  }
  if (!deepEqualPlain(record.resume_point, invariants.resume_point)) {
    errors.push(`resume_point must be ${JSON.stringify(invariants.resume_point)} for ${record.result_type}, got ${JSON.stringify(record.resume_point)}`);
  }
  const reviewerPresent = record.reviewer !== null && typeof record.reviewer === 'object';
  if (invariants.reviewer_required && !reviewerPresent) {
    errors.push(`reviewer is required for ${record.result_type}`);
  }
  if (!invariants.reviewer_required && record.reviewer !== null) {
    errors.push(`reviewer must be null for ${record.result_type}`);
  }
  if (record.grants_publication_authority !== false) {
    errors.push('grants_publication_authority must be false');
  }
  if (record.task_ref?.task_id === null && record.task_ref?.candidate_id === null) {
    errors.push('task_ref must carry at least one of task_id or candidate_id');
  }
  return errors;
}

export function validateResult(record, { root = process.cwd() } = {}) {
  const errors = [];
  try {
    assertNoDangerousKeys(record, '$record');
  } catch (error) {
    return [error.message];
  }
  const schema = loadResultSchema(root);
  errors.push(...validateAgainstSchema(record, schema));
  if (errors.length > 0) return errors; // shape must hold before semantic checks are meaningful
  errors.push(...semanticInvariantErrors(record));
  const recomputed = computeResultId(record);
  if (recomputed !== record.result_id) {
    errors.push(`result_id ${record.result_id} does not match recomputed content digest ${recomputed}`);
  }
  return errors;
}

// --- Content addressing ----------------------------------------------------

export function computeResultId(record) {
  const { result_id, ...rest } = record;
  return digest(rest);
}

/**
 * Builds a complete, internally-consistent result record from the caller's
 * intent. The caller supplies only what genuinely varies per instance;
 * status/owner/resume_point are always taken from RESULT_TYPE_INVARIANTS, so
 * a caller cannot construct an inconsistent record.
 */
export function buildResult({
  resultType,
  taskId = null,
  candidateId = null,
  repositorySha,
  repositoryRef = null,
  reason,
  requiredInput,
  reasonCode = null,
  evidenceDigest,
  reviewer = null,
  upstreamRefs,
  createdAt = new Date().toISOString()
}) {
  const invariants = invariantsFor(resultType);
  if (taskId === null && candidateId === null) {
    throw new Error('buildResult requires at least one of taskId or candidateId');
  }
  if (!/^[a-f0-9]{40}$/.test(repositorySha ?? '')) {
    throw new Error('buildResult requires a 40-character lowercase hex repository sha');
  }
  if (!/^[a-f0-9]{64}$/.test(evidenceDigest ?? '')) {
    throw new Error('buildResult requires a 64-character lowercase hex evidence digest');
  }
  if (!Array.isArray(upstreamRefs) || upstreamRefs.length === 0) {
    throw new Error('buildResult requires at least one upstream_refs entry');
  }
  if (invariants.reviewer_required && (reviewer === null || typeof reviewer !== 'object')) {
    throw new Error(`buildResult requires a reviewer for ${resultType}`);
  }
  if (!invariants.reviewer_required && reviewer !== null) {
    throw new Error(`buildResult must not receive a reviewer for ${resultType}`);
  }

  const draft = {
    schema_version: '1.0.0',
    result_id: '0'.repeat(64), // placeholder; replaced below once content is final
    result_type: resultType,
    status: invariants.status,
    task_ref: { task_id: taskId, candidate_id: candidateId },
    repository: { sha: repositorySha, ref: repositoryRef },
    owner: invariants.owner,
    reason,
    ...(reasonCode !== null ? { reason_code: reasonCode } : {}),
    required_input: requiredInput,
    resume_point: invariants.resume_point,
    evidence_digest: evidenceDigest,
    reviewer,
    upstream_refs: upstreamRefs,
    grants_publication_authority: false,
    created_at: createdAt
  };
  draft.result_id = computeResultId(draft);
  return draft;
}

export function resultPath(root, record) {
  return path.join(resultsDir(root), `${record.result_id}.json`);
}

/**
 * Persists a result as a content-addressed file. Writing the same content
 * twice is a no-op (same digest, same path, identical bytes). Writing
 * different content that happens to collide on result_id is refused —
 * refused rather than silently overwritten, per the fail-closed rule this
 * repository applies everywhere else content addressing is used.
 */
export function writeResult(root, record) {
  const errors = validateResult(record, { root });
  if (errors.length > 0) throw new Error(`INVALID_TASK_RESULT: ${errors.join('; ')}`);
  const target = resultPath(root, record);
  const canonical = `${canonicalize(record)}\n`;
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8');
    if (existing.trim() !== canonical.trim()) {
      throw new Error(`TASK_RESULT_ID_COLLISION: ${record.result_id} already exists with different content`);
    }
    return { path: target, written: false };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, canonical);
  return { path: target, written: true };
}

export function readResult(root, resultId) {
  const target = path.join(resultsDir(root), `${resultId}.json`);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

/**
 * A REVIEW_PASSED or REVIEW_FAILED result is bound to the exact repository
 * SHA it was produced against. If the candidate's current head SHA differs,
 * the review no longer speaks to what exists now and must be treated as
 * stale/invalid — the caller must obtain a fresh review rather than trust an
 * old one across new commits. Non-review result types are informational
 * about provenance only and are not invalidated by this check.
 */
export function isResultCurrent(record, actualSha) {
  const reviewTypes = new Set(['REVIEW_PASSED', 'REVIEW_FAILED']);
  if (!reviewTypes.has(record.result_type)) return true;
  return record.repository.sha === actualSha;
}
