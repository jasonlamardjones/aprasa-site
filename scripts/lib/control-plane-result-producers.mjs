// Wiring layer: real workflow outcomes -> the merged control-plane task-result
// contract.
//
// This module deliberately owns NOTHING that scripts/lib/control-plane-result.mjs
// already owns. It does not define, extend, or re-validate the result schema; it
// does not compute result ids; it does not persist anything itself. It builds
// the per-instance inputs that `buildResult` already accepts and then hands the
// record to the already-merged `writeResult`/`publishResult` persistence path on
// the dedicated results ref. There is exactly one result schema, one identity
// function, and one persistence mechanism in this repository, and they are the
// merged ones.
//
// ---------------------------------------------------------------------------
// Authority boundary
// ---------------------------------------------------------------------------
//
// A producer here may determine only what Project 04 already owns: technical
// validation state, an exact repository SHA, producer identity, a reviewer
// identity that was supplied to it, a technical resume point, and technical
// failure detail. It never determines publication eligibility, editorial
// meaning, business strategy, a Project 03 decision, Portuguese language
// approval, media-rights approval, merge authority, or deploy authority.
//
// Two structural consequences of that boundary live in code below rather than
// in prose:
//
//   * `assertTechnicallyOwned` refuses to emit TECHNICAL_VALIDATION_FAILED for
//     a failure that has not been proven to sit past the governance gate. The
//     caller must pass the governance preflight verdict it already computed;
//     "the packet is not approved" and "the approved packet broke a validator"
//     are different owners, and only the second is Project 04's.
//
//   * `assertResultsRefIsolated` refuses to persist onto the branch being
//     reported on (or onto a default/integration branch). Persisting a result
//     must never move a candidate, main, or anything a human would read as a
//     publication act.
//
// ---------------------------------------------------------------------------
// Logical identity across replays
// ---------------------------------------------------------------------------
//
// `result_id` excludes `created_at`, so two records are the same logical event
// exactly when every other field agrees. For a replayed technical failure to
// land on that guarantee, the failure text that feeds `reason` and
// `evidence_digest` must not carry run-scoped noise. It does carry such noise
// in practice: the guarded publication path runs inside `mkdtemp` staging,
// proof, and backup roots whose names end in six random characters, and it
// shells out through an absolute `process.execPath`. Two identical failures
// would otherwise mint two different result ids purely because a temporary
// directory was named differently.
//
// `normalizeFailureDetail` therefore rewrites exactly those run-scoped tokens
// — repository root, temp roots, node executable — to stable placeholders
// before anything is digested. It is a narrow, enumerated normalization, not a
// general sanitizer: every other byte of the failure text is preserved, so a
// genuinely different failure still produces a genuinely different record.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from './ttd-canonical-json.mjs';
import {
  DEFAULT_REMOTE,
  DEFAULT_RESULTS_REF,
  buildResult,
  publishResult,
  writeResult
} from './control-plane-result.mjs';

/**
 * Producer identity. The task-result schema is `additionalProperties: false`
 * and has no producer field, and this tranche does not change the schema, so
 * producer identity travels in `upstream_refs` under the existing
 * `AUDIT_RECORD` kind with a stable `control-plane-producer:` prefix.
 */
export const PRODUCERS = Object.freeze({
  GUARDED_EVENT_PUBLICATION: 'GUARDED_EVENT_PUBLICATION',
  INDEPENDENT_REVIEW_ADAPTER: 'INDEPENDENT_REVIEW_ADAPTER'
});

export const PRODUCER_REF_PREFIX = 'control-plane-producer:';

export function producerRef(producer) {
  if (!Object.hasOwn(PRODUCERS, producer)) throw new Error(`UNKNOWN_RESULT_PRODUCER: ${producer}`);
  return { kind: 'AUDIT_RECORD', ref: `${PRODUCER_REF_PREFIX}${producer}` };
}

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// Bounded so one pathological validator dump cannot turn a durable governance
// record into a megabyte of log. The cut is deterministic, so a replay of the
// same failure truncates identically and keeps the same logical identity.
export const MAX_DETAIL_CHARS = 4000;
const TRUNCATION_MARKER = '\n[detail truncated]';

// --- Deterministic failure-detail normalization ----------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function realPathOrSelf(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * Rewrites run-scoped tokens in a failure message to stable placeholders so
 * that replaying the same failure yields the same logical result.
 *
 * Exactly three classes are rewritten, most specific first:
 *   1. the repository root path                     -> <ROOT>
 *   2. an OS temp root, and any `mkdtemp` directory
 *      under it (the trailing six random characters
 *      are what vary between runs)                  -> <TMP>/<prefix>*
 *   3. the absolute node executable path            -> <NODE>
 *
 * Both the literal and the realpath form of the repository root and temp root
 * are rewritten, because a child process may report either one (on macOS
 * `os.tmpdir()` and its realpath differ).
 *
 * Everything else is preserved byte for byte. Line endings are normalized to
 * LF and trailing whitespace is trimmed, because neither carries meaning and
 * both vary with the reporting subprocess.
 */
export function normalizeFailureDetail(detail, { root = process.cwd() } = {}) {
  if (typeof detail !== 'string') return '';
  let text = detail.replace(/\r\n/g, '\n');

  const roots = [...new Set([root, realPathOrSelf(root)].filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const candidate of roots) {
    text = text.replaceAll(candidate, '<ROOT>');
  }

  const tmpRoots = [...new Set([os.tmpdir(), realPathOrSelf(os.tmpdir())].filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const tmpRoot of tmpRoots) {
    const escaped = escapeRegExp(tmpRoot);
    // A mkdtemp directory: <tmp>/<stable-prefix><six random chars>.
    text = text.replace(new RegExp(`${escaped}[/\\\\]([A-Za-z0-9._-]*?-)[A-Za-z0-9]{6}`, 'g'), '<TMP>/$1*');
    text = text.replaceAll(tmpRoot, '<TMP>');
  }

  const execPaths = [...new Set([process.execPath, realPathOrSelf(process.execPath)].filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const execPath of execPaths) {
    text = text.replaceAll(execPath, '<NODE>');
  }

  text = text.split('\n').map((line) => line.replace(/\s+$/, '')).join('\n').trim();
  if (text.length > MAX_DETAIL_CHARS) {
    text = `${text.slice(0, MAX_DETAIL_CHARS)}${TRUNCATION_MARKER}`;
  }
  return text;
}

/**
 * Reads the failure's own leading code, e.g. `STALE_BRANCH_REFUSED: ...`.
 * This is a syntactic extraction of a token the failing code already emitted,
 * never a classification of what the failure means. A message that carries no
 * such token yields null and the record simply omits `reason_code` rather than
 * inventing one.
 */
export function technicalFailureReasonCode(detail) {
  if (typeof detail !== 'string') return null;
  const match = /^([A-Z][A-Z0-9_]*):/.exec(detail.trim());
  if (match === null) return null;
  return REASON_CODE_PATTERN.test(match[1]) ? match[1] : null;
}

/**
 * A plain, canonically-serializable copy, or null. Used for structured
 * fragments (a recovery disposition) that are digested into the evidence
 * identity: `canonicalize` refuses `undefined`, accessors, and prototype
 * tampering, and a JSON round trip is the cheapest way to guarantee a plain
 * tree without importing another admission boundary.
 */
export function plainOrNull(value) {
  if (value === null || value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : JSON.parse(encoded);
  } catch {
    return null;
  }
}

// --- Authority and isolation guards ----------------------------------------

/**
 * Refuses to emit a TECHNICAL_VALIDATION_FAILED unless the caller can show the
 * failure sits past the governance gate.
 *
 * `governancePassed` must be the caller's already-computed verdict that the
 * approved-packet preflight succeeded. Before that point a failure's owner may
 * be Project 03, Project 09, the owning media project, or the founder — the
 * packet validator stamps exactly that owner on every issue it raises — and
 * Project 04 may not relabel any of them as a technical validation failure.
 * After that point the packet is governance-approved and every remaining
 * failure is repository/automation mechanics, which Project 04 does own.
 */
export function assertTechnicallyOwned({ governancePassed }) {
  if (governancePassed !== true) {
    throw new Error('RESULT_PRODUCER_NOT_TECHNICALLY_OWNED: a failure before the governance gate is not Project 04\'s to classify');
  }
}

/**
 * Refuses a results ref that is not isolated from the work being reported on.
 *
 * The merged persistence layer already writes by plumbing only and never
 * touches HEAD, the index, or the working tree — but it writes to whatever ref
 * name it is given. Pointing that at the candidate branch, at the checked-out
 * branch, or at an integration branch would make persisting evidence an act
 * that moves the thing the evidence is about. That is refused here rather than
 * relied on not to happen.
 */
export function assertResultsRefIsolated(root, ref, { candidateRef = null } = {}) {
  const name = String(ref ?? '').trim();
  if (!name) throw new Error('RESULTS_REF_REQUIRED');
  const shortName = name.replace(/^refs\/heads\//, '');
  const protectedNames = new Set(['main', 'master', 'HEAD']);
  const current = spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' });
  if (current.status === 0 && current.stdout.trim()) protectedNames.add(current.stdout.trim());
  if (typeof candidateRef === 'string' && candidateRef.trim()) {
    protectedNames.add(candidateRef.trim().replace(/^refs\/heads\//, ''));
  }
  if (protectedNames.has(shortName)) {
    throw new Error(`RESULTS_REF_NOT_ISOLATED: refusing to persist task results onto ${shortName}`);
  }
  return shortName;
}

/**
 * The exact-SHA requirement for a review result, enforced structurally.
 *
 * A review binds to a commit. A SHA this repository cannot resolve to a commit
 * object is not a commit that was reviewed here, so it is refused rather than
 * recorded. A reviewer working from a fresh clone fetches first; that is the
 * intended workflow, not an obstacle to route around.
 */
export function assertResolvableCommit(root, sha) {
  if (!SHA_PATTERN.test(sha ?? '')) {
    throw new Error(`EXACT_CANDIDATE_SHA_REQUIRED: ${JSON.stringify(sha)} is not a 40-character lowercase hex sha`);
  }
  const probe = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(`CANDIDATE_SHA_UNRESOLVABLE: ${sha} is not a commit in this repository; fetch the candidate before recording a review`);
  }
  return sha;
}

/**
 * Identities that would mean the writer certified its own review.
 *
 * The review producer never derives a reviewer from the running process: it
 * reads no git config, no commit author, no CI actor, and no environment
 * variable. Reviewer identity must be supplied explicitly. These tokens are
 * refused on top of that, so that supplying the automation's own identity —
 * the one the results ref commits are authored by — cannot be used to dress a
 * self-certification up as an independent review.
 */
export const REFUSED_REVIEWER_IDENTITIES = Object.freeze([
  'a prasa control plane',
  'automation@aprasa.org',
  'control plane',
  'project 04',
  'project04',
  'self',
  'same worker',
  'implementation worker',
  'writer',
  'n/a',
  'na',
  'none',
  'unknown',
  '-'
]);

export function assertExplicitReviewerIdentity(identity) {
  if (typeof identity !== 'string') {
    throw new Error('REVIEWER_IDENTITY_REQUIRED: an independent review must name its reviewer explicitly');
  }
  const trimmed = identity.trim();
  if (trimmed.length === 0) {
    throw new Error('REVIEWER_IDENTITY_REQUIRED: an independent review must name its reviewer explicitly');
  }
  if (REFUSED_REVIEWER_IDENTITIES.includes(trimmed.toLowerCase())) {
    throw new Error(`REVIEWER_IDENTITY_NOT_INDEPENDENT: ${JSON.stringify(trimmed)} identifies the writing process, not an independent reviewer`);
  }
  return trimmed;
}

// --- Producer 1: guarded event publication -> TECHNICAL_VALIDATION_FAILED ---

export const DEFAULT_TECHNICAL_REQUIRED_INPUT =
  'Correct the reported technical failure and rerun the guarded real-write command from the clean authorized baseline.';

/**
 * Builds the `buildResult` inputs for a technical failure raised by the
 * guarded event-publication path, after the governance gate has passed.
 *
 * Everything recorded here is already Project 04's: the normalized technical
 * failure text, the failure's own leading code, the exact repository SHA the
 * failure was observed at, the branch, and the resume action the guarded path
 * itself authored. Nothing about publication eligibility, editorial meaning,
 * localization, or media rights is read, restated, or decided.
 */
export function buildTechnicalValidationFailedInputs({
  root = process.cwd(),
  governancePassed,
  candidateId = null,
  taskId = null,
  repositorySha,
  repositoryRef = null,
  detail,
  phase = null,
  recovery = null,
  packetRef = null,
  createdAt
}) {
  assertTechnicallyOwned({ governancePassed });
  if (!SHA_PATTERN.test(repositorySha ?? '')) {
    throw new Error(`TECHNICAL_RESULT_SHA_REQUIRED: ${JSON.stringify(repositorySha)} is not a 40-character lowercase hex sha`);
  }
  const normalizedDetail = normalizeFailureDetail(detail, { root });
  if (normalizedDetail.length === 0) {
    throw new Error('TECHNICAL_RESULT_DETAIL_REQUIRED: a technical failure record needs the failure text it reports');
  }
  const reasonCode = technicalFailureReasonCode(normalizedDetail);
  const normalizedRecovery = plainOrNull(recovery);
  const normalizedResume = typeof normalizedRecovery?.resume_action === 'string'
    ? normalizeFailureDetail(normalizedRecovery.resume_action, { root })
    : null;
  if (normalizedRecovery !== null && normalizedResume !== null) {
    normalizedRecovery.resume_action = normalizedResume;
  }
  const normalizedPacketRef = typeof packetRef === 'string' && packetRef.trim()
    ? normalizeFailureDetail(packetRef, { root })
    : null;

  const evidence = {
    producer: PRODUCERS.GUARDED_EVENT_PUBLICATION,
    phase: phase ?? null,
    reason_code: reasonCode,
    detail: normalizedDetail,
    candidate_id: candidateId,
    task_id: taskId,
    packet_ref: normalizedPacketRef,
    repository: { sha: repositorySha, ref: repositoryRef ?? null },
    recovery: normalizedRecovery
  };

  const upstreamRefs = [
    producerRef(PRODUCERS.GUARDED_EVENT_PUBLICATION),
    { kind: 'GITHUB_SHA', ref: repositorySha },
    ...(normalizedPacketRef !== null ? [{ kind: 'FILE', ref: normalizedPacketRef }] : [])
  ];

  return {
    resultType: 'TECHNICAL_VALIDATION_FAILED',
    taskId,
    candidateId,
    repositorySha,
    repositoryRef,
    reason: `${PRODUCERS.GUARDED_EVENT_PUBLICATION}: ${normalizedDetail}`,
    ...(reasonCode !== null ? { reasonCode } : {}),
    requiredInput: normalizedResume ?? DEFAULT_TECHNICAL_REQUIRED_INPUT,
    evidenceDigest: digest(evidence),
    reviewer: null,
    upstreamRefs,
    ...(createdAt !== undefined ? { createdAt } : {})
  };
}

// --- Producer 2: independent exact-SHA review -> REVIEW_PASSED/REVIEW_FAILED -

const REVIEW_RESULT_TYPE_BY_OUTCOME = Object.freeze({
  PASSED: 'REVIEW_PASSED',
  FAILED: 'REVIEW_FAILED'
});

export const REVIEW_OUTCOMES = Object.freeze(Object.keys(REVIEW_RESULT_TYPE_BY_OUTCOME));

/**
 * Builds the `buildResult` inputs for an independent review of an exact
 * candidate SHA.
 *
 * Both of the things that make this evidence rather than assertion are
 * required and neither is ever derived: the exact candidate SHA (which must
 * resolve to a commit in this repository) and the reviewer identity (which must
 * be supplied explicitly and must not name the writing process). A review
 * result reports a verdict; `grants_publication_authority` stays the schema's
 * `const false`, `REVIEW_PASSED` keeps its `null` resume_point, and nothing
 * here merges, deploys, or publishes anything.
 */
export function buildReviewResultInputs({
  root = process.cwd(),
  outcome,
  candidateSha,
  candidateRef = null,
  candidateId = null,
  taskId = null,
  reviewerIdentity,
  reviewerRole = 'INDEPENDENT_REVIEWER',
  reason,
  requiredInput,
  evidenceDigest,
  extraUpstreamRefs = [],
  createdAt
}) {
  const resultType = REVIEW_RESULT_TYPE_BY_OUTCOME[outcome];
  if (resultType === undefined) {
    throw new Error(`REVIEW_OUTCOME_REQUIRED: expected one of ${REVIEW_OUTCOMES.join('|')}, got ${JSON.stringify(outcome)}`);
  }
  assertResolvableCommit(root, candidateSha);
  const identity = assertExplicitReviewerIdentity(reviewerIdentity);
  if (!['INDEPENDENT_REVIEWER', 'HUMAN_ESCALATION'].includes(reviewerRole)) {
    throw new Error(`REVIEWER_ROLE_INVALID: ${JSON.stringify(reviewerRole)}`);
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('REVIEW_REASON_REQUIRED: an independent review must state its finding');
  }
  if (typeof requiredInput !== 'string' || requiredInput.trim().length === 0) {
    throw new Error('REVIEW_REQUIRED_INPUT_REQUIRED: an independent review must state what is needed next');
  }
  if (!DIGEST_PATTERN.test(evidenceDigest ?? '')) {
    throw new Error(`REVIEW_EVIDENCE_DIGEST_REQUIRED: ${JSON.stringify(evidenceDigest)} is not a 64-character lowercase hex digest`);
  }
  if (candidateId === null && taskId === null) {
    throw new Error('REVIEW_SUBJECT_REQUIRED: supply the candidate id or the task id the review is about');
  }

  return {
    resultType,
    taskId,
    candidateId,
    repositorySha: candidateSha,
    repositoryRef: candidateRef,
    reason: reason.trim(),
    requiredInput: requiredInput.trim(),
    evidenceDigest,
    reviewer: { role: reviewerRole, identity },
    upstreamRefs: [
      producerRef(PRODUCERS.INDEPENDENT_REVIEW_ADAPTER),
      { kind: 'GITHUB_SHA', ref: candidateSha },
      ...extraUpstreamRefs
    ],
    ...(createdAt !== undefined ? { createdAt } : {})
  };
}

/** SHA-256 of a review evidence file's exact bytes. */
export function evidenceDigestForFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.resolve(file))).digest('hex');
}

// --- Fail-closed persistence ------------------------------------------------

/**
 * Persists one producer-built record through the merged result layer.
 *
 * Fail-closed in the literal sense: every failure path throws
 * TASK_RESULT_PERSISTENCE_FAILED carrying the underlying cause. There is no
 * branch on which this returns a "continue without record" outcome, and the
 * callers report the thrown failure rather than degrading past it.
 */
export function emitResult(root, inputs, {
  ref = DEFAULT_RESULTS_REF,
  remote = DEFAULT_REMOTE,
  publish = false,
  candidateRef = null
} = {}) {
  const isolatedRef = assertResultsRefIsolated(root, ref, { candidateRef });
  let record;
  try {
    record = buildResult(inputs);
  } catch (error) {
    throw new Error(`TASK_RESULT_PERSISTENCE_FAILED: ${error.message}`, { cause: error });
  }
  // Defence in depth behind the schema `const` and the semantic invariants: a
  // producer must never be the thing that ships a record claiming authority.
  if (record.grants_publication_authority !== false) {
    throw new Error('TASK_RESULT_PERSISTENCE_FAILED: a producer may not emit a record that claims publication authority');
  }
  try {
    const outcome = publish
      ? publishResult(root, record, { ref: isolatedRef, remote })
      : writeResult(root, record, { ref: isolatedRef });
    return {
      status: outcome.written
        ? (publish ? 'PUBLISHED' : 'WRITTEN')
        : (publish ? 'REMOTE_ALREADY_PRESENT' : 'ALREADY_PRESENT'),
      result_id: record.result_id,
      result_type: record.result_type,
      ref: outcome.ref,
      commit: outcome.commit,
      path: outcome.path,
      ...(publish ? { remote: outcome.remote, remote_tip: outcome.remote_tip, published: outcome.published } : {}),
      grants_publication_authority: record.grants_publication_authority,
      record
    };
  } catch (error) {
    throw new Error(`TASK_RESULT_PERSISTENCE_FAILED: ${error.message}`, { cause: error });
  }
}
