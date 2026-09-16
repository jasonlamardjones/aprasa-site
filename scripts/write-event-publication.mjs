#!/usr/bin/env node
// Guarded real-write entrypoint for an already-approved event publication.
//
// Durable task result on failure
// ------------------------------
// A guarded real-write refusal used to be visible only as JSON on stderr and a
// non-zero exit: correct, but not durable. On an ephemeral worker it vanishes
// with the container, and the founder is back to relaying state by hand. This
// entrypoint therefore emits one TECHNICAL_VALIDATION_FAILED task result
// through the merged control-plane result layer when — and only when — the
// failure is Project 04's to classify.
//
// The ownership gate is structural, not textual. Before any guarded work runs,
// the already-approved packet is put through the same `validatePacket`
// preflight `prepareRealWriteCandidate` performs, purely to decide ownership.
// That validator stamps an owner on every issue it raises, and those owners
// include Project 03, Project 09, the owning media project, and the founder. A
// failure at or before that gate is therefore NOT emitted as a technical
// validation failure — Project 04 must not relabel a governance refusal as a
// technical one. Once the gate passes, the packet is governance-approved and
// every remaining failure is repository/automation mechanics, which Project 04
// does own: those are emitted.
//
// The result is persisted onto the dedicated results ref
// (refs/heads/control-plane-task-results), never onto the candidate branch and
// never onto main, and it grants no publication, merge, or deploy authority.
// It is published to the remote by default, because durability across workers
// is the entire point; `--no-publish-result` keeps it local to this checkout
// and `--no-task-result` skips it entirely. Both downgrades are reported in the
// output rather than applied silently.
//
// Persistence is fail-closed: if a required result cannot be persisted, that
// failure is reported alongside the original one and the command still exits
// non-zero. There is no path on which this continues without a record.
//
// Usage:
//   node scripts/write-event-publication.mjs --packet=<approved-real-write-packet.json>
//     [--no-publish-result] [--no-task-result] [--result-ref=<name>] [--result-remote=<name>]

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPacket, validatePacket } from './lib/event-publication-contract.mjs';
import {
  finalizeRealWriteCandidate,
  prepareRealWriteCandidate
} from './lib/event-publication-write.mjs';
import { listOpenPullRequests } from './lib/github-pr-client.mjs';
import { DEFAULT_REMOTE, DEFAULT_RESULTS_REF } from './lib/control-plane-result.mjs';
import { buildTechnicalValidationFailedInputs, emitResult } from './lib/control-plane-result-producers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'jasonlamardjones/aprasa-site';
const packetArg = process.argv.find((arg) => arg.startsWith('--packet='));
const resultRefArg = process.argv.find((arg) => arg.startsWith('--result-ref='));
const resultRemoteArg = process.argv.find((arg) => arg.startsWith('--result-remote='));
const taskResultEnabled = !process.argv.includes('--no-task-result');
const publishResultEnabled = !process.argv.includes('--no-publish-result');
const resultRef = resultRefArg ? resultRefArg.slice('--result-ref='.length) : DEFAULT_RESULTS_REF;
const resultRemote = resultRemoteArg ? resultRemoteArg.slice('--result-remote='.length) : DEFAULT_REMOTE;

if (!packetArg) {
  console.error('Usage: node scripts/write-event-publication.mjs --packet=<approved-real-write-packet.json> [--no-publish-result] [--no-task-result] [--result-ref=<name>] [--result-remote=<name>]');
  process.exit(2);
}

function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: ROOT, encoding: 'utf8', env: process.env });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${executable} ${args.join(' ')} failed (${result.status})${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function currentSha() {
  const probe = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return probe.status === 0 ? probe.stdout.trim() : null;
}

function currentBranch() {
  const probe = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' });
  return probe.status === 0 ? (probe.stdout.trim() || null) : null;
}

/**
 * Ownership classification, computed before any guarded work runs.
 *
 * `governancePassed` is true only when the approved-packet preflight succeeds
 * AND the packet carries explicit real-write authorization with merge still
 * withheld. Both are conditions the founder and the owning projects control,
 * not Project 04, so a failure to meet either is not a technical validation
 * failure.
 */
function classifyOwnership(packet) {
  const preflight = validatePacket(packet, { root: ROOT, checkRepository: true });
  const authorized = packet?.control?.real_write === true && packet?.control?.merge_allowed === false;
  return {
    governancePassed: preflight.ok === true && authorized,
    preflight_state: preflight.state,
    authorized
  };
}

/**
 * Emits the durable technical-validation record for a failure that has already
 * been classified as Project 04's. Never swallows a persistence failure: the
 * caller reports whatever comes back, and a thrown error becomes a visible
 * TASK_RESULT_PERSISTENCE_FAILED block in the same output as the original
 * failure.
 */
function emitTechnicalFailureResult({ packet, packetPath, ownership, error }) {
  if (!taskResultEnabled) {
    return { emitted: false, reason: 'DISABLED_BY_FLAG', flag: '--no-task-result' };
  }
  if (!ownership.governancePassed) {
    return {
      emitted: false,
      reason: 'NOT_TECHNICALLY_OWNED',
      preflight_state: ownership.preflight_state,
      detail: 'A failure at or before the governance gate belongs to the owning project, not Project 04; no technical validation result was created.'
    };
  }
  const recovery = error.recovery ?? null;
  const repositorySha = recovery?.head_sha ?? currentSha();
  const repositoryRef = recovery?.branch ?? currentBranch();
  try {
    const inputs = buildTechnicalValidationFailedInputs({
      root: ROOT,
      governancePassed: ownership.governancePassed,
      candidateId: packet?.event?.id ?? null,
      repositorySha,
      repositoryRef,
      detail: error.message,
      phase: recovery?.phase ?? 'GUARDED_REAL_WRITE',
      recovery,
      packetRef: packetPath
    });
    const outcome = emitResult(ROOT, inputs, {
      ref: resultRef,
      remote: resultRemote,
      publish: publishResultEnabled,
      candidateRef: repositoryRef
    });
    const { record, ...reported } = outcome;
    return { emitted: true, ...reported, publish: publishResultEnabled };
  } catch (persistenceError) {
    return { emitted: false, reason: 'TASK_RESULT_PERSISTENCE_FAILED', detail: persistenceError.message };
  }
}

const packetPath = path.resolve(ROOT, packetArg.slice('--packet='.length));
let ownership = { governancePassed: false, preflight_state: 'NOT_EVALUATED', authorized: false };
let packet = null;

try {
  packet = loadPacket(packetPath);
  ownership = classifyOwnership(packet);
  const branch = run('git', ['branch', '--show-current']);
  // Fail-closed by construction: this throws on any unanswerable lookup —
  // missing credential, transport failure, or a non-success status — so the
  // refusal can never be satisfied by a query that merely failed to run. The
  // lookup is transport-agnostic; a worker without the GitHub CLI installed is
  // no longer a reason to stop an otherwise authorized publication.
  const existing = listOpenPullRequests({ repository: REPOSITORY, branch, cwd: ROOT });
  if (existing.length) throw new Error('DRAFT_PR_REFUSED: an open PR already exists for this branch');
  run('git', ['push', '--dry-run', 'origin', `HEAD:refs/heads/${branch}`]);
  const result = prepareRealWriteCandidate({ root: ROOT, packet, packetPath });
  const published = finalizeRealWriteCandidate({ root: ROOT, packet, result, repository: REPOSITORY });

  console.log(JSON.stringify({
    ...result,
    status: 'FOUNDER_APPROVAL_REQUIRED',
    candidate_sha: published.candidateSha,
    draft_pr: published.prUrl,
    merge_allowed: false
  }, null, 2));
} catch (error) {
  const taskResult = packet === null
    ? { emitted: false, reason: 'PACKET_UNREADABLE' }
    : emitTechnicalFailureResult({ packet, packetPath, ownership, error });

  console.error(JSON.stringify({
    status: 'REAL_WRITE_FAILED',
    owner: 'Project 04',
    reason: error.message,
    recovery: error.recovery ?? null,
    merge_allowed: false,
    task_result: taskResult
  }, null, 2));
  process.exit(1);
}
