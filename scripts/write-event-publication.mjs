#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPacket } from './lib/event-publication-contract.mjs';
import { prepareRealWriteCandidate } from './lib/event-publication-write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packetArg = process.argv.find((arg) => arg.startsWith('--packet='));
const proofArg = process.argv.find((arg) => arg.startsWith('--proof='));

if (!packetArg || !proofArg) {
  console.error('Usage: node scripts/write-event-publication.mjs --packet=<path> --proof=<successful-dry-run-proof.json>');
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
const proofPath = path.resolve(ROOT, proofArg.slice('--proof='.length));

try {
  const packet = loadPacket(packetPath);
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  const branch = run('git', ['branch', '--show-current']);
  const existing = run('gh', ['pr', 'list', '--repo', 'jasonlamardjones/aprasa-site', '--head', branch, '--state', 'open', '--json', 'url']);
  if (JSON.parse(existing).length) throw new Error('DRAFT_PR_REFUSED: an open PR already exists for this branch');
  const result = prepareRealWriteCandidate({ root: ROOT, packet, packetPath, proof });

  run('git', ['add', '--', ...result.changed_files]);
  run('git', ['diff', '--cached', '--check']);
  const staged = run('git', ['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(staged) !== JSON.stringify([...result.changed_files].sort())) {
    throw new Error(`STAGED_SCOPE_MISMATCH: ${staged.join(', ')}`);
  }

  run('git', ['commit', '-m', `Prepare approved event publication: ${packet.event.title}`]);
  const candidateSha = run('git', ['rev-parse', 'HEAD']);
  run('git', ['push', '--set-upstream', 'origin', branch]);

  const prUrl = run('gh', [
    'pr', 'create', '--repo', 'jasonlamardjones/aprasa-site', '--draft', '--base', 'main', '--head', branch,
    '--title', `Publish approved event: ${packet.event.title}`,
    '--body-file', `automation/things-to-do/runs/${packet.event.id}.md`
  ]);

  console.log(JSON.stringify({
    ...result,
    status: 'FOUNDER_APPROVAL_REQUIRED',
    candidate_sha: candidateSha,
    draft_pr: prUrl,
    merge_allowed: false
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'REAL_WRITE_FAILED',
    owner: 'Project 04',
    reason: error.message,
    merge_allowed: false
  }, null, 2));
  process.exit(1);
}
