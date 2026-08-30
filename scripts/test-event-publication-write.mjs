#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mediaIntakeRoot, validatePacket } from './lib/event-publication-contract.mjs';
import {
  assertDryRunProof,
  assertRealWriteSafety,
  finalizeRealWriteCandidate,
  prepareRealWriteCandidate,
  rollbackRealWriteCandidate,
  runTrustedDryRun
} from './lib/event-publication-write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'automation/things-to-do/fixtures/ready-write.json';
const results = [];

function run(cwd, executable, args, { allowFailure = false } = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env: process.env });
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${executable} ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function record(name, fn, group = 'hardening') {
  try {
    fn();
    results.push({ name, group, status: 'PASS' });
  } catch (error) {
    results.push({ name, group, status: 'FAIL', reason: error.message });
  }
}

function expectState(packet, state, options = { root: ROOT, checkRepository: false }) {
  const result = validatePacket(packet, options);
  if (result.state !== state) throw new Error(`expected ${state}, got ${result.state}: ${JSON.stringify(result.issues)}`);
  return result;
}

function expectThrow(fn, pattern) {
  try {
    fn();
  } catch (error) {
    if (pattern.test(error.message)) return error;
    throw new Error(`wrong failure: ${error.message}`);
  }
  throw new Error('operation unexpectedly succeeded');
}

function assertClean(root, expectedHead = null) {
  const status = run(root, 'git', ['status', '--porcelain']);
  if (status) throw new Error(`repository was not restored: ${status}`);
  if (expectedHead && run(root, 'git', ['rev-parse', 'HEAD']) !== expectedHead) {
    throw new Error('repository HEAD changed unexpectedly');
  }
  if (expectedHead) {
    for (const relative of [
      'things-to-do/automation-fixture-guarded-write',
      'pt/things-to-do/automation-fixture-guarded-write',
      'data/locales/pt-overlay-event-automation-fixture-guarded-write.source.json',
      'automation/things-to-do/runs/automation-fixture-guarded-write.json',
      'automation/things-to-do/runs/automation-fixture-guarded-write.md'
    ]) {
      if (fs.existsSync(path.join(root, relative))) throw new Error(`rollback residue remained: ${relative}`);
    }
  }
}

function createRepository({ branch = 'feature/phase1b-test' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-phase1b-test-'));
  const remote = `${root}-remote.git`;
  fs.cpSync(ROOT, root, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
  run(root, 'git', ['init', '-q', '-b', 'main']);
  run(root, 'git', ['config', 'user.name', 'Phase 1B Test']);
  run(root, 'git', ['config', 'user.email', 'phase1b-test@aprasa.org']);
  run(root, 'git', ['add', '.']);
  run(root, 'git', ['commit', '-q', '-m', 'test baseline']);
  run(root, 'git', ['init', '--bare', '-q', remote]);
  run(root, 'git', ['remote', 'add', 'origin', remote]);
  run(root, 'git', ['push', '-q', '-u', 'origin', 'main']);
  const baseline = run(root, 'git', ['rev-parse', 'HEAD']);
  const packet = JSON.parse(fs.readFileSync(path.join(root, FIXTURE), 'utf8'));
  packet.control.expected_main_sha = baseline;
  const packetPath = path.join(root, '.git', 'phase1b-packet.json');
  fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  if (branch !== 'main') run(root, 'git', ['switch', '-q', '-c', branch]);
  return {
    root,
    remote,
    baseline,
    packet,
    packetPath,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
    }
  };
}

function withRepository(options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = {};
  }
  const context = createRepository(options);
  try {
    fn(context);
  } finally {
    context.cleanup();
  }
}

function writePacket(context, packet, name = 'mutated-packet.json') {
  const packetPath = path.join(context.root, '.git', name);
  fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  return packetPath;
}

function configureSuppliedAsset(context, mutate = () => {}) {
  const packet = clone(context.packet);
  const intake = mediaIntakeRoot(context.root);
  fs.mkdirSync(intake, { recursive: true });
  const source = path.join(intake, 'approved.jpg');
  const bytes = Buffer.from('approved fixture image bytes');
  fs.writeFileSync(source, bytes);
  packet.media.supplied_asset = source;
  packet.media.local_asset = `assets/events/${packet.event.id}.jpg`;
  packet.event.media.asset = packet.media.local_asset;
  packet.media.approved_manifest.media_asset = packet.media.local_asset;
  packet.media.asset_sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  mutate({ packet, source, intake, bytes });
  return packet;
}

const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, FIXTURE), 'utf8'));

record('owner approval missing', () => {
  const packet = clone(fixture);
  packet.governance.publication_authorized = false;
  expectState(packet, 'BLOCKED_OWNER_APPROVAL');
}, 'original');

record('Project 09 approval missing', () => {
  const packet = clone(fixture);
  packet.governance.project09_status = 'approval_required';
  expectState(packet, 'BLOCKED_LOCALIZATION');
}, 'original');

record('media review required', () => {
  const packet = clone(fixture);
  packet.media.rights_status = 'review_required';
  expectState(packet, 'BLOCKED_MEDIA');
}, 'original');

record('malformed input', () => {
  const packet = clone(fixture);
  packet.event.title = '';
  expectState(packet, 'INVALID_INPUT');
}, 'original');

record('merge_allowed remains false', () => {
  const packet = clone(fixture);
  packet.control.merge_allowed = true;
  expectState(packet, 'INVALID_INPUT');
}, 'original');

record('write attempt without successful dry run', () => withRepository((ctx) => {
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, testHooks: { failDryRun: true } }), /DRY_RUN_FAILED/);
  assertClean(ctx.root, ctx.baseline);
}), 'original');

record('direct-main write protection', () => withRepository({ branch: 'main' }, (ctx) => {
  expectThrow(() => prepareRealWriteCandidate(ctx), /DIRECT_MAIN_WRITE_REFUSED/);
  assertClean(ctx.root, ctx.baseline);
}), 'original');

record('induced validator failure', () => withRepository((ctx) => {
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, testHooks: { induceValidatorFailure: true } }), /validate-things-to-do-events/);
  assertClean(ctx.root, ctx.baseline);
}), 'original');

record('unexpected changed-file scope', () => withRepository((ctx) => {
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, testHooks: { addUnexpectedFile: true } }), /UNEXPECTED_CHANGED_FILE_SCOPE/);
  assertClean(ctx.root, ctx.baseline);
}), 'original');

record('successful guarded write using non-public fixture', () => withRepository((ctx) => {
  const result = prepareRealWriteCandidate(ctx);
  if (result.status !== 'FOUNDER_APPROVAL_REQUIRED' || result.merge_allowed !== false || !result.idempotent) {
    throw new Error('successful result did not retain approval stop gate');
  }
  rollbackRealWriteCandidate(ctx.root, result);
  assertClean(ctx.root, ctx.baseline);
}), 'original');

const proofContext = createRepository();
let trustedProof;
let proofSafety;
try {
  proofSafety = assertRealWriteSafety(proofContext.root, proofContext.packet);
  trustedProof = runTrustedDryRun(proofContext.root, proofContext.packet, proofContext.packetPath, proofSafety);
} catch (error) {
  proofContext.cleanup();
  throw error;
}

record('forged proof is rejected', () => {
  const forged = { ...trustedProof, status: 'REVIEW_READY', packet_sha256: '0'.repeat(64) };
  expectThrow(() => assertDryRunProof(proofContext.root, proofContext.packet, proofContext.packetPath, forged, proofSafety.head, proofSafety.authoritativeMain), /PROOF_MISMATCH/);
});

record('modified packet invalidates proof', () => {
  const packet = clone(proofContext.packet);
  packet.event.summary = `${packet.event.summary} changed`;
  const packetPath = writePacket(proofContext, packet, 'modified-packet.json');
  expectThrow(() => assertDryRunProof(proofContext.root, packet, packetPath, trustedProof, proofSafety.head, proofSafety.authoritativeMain), /PROOF_MISMATCH/);
});

record('changed as_of invalidates proof', () => {
  const packet = clone(proofContext.packet);
  packet.control.as_of = '2026-08-30';
  const packetPath = writePacket(proofContext, packet, 'changed-as-of.json');
  expectThrow(() => assertDryRunProof(proofContext.root, packet, packetPath, trustedProof, proofSafety.head, proofSafety.authoritativeMain), /PROOF_MISMATCH|PROOF_STALE/);
});

record('mismatched proof changed-file inventory is rejected', () => {
  const proof = { ...trustedProof, changed_files: [...trustedProof.changed_files, 'unexpected.txt'] };
  expectThrow(() => assertDryRunProof(proofContext.root, proofContext.packet, proofContext.packetPath, proof, proofSafety.head, proofSafety.authoritativeMain), /PROOF_SCOPE_MISMATCH/);
});

record('missing or false validation stages are rejected', () => {
  const missing = { ...trustedProof, validation_steps: trustedProof.validation_steps.slice(0, -1) };
  expectThrow(() => assertDryRunProof(proofContext.root, proofContext.packet, proofContext.packetPath, missing, proofSafety.head, proofSafety.authoritativeMain), /PROOF_INCOMPLETE/);
  const falseStage = { ...trustedProof, validation_steps: trustedProof.validation_steps.map((step, index) => index ? step : 'false-validator') };
  expectThrow(() => assertDryRunProof(proofContext.root, proofContext.packet, proofContext.packetPath, falseStage, proofSafety.head, proofSafety.authoritativeMain), /PROOF_INCOMPLETE/);
});

record('changed HEAD invalidates proof', () => {
  expectThrow(() => assertDryRunProof(proofContext.root, proofContext.packet, proofContext.packetPath, trustedProof, '1'.repeat(40), proofSafety.authoritativeMain), /PROOF_STALE/);
});

record('stale proof cannot authorize production write', () => {
  expectThrow(() => prepareRealWriteCandidate({ ...proofContext, proof: trustedProof, testHooks: { failDryRun: true } }), /DRY_RUN_FAILED/);
  assertClean(proofContext.root, proofContext.baseline);
});

proofContext.cleanup();

record('authoritative remote main defeats stale cached origin/main', () => withRepository((ctx) => {
  const updater = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-remote-main-update-'));
  try {
    run(updater, 'git', ['clone', '-q', '--branch', 'main', ctx.remote, '.']);
    run(updater, 'git', ['config', 'user.name', 'Remote Main Test']);
    run(updater, 'git', ['config', 'user.email', 'remote-main-test@aprasa.org']);
    fs.writeFileSync(path.join(updater, 'remote-main-change.txt'), 'remote main advanced\n');
    run(updater, 'git', ['add', 'remote-main-change.txt']);
    run(updater, 'git', ['commit', '-q', '-m', 'advance remote main']);
    run(updater, 'git', ['push', '-q', 'origin', 'main']);
    if (run(ctx.root, 'git', ['rev-parse', 'origin/main']) !== ctx.baseline) throw new Error('cached origin/main unexpectedly moved');
    expectThrow(() => assertRealWriteSafety(ctx.root, ctx.packet), /STALE_MAIN_REFUSED/);
  } finally {
    fs.rmSync(updater, { recursive: true, force: true });
  }
}));

record('../ media destination traversal is rejected', () => {
  const packet = clone(fixture);
  packet.media.local_asset = 'assets/events/../escape.jpg';
  packet.event.media.asset = packet.media.local_asset;
  packet.media.approved_manifest.media_asset = packet.media.local_asset;
  expectState(packet, 'INVALID_INPUT');
});

record('arbitrary repository media destination is rejected', () => {
  const packet = clone(fixture);
  packet.media.local_asset = 'docs/fixture.jpg';
  packet.event.media.asset = packet.media.local_asset;
  packet.media.approved_manifest.media_asset = packet.media.local_asset;
  expectState(packet, 'INVALID_INPUT');
});

record('disallowed media extension is rejected', () => {
  const packet = clone(fixture);
  packet.media.local_asset = 'assets/events/fixture.svg';
  packet.event.media.asset = packet.media.local_asset;
  packet.media.approved_manifest.media_asset = packet.media.local_asset;
  expectState(packet, 'INVALID_INPUT');
});

record('absolute supplied source outside intake root is rejected', () => withRepository((ctx) => {
  const outside = path.join(os.tmpdir(), `outside-${crypto.randomUUID()}.jpg`);
  fs.writeFileSync(outside, 'outside');
  try {
    const packet = configureSuppliedAsset(ctx, ({ packet }) => {
      packet.media.supplied_asset = outside;
      packet.media.asset_sha256 = crypto.createHash('sha256').update('outside').digest('hex');
    });
    expectState(packet, 'BLOCKED_MEDIA', { root: ctx.root, checkRepository: true });
  } finally {
    fs.rmSync(outside, { force: true });
  }
}));

record('supplied source symlink escape is rejected', () => withRepository((ctx) => {
  const packet = configureSuppliedAsset(ctx);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-media-outside-'));
  const outsideFile = path.join(outside, 'escape.jpg');
  fs.writeFileSync(outsideFile, 'escape');
  const link = path.join(mediaIntakeRoot(ctx.root), 'escape-link');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    packet.media.supplied_asset = path.join(link, 'escape.jpg');
    packet.media.asset_sha256 = crypto.createHash('sha256').update('escape').digest('hex');
    expectState(packet, 'BLOCKED_MEDIA', { root: ctx.root, checkRepository: true });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}));

record('supplied media hash mismatch is rejected', () => withRepository((ctx) => {
  const packet = configureSuppliedAsset(ctx, ({ packet }) => { packet.media.asset_sha256 = '0'.repeat(64); });
  expectState(packet, 'BLOCKED_MEDIA', { root: ctx.root, checkRepository: true });
}));

record('supplied media target collision is rejected', () => withRepository((ctx) => {
  const packet = configureSuppliedAsset(ctx);
  fs.writeFileSync(path.join(ctx.root, packet.media.local_asset), 'existing target');
  expectState(packet, 'BLOCKED_MEDIA', { root: ctx.root, checkRepository: true });
}));

record('interrupted promotion restores exact worktree', () => withRepository((ctx) => {
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, testHooks: { interruptPromotionAfter: 1 } }), /INDUCED_PROMOTION_INTERRUPTION/);
  assertClean(ctx.root, ctx.baseline);
}));

record('staging failure restores exact worktree', () => withRepository((ctx) => {
  const result = prepareRealWriteCandidate(ctx);
  const error = expectThrow(() => finalizeRealWriteCandidate({ root: ctx.root, packet: ctx.packet, result, repository: null, testHooks: { induceStagingFailure: true } }), /INDUCED_STAGING_FAILURE/);
  if (error.recovery?.worktree_restored !== true) throw new Error('staging recovery was not reported');
  assertClean(ctx.root, ctx.baseline);
}));

record('commit failure restores exact worktree', () => withRepository((ctx) => {
  const result = prepareRealWriteCandidate(ctx);
  const error = expectThrow(() => finalizeRealWriteCandidate({ root: ctx.root, packet: ctx.packet, result, repository: null, testHooks: { induceCommitFailure: true } }), /INDUCED_COMMIT_FAILURE/);
  if (error.recovery?.phase !== 'PRE_COMMIT') throw new Error('commit failure recovery phase was not explicit');
  assertClean(ctx.root, ctx.baseline);
}));

record('push failure preserves and reports committed candidate', () => withRepository((ctx) => {
  const result = prepareRealWriteCandidate(ctx);
  const error = expectThrow(() => finalizeRealWriteCandidate({ root: ctx.root, packet: ctx.packet, result, repository: null, testHooks: { inducePushFailure: true } }), /INDUCED_PUSH_FAILURE/);
  if (error.recovery?.phase !== 'POST_COMMIT' || error.recovery.pushed !== false || !error.recovery.head_sha) {
    throw new Error('push recovery state was incomplete');
  }
  assertClean(ctx.root);
}));

record('PR-creation failure reports pushed commit and deterministic resume', () => withRepository((ctx) => {
  const result = prepareRealWriteCandidate(ctx);
  const error = expectThrow(() => finalizeRealWriteCandidate({ root: ctx.root, packet: ctx.packet, result, repository: null, testHooks: { inducePrFailure: true } }), /INDUCED_PR_CREATION_FAILURE/);
  if (error.recovery?.phase !== 'POST_COMMIT' || error.recovery.pushed !== true || error.recovery.pr_exists !== false) {
    throw new Error('PR recovery state was incomplete');
  }
  assertClean(ctx.root);
}));

for (const result of results) {
  console.log(`${result.status} — ${result.name}${result.reason ? `: ${result.reason}` : ''}`);
}
const failures = results.filter((result) => result.status === 'FAIL');
const originals = results.filter((result) => result.group === 'original');
const originalFailures = originals.filter((result) => result.status === 'FAIL');
console.log(`\nOriginal Phase 1B guarded-write tests: ${originals.length - originalFailures.length}/${originals.length} passed.`);
console.log(`Complete Phase 1B safety tests: ${results.length - failures.length}/${results.length} passed.`);
if (failures.length) process.exit(1);
