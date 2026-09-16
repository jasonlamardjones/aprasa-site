#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPacket } from './lib/event-publication-contract.mjs';
import {
  finalizeRealWriteCandidate,
  prepareRealWriteCandidate
} from './lib/event-publication-write.mjs';
import {
  emitProducerResult,
  resolveHeadSha,
  technicalFailureIntent
} from './lib/control-plane-result-producers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packetArg = process.argv.find((arg) => arg.startsWith('--packet='));

// Opt-in, fail-closed durable result emission. See the matching block in
// scripts/prepare-event-publication.mjs: without --emit-result this command is
// byte-for-byte the incumbent behaviour.
const emitResult = process.argv.includes('--emit-result');
const resultLocalOnly = process.argv.includes('--result-local-only');
const resultRefArg = process.argv.find((arg) => arg.startsWith('--result-ref='));
const resultRemoteArg = process.argv.find((arg) => arg.startsWith('--result-remote='));

if (!packetArg) {
  console.error('Usage: node scripts/write-event-publication.mjs --packet=<approved-real-write-packet.json> [--emit-result] [--result-local-only] [--result-ref=<ref>] [--result-remote=<name>]');
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

const packetPath = path.resolve(ROOT, packetArg.slice('--packet='.length));

try {
  const packet = loadPacket(packetPath);
  const branch = run('git', ['branch', '--show-current']);
  const existing = run('gh', ['pr', 'list', '--repo', 'jasonlamardjones/aprasa-site', '--head', branch, '--state', 'open', '--json', 'url']);
  if (JSON.parse(existing).length) throw new Error('DRAFT_PR_REFUSED: an open PR already exists for this branch');
  run('git', ['push', '--dry-run', 'origin', `HEAD:refs/heads/${branch}`]);
  const result = prepareRealWriteCandidate({ root: ROOT, packet, packetPath });
  const published = finalizeRealWriteCandidate({ root: ROOT, packet, result });

  console.log(JSON.stringify({
    ...result,
    status: 'FOUNDER_APPROVAL_REQUIRED',
    candidate_sha: published.candidateSha,
    draft_pr: published.prUrl,
    merge_allowed: false
  }, null, 2));
} catch (error) {
  const report = {
    status: 'REAL_WRITE_FAILED',
    owner: 'Project 04',
    reason: error.message,
    recovery: error.recovery ?? null,
    merge_allowed: false
  };
  if (emitResult) {
    try {
      const packet = loadPacket(packetPath);
      const { record, outcome } = emitProducerResult(ROOT, technicalFailureIntent({
        root: ROOT,
        packet,
        packetPath,
        producer: 'write-event-publication',
        stage: 'REAL_WRITE_FAILED',
        detail: error.message,
        repositorySha: resolveHeadSha(ROOT),
        requiredInput: error.recovery?.resume_action
          ?? 'Correct the reported failure and rerun the guarded real-write command from the clean authorized baseline.'
      }), {
        publish: !resultLocalOnly,
        ...(resultRefArg ? { ref: resultRefArg.slice('--result-ref='.length) } : {}),
        ...(resultRemoteArg ? { remote: resultRemoteArg.slice('--result-remote='.length) } : {})
      });
      report.task_result = {
        result_id: record.result_id,
        result_type: record.result_type,
        ref: outcome.ref,
        recorded: outcome.written ? 'NEW' : 'ALREADY_PRESENT',
        grants_publication_authority: record.grants_publication_authority
      };
    } catch (emissionError) {
      // Fail-closed: the write already failed, and a required durable record
      // could not be made either. Both facts are reported; neither is hidden.
      report.task_result = { status: 'TASK_RESULT_EMISSION_FAILED', reason: emissionError.message };
    }
  }
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
