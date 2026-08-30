#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPacket } from './lib/event-publication-contract.mjs';
import {
  finalizeRealWriteCandidate,
  prepareRealWriteCandidate
} from './lib/event-publication-write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packetArg = process.argv.find((arg) => arg.startsWith('--packet='));

if (!packetArg) {
  console.error('Usage: node scripts/write-event-publication.mjs --packet=<approved-real-write-packet.json>');
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
  console.error(JSON.stringify({
    status: 'REAL_WRITE_FAILED',
    owner: 'Project 04',
    reason: error.message,
    recovery: error.recovery ?? null,
    merge_allowed: false
  }, null, 2));
  process.exit(1);
}
