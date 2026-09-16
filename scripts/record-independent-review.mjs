#!/usr/bin/env node
// Structured-input adapter: an independent exact-SHA review outcome -> a
// durable REVIEW_PASSED / REVIEW_FAILED task result.
//
// Usage:
//   node scripts/record-independent-review.mjs \
//     --outcome=PASSED|FAILED \
//     --candidate-sha=<40-char lowercase hex> \
//     --reviewer-identity='<who reviewed it>' \
//     --reason='<the finding>' \
//     --required-input='<what is needed next>' \
//     (--evidence=<path> | --evidence-digest=<64-char lowercase hex>) \
//     [--candidate-id=<id>] [--task-id=<ID>] [--candidate-ref=<ref>] \
//     [--reviewer-role=INDEPENDENT_REVIEWER|HUMAN_ESCALATION] \
//     [--upstream-ref=<KIND>:<ref> ...] \
//     [--ref=<results-ref>] [--root=<repo-root>] [--publish] [--remote=<name>]
//
// Why this is an adapter and not an in-process call.
//
// The implementation worker that produced a candidate can physically call the
// result writer — it is the same repository and the same library. That is
// exactly the thing this adapter is built to refuse. Independence is not
// something a process can assert about itself, so this CLI never derives the
// reviewer: it reads no git config, no commit author, no CI actor variable, no
// environment at all. `--reviewer-identity` must be typed in by whoever is
// recording the review, and identities that name the writing process or the
// control-plane automation are refused outright.
//
// The exact SHA is enforced the same way: `--candidate-sha` is required, must
// be a full 40-character hex SHA, and must resolve to a real commit in this
// repository. A review is evidence about one commit; a SHA this checkout
// cannot resolve is not a commit that was reviewed here.
//
// A recorded review is evidence and nothing more. `grants_publication_authority`
// is a schema `const false`; `REVIEW_PASSED` carries a `null` resume point
// because merge and deploy remain founder-only. This command never merges,
// deploys, pushes the candidate branch, or moves any ref other than the
// dedicated results ref.

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REMOTE, DEFAULT_RESULTS_REF } from './lib/control-plane-result.mjs';
import {
  REVIEW_OUTCOMES,
  buildReviewResultInputs,
  emitResult,
  evidenceDigestForFile
} from './lib/control-plane-result-producers.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  'Usage: node scripts/record-independent-review.mjs \\',
  `  --outcome=${REVIEW_OUTCOMES.join('|')} \\`,
  '  --candidate-sha=<40-char lowercase hex> \\',
  "  --reviewer-identity='<who reviewed it>' \\",
  "  --reason='<the finding>' \\",
  "  --required-input='<what is needed next>' \\",
  '  (--evidence=<path> | --evidence-digest=<64-char lowercase hex>) \\',
  '  [--candidate-id=<id>] [--task-id=<ID>] [--candidate-ref=<ref>] \\',
  '  [--reviewer-role=INDEPENDENT_REVIEWER|HUMAN_ESCALATION] \\',
  '  [--upstream-ref=<KIND>:<ref> ...] \\',
  '  [--ref=<results-ref>] [--root=<repo-root>] [--publish] [--remote=<name>]'
].join('\n');

function option(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

function options(name) {
  const prefix = `--${name}=`;
  return process.argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

function parseUpstreamRef(value) {
  const at = value.indexOf(':');
  if (at <= 0 || at === value.length - 1) {
    throw new Error(`UPSTREAM_REF_MALFORMED: expected <KIND>:<ref>, got ${JSON.stringify(value)}`);
  }
  return { kind: value.slice(0, at), ref: value.slice(at + 1) };
}

const rootArg = option('root');
const ROOT = rootArg ? path.resolve(rootArg) : DEFAULT_ROOT;
const publish = process.argv.includes('--publish');
const ref = option('ref') ?? DEFAULT_RESULTS_REF;
const remote = option('remote') ?? DEFAULT_REMOTE;

// Presence is checked before anything else so a missing required input is a
// usage error (exit 2), never a half-attempted write. Reviewer identity and
// candidate SHA have no default and no fallback by design.
const required = {
  outcome: option('outcome'),
  'candidate-sha': option('candidate-sha'),
  'reviewer-identity': option('reviewer-identity'),
  reason: option('reason'),
  'required-input': option('required-input')
};
const missing = Object.entries(required).filter(([, value]) => value === null).map(([name]) => `--${name}`);
const evidencePath = option('evidence');
const evidenceDigestArg = option('evidence-digest');
if (evidencePath === null && evidenceDigestArg === null) missing.push('--evidence or --evidence-digest');
if (evidencePath !== null && evidenceDigestArg !== null) {
  console.error(JSON.stringify({ status: 'REVIEW_RESULT_USAGE_ERROR', reason: 'pass exactly one of --evidence or --evidence-digest' }, null, 2));
  console.error(USAGE);
  process.exit(2);
}
if (missing.length > 0) {
  console.error(JSON.stringify({ status: 'REVIEW_RESULT_USAGE_ERROR', reason: `missing required option(s): ${missing.join(', ')}` }, null, 2));
  console.error(USAGE);
  process.exit(2);
}

try {
  const inputs = buildReviewResultInputs({
    root: ROOT,
    outcome: required.outcome,
    candidateSha: required['candidate-sha'],
    candidateRef: option('candidate-ref'),
    candidateId: option('candidate-id'),
    taskId: option('task-id'),
    reviewerIdentity: required['reviewer-identity'],
    ...(option('reviewer-role') !== null ? { reviewerRole: option('reviewer-role') } : {}),
    reason: required.reason,
    requiredInput: required['required-input'],
    evidenceDigest: evidenceDigestArg ?? evidenceDigestForFile(path.resolve(ROOT, evidencePath)),
    extraUpstreamRefs: options('upstream-ref').map(parseUpstreamRef)
  });

  const outcome = emitResult(ROOT, inputs, {
    ref,
    remote,
    publish,
    candidateRef: option('candidate-ref') ?? inputs.candidateId
  });

  const { record, ...reported } = outcome;
  console.log(JSON.stringify({
    ...reported,
    reviewer: record.reviewer,
    repository_sha: record.repository.sha,
    merge_allowed: false,
    deploy_allowed: false
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'REVIEW_RESULT_REFUSED', reason: error.message }, null, 2));
  process.exit(1);
}
