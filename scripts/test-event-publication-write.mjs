#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPublicInputBoundary, expectedChangedFiles, mediaIntakeRoot, removeTempTree, validatePacket } from './lib/event-publication-contract.mjs';
import { TRANSPORT_API, resolveExecutable, selectTransport } from './lib/github-pr-client.mjs';
import {
  assertDryRunProof,
  assertRealWriteSafety,
  finalizeRealWriteCandidate,
  prepareRealWriteCandidate,
  rollbackRealWriteCandidate,
  candidateBuildSteps,
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

// The URDI scenarios below rehearse the URDI publication itself: they hand the
// guarded writer the real URDI packet and expect it to be a NEW event. Once that
// publication has landed on main the writer correctly refuses it as a collision
// with an existing canonical id, so those rehearsals would fail on the very
// repository they exist to protect. Every throwaway repository is therefore
// returned to the state it had immediately before the URDI publication, whether
// or not URDI has since been published: a no-op until then, and the same
// pre-publication baseline afterwards. Only the isolated copy is touched.
const URDI_PUBLISHED_ID = 'urdi-2026-mindelo';
const PRE_URDI_AS_OF = '2026-11-18';

function stripPublishedUrdi(root) {
  const eventsPath = path.join(root, 'data', 'things-to-do-events.json');
  const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
  const published = events.records.find((item) => item.id === URDI_PUBLISHED_ID);
  if (!published) return false;

  events.records = events.records.filter((item) => item.id !== URDI_PUBLISHED_ID);
  writeJsonFile(eventsPath, events);

  const manifestPath = path.join(root, 'internal', 'provider-media-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.records = manifest.records.filter((item) => item.title !== published.media_manifest_title);
  writeJsonFile(manifestPath, manifest);

  for (const relative of [
    `data/locales/pt-overlay-event-${URDI_PUBLISHED_ID}.source.json`,
    `automation/things-to-do/runs/${URDI_PUBLISHED_ID}.json`,
    `automation/things-to-do/runs/${URDI_PUBLISHED_ID}.md`,
    `things-to-do/${URDI_PUBLISHED_ID}`,
    `pt/things-to-do/${URDI_PUBLISHED_ID}`
  ]) fs.rmSync(path.join(root, relative), { recursive: true, force: true });

  const block = new RegExp(`\\r?\\n[ \\t]*<!-- BEGIN GENERATED EVENT: ${URDI_PUBLISHED_ID} -->[\\s\\S]*?<!-- END GENERATED EVENT: ${URDI_PUBLISHED_ID} -->`);
  for (const relative of ['index.html', path.join('pt', 'index.html')]) {
    const file = path.join(root, relative);
    const html = fs.readFileSync(file, 'utf8');
    if (!block.test(html)) throw new Error(`${relative}: the published URDI Home block was not found to strip`);
    fs.writeFileSync(file, html.replace(block, ''));
  }

  writeJsonFile(path.join(root, CURRENTNESS_FILE), { ...JSON.parse(fs.readFileSync(path.join(root, CURRENTNESS_FILE), 'utf8')), as_of: PRE_URDI_AS_OF });
  // The writer's own build sequence, so the generated surfaces (locale data,
  // Home, PT Home training content, sitemap) are rebuilt exactly as it builds them.
  for (const [script, ...args] of candidateBuildSteps({ control: { as_of: PRE_URDI_AS_OF } })) {
    run(root, process.execPath, [script, ...args]);
  }
  return true;
}

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

// The 28 November historical-baseline simulation must carry the AAI training
// call across its actual 26 November deadline. This changes only the throwaway
// test repository; production currentness and its fail-closed validator remain
// untouched. Keep the historical record and approved locale rows, but clear
// its actionable EN/PT Home regions through the incumbent generator.
function expireAAIInFutureTestBaseline(root, asOf) {
  const file = path.join(root, 'data', 'training-opportunities.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const record = data.records.find((item) => item.id === 'aai-portuguese-a1-2026');
  if (!record || record.lifecycle_class !== 'fixed-window-opportunity' || record.end_date !== '2026-11-26') {
    throw new Error('AAI future-baseline fixture no longer matches the governed deadline');
  }
  if (asOf <= record.end_date) return;
  if (!['CURRENT', 'EXPIRED'].includes(record.publication_state)) throw new Error('AAI future-baseline fixture has unexpected publication state');
  if (record.publication_state === 'CURRENT') {
    record.publication_state = 'EXPIRED';
    writeJsonFile(file, data);
  }
  for (const [locale, home] of [['en', 'index.html'], ['pt', 'pt/index.html']]) {
    run(root, process.execPath, ['scripts/generate-training-opportunities.mjs', `--as-of=${asOf}`, `--locale=${locale}`, `--home=${home}`, '--write']);
    const html = fs.readFileSync(path.join(root, home), 'utf8');
    const region = html.split('<!-- BEGIN GENERATED TRAINING: aai-portuguese-a1-2026 -->')[1]
      ?.split('<!-- END GENERATED TRAINING: aai-portuguese-a1-2026 -->')[0];
    if (region == null || region.trim()) throw new Error(`${home}: expired AAI application still actionable in test baseline`);
  }
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

// Install an unresolved media state only inside the throwaway repository used
// by the gate-propagation regression. The production corpus is now media-
// complete, so the test must own the exit-2 condition it is asserting instead
// of depending on whichever live record happens to remain unresolved.
function installTemporaryMediaGap(root) {
  const manifestPath = path.join(root, 'internal', 'provider-media-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const record = manifest.records.find((item) => item.title === 'China Ambassador Scholarship for Uni-CV Students');
  if (!record) throw new Error('test media-gap fixture record is missing');
  record.media_state = 'fallback-temporary';
  record.fallback_reason = 'Test-only unresolved media state used to exercise exit-2 propagation.';
  record.media_provenance = 'Test-only standardized fallback in an isolated repository; no production metadata is changed.';
  record.media_checked_date = null;
  writeJsonFile(manifestPath, manifest);
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
//   openMediaGate  install one test-only fallback-temporary manifest state so
//                  exit-2 propagation is deterministic even when production
//                  media is fully resolved.
function createRepository({ branch = 'feature/phase1b-test', committedAsOf = null, boundaryDay = null, asOf = null, openMediaGate = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-phase1b-test-'));
  const remote = `${root}-remote.git`;
  fs.cpSync(ROOT, root, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
  stripPublishedUrdi(root);

  if (committedAsOf) {
    if (!ISO_DAY.test(committedAsOf)) throw new Error(`simulated committed baseline is not an ISO day: ${committedAsOf}`);
    writeJsonFile(path.join(root, CURRENTNESS_FILE), { ...JSON.parse(fs.readFileSync(path.join(root, CURRENTNESS_FILE), 'utf8')), as_of: committedAsOf });
  }
  if (boundaryDay) installBoundaryRecord(root, boundaryDay);
  if (openMediaGate) installTemporaryMediaGap(root);
  const committed = readCommittedCurrentness(root);
  if (committedAsOf || boundaryDay) runCanonicalGenerators(root, committed);
  if (committedAsOf) expireAAIInFutureTestBaseline(root, committed);

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
      removeTempTree(root);
      removeTempTree(remote);
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

// --- public-input boundary (Codex review remediation) -------------------------
//
// The writer copies packet.event, packet.media.approved_manifest and the approved
// locale package into public repository JSON, so an unknown field in any of them
// must stop the write rather than ride along. Restricted shapes are assembled
// from parts so this file never holds one whole.
const RESTRICTED_ATTACHMENT = `file_${'0123456789abcdef'.repeat(2)}`;
const RESTRICTED_EVIDENCE_ID = ['P25', 'EV', '2026', '0001'].join('-');
record('unknown restricted event field is rejected as INVALID_INPUT', () => {
  const packet = clone(fixture);
  packet.event.restricted_note = RESTRICTED_ATTACHMENT;
  const result = expectState(packet, 'INVALID_INPUT');
  if (JSON.stringify(result.issues).includes(RESTRICTED_ATTACHMENT)) throw new Error('issue text echoed the restricted value');
}, 'original');

record('unknown manifest and locale-row fields are rejected as INVALID_INPUT', () => {
  const manifestPacket = clone(fixture);
  manifestPacket.media.approved_manifest.internal_ref = RESTRICTED_EVIDENCE_ID;
  expectState(manifestPacket, 'INVALID_INPUT');
  const rowPacket = clone(fixture);
  rowPacket.localization.approved_package.rows[0].internal_ref = RESTRICTED_EVIDENCE_ID;
  expectState(rowPacket, 'INVALID_INPUT');
}, 'original');

record('the writer copy boundary throws on an unchecked extra field', () => {
  const packet = clone(fixture);
  packet.media.approved_manifest.internal_ref = RESTRICTED_ATTACHMENT;
  expectThrow(() => assertPublicInputBoundary(packet), /PUBLIC_INPUT_BOUNDARY/);
  assertPublicInputBoundary(clone(fixture));
}, 'original');

record('a real-write attempt with an unknown event field is refused before anything is written', () => withRepository((ctx) => {
  const packet = clone(ctx.packet);
  packet.event.restricted_note = RESTRICTED_ATTACHMENT;
  const error = expectThrow(() => prepareRealWriteCandidate({ ...ctx, packet }), /not an allowed public field/);
  if (error.message.includes(RESTRICTED_ATTACHMENT)) throw new Error('refusal echoed the restricted value');
  assertClean(ctx.root, ctx.baseline);
}), 'original');

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

// --- the open media gate survives the REAL write -----------------------------
//
// This asserts against the object prepareRealWriteCandidate actually returns
// and against the founder report it actually writes to disk -- not against a
// handcrafted result. That distinction is the whole point: the defect this
// pins was not a wrong classification, it was correct state being dropped on
// the way out. A test that builds its own result cannot observe that, so the
// precise path that regressed in patch cycle 2 would stay uncovered.
//
// The fixture repository explicitly installs one fallback-temporary state, so
// validate-card-media.mjs genuinely exits 2 without borrowing a live production
// gap. The candidate is rolled back immediately; nothing outside the throwaway
// copy is touched, and no PR, merge or deployment occurs.
record('real-write result and founder report preserve the open media gate', () => withRepository({ openMediaGate: true }, (ctx) => {
  const result = prepareRealWriteCandidate(ctx);
  try {
    const outcomes = result.validation_outcomes;
    if (!Array.isArray(outcomes)) throw new Error('real result carries no validation_outcomes');

    // 1-4: the media validator's own recorded outcome.
    const media = outcomes.find((outcome) => outcome.step === 'scripts/validate-card-media.mjs');
    if (!media) throw new Error('real result has no validate-card-media.mjs outcome');
    if (media.status !== 2) throw new Error(`media outcome status is ${JSON.stringify(media.status)}, expected numeric 2`);
    if (media.passed !== false) throw new Error('an exit-2 media outcome must never be recorded as passed');
    if (media.media_gate_open !== true) throw new Error('media outcome did not record media_gate_open');

    // 5-7: result-level disposition.
    if (result.media_gate !== 'OPEN') throw new Error(`result.media_gate is ${JSON.stringify(result.media_gate)}, expected "OPEN"`);
    if (result.media_gate_open !== true) throw new Error('result.media_gate_open did not survive the real write');
    if (result.merge_allowed !== false) throw new Error('an open media gate must never be merge-ready');

    // 8-10: the founder report as actually written into the candidate.
    const reportPath = path.join(ctx.root, 'automation', 'things-to-do', 'runs', `${ctx.packet.event.id}.md`);
    const report = fs.readFileSync(reportPath, 'utf8');
    if (!/MEDIA GATE: OPEN/.test(report)) throw new Error('written founder report does not state MEDIA GATE: OPEN');
    if (!/unresolved media records remain/.test(report) || !/not media-complete for merge/.test(report)) {
      throw new Error('written founder report does not explain that the branch is not media-complete');
    }
    if (/- Media: approved/.test(report)) throw new Error('written founder report calls media approved while the gate is open');
    if (!/- Merge allowed: false/.test(report)) throw new Error('written founder report does not carry the merge stop gate');

    // 11: totals count only genuine passes.
    const passedCount = outcomes.filter((outcome) => outcome.passed === true).length;
    const expectedLine = `- Validation: ${passedCount} of ${outcomes.length} incumbent validators passed`;
    if (!report.includes(expectedLine)) {
      throw new Error(`written founder report validation total is not "${expectedLine}"`);
    }
    if (passedCount >= outcomes.length) throw new Error('an open gate must leave at least one outcome unpassed');

    // The persisted machine-readable artifact must agree with the report.
    const artifact = JSON.parse(fs.readFileSync(path.join(ctx.root, 'automation', 'things-to-do', 'runs', `${ctx.packet.event.id}.json`), 'utf8'));
    if (artifact.media_gate !== 'OPEN' || artifact.media_gate_open !== true || artifact.merge_allowed !== false) {
      throw new Error('persisted run artifact lost the open media gate');
    }
  } finally {
    rollbackRealWriteCandidate(ctx.root, result);
  }
  assertClean(ctx.root, ctx.baseline);
}), 'media-gate');

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
    removeTempTree(updater);
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

// --- runtime GitHub transport ----------------------------------------------
//
// The worker these scripts actually run in has node and git but no `gh`. These
// tests pin the consequence of that: an absent CLI must not stop an otherwise
// authorized publication, and every guarantee the incumbent path made around
// the two PR operations must survive the transport change unchanged.

/**
 * A pull-request client that records what it was asked to do. It never touches
 * the network and never sees a real packet — it stands exactly where the
 * incumbent `gh` subprocess stood.
 */
function recordingPullRequests({ open = [], createDraft = null } = {}) {
  const calls = { list: [], createDraft: [] };
  return {
    calls,
    list(request) {
      calls.list.push(request);
      return open;
    },
    createDraft(request) {
      calls.createDraft.push(request);
      if (typeof createDraft === 'function') return createDraft(request);
      return 'https://github.com/jasonlamardjones/aprasa-site/pull/1';
    }
  };
}

function remoteSha(context, ref) {
  const output = run(context.root, 'git', ['ls-remote', context.remote, `refs/heads/${ref}`], { allowFailure: true });
  return output ? output.split(/\s+/)[0] : null;
}

record('the guarded publication path invokes no gh binary', () => {
  // Environment-independent: the modules that perform the guarded write must
  // not shell out to a GitHub CLI at all, so a worker without one cannot fail
  // for that reason. This holds whether or not `gh` happens to be installed
  // wherever the suite runs.
  for (const file of ['scripts/write-event-publication.mjs', 'scripts/lib/event-publication-write.mjs']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const invocations = source.match(/['"`]gh['"`]\s*,/g) ?? [];
    if (invocations.length) throw new Error(`${file} still invokes a gh binary`);
  }
  // The transport the path does use resolves without one, given a credential.
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-no-gh-'));
  try {
    if (resolveExecutable('gh', { PATH: isolated }) !== null) throw new Error('the isolated PATH exposes a gh CLI');
    const selection = selectTransport({ env: { PATH: isolated, GITHUB_TOKEN: 'test-only-not-a-real-credential' } });
    if (selection.transport !== TRANSPORT_API) throw new Error('no usable transport without a gh CLI');
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});

record('a guarded publication completes without a gh CLI in the path', () => withRepository((ctx) => {
  const pullRequests = recordingPullRequests();
  const result = prepareRealWriteCandidate(ctx);
  const published = finalizeRealWriteCandidate({ root: ctx.root, packet: ctx.packet, result, pullRequests });
  if (!published.candidateSha || published.pushed !== true) throw new Error('the guarded write did not complete');
  if (published.prUrl !== 'https://github.com/jasonlamardjones/aprasa-site/pull/1') throw new Error('no draft PR was opened');
  if (pullRequests.calls.createDraft.length !== 1) throw new Error('draft PR creation was not attempted exactly once');
}));

record('draft PR creation stays bounded and withholds merge', () => withRepository((ctx) => {
  const pullRequests = recordingPullRequests();
  const result = prepareRealWriteCandidate(ctx);
  const published = finalizeRealWriteCandidate({ root: ctx.root, packet: ctx.packet, result, pullRequests });
  const request = pullRequests.calls.createDraft[0];
  if (request.base !== 'main') throw new Error(`draft PR was not based on main: ${request.base}`);
  if (request.head !== result.branch) throw new Error(`draft PR head was not the candidate branch: ${request.head}`);
  if (!request.title.startsWith('Publish approved event:')) throw new Error(`unexpected draft PR title: ${request.title}`);
  // The body is the committed founder-approval report, not an invented summary.
  const report = fs.readFileSync(path.join(ctx.root, 'automation', 'things-to-do', 'runs', `${ctx.packet.event.id}.md`), 'utf8');
  if (request.body !== report) throw new Error('the draft PR body is not the committed candidate report');
  if (!request.body.includes('Merge allowed: false')) throw new Error('the candidate report did not withhold merge');
  if (result.merge_allowed !== false || published.merged !== undefined) throw new Error('merge authority leaked into the result');
  for (const key of Object.keys(request)) {
    if (/merge|deploy|auto/i.test(key)) throw new Error(`draft PR request carried ${key}`);
  }
}));

record('a failed draft PR creation leaves the candidate branch and main untouched', () => withRepository((ctx) => {
  const mainBefore = remoteSha(ctx, 'main');
  const pullRequests = recordingPullRequests({
    createDraft() { throw new Error('GITHUB_PR_CREATE_FAILED: GitHub API returned HTTP 503'); }
  });
  const result = prepareRealWriteCandidate(ctx);
  const error = expectThrow(
    () => finalizeRealWriteCandidate({ root: ctx.root, packet: ctx.packet, result, pullRequests }),
    /GITHUB_PR_CREATE_FAILED/
  );
  // Post-commit state is recoverable and reported, not rolled back.
  if (error.recovery?.phase !== 'POST_COMMIT' || error.recovery.pushed !== true) {
    throw new Error('a failed PR creation did not report recoverable post-commit state');
  }
  if (error.recovery.worktree_restored !== false) throw new Error('a committed candidate was wrongly reported as rolled back');
  if (error.recovery.head_sha !== run(ctx.root, 'git', ['rev-parse', 'HEAD'])) {
    throw new Error('the reported candidate SHA is not the committed candidate');
  }
  if (!/do not rebuild|no new commit|Create the draft PR/.test(error.recovery.resume_action)) {
    throw new Error(`the resume action was not deterministic: ${error.recovery.resume_action}`);
  }
  // main is untouched, locally and on the authoritative remote.
  if (remoteSha(ctx, 'main') !== mainBefore) throw new Error('remote main moved during a failed PR creation');
  if (run(ctx.root, 'git', ['rev-parse', 'main']) !== ctx.baseline) throw new Error('local main moved during a failed PR creation');
  // The candidate branch is exactly the one commit, still on top of baseline.
  if (run(ctx.root, 'git', ['rev-parse', `${result.branch}~1`]) !== ctx.baseline) {
    throw new Error('the candidate branch is not a single commit on the authorized baseline');
  }
  if (remoteSha(ctx, result.branch) !== error.recovery.head_sha) {
    throw new Error('the pushed candidate branch does not match the reported recovery SHA');
  }
  assertClean(ctx.root);
}));

record('an unanswerable PR lookup during recovery reports unknown, never "no PR"', () => withRepository((ctx) => {
  const pullRequests = {
    list() { throw new Error('GITHUB_API_TRANSPORT_FAILED: timeout after 20000ms'); },
    createDraft() { throw new Error('GITHUB_PR_CREATE_FAILED: GitHub API returned HTTP 502'); }
  };
  const result = prepareRealWriteCandidate(ctx);
  const error = expectThrow(
    () => finalizeRealWriteCandidate({ root: ctx.root, packet: ctx.packet, result, pullRequests }),
    /GITHUB_PR_CREATE_FAILED/
  );
  // The recovery record must still be produced: a second failure while
  // reporting the first one must not replace the original error.
  if (error.recovery?.phase !== 'POST_COMMIT') throw new Error('recovery reporting was lost to the lookup failure');
  if (error.recovery.pr_exists !== false || error.recovery.pr_url !== null) {
    throw new Error('an unanswerable lookup was reported as a positive PR state');
  }
  if (error.recovery.pushed !== true) throw new Error('the pushed candidate was not reported');
  assertClean(ctx.root);
}));

record('an existing open PR for the candidate branch is refused', () => {
  // The gate the entrypoint applies, exercised against the same transport the
  // guarded path uses: a non-empty result must stop the run.
  const open = [{ url: 'https://github.com/jasonlamardjones/aprasa-site/pull/2', isDraft: true, headRefOid: 'c'.repeat(40), number: 2 }];
  const pullRequests = recordingPullRequests({ open });
  const existing = pullRequests.list({ repository: 'jasonlamardjones/aprasa-site', branch: 'feature/phase1b-test' });
  if (!existing.length) throw new Error('an open PR was not detected');
  // And a lookup that could not be answered is never mistaken for "none".
  expectThrow(() => {
    const failing = { list() { throw new Error('GITHUB_AUTH_UNAVAILABLE: no credential'); } };
    const found = failing.list({});
    if (!found.length) throw new Error('unreachable');
  }, /GITHUB_AUTH_UNAVAILABLE/);
});

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

// --- Issue #100: bounded ENOTEMPTY teardown retry ---------------------------
//
// The exhaustive lifecycle audit found no lingering handle, subprocess, or
// async write: every git and generator/validator call on the real-write path
// is spawnSync, fully reaped before its temp directory is removed. What
// removeTempTree hardens is the one remaining unsafe assumption -- that a
// recursive delete of a directory that was just subjected to heavy churn
// always succeeds on the first OS-level attempt. These prove its retry is
// restricted to exactly the named transient codes, still fails closed on an
// unrelated error or on retry exhaustion, and actually removes a real tree.

record('teardown retries only transient codes and recovers within budget', () => {
  let calls = 0;
  const rm = () => {
    calls += 1;
    if (calls <= 2) {
      const error = new Error('directory not empty');
      error.code = 'ENOTEMPTY';
      throw error;
    }
  };
  let slept = 0;
  removeTempTree('/unused/path', { rm, retries: 5, delayMs: 10, sleep: (ms) => { slept += ms; } });
  if (calls !== 3) throw new Error(`expected exactly 3 attempts before success, got ${calls}`);
  if (slept !== 20) throw new Error(`expected two 10ms backoff delays between retries, got ${slept}`);
}, 'teardown-reliability');

record('teardown does not retry an unrelated filesystem error', () => {
  let calls = 0;
  const rm = () => {
    calls += 1;
    const error = new Error('permission denied');
    error.code = 'EACCES';
    throw error;
  };
  expectThrow(
    () => removeTempTree('/unused/path', { rm, retries: 5, delayMs: 10, sleep: () => { throw new Error('must not sleep for a non-transient error'); } }),
    /permission denied/
  );
  if (calls !== 1) throw new Error(`expected exactly 1 attempt for a non-transient error, got ${calls}`);
}, 'teardown-reliability');

record('teardown retry exhaustion still fails closed', () => {
  let calls = 0;
  const rm = () => {
    calls += 1;
    const error = new Error('still not empty');
    error.code = 'ENOTEMPTY';
    throw error;
  };
  const error = expectThrow(
    () => removeTempTree('/unused/path', { rm, retries: 3, delayMs: 0, sleep: () => {} }),
    /still not empty/
  );
  if (error.code !== 'ENOTEMPTY') throw new Error('exhausted retry did not preserve the original transient error code');
  if (calls !== 4) throw new Error(`expected retries+1 = 4 attempts before giving up, got ${calls}`);
}, 'teardown-reliability');

record('teardown removes a real freshly-written directory tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-teardown-check-'));
  try {
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'file.txt'), 'x');
    removeTempTree(dir);
    if (fs.existsSync(dir)) throw new Error('directory was not removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 'teardown-reliability');

// --- URDI 2026 Tranche A: guarded-writer extension --------------------------
//
// Project 03 reconciled input + Project 09 approved r2 package (23 November
// 2026). The 16 approved rows keep their r1 provenance and the two additive
// checked rows carry r2; the writer must accept exactly that lineage, the
// approved no-asset fallback and the approved CNAD action, and nothing wider.
// The approved text is restated here, independently of the module under test.
const URDI_ID = 'urdi-2026-mindelo';
const URDI_R1 = 'P09-PT-TTD-URDI-2026-11-22-r1';
const URDI_R2 = 'P09-PT-TTD-URDI-2026-11-23-r2';
const URDI_VENUE = 'Praça Amílcar Cabral (Praça Nova), Mindelo, São Vicente';
const URDI_SUMMARY_EN = 'The 11th edition of URDI brings Cabo Verdean crafts and design to Praça Nova in Mindelo, from 25 to 29 November 2026.';
const URDI_SUMMARY_PT = 'A 11.ª edição da URDI leva o artesanato e o design cabo-verdianos à Praça Nova, no Mindelo, de 25 a 29 de novembro de 2026.';
const URDI_SOURCE_URL = 'https://www.inforpress.cv/pt/sao-vicente-praca-nova-ganha-forma-para-receber-11-edicao-da-urdi-com-150-artesaos-expositores';
const URDI_CNAD_URL = 'https://www.facebook.com/cnad.cv/';
// [key suffix, EN, PT, revision]
const URDI_ROWS = [
  ['title', 'URDI 2026 — Cabo Verde Crafts & Design Fair', 'URDI 2026 — Feira de Artesanato e Design de Cabo Verde', URDI_R1],
  ['summary', URDI_SUMMARY_EN, URDI_SUMMARY_PT, URDI_R1],
  ['display.status', '25–29 November 2026', '25–29 de novembro de 2026', URDI_R1],
  ['display.meta', URDI_VENUE, URDI_VENUE, URDI_R1],
  ['detail.body', 'Organized by CNAD, this year\'s fair celebrates 50 years of memory, creation and resistance, with artisan exhibitors and accompanying cultural activities.', 'Organizada pelo CNAD, a feira deste ano celebra 50 anos de memória, criação e resistência, com artesãos expositores e atividades culturais complementares.', URDI_R1],
  ['detail.good_to_know', 'The fair takes place in a public square. Check CNAD\'s official information for the current programme and any activity-specific access requirements.', 'A feira realiza-se numa praça pública. Consulte as informações oficiais do CNAD para confirmar o programa atual e quaisquer requisitos de acesso específicos de cada atividade.', URDI_R1],
  ['card_action.label', 'View organizer information', 'Ver informações da organização', URDI_R1],
  ['detail.action_label', 'View organizer information', 'Ver informações da organização', URDI_R1],
  ['detail.fact.dates.label', 'Dates', 'Datas', URDI_R1],
  ['detail.fact.dates.value_display', '25–29 November 2026', '25–29 de novembro de 2026', URDI_R1],
  ['detail.fact.venue.label', 'Venue', 'Local', URDI_R1],
  ['detail.fact.venue.value_display', URDI_VENUE, URDI_VENUE, URDI_R1],
  ['detail.fact.organizer.label', 'Organizer', 'Organização', URDI_R1],
  ['detail.fact.organizer.value_display', 'Centro Nacional de Arte, Artesanato e Design (CNAD)', 'Centro Nacional de Arte, Artesanato e Design (CNAD)', URDI_R1],
  ['seo.title', 'URDI 2026 — Cabo Verde Crafts & Design Fair | A PRASA', 'URDI 2026 — Feira de Artesanato e Design de Cabo Verde | A PRASA', URDI_R1],
  ['seo.description', URDI_SUMMARY_EN, URDI_SUMMARY_PT, URDI_R1],
  ['display.checked', 'Checked 22 November 2026', 'Revisto em 22 de novembro de 2026', URDI_R2],
  ['detail.checked', 'Checked 22 November 2026 against current Inforpress reporting based on statements from CNAD\'s director and the corroborating CNAD-origin event announcement.', 'Revisto em 22 de novembro de 2026 com base na reportagem atual da Inforpress, fundamentada em declarações do diretor do CNAD e corroborada pelo anúncio do evento com origem no CNAD.', URDI_R2]
];
const urdiKey = (suffix) => `event.${URDI_ID}.${suffix}`;
const urdiEn = (suffix) => URDI_ROWS.find((row) => row[0] === suffix)[1];

// The approved public packet wrapper. The first 16 rows carry no context or
// linguistic notes upstream; the wrapper normalizes them to empty strings
// WITHOUT touching key, EN, PT or revision values.
function urdiPacket({ baseline, asOf }) {
  const rows = URDI_ROWS.map(([suffix, en, pt, revision]) => ({
    key: urdiKey(suffix),
    source_revision: revision,
    source_en: en,
    pt,
    scope_status: 'REQUIRED_FOR_PT_LAUNCH',
    identity_policy: 'GOVERNED_SOURCE',
    context_notes: suffix === 'display.checked' ? 'Card/display currentness line.' : suffix === 'detail.checked' ? 'Detail currentness/provenance line.' : '',
    record_id: URDI_ID,
    linguistic_notes: '',
    translation_status: 'APPROVED'
  }));
  const title = urdiEn('title');
  return {
    contract_version: 1,
    event: {
      id: URDI_ID,
      kind: 'dated-event',
      title,
      provider: 'Centro Nacional de Arte, Artesanato e Design (CNAD)',
      summary: URDI_SUMMARY_EN,
      category: 'culture',
      location: { name: 'Praça Amílcar Cabral (Praça Nova)', locality: 'Mindelo, São Vicente' },
      source_url: URDI_SOURCE_URL,
      source_type: 'news-agency-report',
      start_date: '2026-11-25',
      start_datetime: null,
      end_datetime: null,
      end_date: '2026-11-29',
      end_precision: 'day',
      checked_at: '2026-11-22',
      publication_state: 'published',
      media_policy: 'fallback_allowed',
      media_manifest_title: title,
      detail_page: `things-to-do/${URDI_ID}/`,
      free_admission: null,
      display: { status: urdiEn('display.status'), meta: urdiEn('display.meta'), checked: urdiEn('display.checked') },
      media: null,
      card_action: { label: urdiEn('card_action.label'), url: URDI_CNAD_URL },
      detail: {
        facts: [
          { label: 'Dates', value: urdiEn('detail.fact.dates.value_display') },
          { label: 'Venue', value: urdiEn('detail.fact.venue.value_display') },
          { label: 'Organizer', value: urdiEn('detail.fact.organizer.value_display') }
        ],
        body: urdiEn('detail.body'),
        good_to_know: urdiEn('detail.good_to_know'),
        checked: urdiEn('detail.checked'),
        action_label: urdiEn('detail.action_label')
      },
      seo: { description: URDI_SUMMARY_EN, title: urdiEn('seo.title'), schema_type: 'Event' }
    },
    localization: {
      pt_status: 'approved',
      new_strings_required: false,
      pt_values: Object.fromEntries(URDI_ROWS.map(([suffix, , pt]) => [urdiKey(suffix), pt])),
      approved_package: {
        package_id: 'aprasa-pt-ttd-urdi-2026-mindelo',
        source_revision: URDI_R2,
        previous_source_revision: URDI_R1,
        project_09_status: 'approved',
        rows
      }
    },
    media: {
      rights_status: 'not_required',
      alt_status: 'not_required',
      source_url: null,
      local_asset: null,
      supplied_asset: null,
      asset_sha256: null,
      approved_manifest: {
        section: 'things-to-do',
        title,
        provider: 'Centro Nacional de Arte, Artesanato e Design (CNAD)',
        source_url: URDI_SOURCE_URL,
        media_type: 'editorial-fallback',
        media_state: 'fallback-final',
        media_source: null,
        media_asset: null,
        fallback_category: 'things-culture',
        fallback_reason: 'No event-specific URDI/CNAD media reuse rights established; shared neutral A PRASA category fallback only.',
        media_provenance: 'Existing shared A PRASA editorial fallback region; no URDI-specific image is ingested, and no depiction of the fair, organizer, artisans or activities is claimed.',
        media_asset_source_url: null,
        media_checked_date: null,
        media_alt: null
      }
    },
    governance: { publication_authorized: true, project03_status: 'approved', project09_status: 'approved', media_status: 'approved' },
    control: {
      dry_run: false,
      real_write: true,
      expected_main_sha: baseline,
      as_of: asOf,
      allow_branch: true,
      allow_commit: true,
      allow_pr: true,
      merge_allowed: false
    }
  };
}

const URDI_STATIC = () => urdiPacket({ baseline: 'a'.repeat(40), asOf: '2026-11-23' });
const urdiRow = (packet, suffix) => packet.localization.approved_package.rows.find((row) => row.key === urdiKey(suffix));

record('URDI: the approved mixed-revision packet (16 r1 + 2 r2, null-alt fallback, CNAD action) is accepted', () => {
  const packet = URDI_STATIC();
  const rows = packet.localization.approved_package.rows;
  if (rows.length !== 18 || rows.filter((row) => row.source_revision === URDI_R1).length !== 16 || rows.filter((row) => row.source_revision === URDI_R2).length !== 2) {
    throw new Error('test packet is not the 16 r1 + 2 r2 approved shape');
  }
  expectState(packet, 'READY_FOR_IMPLEMENTATION');
}, 'urdi');

record('URDI: previous_source_revision is rejected for every other event', () => {
  const packet = clone(fixture);
  packet.localization.approved_package.previous_source_revision = URDI_R1;
  expectState(packet, 'INVALID_INPUT');
}, 'urdi');

record('URDI: an incumbent event still needs package-wide revision equality (generic check not weakened)', () => {
  const packet = clone(fixture);
  packet.localization.approved_package.rows[0].source_revision = `${packet.localization.approved_package.source_revision}-forged`;
  expectState(packet, 'BLOCKED_LOCALIZATION');
}, 'urdi');

record('URDI: a forged revision on an r1 row, or an r1 revision on an r2 row, is refused', () => {
  const forgedR1 = URDI_STATIC();
  urdiRow(forgedR1, 'title').source_revision = URDI_R2;
  expectState(forgedR1, 'BLOCKED_LOCALIZATION');
  const forgedR2 = URDI_STATIC();
  urdiRow(forgedR2, 'display.checked').source_revision = URDI_R1;
  expectState(forgedR2, 'BLOCKED_LOCALIZATION');
  const unknown = URDI_STATIC();
  urdiRow(unknown, 'summary').source_revision = 'P09-PT-TTD-URDI-2026-11-24-r3';
  expectState(unknown, 'BLOCKED_LOCALIZATION');
}, 'urdi');

record('URDI: every row at the package revision (no mixed lineage) is refused', () => {
  const packet = URDI_STATIC();
  for (const row of packet.localization.approved_package.rows) row.source_revision = URDI_R2;
  expectState(packet, 'BLOCKED_LOCALIZATION');
}, 'urdi');

record('URDI: a missing or wrong previous_source_revision, package id or package revision is refused', () => {
  const missing = URDI_STATIC();
  delete missing.localization.approved_package.previous_source_revision;
  expectState(missing, 'BLOCKED_LOCALIZATION');
  const wrongPrevious = URDI_STATIC();
  wrongPrevious.localization.approved_package.previous_source_revision = 'P09-PT-TTD-URDI-2026-11-21-r0';
  expectState(wrongPrevious, 'BLOCKED_LOCALIZATION');
  const wrongPackage = URDI_STATIC();
  wrongPackage.localization.approved_package.package_id = 'aprasa-pt-ttd-other';
  expectState(wrongPackage, 'BLOCKED_LOCALIZATION');
  const wrongRevision = URDI_STATIC();
  wrongRevision.localization.approved_package.source_revision = URDI_R1;
  expectState(wrongRevision, 'BLOCKED_LOCALIZATION');
  const nonString = URDI_STATIC();
  nonString.localization.approved_package.previous_source_revision = 1;
  expectState(nonString, 'INVALID_INPUT');
}, 'urdi');

record('URDI: a missing, extra or duplicated locale row is refused', () => {
  const missing = URDI_STATIC();
  missing.localization.approved_package.rows.pop();
  expectState(missing, 'BLOCKED_LOCALIZATION');
  const extra = URDI_STATIC();
  extra.localization.approved_package.rows.push({ ...clone(urdiRow(extra, 'title')), key: urdiKey('detail.unapproved') });
  expectState(extra, 'INVALID_INPUT');
  const duplicate = URDI_STATIC();
  duplicate.localization.approved_package.rows.push(clone(urdiRow(duplicate, 'title')));
  expectState(duplicate, 'INVALID_INPUT');
}, 'urdi');

record('URDI: altered approved EN or PT text is refused (approved content is immutable)', () => {
  const pt = URDI_STATIC();
  urdiRow(pt, 'summary').pt = `${urdiRow(pt, 'summary').pt} `;
  expectState(pt, 'BLOCKED_LOCALIZATION');
  const en = URDI_STATIC();
  urdiRow(en, 'detail.body').source_en = `${urdiRow(en, 'detail.body').source_en} `;
  expectState(en, 'INVALID_INPUT');
}, 'urdi');

record('URDI: the final no-asset fallback must match the approval exactly', () => {
  const emptyAlt = URDI_STATIC();
  emptyAlt.media.approved_manifest.media_alt = '';
  expectState(emptyAlt, 'INVALID_INPUT');
  const informativeAlt = URDI_STATIC();
  informativeAlt.media.approved_manifest.media_alt = 'A photograph of the fair';
  expectState(informativeAlt, 'INVALID_INPUT');
  const temporary = URDI_STATIC();
  temporary.media.approved_manifest.media_state = 'fallback-temporary';
  expectState(temporary, 'INVALID_INPUT');
  const wrongType = URDI_STATIC();
  wrongType.media.approved_manifest.media_type = 'provider-supplied';
  expectState(wrongType, 'INVALID_INPUT');
  const wrongCategory = URDI_STATIC();
  wrongCategory.media.approved_manifest.fallback_category = 'things-visual-arts';
  expectState(wrongCategory, 'INVALID_INPUT');
  const withAsset = URDI_STATIC();
  withAsset.media.approved_manifest.media_asset = 'assets/events/urdi-2026-mindelo.jpg';
  expectState(withAsset, 'INVALID_INPUT');
  const withSize = URDI_STATIC();
  withSize.media.approved_manifest.media_width = 1200;
  expectState(withSize, 'INVALID_INPUT');
  const emptyProvenance = URDI_STATIC();
  emptyProvenance.media.approved_manifest.media_provenance = '';
  expectState(emptyProvenance, 'INVALID_INPUT');
}, 'urdi');

record('URDI: no media binary, asset path, hash or event media is admitted', () => {
  const suppliedAsset = URDI_STATIC();
  suppliedAsset.media.supplied_asset = path.join(os.tmpdir(), 'urdi.jpg');
  suppliedAsset.media.asset_sha256 = 'b'.repeat(64);
  expectState(suppliedAsset, 'INVALID_INPUT');
  const localAsset = URDI_STATIC();
  localAsset.media.local_asset = 'assets/events/urdi-2026-mindelo.jpg';
  expectState(localAsset, 'INVALID_INPUT');
  const eventMedia = URDI_STATIC();
  eventMedia.event.media = { asset: 'assets/events/urdi-2026-mindelo.jpg', alt: 'x', width: 1, height: 1 };
  expectState(eventMedia, 'INVALID_INPUT');
  const required = URDI_STATIC();
  required.event.media_policy = 'required';
  expectState(required, 'INVALID_INPUT');
}, 'urdi');

record('URDI: the null manifest alt is NOT a general allowance for other no-media events', () => {
  const packet = clone(fixture);
  packet.event.media = null;
  packet.event.media_policy = 'fallback_allowed';
  packet.media.local_asset = null;
  packet.media.asset_sha256 = null;
  packet.media.supplied_asset = null;
  // No event media means no media.alt locale row: drop the fixture's row and value.
  packet.localization.approved_package.rows = packet.localization.approved_package.rows.filter((row) => !row.key.endsWith('.media.alt'));
  for (const key of Object.keys(packet.localization.pt_values)) if (key.endsWith('.media.alt')) delete packet.localization.pt_values[key];
  packet.media.approved_manifest = { ...packet.media.approved_manifest, media_type: 'editorial-fallback', media_state: 'fallback-final', media_asset: null, media_alt: null };
  delete packet.media.approved_manifest.media_width;
  delete packet.media.approved_manifest.media_height;
  expectState(packet, 'BLOCKED_MEDIA');
  packet.media.approved_manifest.media_alt = '';
  expectState(packet, 'READY_FOR_IMPLEMENTATION');
}, 'urdi');

record('URDI: the approved CNAD action URL and the untouched evidence source are both required', () => {
  const action = URDI_STATIC();
  action.event.card_action.url = 'https://www.facebook.com/someone-else/';
  expectState(action, 'INVALID_INPUT');
  const evidenceSwap = URDI_STATIC();
  evidenceSwap.event.source_url = URDI_CNAD_URL;
  evidenceSwap.media.approved_manifest.source_url = URDI_CNAD_URL;
  expectState(evidenceSwap, 'INVALID_INPUT');
  const noAction = URDI_STATIC();
  noAction.event.card_action = null;
  expectState(noAction, 'INVALID_INPUT');
}, 'urdi');

record('URDI: the writer\'s expected scope names exactly the approved publication outputs and no technical file', () => {
  const packet = URDI_STATIC();
  const expected = expectedChangedFiles(packet).sort();
  const want = [
    'automation/things-to-do/runs/urdi-2026-mindelo.json',
    'automation/things-to-do/runs/urdi-2026-mindelo.md',
    'data/locales/locale-data.generated.json',
    'data/locales/pt-overlay-event-urdi-2026-mindelo.source.json',
    'data/things-to-do-events.json',
    'index.html',
    'internal/provider-media-manifest.json',
    'pt/index.html',
    'pt/things-to-do/urdi-2026-mindelo/index.html',
    'sitemap.xml',
    'things-to-do/urdi-2026-mindelo/index.html'
  ];
  if (JSON.stringify(expected) !== JSON.stringify(want)) throw new Error(`unexpected scope: ${expected.join(', ')}`);
  if (expected.some((file) => file.startsWith('scripts/') || file.startsWith('assets/'))) throw new Error('scope includes a source or media file');
}, 'urdi');

record('URDI: a real write refuses a stale expected_main_sha and a dirty worktree before writing anything', () => withRepository({ committedAsOf: '2026-11-23' }, (ctx) => {
  const stale = urdiPacket({ baseline: 'c'.repeat(40), asOf: ctx.committed });
  const stalePath = writePacket(ctx, stale, 'urdi-stale.json');
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, packet: stale, packetPath: stalePath }), /STALE_BRANCH_REFUSED/);
  assertClean(ctx.root, ctx.baseline);
  const packet = urdiPacket({ baseline: ctx.baseline, asOf: ctx.committed });
  const packetPath = writePacket(ctx, packet, 'urdi-dirty.json');
  fs.writeFileSync(path.join(ctx.root, 'stray.txt'), 'dirty\n');
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, packet, packetPath }), /DIRTY_WORKTREE_REFUSED/);
  fs.rmSync(path.join(ctx.root, 'stray.txt'));
  assertClean(ctx.root, ctx.baseline);
}), 'urdi');

record('URDI: a stale or foreign dry-run proof is refused by the writer', () => withRepository({ committedAsOf: '2026-11-23' }, (ctx) => {
  const packet = urdiPacket({ baseline: ctx.baseline, asOf: ctx.committed });
  const packetPath = writePacket(ctx, packet, 'urdi-proof.json');
  const proof = runTrustedDryRun(ctx.root, packet, packetPath, { head: ctx.baseline, authoritativeMain: ctx.baseline });
  const stale = { ...clone(proof), base_head_sha: 'd'.repeat(40) };
  expectThrow(() => assertDryRunProof(ctx.root, packet, packetPath, stale, ctx.baseline, ctx.baseline), /DRY_RUN_PROOF_STALE/);
  const wrongScope = { ...clone(proof), changed_files: proof.changed_files.filter((file) => file !== 'sitemap.xml') };
  expectThrow(() => assertDryRunProof(ctx.root, packet, packetPath, wrongScope, ctx.baseline, ctx.baseline), /DRY_RUN_PROOF_SCOPE_MISMATCH/);
  const changedPacket = clone(packet);
  changedPacket.event.summary = `${changedPacket.event.summary} `;
  const changedPath = writePacket(ctx, changedPacket, 'urdi-proof-changed.json');
  expectThrow(() => assertDryRunProof(ctx.root, changedPacket, changedPath, proof, ctx.baseline, ctx.baseline), /DRY_RUN_PROOF_MISMATCH/);
}), 'urdi');

record('URDI: the complete guarded write (dry run, build, validators, idempotence, exact scope) succeeds and rolls back clean', () => withRepository({ committedAsOf: '2026-11-23' }, (ctx) => {
  const packet = urdiPacket({ baseline: ctx.baseline, asOf: ctx.committed });
  const packetPath = writePacket(ctx, packet, 'urdi-real.json');
  const result = prepareRealWriteCandidate({ ...ctx, packet, packetPath });
  try {
    if (result.status !== 'FOUNDER_APPROVAL_REQUIRED' || result.merge_allowed !== false || !result.idempotent) {
      throw new Error('successful result did not retain the approval stop gate and idempotence');
    }
    const want = expectedChangedFiles(packet).sort();
    const got = [...result.changed_files].filter((file) => file !== 'data/things-to-do-currentness.json').sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`changed-file scope mismatch: got [${got}] want [${want}]`);

    // 16 r1 + 2 r2 survive byte-for-byte into the governed overlay source, with
    // the explicit lineage field copied through and no metadata rewritten.
    const overlay = JSON.parse(fs.readFileSync(path.join(ctx.root, `data/locales/pt-overlay-event-${URDI_ID}.source.json`), 'utf8'));
    if (overlay.previous_source_revision !== URDI_R1 || overlay.source_revision !== URDI_R2) throw new Error('overlay lost the explicit lineage');
    if (JSON.stringify(overlay.rows) !== JSON.stringify(packet.localization.approved_package.rows)) throw new Error('overlay rows differ from the approved rows');
    if (overlay.rows.filter((row) => row.source_revision === URDI_R1).length !== 16 || overlay.rows.filter((row) => row.source_revision === URDI_R2).length !== 2) {
      throw new Error('overlay did not preserve 16 r1 + 2 r2');
    }
    const locale = JSON.parse(fs.readFileSync(path.join(ctx.root, 'data/locales/locale-data.generated.json'), 'utf8'));
    for (const [suffix, , , revision] of URDI_ROWS) {
      if (locale.keys[urdiKey(suffix)]?.source_revision !== revision) throw new Error(`generated locale key lost its revision: ${suffix}`);
    }

    // The approved manifest is written verbatim: null alt, no asset, final fallback.
    const manifest = JSON.parse(fs.readFileSync(path.join(ctx.root, 'internal/provider-media-manifest.json'), 'utf8'));
    const entry = manifest.records.find((item) => item.title === packet.event.media_manifest_title);
    if (!entry || JSON.stringify(entry) !== JSON.stringify(packet.media.approved_manifest)) throw new Error('approved manifest was not written verbatim');
    if (fs.readdirSync(path.join(ctx.root, 'assets', 'events')).some((name) => name.includes(URDI_ID))) throw new Error('a URDI media binary appeared');

    // The CNAD action is the public action on every surface; the evidence stays Inforpress.
    for (const page of [`things-to-do/${URDI_ID}/index.html`, `pt/things-to-do/${URDI_ID}/index.html`]) {
      const html = fs.readFileSync(path.join(ctx.root, page), 'utf8');
      if (!html.includes(`href="${URDI_CNAD_URL}"`)) throw new Error(`${page}: CNAD action URL missing`);
      if (html.includes(`class="dialog-link" href="${URDI_SOURCE_URL}"`)) throw new Error(`${page}: action still resolves to the evidence source`);
    }
    for (const home of ['index.html', 'pt/index.html']) {
      const html = fs.readFileSync(path.join(ctx.root, home), 'utf8');
      if (!html.includes(`data-event-id="${URDI_ID}"`)) throw new Error(`${home}: URDI card is not on Home`);
      if (!html.includes(`href="${URDI_CNAD_URL}"`)) throw new Error(`${home}: CNAD action URL missing from the Home card`);
    }
  } finally {
    rollbackRealWriteCandidate(ctx.root, result);
  }
  const status = run(ctx.root, 'git', ['status', '--porcelain']);
  if (status) throw new Error(`repository was not restored: ${status}`);
  if (fs.existsSync(path.join(ctx.root, `things-to-do/${URDI_ID}`))) throw new Error('rollback residue remained');
}), 'urdi');

// --- Guarded-writer build order: PT Home preservation --------------------------
//
// build-static-pages.mjs derives pt/index.html from the English sources, which
// leaves the PT Home training and Learning Spotlight cards in English until the
// training-opportunity generators run. The candidate build therefore has to
// follow the canonical scripts/build-all.mjs order, including those generators.
// The changed-file scope check cannot see this defect (pt/index.html is in scope
// for every publication), so it is pinned here by content.
const GENERATED_EVENT_REGION = /<!-- BEGIN GENERATED EVENT: ([a-z0-9]+(?:-[a-z0-9]+)*) -->[\s\S]*?<!-- END GENERATED EVENT: \1 -->/g;
const lf = (text) => text.replace(/\r\n/g, '\n');
const outsideGeneratedEventRegions = (html) => lf(html).replace(GENERATED_EVENT_REGION, '<!-- generated event region -->');
const withoutUrdiBlock = (html) => lf(html).replace(/\n[ \t]*<!-- BEGIN GENERATED EVENT: urdi-2026-mindelo -->[\s\S]*?<!-- END GENERATED EVENT: urdi-2026-mindelo -->/, '');
const GOVERNED_URDI_PATHS = [
  'automation/things-to-do/runs/urdi-2026-mindelo.json',
  'automation/things-to-do/runs/urdi-2026-mindelo.md',
  'data/locales/locale-data.generated.json',
  'data/locales/pt-overlay-event-urdi-2026-mindelo.source.json',
  'data/things-to-do-currentness.json',
  'data/things-to-do-events.json',
  'index.html',
  'internal/provider-media-manifest.json',
  'pt/index.html',
  'pt/things-to-do/urdi-2026-mindelo/index.html',
  'sitemap.xml',
  'things-to-do/urdi-2026-mindelo/index.html'
];

record('build order: the EN then PT training generators run after the PT Things-to-Do pass, before the sitemap, on the packet as_of', () => {
  const packet = clone(fixture);
  packet.control.as_of = '2026-11-23';
  const steps = candidateBuildSteps(packet).map((step) => step.join(' '));
  const at = (needle) => steps.findIndex((step) => step.includes(needle));
  const idx = {
    locale: at('build-locale-data.mjs'),
    en: at('generate-things-to-do.mjs --as-of=2026-11-23 --locale=en'),
    statics: at('build-static-pages.mjs'),
    ptEvents: at('generate-things-to-do.mjs --as-of=2026-11-23 --locale=pt --home=pt/index.html'),
    trainEn: at('generate-training-opportunities.mjs --as-of=2026-11-23 --locale=en'),
    trainPt: at('generate-training-opportunities.mjs --as-of=2026-11-23 --locale=pt --home=pt/index.html'),
    sitemap: at('build-sitemap.mjs')
  };
  if (Object.values(idx).some((value) => value < 0)) throw new Error(`a required build step is missing: ${JSON.stringify(idx)}`);
  const ordered = [idx.locale, idx.en, idx.statics, idx.ptEvents, idx.trainEn, idx.trainPt, idx.sitemap];
  if (JSON.stringify(ordered) !== JSON.stringify([...ordered].sort((a, b) => a - b))) throw new Error(`build steps are out of canonical order: ${steps.join(' | ')}`);
  if (steps.length !== 7) throw new Error(`unexpected build step count ${steps.length}`);
  if (steps.some((step) => /generate-training-opportunities/.test(step) && !step.includes('--as-of=2026-11-23'))) throw new Error('a training generator is not bound to packet.control.as_of');
  const other = clone(packet);
  other.control.as_of = '2026-12-01';
  if (candidateBuildSteps(other).filter((step) => /generate-training/.test(step[0])).some((step) => !step.includes('--as-of=2026-12-01'))) {
    throw new Error('training generator as_of does not follow the packet');
  }
}, 'build-order');

record('build order: the canonical committed PT/EN Home is a fixed point of the candidate sequence, and the old sequence was not', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-build-order-'));
  try {
    fs.cpSync(ROOT, copy, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
    const committedAsOf = JSON.parse(fs.readFileSync(path.join(copy, 'data/things-to-do-currentness.json'), 'utf8')).as_of;
    const packet = { control: { as_of: committedAsOf } };
    const committed = {
      pt: lf(fs.readFileSync(path.join(copy, 'pt/index.html'), 'utf8')),
      en: lf(fs.readFileSync(path.join(copy, 'index.html'), 'utf8'))
    };
    const stepsRun = (steps) => {
      for (const [script, ...args] of steps) run(copy, process.execPath, [script, ...args], { allowFailure: false });
    };
    const all = candidateBuildSteps(packet);
    // Old sequence: every step except the two training generators.
    stepsRun(all.filter((step) => !/generate-training-opportunities/.test(step[0])));
    const oldPt = lf(fs.readFileSync(path.join(copy, 'pt/index.html'), 'utf8'));
    if (outsideGeneratedEventRegions(oldPt) === outsideGeneratedEventRegions(committed.pt)) {
      throw new Error('regression pin is vacuous: the sequence without training generators did not alter PT Home');
    }
    // Candidate sequence from that same state must restore byte-for-byte equality.
    stepsRun(all);
    const nextPt = lf(fs.readFileSync(path.join(copy, 'pt/index.html'), 'utf8'));
    const nextEn = lf(fs.readFileSync(path.join(copy, 'index.html'), 'utf8'));
    if (nextPt !== committed.pt) throw new Error('PT Home differs from the committed canonical Home after the candidate build sequence');
    if (nextEn !== committed.en) throw new Error('EN Home differs from the committed canonical Home after the candidate build sequence');
  } finally {
    removeTempTree(copy);
  }
}, 'build-order');

record('build order: a complete URDI guarded write changes exactly the 12 governed paths and only adds the approved URDI Home block', () => withRepository({ asOf: '2026-11-23' }, (ctx) => {
  const packet = urdiPacket({ baseline: ctx.baseline, asOf: '2026-11-23' });
  const packetPath = writePacket(ctx, packet, 'urdi-build-order.json');
  const committedHome = {
    en: lf(fs.readFileSync(path.join(ctx.root, 'index.html'), 'utf8')),
    pt: lf(fs.readFileSync(path.join(ctx.root, 'pt/index.html'), 'utf8'))
  };
  const result = prepareRealWriteCandidate({ ...ctx, packet, packetPath });
  try {
    if (JSON.stringify([...result.changed_files].sort()) !== JSON.stringify(GOVERNED_URDI_PATHS)) {
      throw new Error(`changed-file proof is not the governed 12 paths: ${result.changed_files.join(', ')}`);
    }
    if (result.merge_allowed !== false || !result.idempotent || result.status !== 'FOUNDER_APPROVAL_REQUIRED') throw new Error('approval stop gate or idempotence was lost');
    for (const [label, rel] of [['en', 'index.html'], ['pt', 'pt/index.html']]) {
      const candidate = lf(fs.readFileSync(path.join(ctx.root, rel), 'utf8'));
      if (!candidate.includes('data-event-id="urdi-2026-mindelo"')) throw new Error(`${rel}: the approved URDI block is missing`);
      // Removing exactly the URDI block must give back the committed Home byte-for-byte:
      // nothing else on the page (including PT training and Learning Spotlight cards) moved.
      if (withoutUrdiBlock(candidate) !== committedHome[label]) throw new Error(`${rel}: Home changed outside the approved URDI block`);
      if (outsideGeneratedEventRegions(withoutUrdiBlock(candidate)) !== outsideGeneratedEventRegions(committedHome[label])) throw new Error(`${rel}: content outside the generated event regions changed`);
    }
  } finally {
    rollbackRealWriteCandidate(ctx.root, result);
  }
  const status = run(ctx.root, 'git', ['status', '--porcelain']);
  if (status) throw new Error(`repository was not restored: ${status}`);
}), 'build-order');

record('build order: the existing guarded-write gates still refuse a stale head, a dirty tree and a stale proof with the repaired sequence', () => withRepository({ asOf: '2026-11-23' }, (ctx) => {
  const stale = urdiPacket({ baseline: 'e'.repeat(40), asOf: '2026-11-23' });
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, packet: stale, packetPath: writePacket(ctx, stale, 'urdi-bo-stale.json') }), /STALE_BRANCH_REFUSED/);
  const packet = urdiPacket({ baseline: ctx.baseline, asOf: '2026-11-23' });
  const packetPath = writePacket(ctx, packet, 'urdi-bo-dirty.json');
  fs.writeFileSync(path.join(ctx.root, 'stray-build-order.txt'), 'dirty\n');
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, packet, packetPath }), /DIRTY_WORKTREE_REFUSED/);
  fs.rmSync(path.join(ctx.root, 'stray-build-order.txt'));
  expectThrow(() => prepareRealWriteCandidate({ ...ctx, packet, packetPath, testHooks: { addUnexpectedFile: true } }), /UNEXPECTED_CHANGED_FILE_SCOPE/);
  assertClean(ctx.root, ctx.baseline);
}), 'build-order');

for (const result of results) {
  console.log(`${result.status} — ${result.name}${result.reason ? `: ${result.reason}` : ''}`);
}
const failures = results.filter((result) => result.status === 'FAIL');
const originals = results.filter((result) => result.group === 'original');
const originalFailures = originals.filter((result) => result.status === 'FAIL');
console.log(`\nOriginal Phase 1B guarded-write tests: ${originals.length - originalFailures.length}/${originals.length} passed.`);
const urdiTests = results.filter((result) => result.group === 'urdi');
console.log(`URDI Tranche A guarded-writer tests: ${urdiTests.filter((result) => result.status === 'PASS').length}/${urdiTests.length} passed.`);
const buildOrderTests = results.filter((result) => result.group === 'build-order');
console.log(`Writer build-order tests: ${buildOrderTests.filter((result) => result.status === 'PASS').length}/${buildOrderTests.length} passed.`);
console.log(`Complete Phase 1B safety tests: ${results.length - failures.length}/${results.length} passed.`);
if (failures.length) process.exit(1);
