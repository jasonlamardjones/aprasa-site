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

const CURRENTNESS_FILE = 'data/things-to-do-currentness.json';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Test-only synthetic lifecycle-boundary record. It exists solely inside an
// isolated temporary repository so the deliberate-divergence regression below
// owns its own CURRENT -> EXPIRED transition instead of borrowing one from the
// governed corpus. Borrowing one is what produced the previous date treadmill:
// a live record with a conveniently future expiry stops being convenient the
// moment it expires, and nothing in the corpus is obliged to keep supplying a
// replacement. Day precision only; REVIEW_DUE is a month-precision
// reverification signal, never an expiry transition, so it is never used here.
const BOUNDARY_ID = 'phase1b-temp-lifecycle-boundary';
const BOUNDARY_TITLE = 'Phase 1B Temporary Lifecycle Boundary';

function readCommittedCurrentness(root) {
  const value = JSON.parse(fs.readFileSync(path.join(root, CURRENTNESS_FILE), 'utf8')).as_of;
  if (!ISO_DAY.test(value ?? '')) {
    throw new Error(`committed currentness baseline is not an ISO day: ${JSON.stringify(value)}`);
  }
  return value;
}

// Day arithmetic on the committed baseline, never on the system clock: every
// date this harness derives is a function of what the repository has committed,
// so the same implementation keeps passing as that baseline moves.
function shiftDay(day, days) {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function renderDay(day, locale) {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${day}T00:00:00Z`));
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function insertHomeMarkers(root, relative, id) {
  const file = path.join(root, relative);
  let html = fs.readFileSync(file, 'utf8');
  const begin = `<!-- BEGIN GENERATED EVENT: ${id} -->`;
  const end = `<!-- END GENERATED EVENT: ${id} -->`;
  if (html.includes(begin) || html.includes(end)) throw new Error(`${relative} already contains ${id}`);
  const matches = [...html.matchAll(/<!-- END GENERATED EVENT: [a-z0-9]+(?:-[a-z0-9]+)* -->/g)];
  if (!matches.length) throw new Error(`${relative} has no incumbent event markers`);
  const last = matches.at(-1);
  const at = last.index + last[0].length;
  html = `${html.slice(0, at)}\n        ${begin}\n        ${end}${html.slice(at)}`;
  fs.writeFileSync(file, html);
}

// The canonical generator sequence, identical to the one the guarded write
// itself runs. The temporary repository is rebuilt through it so its committed
// baseline is self-consistent at whichever currentness date the case simulates.
function runCanonicalGenerators(root, asOf) {
  run(root, process.execPath, ['scripts/build-locale-data.mjs']);
  run(root, process.execPath, ['scripts/generate-things-to-do.mjs', `--as-of=${asOf}`, '--locale=en', '--write']);
  run(root, process.execPath, ['scripts/build-static-pages.mjs', '--write']);
  run(root, process.execPath, ['scripts/generate-things-to-do.mjs', `--as-of=${asOf}`, '--locale=pt', '--home=pt/index.html', '--write']);
  run(root, process.execPath, ['scripts/build-sitemap.mjs', '--write']);
}

// Derive the synthetic record from the committed fixture packet so it carries a
// complete, already-approved shape (event, media manifest, PT package) without
// inventing governed content. Its id, detail route and title are rewritten so it
// can never collide with a governed record, and its day-precision end_date is
// pinned to `boundary`: CURRENT at `boundary`, EXPIRED at `boundary` + 1 day.
function installBoundaryRecord(root, boundary) {
  const source = JSON.parse(fs.readFileSync(path.join(root, FIXTURE), 'utf8'));
  const derived = JSON.parse(
    JSON.stringify(source)
      .split(source.event.id).join(BOUNDARY_ID)
      .split(source.event.title).join(BOUNDARY_TITLE)
  );

  const en = renderDay(boundary, 'en-GB');
  const pt = renderDay(boundary, 'pt-PT');
  const event = derived.event;
  event.start_datetime = `${boundary}T18:30:00-01:00`;
  event.end_date = boundary;
  event.checked_at = boundary;
  event.display.status = `${en} · 18:30`;
  event.display.checked = `Checked ${en}`;
  event.detail.facts[0].value = `${en} · 18:30`;
  event.detail.checked = `Checked ${en} against the approved fixture packet.`;

  const ptText = {
    [`event.${BOUNDARY_ID}.display.status`]: [`${en} · 18:30`, `${pt} · 18:30`],
    [`event.${BOUNDARY_ID}.display.checked`]: [`Checked ${en}`, `Revisto em ${pt}`],
    [`event.${BOUNDARY_ID}.detail.fact.date.value_display`]: [`${en} · 18:30`, `${pt} · 18:30`],
    [`event.${BOUNDARY_ID}.detail.checked`]: [
      `Checked ${en} against the approved fixture packet.`,
      `Revisto em ${pt} contra o pacote de teste aprovado.`
    ]
  };
  for (const [key, [sourceEn, ptValue]] of Object.entries(ptText)) {
    derived.localization.pt_values[key] = ptValue;
    const row = derived.localization.approved_package.rows.find((item) => item.key === key);
    if (!row) throw new Error(`synthetic boundary record is missing PT row ${key}`);
    row.source_en = sourceEn;
    row.pt = ptValue;
  }

  const eventsPath = path.join(root, 'data', 'things-to-do-events.json');
  const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
  events.records.push(event);
  writeJsonFile(eventsPath, events);

  const manifestPath = path.join(root, 'internal', 'provider-media-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestRecord = derived.media.approved_manifest;
  manifestRecord.media_checked_date = boundary;
  manifest.records.push(manifestRecord);
  writeJsonFile(manifestPath, manifest);

  writeJsonFile(path.join(root, 'data', 'locales', `pt-overlay-event-${BOUNDARY_ID}.source.json`), {
    ...derived.localization.approved_package,
    event_id: BOUNDARY_ID,
    supplied_rows_approved: derived.localization.approved_package.rows.length,
    review_required: 0,
    blocking_issue: null
  });

  insertHomeMarkers(root, 'index.html', BOUNDARY_ID);
  insertHomeMarkers(root, path.join('pt', 'index.html'), BOUNDARY_ID);
}

const BOUNDARY_ROUTES = [
  `things-to-do/${BOUNDARY_ID}/index.html`,
  `pt/things-to-do/${BOUNDARY_ID}/index.html`
];

// The temporary repository owns the normal success path's currentness binding.
//
// Project 03 ruling A: the harness may read committed repository currentness and
// bind the TEST COPY of the packet to it. The committed historical literal in
// the fixture is deliberately left alone -- statically repinning it only moves
// the treadmill to the next baseline advance. Production code still receives an
// explicit control.as_of and still derives nothing.
//
//   committedAsOf  simulate a different committed baseline in the temporary
//                  repository (the repository is rebuilt through the canonical
//                  generators so its committed state stays self-consistent).
//   boundaryDay    install the test-only synthetic lifecycle-boundary record
//                  with a day-precision end_date pinned to this day.
//   asOf           override the test packet's control.as_of. Only the
//                  deliberate cross-boundary divergence case supplies this;
//                  every normal case stays bound to committed currentness.
function createRepository({ branch = 'feature/phase1b-test', committedAsOf = null, boundaryDay = null, asOf = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-phase1b-test-'));
  const remote = `${root}-remote.git`;
  fs.cpSync(ROOT, root, { recursive: true, filter: (src) => path.basename(src) !== '.git' });

  if (committedAsOf) {
    if (!ISO_DAY.test(committedAsOf)) throw new Error(`simulated committed baseline is not an ISO day: ${committedAsOf}`);
    writeJsonFile(path.join(root, CURRENTNESS_FILE), { ...JSON.parse(fs.readFileSync(path.join(root, CURRENTNESS_FILE), 'utf8')), as_of: committedAsOf });
  }
  if (boundaryDay) installBoundaryRecord(root, boundaryDay);
  const committed = readCommittedCurrentness(root);
  if (committedAsOf || boundaryDay) runCanonicalGenerators(root, committed);

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
  // The complete explicit packet is written once, before any proof exists, so
  // the bound as_of is inside the exact bytes the dry-run proof digests.
  packet.control.as_of = asOf ?? committed;
  if (!ISO_DAY.test(packet.control.as_of)) throw new Error(`test packet control.as_of is not an explicit ISO day: ${JSON.stringify(packet.control.as_of)}`);
  const packetPath = path.join(root, '.git', 'phase1b-packet.json');
  fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  if (branch !== 'main') run(root, 'git', ['switch', '-q', '-c', branch]);
  return {
    root,
    remote,
    baseline,
    committed,
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

record('dry-run proof binds the committed-baseline as_of it was created from', () => {
  if (trustedProof.as_of !== proofContext.committed) {
    throw new Error(`proof as_of ${trustedProof.as_of} is not the committed baseline ${proofContext.committed}`);
  }
  const onDisk = JSON.parse(fs.readFileSync(proofContext.packetPath, 'utf8'));
  if (onDisk.control.as_of !== trustedProof.as_of || proofContext.packet.control.as_of !== trustedProof.as_of) {
    throw new Error('packet as_of drifted away from the proof after the proof was created');
  }
  // The bound as_of is inside the exact bytes the proof digests, so the proof
  // still validates against the unmodified packet and nothing else.
  assertDryRunProof(proofContext.root, proofContext.packet, proofContext.packetPath, trustedProof, proofSafety.head, proofSafety.authoritativeMain);
});

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

// --- Project 03 ruling A: committed-baseline binding ------------------------

record('normal test packet carries an explicit ISO control.as_of equal to committed currentness', () => withRepository((ctx) => {
  const committed = readCommittedCurrentness(ctx.root);
  const onDisk = JSON.parse(fs.readFileSync(ctx.packetPath, 'utf8'));
  if (!ISO_DAY.test(onDisk.control.as_of ?? '')) {
    throw new Error(`test packet control.as_of is not an explicit ISO day: ${JSON.stringify(onDisk.control.as_of)}`);
  }
  if (onDisk.control.as_of !== committed) {
    throw new Error(`test packet control.as_of ${onDisk.control.as_of} is not the committed baseline ${committed}`);
  }
  if (onDisk.control.as_of !== ctx.packet.control.as_of) {
    throw new Error('in-memory packet and the on-disk test packet disagree on control.as_of');
  }
  expectState(onDisk, 'READY_FOR_IMPLEMENTATION', { root: ctx.root, checkRepository: true });
}), 'baseline-binding');

// The binding follows the repository, not the fixture's committed literal.
// This is the whole reason the literal does not need re-pinning.
record('bound test packet follows committed currentness, not the committed fixture literal', () => {
  const simulated = shiftDay(readCommittedCurrentness(ROOT), 3);
  if (fixture.control.as_of === simulated) throw new Error('simulated baseline must differ from the committed fixture literal');
  withRepository({ committedAsOf: simulated }, (ctx) => {
    if (ctx.packet.control.as_of !== simulated) {
      throw new Error(`test packet control.as_of ${ctx.packet.control.as_of} did not follow the committed baseline ${simulated}`);
    }
    if (!ISO_DAY.test(fixture.control.as_of ?? '')) throw new Error('committed fixture must retain an explicit ISO control.as_of');
  });
}, 'baseline-binding');

// Binding happens only in the test copy. The real contract is unchanged and
// still refuses a packet that does not carry a valid explicit control.as_of.
record('real packet validation still rejects missing or malformed control.as_of', () => {
  for (const value of [undefined, null, '', '2026-9-1', '2026-02-30', '20260901', 'today']) {
    const packet = clone(fixture);
    if (value === undefined) delete packet.control.as_of;
    else packet.control.as_of = value;
    expectState(packet, 'INVALID_INPUT');
  }
}, 'baseline-binding');

// Regression matrix: the same harness implementation, no fixture re-pinning
// between cases. With the current committed baseline these resolve to the
// historical baseline, 2026-09-01, and a later baseline that has already
// crossed a day-precision CURRENT -> EXPIRED boundary.
const committedBaseline = readCommittedCurrentness(ROOT);
for (const { label, options } of [
  { label: `committed baseline ${committedBaseline}`, options: {} },
  { label: `advanced baseline ${shiftDay(committedBaseline, 3)}`, options: { committedAsOf: shiftDay(committedBaseline, 3) } },
  {
    label: `later baseline ${shiftDay(committedBaseline, 10)} past a day-precision boundary`,
    options: { committedAsOf: shiftDay(committedBaseline, 10), boundaryDay: shiftDay(committedBaseline, 9) }
  }
]) {
  record(`guarded write succeeds at ${label}`, () => withRepository(options, (ctx) => {
    if (ctx.packet.control.as_of !== ctx.committed) throw new Error('test packet was not bound to committed currentness');
    const result = prepareRealWriteCandidate(ctx);
    if (result.status !== 'FOUNDER_APPROVAL_REQUIRED' || result.merge_allowed !== false || !result.idempotent) {
      throw new Error('successful result did not retain approval stop gate');
    }
    if (result.as_of !== ctx.committed) throw new Error(`candidate as_of ${result.as_of} is not the committed baseline ${ctx.committed}`);
    rollbackRealWriteCandidate(ctx.root, result);
    assertClean(ctx.root, ctx.baseline);
  }), 'baseline-binding');
}

// The negative half of the ruling: binding the normal path must not disarm the
// bounded-diff guard. A deliberately divergent control.as_of moves the
// synthetic record across its own day-precision boundary, which moves derived
// surfaces the packet never authorized, and the guard must still refuse.
record('deliberate cross-boundary as_of divergence is refused', () => {
  const committed = readCommittedCurrentness(ROOT);
  const divergent = shiftDay(committed, 1);
  withRepository({ boundaryDay: committed, asOf: divergent }, (ctx) => {
    if (ctx.packet.control.as_of !== divergent || ctx.committed === divergent) {
      throw new Error('divergence case did not actually diverge from committed currentness');
    }
    const error = expectThrow(() => prepareRealWriteCandidate(ctx), /STATUS: VALIDATION_FAILED[\s\S]*Unexpected dry-run diff scope/);
    for (const route of BOUNDARY_ROUTES) {
      if (!error.message.includes(route)) {
        throw new Error(`refusal did not name the synthetic lifecycle-boundary surface ${route}`);
      }
    }
    assertClean(ctx.root, ctx.baseline);
  });
}, 'baseline-binding');

for (const result of results) {
  console.log(`${result.status} — ${result.name}${result.reason ? `: ${result.reason}` : ''}`);
}
const failures = results.filter((result) => result.status === 'FAIL');
const originals = results.filter((result) => result.group === 'original');
const originalFailures = originals.filter((result) => result.status === 'FAIL');
console.log(`\nOriginal Phase 1B guarded-write tests: ${originals.length - originalFailures.length}/${originals.length} passed.`);
console.log(`Complete Phase 1B safety tests: ${results.length - failures.length}/${results.length} passed.`);
if (failures.length) process.exit(1);
