// Provider-neutral control-plane task-result records.
//
// A task result persists exactly one of five outcomes that stop autonomous
// progression: NEEDS_EVIDENCE_VERIFICATION, NEEDS_PROJECT_03_DECISION,
// TECHNICAL_VALIDATION_FAILED, REVIEW_PASSED, REVIEW_FAILED. It never grants
// publication, merge, or deploy authority (grants_publication_authority is a
// schema const false).
//
// Identity vs. occurrence metadata: result_id is the SHA-256 digest of the
// record with result_id AND created_at both removed. created_at is retained
// on every record as useful occurrence data, but it is deliberately excluded
// from identity — otherwise a retry of the same logical event (a CLI rerun
// after a transient failure, an idempotent re-adjudication) would mint a new
// result_id merely because wall-clock time advanced. Two records are "the
// same logical event" exactly when every other field is identical; if any
// governance-relevant field differs (reason, evidence_digest, reviewer,
// upstream_refs, ...) that is a genuinely new event and correctly gets a new
// identity. created_at is therefore not itself tamper-evident — the fields
// that gate any authority decision (repository.sha, evidence_digest) remain
// digest-protected, and the persisting git commit's own committer timestamp
// (see persistToRef below) supplies an independently tamper-evident
// occurrence record at the git-object layer.
//
// Persistence: a REVIEW_PASSED/REVIEW_FAILED record binds to an exact
// repository.sha and must not itself change that SHA by being committed onto
// the same branch it reviews. Every result type is therefore persisted onto
// a separate, dedicated git ref (default refs/heads/control-plane-task-results)
// via plumbing only (hash-object/read-tree/write-tree/commit-tree/update-ref)
// — the working tree, the index, and HEAD of whatever branch happens to be
// checked out are never touched, so persisting review evidence about a
// candidate can never move that candidate's own head.
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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertNoDangerousKeys, canonicalize, digest } from './ttd-canonical-json.mjs';

export const DEFAULT_RESULTS_REF = 'control-plane-task-results';

// The SHA-1 of an empty git tree. This is a universal git constant (the hash
// of zero entries under git's tree object format), identical in every git
// repository regardless of content or git version — not looked up, not
// created, just known. Used as the base tree when the results ref does not
// exist yet, so the very first write does not require special-casing.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const ZERO_SHA = '0'.repeat(40);
const RESULT_COMMIT_IDENTITY = Object.freeze({ name: 'A PRASA Control Plane', email: 'automation@aprasa.org' });

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
//
// Identity is computed over every field except result_id itself and
// created_at — see the module-level comment for why created_at is excluded.

export function computeResultId(record) {
  const { result_id, created_at, ...rest } = record;
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

export function resultRelativePath(record) {
  return `${RESULTS_DIR.split(path.sep).join('/')}/${record.result_id}.json`;
}

// --- Git plumbing helpers ---------------------------------------------------
// Every call here is pure object-database/ref plumbing: no working-tree file
// is written, read, or staged, the real index is never touched (a throwaway
// GIT_INDEX_FILE is used instead), and HEAD is never moved. This is what
// makes it safe to persist review evidence about a candidate without the act
// of persisting it changing that candidate's own SHA.

function git(root, args, { allowFailure = false, env = {}, input = undefined } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input
  });
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`git ${args.join(' ')} failed (${result.status})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function resolveRefTip(root, ref) {
  const probe = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], { allowFailure: true });
  const sha = probe.stdout.trim();
  return probe.status === 0 && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

function readBlobAtPath(root, treeIsh, relPath) {
  const probe = git(root, ['show', `${treeIsh}:${relPath}`], { allowFailure: true });
  return probe.status === 0 ? probe.stdout : null;
}

/**
 * Lists every result file recorded on a results ref, as {relPath} entries.
 * Returns [] when the ref does not exist yet (nothing has been persisted).
 */
export function listPersistedResults(root, { ref = DEFAULT_RESULTS_REF } = {}) {
  const tip = resolveRefTip(root, ref);
  if (tip === null) return [];
  const dirPrefix = RESULTS_DIR.split(path.sep).join('/');
  const probe = git(root, ['ls-tree', '-r', '--name-only', tip, '--', dirPrefix], { allowFailure: true });
  if (probe.status !== 0) return [];
  return probe.stdout.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.json'));
}

/**
 * Reads one persisted result by content-addressed id from a results ref.
 * Returns null if the ref or the file does not exist.
 */
export function readPersistedResult(root, resultId, { ref = DEFAULT_RESULTS_REF } = {}) {
  const tip = resolveRefTip(root, ref);
  if (tip === null) return null;
  const relPath = `${RESULTS_DIR.split(path.sep).join('/')}/${resultId}.json`;
  const content = readBlobAtPath(root, tip, relPath);
  return content === null ? null : JSON.parse(content);
}

/**
 * Persists a result onto a dedicated results ref via plumbing only — never
 * onto whatever branch happens to be checked out, and never touching the
 * working tree, the real index, or HEAD. This is what lets a REVIEW_PASSED /
 * REVIEW_FAILED record be committed durably without invalidating the exact
 * repository.sha it binds to: that SHA belongs to a different branch/ref
 * entirely, and this operation never writes to it.
 *
 * Writing the same logical result twice (same computeResultId, i.e. same
 * content once created_at is set aside) is a no-op: no new blob, tree, or
 * commit is created, and the originally-persisted created_at is preserved.
 * Writing different content that happened to collide on result_id — which
 * would require an actual SHA-256 collision, since result_id is itself that
 * content's digest — is refused rather than silently overwritten.
 */
export function writeResult(root, record, { ref = DEFAULT_RESULTS_REF } = {}) {
  const errors = validateResult(record, { root });
  if (errors.length > 0) throw new Error(`INVALID_TASK_RESULT: ${errors.join('; ')}`);

  const relPath = resultRelativePath(record);
  const canonical = `${canonicalize(record)}\n`;

  const oldTip = resolveRefTip(root, ref);
  const baseTree = oldTip !== null ? git(root, ['rev-parse', `${oldTip}^{tree}`]).stdout.trim() : EMPTY_TREE_SHA;

  const existing = readBlobAtPath(root, baseTree, relPath);
  if (existing !== null) {
    // The path is the result_id, which is itself a digest of every field
    // except created_at, so two records that land here already agree on
    // everything but possibly created_at — that is exactly the "same logical
    // event, replayed at a later instant" case, and must be a no-op that
    // keeps the originally-persisted created_at. Comparing full bytes here
    // (including created_at) would wrongly treat every retry as a collision.
    const existingRecord = JSON.parse(existing);
    const { created_at: existingCreatedAt, ...existingIdentity } = existingRecord;
    const { created_at: newCreatedAt, ...newIdentity } = record;
    if (canonicalize(existingIdentity) === canonicalize(newIdentity)) {
      return { written: false, ref, path: relPath, commit: oldTip };
    }
    throw new Error(`TASK_RESULT_ID_COLLISION: ${record.result_id} already exists on ${ref} with different content`);
  }

  const blobSha = git(root, ['hash-object', '-w', '--stdin'], { input: canonical }).stdout.trim();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-result-index-'));
  const tmpIndex = path.join(tmpDir, 'index');
  try {
    const indexEnv = { GIT_INDEX_FILE: tmpIndex };
    git(root, ['read-tree', baseTree], { env: indexEnv });
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${blobSha},${relPath}`], { env: indexEnv });
    const newTree = git(root, ['write-tree'], { env: indexEnv }).stdout.trim();

    const commitArgs = ['commit-tree', newTree];
    if (oldTip !== null) commitArgs.push('-p', oldTip);
    commitArgs.push('-m', `task-result ${record.result_type} ${record.result_id}`);
    const commitEnv = {
      GIT_AUTHOR_NAME: RESULT_COMMIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: RESULT_COMMIT_IDENTITY.email,
      GIT_COMMITTER_NAME: RESULT_COMMIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: RESULT_COMMIT_IDENTITY.email
    };
    const newCommit = git(root, commitArgs, { env: commitEnv }).stdout.trim();

    // Compare-and-swap: fails closed if something else moved the ref between
    // our read of oldTip and this update, rather than silently clobbering it.
    git(root, ['update-ref', `refs/heads/${ref}`, newCommit, oldTip ?? ZERO_SHA]);

    return { written: true, ref, path: relPath, commit: newCommit };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function readResult(root, resultId, options = {}) {
  const record = readPersistedResult(root, resultId, options);
  if (record === null) throw new Error(`TASK_RESULT_NOT_FOUND: ${resultId}`);
  return record;
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
