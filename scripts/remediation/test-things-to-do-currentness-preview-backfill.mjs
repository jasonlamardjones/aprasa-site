// Integration coverage for the Phase 2B preview-boundary backfill repair.
//
// The unit suite next to this file covers authorization, probe parsing and the
// pure write-set derivation. This file covers the thing that unit tests cannot
// reach: whether canonical generation, driven the way the adapter drives it,
// actually produces a coherent Home after a lifecycle transition — and whether
// the derived write set admits exactly that transition and nothing else.
//
// Fixture data is SYNTHETIC. The audit case was Eclipse leaving the Home
// preview on 2026-09-13, but a test pinned to that would decay the moment the
// canonical record is corrected or the tracked as_of moves, and it would
// silently stop exercising the boundary at all. Instead the fixture assigns
// explicit end dates to the canonical records inside a sandbox so an
// Eclipse-CLASS expiry is constructed on demand:
//
//   preview before  cartinha (active) · eclipse (expires at the boundary) · sinergia
//   preview after   cartinha (active) · sinergia · 50-anos (PROMOTED)
//
// Nothing here writes to the repository: every step runs in a temporary
// sandbox copy, and no step contacts GitHub.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertBoundedWriteSet,
  assertHomeRegionChangeBounded,
  assertValidatorResults,
  expectedWriteSetForTransition,
  homeRegionAuthorizedIds,
  homeRegionChange,
  parseValidatorDriftIds,
  resolvePreviewTransition,
} from './lib/things-to-do-currentness-remediation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');

const BEFORE = '2026-10-01';
const AFTER = '2026-10-02';
const ACTIVE = 'cartinha-dholanda-mindelo-2026';
const EXPIRING = 'eclipse-yuran-henrique';
const RETAINED = 'sinergia-da-materia';
const PROMOTED = '50-anos-de-memoria-criacao-e-resistencia';

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.txt', '.xml', '.yaml', '.yml']);

function node(cwd, script, args = []) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: process.env });
}

function nodeOk(cwd, script, args = []) {
  const result = node(cwd, script, args);
  assert.equal(result.status, 0, `${script} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result;
}

// Same inventory/diff semantics the adapter uses, so "changed files" here means
// what it means there.
function inventory(dir) {
  const map = new Map();
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const rel = path.relative(dir, full).split(path.sep).join('/');
        const bytes = fs.readFileSync(full);
        const normalized = TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
          ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'))
          : bytes;
        map.set(rel, crypto.createHash('sha256').update(normalized).digest('hex'));
      }
    }
  }
  visit(dir);
  return map;
}

function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

function readJson(dir, relative) {
  return JSON.parse(fs.readFileSync(path.join(dir, relative), 'utf8'));
}

function writeJson(dir, relative, doc) {
  fs.writeFileSync(path.join(dir, relative), `${JSON.stringify(doc, null, 2)}\n`);
}

function homeCardIds(dir, relative) {
  const html = fs.readFileSync(path.join(dir, relative), 'utf8');
  return [...html.matchAll(/<article class="resource-card" data-event-id="([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Build a sandbox whose canonical records produce an Eclipse-class
 * preview-boundary expiry between BEFORE and AFTER. Only end dates move:
 * membership and ordering stay the incumbent selector's business.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2b-backfill-test-'));
  fs.cpSync(root, dir, {
    recursive: true,
    filter: (src) => !['.git', 'node_modules'].includes(path.basename(src)),
  });
  const events = readJson(dir, 'data/things-to-do-events.json');
  const keep = { [ACTIVE]: '2026-12-31', [RETAINED]: '2026-12-31', [PROMOTED]: '2026-12-31', [EXPIRING]: BEFORE };
  for (const record of events.records) {
    // A record with no assigned survival date ends on its own start day, which
    // is always >= its start and always before BEFORE, so it is out of the
    // collection on both sides of the transition. A record that states only a
    // start_datetime still needs a day, hence the fallback chain — leaving
    // end_date unset would make the record permanently current and quietly
    // change preview membership out from under the fixture.
    const startDay = record.start_date ?? record.start_datetime?.slice(0, 10) ?? '2026-01-01';
    record.end_date = keep[record.id] ?? startDay;
    record.end_precision = 'day';
    delete record.end_month;
  }
  writeJson(dir, 'data/things-to-do-events.json', events);
  const currentness = readJson(dir, 'data/things-to-do-currentness.json');
  currentness.as_of = BEFORE;
  writeJson(dir, 'data/things-to-do-currentness.json', currentness);
  return dir;
}

/** Exactly what runCanonicalGeneration() in the adapter does. */
function runCanonicalGeneration(dir, asOf) {
  const currentness = readJson(dir, 'data/things-to-do-currentness.json');
  currentness.as_of = asOf;
  writeJson(dir, 'data/things-to-do-currentness.json', currentness);
  nodeOk(dir, 'scripts/build-all.mjs', [`--as-of=${asOf}`]);
}

/** Exactly what runIncumbentValidators() in the adapter gates on. */
function incumbentValidatorResults(dir, asOf) {
  const steps = [
    ['scripts/validate-things-to-do-events.mjs'],
    ['scripts/validate-things-to-do-currentness.mjs', `--as-of=${asOf}`],
    ['scripts/validate-things-to-do-surface-equivalence.mjs', `--as-of=${asOf}`],
    ['scripts/validate-things-to-do-sitemap.mjs'],
    ['scripts/validate-card-media.mjs'],
    ['scripts/validate-locale-contract.mjs', '--html', 'pt'],
    ['scripts/validate-pt-home-events.mjs'],
    ['scripts/validate-training-opportunities-currentness.mjs', `--as-of=${asOf}`, '--home=index.html', '--home=pt/index.html'],
  ];
  return steps.map(([script, ...args]) => ({
    step: [script, ...args].join(' '),
    status: node(dir, script, args).status,
  }));
}

const sandboxes = [];
function freshSandbox() {
  const dir = sandbox();
  sandboxes.push(dir);
  return dir;
}

try {
  // --- Coherent BEFORE baseline -------------------------------------------
  const work = freshSandbox();

  // --- The transition this repair exists for -------------------------------
  const records = readJson(work, 'data/things-to-do-events.json').records;
  const transition = resolvePreviewTransition({ records, fromAsOf: BEFORE, toAsOf: AFTER });
  assert.deepEqual(transition.previewBefore, [ACTIVE, EXPIRING, RETAINED].sort());
  assert.deepEqual(transition.previewAfter, [ACTIVE, PROMOTED, RETAINED].sort());
  assert.ok(!transition.previewAfter.includes(EXPIRING), 'the expiring record must leave the preview');
  assert.ok(!transition.previewBefore.includes(PROMOTED), 'the promoted record must be absent before the transition');
  // Only the expiring record's own currentness state moves. The promoted record
  // stays CURRENT across the transition, which is why it earns a Home slot but
  // no detail-page authority.
  assert.deepEqual(transition.stateChangedIds, [EXPIRING]);
  // Detail authority follows RENDERED currentness, which is narrower still:
  // renderDetailPage() consults isExpired() alone.
  assert.deepEqual(transition.detailRenderingChangedIds, [EXPIRING]);

  nodeOk(work, 'scripts/build-all.mjs', [`--as-of=${BEFORE}`]);
  assert.deepEqual(homeCardIds(work, 'index.html'), [ACTIVE, EXPIRING, RETAINED]);
  assert.deepEqual(homeCardIds(work, 'pt/index.html'), [ACTIVE, EXPIRING, RETAINED]);
  assert.doesNotThrow(() => assertValidatorResults(incumbentValidatorResults(work, BEFORE)),
    'the synthetic BEFORE baseline must itself be a valid published state');

  // --- Drift, read the way the adapter reads it ---------------------------
  const currentness = node(work, 'scripts/validate-things-to-do-currentness.mjs', [`--as-of=${AFTER}`]);
  assert.equal(currentness.status, 1, 'the baseline must present drift at the later as_of');
  const driftIds = parseValidatorDriftIds(currentness.stderr);
  assert.deepEqual(driftIds, [EXPIRING]);

  // --- NEGATIVE PROOF: the incumbent drift-id-only generation cannot repair
  // this. It empties the expired record's own Home slot and never fills the
  // promoted record's, so Home ships two cards and surface equivalence fails —
  // which is exactly the PHASE2B_INCUMBENT_VALIDATOR_FAILED abort the audit
  // reproduced. This must keep failing: if it ever passes, the fix below is no
  // longer the thing that makes the repair work.
  const narrow = freshSandbox();
  nodeOk(narrow, 'scripts/build-all.mjs', [`--as-of=${BEFORE}`]);
  const narrowCurrentness = readJson(narrow, 'data/things-to-do-currentness.json');
  narrowCurrentness.as_of = AFTER;
  writeJson(narrow, 'data/things-to-do-currentness.json', narrowCurrentness);
  for (const id of driftIds) {
    nodeOk(narrow, 'scripts/generate-things-to-do.mjs', [`--as-of=${AFTER}`, `--id=${id}`, '--locale=en', '--write']);
    nodeOk(narrow, 'scripts/generate-things-to-do.mjs', [`--as-of=${AFTER}`, `--id=${id}`, '--locale=pt', '--home=pt/index.html', '--write']);
  }
  assert.deepEqual(homeCardIds(narrow, 'index.html'), [ACTIVE, RETAINED],
    'drift-id-only generation leaves the promoted record unbackfilled');
  const narrowResults = incumbentValidatorResults(narrow, AFTER);
  assert.throws(() => assertValidatorResults(narrowResults), /PHASE2B_INCUMBENT_VALIDATOR_FAILED/);
  assert.ok(
    narrowResults.some((item) => item.step.startsWith('scripts/validate-things-to-do-surface-equivalence.mjs') && item.status !== 0),
    'surface equivalence is the gate drift-id-only generation fails',
  );

  // --- 1. PREVIEW-BOUNDARY EXPIRY: canonical generation backfills ----------
  const baseline = inventory(work);
  const homeBefore = new Map(['index.html', 'pt/index.html'].map(
    (file) => [file, fs.readFileSync(path.join(work, file), 'utf8')],
  ));
  runCanonicalGeneration(work, AFTER);
  const changed = changedFiles(baseline, inventory(work));

  assert.deepEqual(homeCardIds(work, 'index.html'), [ACTIVE, RETAINED, PROMOTED],
    'the promoted record must be backfilled into the EN Home preview');
  assert.deepEqual(homeCardIds(work, 'pt/index.html'), [ACTIVE, RETAINED, PROMOTED],
    'the promoted record must be backfilled into the PT Home preview');
  assert.doesNotThrow(() => assertValidatorResults(incumbentValidatorResults(work, AFTER)),
    'remediation must complete rather than abort with PHASE2B_INCUMBENT_VALIDATOR_FAILED');

  // --- 3. DERIVED WRITE SET permits this transition ------------------------
  const allowed = expectedWriteSetForTransition({
    driftIds,
    previewBefore: transition.previewBefore,
    previewAfter: transition.previewAfter,
    detailRenderingChangedIds: transition.detailRenderingChangedIds,
  });
  assert.ok(allowed.includes('data/things-to-do-currentness.json'));
  assert.ok(allowed.includes('index.html') && allowed.includes('pt/index.html'));
  // Detail authority follows a record's OWN state change, not preview
  // membership: the expiring record earns its detail pages, and the promoted
  // record — CURRENT on both sides — does not.
  for (const id of [EXPIRING]) {
    assert.ok(allowed.includes(`things-to-do/${id}/index.html`), `EN detail page for ${id} must be permitted`);
    assert.ok(allowed.includes(`pt/things-to-do/${id}/index.html`), `PT detail page for ${id} must be permitted`);
  }
  for (const id of [ACTIVE, RETAINED, PROMOTED]) {
    assert.ok(!allowed.includes(`things-to-do/${id}/index.html`),
      `${id} keeps its currentness state, so its detail page must NOT be authorized`);
    assert.ok(!allowed.includes(`pt/things-to-do/${id}/index.html`),
      `${id} keeps its currentness state, so its PT detail page must NOT be authorized`);
  }
  // Derivation, not a remembered file count: the audit's five-file Eclipse
  // result is a property of one transition, never the contract.
  assert.ok(!allowed.includes('sitemap.xml'),
    'sitemap.xml is record-derived, not currentness-derived, so a transition must not admit it');

  // --- Home bounded at REGION level, not only file level -------------------
  // Canonical generation rewrites both Home files in full, so the file-level
  // check alone would admit unrelated Home drift. Prove the real repair moves
  // only the transition's own generated-event regions and nothing outside them.
  const regionIds = homeRegionAuthorizedIds({
    driftIds,
    previewBefore: transition.previewBefore,
    previewAfter: transition.previewAfter,
  });
  // Region authority is the drift IDs plus the records that ENTER or LEAVE the
  // preview — never the ones retained on both sides. renderHomeArticle(record,
  // loc) takes no asOf and reads only record fields, so a retained member's slot
  // cannot move for a lifecycle reason; authorizing it would let unrelated drift
  // inside that slot ride along on a repair.
  assert.deepEqual(regionIds, [EXPIRING, PROMOTED].sort());
  for (const retained of [ACTIVE, RETAINED]) {
    assert.ok(!regionIds.includes(retained),
      `${retained} is retained across the transition, so its Home slot must NOT be authorized`);
  }
  for (const [file, beforeHtml] of homeBefore) {
    const afterHtml = fs.readFileSync(path.join(work, file), 'utf8');
    const regionDiff = homeRegionChange(beforeHtml, afterHtml);
    assert.equal(regionDiff.outsideChanged, false, `${file} must not change outside its generated-event regions`);
    assert.deepEqual(regionDiff.changedIds, [EXPIRING, PROMOTED].sort(),
      `${file} must move exactly the expiring and promoted slots`);
    assert.deepEqual(assertHomeRegionChangeBounded(beforeHtml, afterHtml, regionIds, file), [EXPIRING, PROMOTED].sort());
  }
  // Unrelated Home drift outside the regions fails closed, and so does a region
  // belonging to a record this transition never touched.
  const [, firstHome] = [...homeBefore][0];
  const driftedHome = firstHome.replace('<main id="main">', '<main id="main">\n      <!-- unrelated hand edit -->');
  assert.notEqual(driftedHome, firstHome, 'the drift fixture must actually differ');
  assert.throws(
    () => assertHomeRegionChangeBounded(driftedHome, fs.readFileSync(path.join(work, 'index.html'), 'utf8'), regionIds, 'index.html'),
    /PHASE2B_HOME_CHANGE_OUTSIDE_GENERATED_REGIONS/,
  );
  assert.throws(
    () => assertHomeRegionChangeBounded(firstHome, fs.readFileSync(path.join(work, 'index.html'), 'utf8'), [EXPIRING], 'index.html'),
    /PHASE2B_HOME_REGION_CHANGE_UNAUTHORIZED/,
  );

  const bounded = assertBoundedWriteSet(changed, allowed);
  assert.deepEqual(bounded, changed);
  for (const required of [
    'data/things-to-do-currentness.json',
    'index.html',
    'pt/index.html',
    `things-to-do/${EXPIRING}/index.html`,
    `pt/things-to-do/${EXPIRING}/index.html`,
  ]) {
    assert.ok(changed.includes(required), `${required} must be part of the repair`);
  }

  // --- 2. ACTIVE RECORD untouched -----------------------------------------
  for (const surface of [`things-to-do/${ACTIVE}/index.html`, `pt/things-to-do/${ACTIVE}/index.html`]) {
    assert.ok(!changed.includes(surface), `${surface} must not change for a record whose currentness did not move`);
  }
  assert.ok(homeCardIds(work, 'index.html').includes(ACTIVE), 'the active record stays on Home');

  // --- 4. GENUINELY OUT-OF-SCOPE MUTATION still fails closed --------------
  // Not a synthetic list: a real unrelated file written into the sandbox, so the
  // refusal comes from the same inventory diff the adapter performs.
  const strayRelative = 'assets/phase2b-out-of-scope-probe.txt';
  fs.mkdirSync(path.dirname(path.join(work, strayRelative)), { recursive: true });
  fs.writeFileSync(path.join(work, strayRelative), 'unrelated repository drift\n');
  const withStray = changedFiles(baseline, inventory(work));
  assert.ok(withStray.includes(strayRelative));
  assert.throws(() => assertBoundedWriteSet(withStray, allowed), /PHASE2B_UNEXPECTED_FILE_CHANGE/);
  fs.rmSync(path.join(work, strayRelative), { force: true });
  // A record outside the transition is out of scope too, however plausible it
  // looks: only drift plus both sides of the preview may be written.
  const outsideTransition = 'things-to-do/mon-pikenin/index.html';
  assert.ok(!allowed.includes(outsideTransition));
  assert.throws(() => assertBoundedWriteSet([...changed, outsideTransition], allowed), /PHASE2B_UNEXPECTED_FILE_CHANGE/);

  // --- 5. IDEMPOTENCE -----------------------------------------------------
  const beforeSecondPass = inventory(work);
  runCanonicalGeneration(work, AFTER);
  assert.deepEqual(changedFiles(beforeSecondPass, inventory(work)), [],
    'a second canonical generation at the same as_of must produce zero additional diff');

  // --- The adapter really drives this pathway -----------------------------
  // Source assertions, so the behaviour proved above cannot silently diverge
  // from what the workflow executes.
  const runnerSource = fs.readFileSync(path.join(scriptDir, 'run-things-to-do-currentness-remediation.mjs'), 'utf8');
  assert.ok(runnerSource.includes("node(dir, 'scripts/build-all.mjs', [`--as-of=${asOf}`]);"),
    'the adapter must drive canonical generation through build-all');
  assert.ok(!/--id=\$\{id\}/.test(runnerSource), 'the adapter must no longer generate per drift ID');
  assert.ok(runnerSource.includes('expectedWriteSetForTransition('),
    'the adapter must derive its write set from the transition');
  assert.ok(runnerSource.includes('resolvePreviewTransition('),
    'the adapter must resolve preview membership either side of the transition');
  assert.ok(runnerSource.includes('assertHomeRegionChangeBounded('),
    'the adapter must bound Home at region level, not only at file level');
  assert.ok(runnerSource.includes('detailRenderingChangedIds: previewTransition.detailRenderingChangedIds'),
    'the adapter must derive detail authority from actual detail-rendering changes');

  console.log('Phase 2B preview-boundary backfill integration tests passed.');
} finally {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
}
