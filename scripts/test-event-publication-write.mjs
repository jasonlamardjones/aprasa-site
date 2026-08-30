#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePacket } from './lib/event-publication-contract.mjs';
import { prepareRealWriteCandidate } from './lib/event-publication-write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'automation/things-to-do/fixtures/ready-write.json';
const results = [];

function run(cwd, executable, args) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env: process.env });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${executable} ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function record(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS' });
  } catch (error) {
    results.push({ name, status: 'FAIL', reason: error.message });
  }
}

function expectState(packet, state) {
  const result = validatePacket(packet, { root: ROOT, checkRepository: false });
  if (result.state !== state) throw new Error(`expected ${state}, got ${result.state}`);
}

function expectThrow(fn, pattern) {
  try {
    fn();
  } catch (error) {
    if (pattern.test(error.message)) return;
    throw new Error(`wrong failure: ${error.message}`);
  }
  throw new Error('operation unexpectedly succeeded');
}

function withRepository({ branch = 'feature/phase1b-test', proof = true } = {}, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-phase1b-test-'));
  try {
    fs.cpSync(ROOT, root, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
    run(root, 'git', ['init', '-q', '-b', 'main']);
    run(root, 'git', ['config', 'user.name', 'Phase 1B Test']);
    run(root, 'git', ['config', 'user.email', 'phase1b-test@aprasa.org']);
    run(root, 'git', ['add', '.']);
    run(root, 'git', ['commit', '-q', '-m', 'test baseline']);
    if (branch !== 'main') run(root, 'git', ['switch', '-q', '-c', branch]);
    const packetPath = path.join(root, FIXTURE);
    const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
    let proofValue = null;
    if (proof) {
      run(root, process.execPath, ['scripts/prepare-event-publication.mjs', `--packet=${FIXTURE}`, '--proof=.git/phase1b-proof.json']);
      proofValue = JSON.parse(fs.readFileSync(path.join(root, '.git', 'phase1b-proof.json'), 'utf8'));
    }
    fn({ root, packet, packetPath, proof: proofValue });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, FIXTURE), 'utf8'));

record('owner approval missing', () => {
  const packet = clone(fixture);
  packet.governance.publication_authorized = false;
  expectState(packet, 'BLOCKED_OWNER_APPROVAL');
});

record('Project 09 approval missing', () => {
  const packet = clone(fixture);
  packet.governance.project09_status = 'approval_required';
  expectState(packet, 'BLOCKED_LOCALIZATION');
});

record('media review required', () => {
  const packet = clone(fixture);
  packet.media.rights_status = 'review_required';
  expectState(packet, 'BLOCKED_MEDIA');
});

record('malformed input', () => {
  const packet = clone(fixture);
  packet.event.title = '';
  expectState(packet, 'INVALID_INPUT');
});

record('merge_allowed remains false', () => {
  const packet = clone(fixture);
  packet.control.merge_allowed = true;
  expectState(packet, 'INVALID_INPUT');
});

record('write attempt without successful dry run', () => withRepository({ proof: false }, (ctx) => {
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, requireOrigin: false, allowTestBaseline: true }), /DRY_RUN_PROOF_REQUIRED/);
}));

record('direct-main write protection', () => withRepository({ branch: 'main' }, (ctx) => {
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, requireOrigin: false, allowTestBaseline: true }), /DIRECT_MAIN_WRITE_REFUSED/);
}));

record('induced validator failure', () => withRepository({}, (ctx) => {
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, requireOrigin: false, allowTestBaseline: true, testHooks: { induceValidatorFailure: true } }), /validate-things-to-do-events/);
}));

record('unexpected changed-file scope', () => withRepository({}, (ctx) => {
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, requireOrigin: false, allowTestBaseline: true, testHooks: { addUnexpectedFile: true } }), /UNEXPECTED_CHANGED_FILE_SCOPE/);
}));

record('successful guarded write using non-public fixture', () => withRepository({}, (ctx) => {
  const result = prepareRealWriteCandidate({ ...ctx, requireOrigin: false, allowTestBaseline: true });
  if (result.status !== 'FOUNDER_APPROVAL_REQUIRED' || result.merge_allowed !== false || !result.idempotent) {
    throw new Error('successful result did not retain approval stop gate');
  }
  const status = run(ctx.root, 'git', ['status', '--porcelain']);
  if (!status.includes('automation-fixture-guarded-write')) throw new Error('fixture candidate was not written to isolated repository');
}));

for (const result of results) {
  console.log(`${result.status} — ${result.name}${result.reason ? `: ${result.reason}` : ''}`);
}
const failures = results.filter((result) => result.status === 'FAIL');
console.log(`\nPhase 1B guarded-write tests: ${results.length - failures.length}/${results.length} passed.`);
if (failures.length) process.exit(1);
