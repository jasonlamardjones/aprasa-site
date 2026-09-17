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
//   preview after   cartinha (active) · sinergia
//
// PROMOTION IS NO LONGER PART OF THIS SCENARIO, and cannot be.
//
// Home membership used to be "the first N eligible records", so an expiry
// UNSELECTED the next eligible record onto Home and the repair had to backfill
// its slot. Since Project 03's EXPAND_HOME_PREVIEW ruling (17 September 2026)
// membership is a governed curated list (HOME_PREVIEW_IDS) intersected with
// eligibility. Eligibility only ever shrinks, so preview membership can only
// ever shrink: no record is promoted into a freed slot, by construction.
//
// What survives, and is still exercised below, is everything the backfill case
// was wrapped around: that a preview-boundary expiry authorizes Home at all,
// that the derived write set stays bounded, that Home moves only inside its own
// generated-event regions, and that unrelated or unauthorized Home drift fails
// closed. What is gone is the single assertion that canonical generation fills
// a promoted record's slot - unreachable while a curated list governs Home.
//
// IF MEMBERSHIP EVER RETURNS TO A COUNT-BASED RULE, the promotion assertions
// must come back with it; see git history for this file at
// 0dcf1babd8e115fcdc71e8f0698069ef917b2793.
//
// So the fixture assigns its ROLES from the governed selection rather than
// patching it: the record it expires is one HOME_PREVIEW_IDS actually selects,
// so the expiry is still a real preview-boundary event, and 50-anos stays as
// the eligible-but-UNSELECTED control. Only end dates are synthetic, exactly as
// before. (Patching the selection in the sandbox would not work anyway: the
// transition below is derived IN THIS PROCESS from the real module, while the
// sandbox only governs what the child generator processes see.)
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
import { isDatedEvent } from '../lib/things-to-do-kinds.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');

const BEFORE = '2026-10-01';
const AFTER = '2026-10-02';
// Roles, all drawn from the governed Home selection except UNSELECTED.
// ACTIVE, EXPIRING, RETAINED and the two EVERGREEN records are selected by
// HOME_PREVIEW_IDS; UNSELECTED deliberately is not, and is the control that
// proves a freed slot is never backfilled.
const ACTIVE = 'cartinha-dholanda-mindelo-2026';
const EXPIRING = 'voyage-obi-margo-kafe-djan-djan-2026';
const RETAINED = 'sinergia-da-materia';
const UNSELECTED = '50-anos-de-memoria-criacao-e-resistencia';
// Selected, evergreen and therefore current on both sides of every transition.
const EVERGREEN = ['taverna-live-music', 'nautilus-live-music'];

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
  const keep = { [ACTIVE]: '2026-12-31', [RETAINED]: '2026-12-31', [UNSELECTED]: '2026-12-31', [EXPIRING]: BEFORE };
  for (const record of events.records) {
    // Only DATED EVENTS take part in a preview-boundary expiry, so only they
    // are given a synthetic end. An evergreen recurring-venue record states no
    // occurrence at all -- it carries no end field to assign, it can never
    // expire, and the canonical schema rejects it outright if it is given one.
    // It is therefore left exactly as committed, which is also what the
    // fixture wants: such a record sits after all four named records in
    // canonical order, so it stays outside the three-slot preview on both
    // sides of the transition and cannot perturb the membership asserted below.
    if (!isDatedEvent(record)) continue;
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
  assert.deepEqual(transition.previewBefore, [ACTIVE, EXPIRING, RETAINED, ...EVERGREEN].sort());
  assert.deepEqual(transition.previewAfter, [ACTIVE, RETAINED, ...EVERGREEN].sort());
  assert.ok(!transition.previewAfter.includes(EXPIRING), 'the expiring record must leave the preview');
  // The curated selection is why nothing takes its place. 50-anos is eligible on
  // BOTH sides of the transition and simply is not selected, so it is on neither
  // side of the preview -- this is the assertion that fails if Home membership
  // ever silently reverts to "the first N eligible records".
  assert.ok(!transition.previewBefore.includes(UNSELECTED), 'the unselected record must be absent before the transition');
  assert.ok(!transition.previewAfter.includes(UNSELECTED), 'the unselected record must not be promoted into the freed slot');
  // Only the expiring record's own currentness state moves.
  assert.deepEqual(transition.stateChangedIds, [EXPIRING]);
  // Detail authority follows RENDERED currentness, which is narrower still:
  // renderDetailPage() consults isExpired() alone.
  assert.deepEqual(transition.detailRenderingChangedIds, [EXPIRING]);

  nodeOk(work, 'scripts/build-all.mjs', [`--as-of=${BEFORE}`]);
  // Rendered order is Home's marker-slot order, not the selection's order.
  const HOME_BEFORE = [ACTIVE, RETAINED, EXPIRING, ...EVERGREEN];
  const HOME_AFTER = [ACTIVE, RETAINED, ...EVERGREEN];
  assert.deepEqual(homeCardIds(work, 'index.html'), HOME_BEFORE);
  assert.deepEqual(homeCardIds(work, 'pt/index.html'), HOME_BEFORE);
  assert.doesNotThrow(() => assertValidatorResults(incumbentValidatorResults(work, BEFORE)),
    'the synthetic BEFORE baseline must itself be a valid published state');

  // --- Drift, read the way the adapter reads it ---------------------------
  const currentness = node(work, 'scripts/validate-things-to-do-currentness.mjs', [`--as-of=${AFTER}`]);
  assert.equal(currentness.status, 1, 'the baseline must present drift at the later as_of');
  const driftIds = parseValidatorDriftIds(currentness.stderr);
  assert.deepEqual(driftIds, [EXPIRING]);

  // --- DRIFT-ID-ONLY GENERATION, the case the audit was about --------------
  //
  // This block used to be a NEGATIVE proof: under "first N eligible", an expiry
  // promoted a record whose slot drift-id-only generation never filled, Home
  // shipped a short preview, and surface equivalence failed with
  // PHASE2B_INCUMBENT_VALIDATOR_FAILED.
  //
  // Under a curated selection there is nothing to backfill, so the same
  // generation is now SUFFICIENT and the proof inverts. That inversion is the
  // point: it is asserted rather than deleted, because the day it starts
  // failing again is the day Home membership has silently gone back to being
  // count-derived, and the backfill machinery below is load-bearing again.
  const narrow = freshSandbox();
  nodeOk(narrow, 'scripts/build-all.mjs', [`--as-of=${BEFORE}`]);
  const narrowCurrentness = readJson(narrow, 'data/things-to-do-currentness.json');
  narrowCurrentness.as_of = AFTER;
  writeJson(narrow, 'data/things-to-do-currentness.json', narrowCurrentness);
  for (const id of driftIds) {
    nodeOk(narrow, 'scripts/generate-things-to-do.mjs', [`--as-of=${AFTER}`, `--id=${id}`, '--locale=en', '--write']);
    nodeOk(narrow, 'scripts/generate-things-to-do.mjs', [`--as-of=${AFTER}`, `--id=${id}`, '--locale=pt', '--home=pt/index.html', '--write']);
  }
  assert.deepEqual(homeCardIds(narrow, 'index.html'), HOME_AFTER,
    'emptying the expired record\'s own slot is the whole repair under a curated selection');
  assert.ok(!homeCardIds(narrow, 'index.html').includes(UNSELECTED),
    'no unselected eligible record may appear, however Home was generated');
  const narrowResults = incumbentValidatorResults(narrow, AFTER);
  assert.doesNotThrow(() => assertValidatorResults(narrowResults),
    'with no promotion to backfill, drift-id-only generation now produces a valid published state');

  // --- 1. PREVIEW-BOUNDARY EXPIRY: canonical generation stays correct ------
  const baseline = inventory(work);
  const homeBefore = new Map(['index.html', 'pt/index.html'].map(
    (file) => [file, fs.readFileSync(path.join(work, file), 'utf8')],
  ));
  runCanonicalGeneration(work, AFTER);
  const changed = changedFiles(baseline, inventory(work));

  assert.deepEqual(homeCardIds(work, 'index.html'), HOME_AFTER,
    'the expired record must leave the EN Home preview, with nothing promoted into its slot');
  assert.deepEqual(homeCardIds(work, 'pt/index.html'), HOME_AFTER,
    'the expired record must leave the PT Home preview, with nothing promoted into its slot');
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
  for (const id of [ACTIVE, RETAINED, UNSELECTED, ...EVERGREEN]) {  // currentness unchanged across the transition
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
  //
  // Under a curated selection only the LEAVING record qualifies, so authority
  // narrows to the expiring record alone. The derivation is unchanged; it simply
  // has one fewer kind of membership change to describe.
  assert.deepEqual(regionIds, [EXPIRING]);
  assert.ok(!regionIds.includes(UNSELECTED),
    'an eligible but unselected record never enters the preview, so its slot is never authorized');
  for (const retained of [ACTIVE, RETAINED]) {
    assert.ok(!regionIds.includes(retained),
      `${retained} is retained across the transition, so its Home slot must NOT be authorized`);
  }
  for (const [file, beforeHtml] of homeBefore) {
    const afterHtml = fs.readFileSync(path.join(work, file), 'utf8');
    const regionDiff = homeRegionChange(beforeHtml, afterHtml);
    assert.equal(regionDiff.outsideChanged, false, `${file} must not change outside its generated-event regions`);
    assert.deepEqual(regionDiff.changedIds, [EXPIRING],
      `${file} must move exactly the expiring slot and nothing else`);
    assert.deepEqual(assertHomeRegionChangeBounded(beforeHtml, afterHtml, regionIds, file), [EXPIRING]);
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
  // Authority narrowed below what actually moved must still fail closed. This
  // used to pass [EXPIRING] against an authority of [EXPIRING, UNSELECTED]; with
  // authority now [EXPIRING], the under-authorized set is the empty one.
  assert.throws(
    () => assertHomeRegionChangeBounded(firstHome, fs.readFileSync(path.join(work, 'index.html'), 'utf8'), [], 'index.html'),
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
