// Producer adapters: turn real workflow outcomes into durable control-plane
// task results.
//
// This is deliberately a thin adapter around the already-merged result layer
// in ./control-plane-result.mjs. It does NOT re-implement schema validation,
// result identity, or persistence — it only decides (a) whether an outcome is
// eligible to be recorded at all, and (b) what stable, replay-safe inputs to
// hand to buildResult/publishResult.
//
// AUTHORITY: the classification below never invents ownership. The publication
// contract already declares an explicit `owner` string on every issue it
// raises (see validatePacket in ./event-publication-contract.mjs), and that
// declared owner — not the issue's state code — is the only authority signal
// used here. This distinction is load-bearing: BLOCKED_MEDIA is raised with
// owner 'Project 04' for purely technical faults (missing local asset, target
// collision, SHA mismatch) and with owner 'Owning Project' for media-rights
// approval. Classifying by state code would silently convert a media-rights
// boundary into a Project 04 technical claim.
//
// Owners with no admissible mapping are REFUSED rather than coerced into the
// nearest result type. There is no NEEDS_PROJECT_09_DECISION in the merged
// contract, so a Project 09 localization boundary is not recordable here; the
// correct behaviour is to decline, not to relabel it as a Project 03 decision.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from './ttd-canonical-json.mjs';
import { buildResult, publishResult, writeResult } from './control-plane-result.mjs';

// Declared-owner -> result_type. Anything absent from this table is refused.
//
// 'Project 04' is this project's own technical authority: malformed packets,
// failed generators/validators, fail-closed preparation faults.
//
// 'Project 03 / owning Project' is the one authority boundary the incumbent
// contract already reaches deterministically (BLOCKED_OWNER_APPROVAL:
// publication/factual approval is not complete). Recording that the workflow
// ARRIVED at that boundary is evidence, not adjudication — the record's own
// invariants route it to PROJECT_03/HUMAN_ESCALATION and it grants nothing.
export const OWNER_RESULT_TYPES = Object.freeze({
  'Project 04': 'TECHNICAL_VALIDATION_FAILED',
  'Project 03 / owning Project': 'NEEDS_PROJECT_03_DECISION'
});

// Owners deliberately left unwired, with the reason recorded so a refusal is
// self-explaining rather than looking like an oversight.
export const REFUSED_OWNERS = Object.freeze({
  'Project 09': 'PROJECT_09_LOCALIZATION_AUTHORITY',
  'Owning Project': 'MEDIA_RIGHTS_AUTHORITY',
  'Owning Project / Project 09 as applicable': 'MEDIA_RIGHTS_AUTHORITY',
  Founder: 'FOUNDER_AUTHORITY'
});

export const REFUSAL_UNMAPPED_OWNER = 'OWNER_OUTSIDE_PRODUCER_AUTHORITY';

/**
 * Maps one declared owner string onto a result type, or refuses.
 * Never throws: refusal is an ordinary, inspectable outcome.
 */
export function classifyDeclaredOwner(owner) {
  const resultType = OWNER_RESULT_TYPES[owner];
  if (resultType) return { eligible: true, owner, resultType };
  return {
    eligible: false,
    owner,
    refusal: REFUSED_OWNERS[owner] ?? REFUSAL_UNMAPPED_OWNER
  };
}

/**
 * Classifies a validatePacket() preflight outcome using the SAME primary-issue
 * precedence the contract itself applies (preflight.state), so this adapter
 * cannot disagree with the incumbent validator about which issue is primary.
 */
export function classifyPacketPreflight(preflight) {
  if (preflight?.ok === true) return { eligible: false, refusal: 'NO_FAILURE_TO_RECORD', owner: null };
  const primary = preflight?.issues?.find((item) => item.code === preflight.state) ?? preflight?.issues?.[0] ?? null;
  if (!primary) return { eligible: false, refusal: 'NO_FAILURE_TO_RECORD', owner: null };
  return { ...classifyDeclaredOwner(primary.owner), issue: primary, state: preflight.state };
}

// --- Replay-stable text ----------------------------------------------------
//
// result_id excludes created_at, so a replayed outcome is already idempotent
// PROVIDED its content is byte-identical. Failure text routinely embeds the
// absolute mkdtemp root the run happened to use, which differs on every
// invocation and would mint a new logical result per retry. That path is
// occurrence detail, never logical identity, so it is redacted to a stable
// placeholder. Only paths under the OS temp root are touched; repository-
// relative paths, which ARE identity, are left exactly as they are.

const TEMP_PLACEHOLDER = '<temp-root>';

function tempRootCandidates(tmpdir) {
  const roots = new Set([tmpdir]);
  try {
    roots.add(fs.realpathSync(tmpdir));
  } catch {
    // An unresolvable temp root simply yields one fewer redaction pattern.
  }
  return [...roots];
}

export function redactVolatilePaths(text, { tmpdir = os.tmpdir() } = {}) {
  let output = String(text ?? '');
  for (const root of tempRootCandidates(tmpdir)) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    output = output.replace(new RegExp(`${escaped}[/\\\\][A-Za-z0-9._-]+`, 'g'), TEMP_PLACEHOLDER);
  }
  return output;
}

/** Repo-relative where possible, so identity survives a fresh checkout at a different path. */
export function stableRef(root, target) {
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return redactVolatilePaths(resolved);
}

export function evidenceDigestFor(evidence) {
  return digest(evidence);
}

// --- Emission --------------------------------------------------------------

/**
 * Builds and persists one producer result. Fail-closed by construction: every
 * error from validation, construction, or persistence propagates to the
 * caller. There is deliberately no "best effort" mode and no swallowed
 * failure — a producer that cannot record a required result must not report
 * success.
 *
 * Idempotence is inherited from the merged layer: identical logical content
 * yields an identical result_id, and re-persisting it is a no-op that keeps
 * the originally recorded created_at.
 */
export function emitProducerResult(root, {
  resultType,
  taskId = null,
  candidateId = null,
  repositorySha,
  repositoryRef = null,
  reason,
  requiredInput,
  reasonCode = null,
  evidence,
  reviewer = null,
  upstreamRefs,
  createdAt
}, { publish = true, ref, remote } = {}) {
  const record = buildResult({
    resultType,
    taskId,
    candidateId,
    repositorySha,
    repositoryRef,
    reason: redactVolatilePaths(reason),
    requiredInput,
    reasonCode,
    evidenceDigest: evidenceDigestFor(evidence),
    reviewer,
    upstreamRefs,
    ...(createdAt !== undefined ? { createdAt } : {})
  });
  const options = {
    ...(ref !== undefined ? { ref } : {}),
    ...(remote !== undefined ? { remote } : {})
  };
  const outcome = publish
    ? publishResult(root, record, options)
    : writeResult(root, record, options);
  return { record, outcome };
}

// --- Publication-path intents ----------------------------------------------
//
// Both publication entrypoints share one evidence shape, defined here so the
// two CLIs stay thin and cannot drift apart on what a recorded failure means.

export function resolveHeadSha(root) {
  const probe = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const sha = probe.stdout?.trim() ?? '';
  if (probe.status !== 0 || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('HEAD_SHA_UNRESOLVED: a durable result must bind to an exact repository SHA');
  }
  return sha;
}

/**
 * Intent for a packet that failed preflight. Eligibility follows the declared
 * owner of the contract's own primary issue; an owner outside the mapped set
 * is refused rather than recorded under a borrowed authority.
 */
export function packetPreflightIntent({ root, packet, packetPath, preflight, repositorySha, repositoryRef = null }) {
  const classification = classifyPacketPreflight(preflight);
  if (!classification.eligible) return classification;
  const issue = classification.issue;
  const packetRef = stableRef(root, packetPath);
  return {
    ...classification,
    intent: {
      resultType: classification.resultType,
      candidateId: packet?.event?.id ?? null,
      repositorySha,
      repositoryRef,
      reason: `${preflight.state}: ${issue.reason}`,
      requiredInput: issue.required_input,
      reasonCode: preflight.state,
      evidence: {
        producer: 'prepare-event-publication',
        stage: 'PACKET_PREFLIGHT',
        state: preflight.state,
        declared_owner: issue.owner,
        reason: issue.reason,
        required_input: issue.required_input,
        resume_from: issue.resume_from,
        event_id: packet?.event?.id ?? null,
        packet_ref: packetRef
      },
      upstreamRefs: [
        { kind: 'FILE', ref: packetRef },
        { kind: 'GITHUB_SHA', ref: repositorySha }
      ]
    }
  };
}

/**
 * Intent for a technical fault raised while executing the publication path
 * itself (generator, validator, or fail-closed preparation/write failure).
 * Ownership is unambiguous here: these faults are raised by this project's own
 * machinery, so they are always TECHNICAL_VALIDATION_FAILED.
 */
export function technicalFailureIntent({
  root,
  packet,
  packetPath,
  producer,
  stage,
  detail,
  repositorySha,
  repositoryRef = null,
  requiredInput = 'Technical correction by Project 04, then rerun the guarded command from the authorized baseline.'
}) {
  const packetRef = stableRef(root, packetPath);
  const redacted = redactVolatilePaths(detail);
  return {
    resultType: 'TECHNICAL_VALIDATION_FAILED',
    candidateId: packet?.event?.id ?? null,
    repositorySha,
    repositoryRef,
    reason: `${stage}: ${redacted}`,
    requiredInput,
    reasonCode: stage,
    evidence: {
      producer,
      stage,
      detail: redacted,
      event_id: packet?.event?.id ?? null,
      packet_ref: packetRef
    },
    upstreamRefs: [
      { kind: 'FILE', ref: packetRef },
      { kind: 'GITHUB_SHA', ref: repositorySha }
    ]
  };
}

// --- Review producer guards ------------------------------------------------
//
// A review result is the only result type that carries reviewer identity, and
// it is the one an implementation worker must never mint for its own work.
// The guard is structural: identity must be supplied explicitly by the
// caller, the exact reviewed SHA must be supplied explicitly (never derived
// from whatever HEAD happens to be), and the automation identity that writes
// the results ref is refused as a reviewer outright.

export const SELF_CERTIFICATION_DENYLIST = Object.freeze([
  'a prasa control plane',
  'automation@aprasa.org',
  'self',
  'same-worker',
  'implementation-worker'
]);

export const REVIEW_RESULT_TYPES = Object.freeze({
  PASSED: 'REVIEW_PASSED',
  FAILED: 'REVIEW_FAILED'
});

export function assertReviewerIsIndependent(identity) {
  const normalized = String(identity ?? '').trim();
  if (normalized.length === 0) {
    throw new Error('REVIEWER_IDENTITY_REQUIRED: an independent review result requires an explicit reviewer identity');
  }
  if (SELF_CERTIFICATION_DENYLIST.includes(normalized.toLowerCase())) {
    throw new Error(`SELF_CERTIFIED_REVIEW_REFUSED: ${normalized} is the producing automation identity, not an independent reviewer`);
  }
  return normalized;
}

export function assertExactCandidateSha(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) {
    throw new Error('EXACT_CANDIDATE_SHA_REQUIRED: a review result must bind to an explicit 40-character candidate SHA');
  }
  return sha;
}
