#!/usr/bin/env node
// Records an independent review outcome as a durable control-plane task result.
//
// Usage:
//   node scripts/record-review-result.mjs --outcome=passed|failed \
//     --candidate-sha=<40-hex> --reviewer-identity=<who> \
//     --reason=<text> --required-input=<text> \
//     [--reviewer-role=INDEPENDENT_REVIEWER|HUMAN_ESCALATION] \
//     [--candidate-id=<id>] [--task-id=<id>] [--candidate-ref=<ref>] \
//     [--upstream=<kind>:<ref> ...] \
//     [--root=<repo-root>] [--ref=<results-ref>] [--remote=<name>] [--local-only]
//
// This adapter exists so a review outcome is recorded as EVIDENCE, never as
// authority. A REVIEW_PASSED record grants nothing: grants_publication_
// authority is a schema const false, and the type's own invariants give it no
// automatic resume route, because merge/deploy authority is founder-only.
//
// Two inputs are deliberately mandatory and never derived:
//
//   --reviewer-identity  Who reviewed. Never inferred from the current
//                        process, the git config, or the environment. An
//                        implementation worker cannot become an independent
//                        reviewer merely by being the process that can call
//                        the writer, so the producing automation identity is
//                        refused outright.
//
//   --candidate-sha      The exact commit reviewed. Never defaulted to HEAD:
//                        a review binds to the state it actually examined, and
//                        silently adopting whatever is checked out now is the
//                        precise way a stale review gets treated as current.
//
// Persistence uses the merged result layer, which writes only to a dedicated
// results ref via git plumbing. The candidate branch is never moved, never
// pushed, and never merged by this command.

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertExactCandidateSha,
  assertReviewerIsIndependent,
  emitProducerResult,
  REVIEW_RESULT_TYPES
} from './lib/control-plane-result-producers.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name) {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(`--${name}=`.length) : null;
}

const outcome = (flag('outcome') ?? '').toLowerCase();
const rootArg = flag('root');
const ROOT = rootArg ? path.resolve(rootArg) : DEFAULT_ROOT;
const localOnly = process.argv.includes('--local-only');

const USAGE = 'Usage: node scripts/record-review-result.mjs --outcome=passed|failed --candidate-sha=<40-hex> --reviewer-identity=<who> --reason=<text> --required-input=<text> [--reviewer-role=...] [--candidate-id=<id>] [--task-id=<id>] [--upstream=<kind>:<ref>] [--root=<dir>] [--ref=<results-ref>] [--remote=<name>] [--local-only]';

try {
  if (outcome !== 'passed' && outcome !== 'failed') {
    throw new Error(`REVIEW_OUTCOME_REQUIRED: --outcome must be passed or failed. ${USAGE}`);
  }

  // Both guards throw rather than defaulting. See the header: neither reviewer
  // identity nor the reviewed SHA may be inferred.
  const reviewerIdentity = assertReviewerIsIndependent(flag('reviewer-identity'));
  const candidateSha = assertExactCandidateSha(flag('candidate-sha'));

  const reviewerRole = flag('reviewer-role') ?? 'INDEPENDENT_REVIEWER';
  if (!['INDEPENDENT_REVIEWER', 'HUMAN_ESCALATION'].includes(reviewerRole)) {
    throw new Error(`REVIEWER_ROLE_INVALID: ${reviewerRole}`);
  }

  const reason = flag('reason');
  const requiredInput = flag('required-input');
  if (!reason) throw new Error('REVIEW_REASON_REQUIRED: --reason must state what the review found');
  if (!requiredInput) throw new Error('REVIEW_REQUIRED_INPUT_REQUIRED: --required-input must state what happens next');

  const candidateId = flag('candidate-id');
  const taskId = flag('task-id');
  if (!candidateId && !taskId) {
    throw new Error('TASK_REF_REQUIRED: supply at least one of --candidate-id or --task-id');
  }

  const suppliedUpstream = process.argv
    .filter((arg) => arg.startsWith('--upstream='))
    .map((arg) => arg.slice('--upstream='.length))
    .map((entry) => {
      const separator = entry.indexOf(':');
      if (separator <= 0) throw new Error(`UPSTREAM_REF_MALFORMED: expected <kind>:<ref>, got ${entry}`);
      return { kind: entry.slice(0, separator), ref: entry.slice(separator + 1) };
    });

  const upstreamRefs = suppliedUpstream.length > 0
    ? suppliedUpstream
    : [{ kind: 'GITHUB_SHA', ref: candidateSha }];

  const resultType = outcome === 'passed' ? REVIEW_RESULT_TYPES.PASSED : REVIEW_RESULT_TYPES.FAILED;

  const { record, outcome: persisted } = emitProducerResult(ROOT, {
    resultType,
    taskId,
    candidateId,
    repositorySha: candidateSha,
    repositoryRef: flag('candidate-ref'),
    reason,
    requiredInput,
    reasonCode: flag('reason-code'),
    evidence: {
      producer: 'record-review-result',
      outcome: resultType,
      candidate_sha: candidateSha,
      reviewer_identity: reviewerIdentity,
      reviewer_role: reviewerRole,
      reason,
      required_input: requiredInput,
      upstream_refs: upstreamRefs
    },
    reviewer: { role: reviewerRole, identity: reviewerIdentity },
    upstreamRefs
  }, {
    publish: !localOnly,
    ...(flag('ref') !== null ? { ref: flag('ref') } : {}),
    ...(flag('remote') !== null ? { remote: flag('remote') } : {})
  });

  console.log(JSON.stringify({
    status: persisted.written
      ? (localOnly ? 'WRITTEN' : 'PUBLISHED')
      : (localOnly ? 'ALREADY_PRESENT' : 'REMOTE_ALREADY_PRESENT'),
    result_id: record.result_id,
    result_type: record.result_type,
    candidate_sha: candidateSha,
    reviewer: record.reviewer,
    ref: persisted.ref,
    commit: persisted.commit,
    // Restated on every emission so no downstream reader has to infer it.
    grants_publication_authority: record.grants_publication_authority,
    merge_allowed: false
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'REVIEW_RESULT_WRITE_FAILED', reason: error.message }, null, 2));
  process.exit(1);
}
