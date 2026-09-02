#!/usr/bin/env node
// Phase 1 publication-packet currentness contract test.
//
// Project 03 ruling of 1 September 2026 (Option A):
//
//   NORMAL READY CI FIXTURE   tracks the repository's committed currentness
//                             baseline.
//   REAL PUBLICATION PACKETS  continue to require an explicit governed
//                             control.as_of.
//   DELIBERATE DIVERGENCE     stays covered, but as a separate deterministic
//                             regression rather than as a side effect of the
//                             normal ready path.
//   REVIEW_READY              unchanged.
//
// --- Why the ready path no longer runs on a pinned date -------------------
//
// scripts/prepare-event-publication.mjs writes packet.control.as_of into the
// isolated dry-run workspace and regenerates the Things-to-Do surfaces from
// it. When the packet's as_of differs from the committed baseline, that is a
// deliberate rewind or advance of repository currentness, and every record
// whose lifecycle boundary lies between the two dates re-renders. Those
// records are not the packet's, so the regenerated files fall outside
// expectedDryRunChangedFiles() and the bounded-diff assertion refuses the
// run -- correctly.
//
// A pinned fixture date therefore only holds while the repository baseline
// happens to equal it. Every currentness repair that advances the baseline
// past an event's end_date broke the CI fixture and was answered by editing
// the date again (see f6541b0, "Align ready fixture with currentness
// baseline"). Binding the normal ready path to the committed baseline ends
// that treadmill without touching the bounded-diff contract, which is doing
// exactly the job it exists to do.
//
// Every date below is derived from committed repository data. None is read
// from the system clock and none is written down, so this file cannot become
// the next date treadmill.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPacket, requiredPtKeys, validatePacket } from './lib/event-publication-contract.mjs';
import { isExpired, isReviewDue } from './lib/things-to-do-currentness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'automation/things-to-do/fixtures/ready.json';
const SUCCESS_TOKEN = 'STATUS: REVIEW_READY';
const results = [];

function run(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: process.env });
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${args.join(' ')} failed: ${detail}`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function record(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS' });
  } catch (error) {
    results.push({ name, status: 'FAIL', reason: error.message });
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The repository's committed currentness baseline. The single source here. */
function committedAsOf(root = ROOT) {
  return readJson(path.join(root, 'data', 'things-to-do-currentness.json')).as_of;
}

function records(root) {
  return readJson(path.join(root, 'data', 'things-to-do-events.json')).records;
}

/**
 * What the generator actually renders from, per record, at a date.
 *
 * EXPIRY is the surface-bearing distinction, not the full currentness state.
 * CURRENT and REVIEW_DUE render identically -- a review-due record stays on
 * Home and its detail route is deliberately NOT labelled a past event -- so a
 * current -> review-due transition changes currentnessState() while leaving
 * every byte of every surface alone. Keying this vector on the full state
 * would therefore report "crosses a boundary" for a transition that
 * regenerates nothing, and the bounded-diff tests built on it would assert a
 * diff that never materializes.
 */
function renderVector(root, asOf) {
  return records(root).map((item) => `${item.id}:${isExpired(item, asOf)}`).join('|');
}

/**
 * True when any record demands reverification at a date.
 *
 * This is a publication-viability test, not a rendering one. The canonical
 * currentness validator exits 3 at a review-due date, and
 * prepare-event-publication.mjs runs that validator, so the whole dry-run is
 * refused before the bounded-diff check is ever reached. That refusal is
 * governed behavior -- a record with no established closing day must be
 * reverified by a human first -- so a date carrying it cannot be used to test
 * the diff-scope contract, which is a different guard entirely.
 */
function hasReviewDue(root, asOf) {
  return records(root).some((item) => isReviewDue(item, asOf));
}

function shiftDay(day, offset) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const SEARCH_DAYS = 400;

/**
 * The nearest date to the committed baseline that either does or does not
 * cross a rendered lifecycle boundary, whichever the caller asks for. Derived
 * from the committed events, so it moves with the data instead of pinning a
 * calendar day.
 *
 * Only the two divergence tests use this. They search the governed corpus
 * because they are ABOUT the governed corpus, and they are direction-agnostic
 * by nature -- a date that diverges from the baseline diverges whichever side
 * it falls on. The historical regression deliberately does NOT use this: it
 * builds its own boundary by arithmetic, so there is no search that could
 * resolve backwards and no dependency on a convenient governed expiry.
 */
function divergentAsOf(root, { crossesLifecycle }) {
  const baseline = committedAsOf(root);
  const target = renderVector(root, baseline);
  for (let distance = 1; distance <= SEARCH_DAYS; distance += 1) {
    for (const sign of [1, -1]) {
      const candidate = shiftDay(baseline, sign * distance);
      // A review-due candidate is refused by the currentness validator before
      // the diff-scope check runs, so it cannot decide either divergence case.
      if (hasReviewDue(root, candidate)) continue;
      if ((renderVector(root, candidate) !== target) === crossesLifecycle) return candidate;
    }
  }
  throw new Error(
    `no ${crossesLifecycle ? 'crossing' : 'non-crossing'} publication-viable ` +
    `as_of exists within ${SEARCH_DAYS} days of baseline ${baseline}`
  );
}

/** The committed ready fixture, rebound to a chosen as_of, on disk. */
function materializePacket(asOf, root = ROOT) {
  const packet = loadPacket(path.join(root, FIXTURE));
  packet.control.as_of = asOf;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-packet-currentness-'));
  const file = path.join(dir, 'packet.json');
  writeJson(file, packet);
  return { packet, file, dir };
}

function withPacket(asOf, fn, root = ROOT) {
  const materialized = materializePacket(asOf, root);
  try {
    return fn(materialized);
  } finally {
    fs.rmSync(materialized.dir, { recursive: true, force: true });
  }
}

function preflight(file, root = ROOT) {
  const result = run(root, ['scripts/validate-event-publication-packet.mjs', `--packet=${file}`], { allowFailure: true });
  return { ...result, report: JSON.parse(result.stdout || result.stderr) };
}

function prepare(file, root = ROOT) {
  return run(root, ['scripts/prepare-event-publication.mjs', `--packet=${file}`], { allowFailure: true });
}

function expectPrepared(result) {
  if (result.status !== 0 || !result.stdout.includes(SUCCESS_TOKEN)) {
    throw new Error(`expected ${SUCCESS_TOKEN} (exit 0), got exit ${result.status}: ${result.stdout.trim()}`);
  }
}

function expectBoundedDiffRefusal(result, context) {
  if (result.status === 0) throw new Error(`${context}: accepted; the bounded-diff guard is not holding`);
  if (!/STATUS: VALIDATION_FAILED/.test(result.stdout) || !/Unexpected dry-run diff scope/.test(result.stdout)) {
    throw new Error(`${context}: expected a bounded-diff refusal, got: ${result.stdout.trim()}`);
  }
}

/**
 * A throwaway repository carrying its OWN deterministic lifecycle boundary.
 *
 * The historical regression needs a repository whose committed baseline sits
 * strictly after an expiry that regenerates surfaces. Deriving that boundary
 * from the governed corpus made the test depend on a convenient future event
 * existing there: once the committed baseline passes the last day-precision
 * end_date, no future expiry remains, and the helper failed closed and
 * reddened CI for a reason that has nothing to do with the contract under
 * test. Month-precision records do not fill the gap -- REVIEW_DUE stays public
 * and renders identically, so it is not an expiry transition at all.
 *
 * So the boundary is constructed here instead. A TEST-ONLY record is cloned
 * from a governed one, given a distinct id and route, and dated relative to
 * the chosen baseline:
 *
 *   end_date = baseline - 1  ->  EXPIRED at `baseline`, CURRENT at `end_date`
 *
 * That single record guarantees a rendered lifecycle change between those two
 * dates whatever the governed corpus contains -- zero future expiries, only
 * month-precision records, or no boundary for years. The synthetic record
 * lives only in the temporary copy: production event data, the production
 * currentness resolver and every committed surface are untouched, and no
 * production validator is weakened to accommodate it.
 */
const SYNTHETIC_ID = 'automation-regression-boundary-event';
// scripts/validate-things-to-do-currentness.mjs decides whether a record is on
// Home by matching `<h3>${record.title}</h3>`, so a clone that kept the source
// title would be read as the GOVERNED record appearing on Home and trip a
// false currentness error the moment the synthetic record renders as current.
// The title has to be as distinct as the id and the route.
const SYNTHETIC_TITLE = 'Automation Regression Boundary Event';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function insertHomeMarkers(file, id) {
  const html = fs.readFileSync(file, 'utf8');
  const matches = [...html.matchAll(/<!-- END GENERATED EVENT: [a-z0-9]+(?:-[a-z0-9]+)* -->/g)];
  if (!matches.length) throw new Error(`${file} has no generated-event marker block`);
  const last = matches[matches.length - 1];
  const at = last.index + last[0].length;
  const insertion = `\n        <!-- BEGIN GENERATED EVENT: ${id} -->\n        <!-- END GENERATED EVENT: ${id} -->`;
  fs.writeFileSync(file, html.slice(0, at) + insertion + html.slice(at));
}

/** The governed record the synthetic one is cloned from: day precision, published, with media. */
function cloneSource(root) {
  const source = records(root).find(
    (item) => item.publication_state === 'published' && item.media && (item.end_precision ?? 'day') === 'day'
  );
  if (!source) throw new Error('no published day-precision record available to clone');
  return source;
}

function withSyntheticBoundaryRepository({ baseline = committedAsOf(ROOT) } = {}, fn) {
  // `advanced` is the repository's committed baseline; `priorTo` is the day the
  // synthetic record expires on. advanced > priorTo always, by construction --
  // there is no search, so there is nothing to accidentally resolve backwards.
  const advanced = baseline;
  const priorTo = shiftDay(advanced, -1);
  if (!(advanced > priorTo)) throw new Error(`synthetic boundary is not forward: ${advanced} !> ${priorTo}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-synthetic-boundary-'));
  const root = path.join(dir, 'repo');
  try {
    fs.cpSync(ROOT, root, { recursive: true, filter: (src) => path.basename(src) !== '.git' });

    const source = cloneSource(root);
    const synthetic = cloneJson(source);
    synthetic.id = SYNTHETIC_ID;
    synthetic.title = SYNTHETIC_TITLE;
    synthetic.detail_page = `things-to-do/${SYNTHETIC_ID}/`;
    synthetic.media_manifest_title = SYNTHETIC_TITLE;
    synthetic.end_precision = 'day';
    delete synthetic.end_month;
    delete synthetic.start_datetime;
    delete synthetic.end_datetime;
    synthetic.start_date = shiftDay(advanced, -8);
    synthetic.end_date = priorTo;
    synthetic.checked_at = synthetic.start_date;

    const eventsPath = path.join(root, 'data', 'things-to-do-events.json');
    const events = readJson(eventsPath);
    if (events.records.some((item) => item.id === SYNTHETIC_ID)) {
      throw new Error(`${SYNTHETIC_ID} collides with a governed record id`);
    }
    if (events.records.some((item) => item.title === SYNTHETIC_TITLE)) {
      throw new Error(`${SYNTHETIC_TITLE} collides with a governed record title`);
    }
    events.records.push(synthetic);
    writeJson(eventsPath, events);

    const manifestPath = path.join(root, 'internal', 'provider-media-manifest.json');
    const manifest = readJson(manifestPath);
    const sourceMedia = manifest.records.find(
      (item) => item.section === 'things-to-do' && item.title === source.media_manifest_title
    );
    if (!sourceMedia) throw new Error(`no media manifest record for ${source.media_manifest_title}`);
    const syntheticMedia = cloneJson(sourceMedia);
    syntheticMedia.title = synthetic.media_manifest_title;
    syntheticMedia.media_checked_date = synthetic.checked_at;
    manifest.records.push(syntheticMedia);
    writeJson(manifestPath, manifest);

    // PT coverage, taken key-for-key from the cloned record so the locale
    // contract stays satisfied without inventing governed translations.
    const localePath = path.join(root, 'data', 'locales', 'locale-data.generated.json');
    const locale = readJson(localePath);
    for (const key of requiredPtKeys(synthetic)) {
      const sourceKey = key.replace(`event.${SYNTHETIC_ID}.`, `event.${source.id}.`);
      const pt = key.endsWith('.title') ? SYNTHETIC_TITLE : locale.keys[sourceKey]?.pt;
      if (pt == null) throw new Error(`cloned record is missing PT key ${sourceKey}`);
      locale.keys[key] = {
        key,
        en: '',
        pt,
        scope_status: 'REQUIRED_FOR_PT_LAUNCH',
        identity_policy: 'TRANSLATE_NORMALLY',
        record_id: SYNTHETIC_ID,
        translation_status: 'APPROVED',
        source_revision: 'TEST_ONLY_REGRESSION_BOUNDARY',
        context_notes: 'Ephemeral test-only row; never a governed locale source mutation.',
        linguistic_notes: ''
      };
    }
    writeJson(localePath, locale);

    insertHomeMarkers(path.join(root, 'index.html'), SYNTHETIC_ID);
    insertHomeMarkers(path.join(root, 'pt', 'index.html'), SYNTHETIC_ID);

    const currentnessPath = path.join(root, 'data', 'things-to-do-currentness.json');
    writeJson(currentnessPath, { ...readJson(currentnessPath), as_of: advanced });
    run(root, ['scripts/generate-things-to-do.mjs', `--as-of=${advanced}`, '--write']);
    run(root, ['scripts/generate-things-to-do.mjs', `--as-of=${advanced}`, '--locale=pt', '--write']);
    run(root, ['scripts/build-sitemap.mjs', '--write']);

    if (committedAsOf(root) !== advanced) throw new Error('temporary repository did not adopt the advanced baseline');
    if (renderVector(root, advanced) === renderVector(root, priorTo)) {
      throw new Error(`synthetic boundary did not change rendered state between ${priorTo} and ${advanced}`);
    }
    if (hasReviewDue(root, advanced) || hasReviewDue(root, priorTo)) {
      throw new Error('synthetic boundary window carries a review-due record');
    }
    return fn({ root, advanced, priorTo, syntheticId: SYNTHETIC_ID });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Normal ready path: bound to the committed baseline -------------------

record('committed ready fixture is a valid packet as stored', () => {
  const result = preflight(path.join(ROOT, FIXTURE));
  if (result.status !== 0 || result.report.state !== 'READY_FOR_IMPLEMENTATION') {
    throw new Error(`expected READY_FOR_IMPLEMENTATION, got ${result.report.state}`);
  }
});

record('normal ready path preflights READY_FOR_IMPLEMENTATION at the committed baseline', () => {
  withPacket(committedAsOf(), ({ file }) => {
    const result = preflight(file);
    if (result.status !== 0 || result.report.state !== 'READY_FOR_IMPLEMENTATION') {
      throw new Error(`expected READY_FOR_IMPLEMENTATION, got ${result.report.state}: ${JSON.stringify(result.report.issues)}`);
    }
  });
});

record('normal ready path prepares REVIEW_READY at the committed baseline', () => {
  withPacket(committedAsOf(), ({ file }) => expectPrepared(prepare(file)));
});

record('normal ready path declares no currentness mutation at the committed baseline', () => {
  withPacket(committedAsOf(), ({ file }) => {
    const result = prepare(file);
    expectPrepared(result);
    if (result.stdout.includes('- data/things-to-do-currentness.json')) {
      throw new Error('baseline-bound ready path must not rewrite committed currentness');
    }
  });
});

// --- Historical regression: a self-contained lifecycle boundary -----------

record('the synthetic boundary repository is built strictly forward of its expiry', () => {
  withSyntheticBoundaryRepository({}, ({ root, advanced, priorTo, syntheticId }) => {
    if (!(advanced > priorTo)) throw new Error(`advanced ${advanced} does not follow ${priorTo}`);
    if (committedAsOf(root) !== advanced) throw new Error('temporary repository baseline was not adopted');
    const synthetic = records(root).find((item) => item.id === syntheticId);
    if (!synthetic) throw new Error('synthetic record was not injected');
    if (synthetic.end_date !== priorTo) throw new Error('synthetic record does not carry the intended expiry');
    if (isExpired(synthetic, priorTo)) throw new Error(`synthetic record is already expired at ${priorTo}`);
    if (!isExpired(synthetic, advanced)) throw new Error(`synthetic record has not expired at ${advanced}`);
  });
});

record('the synthetic boundary is arithmetic, not a search of the governed corpus', () => {
  withSyntheticBoundaryRepository({}, ({ root, advanced, priorTo, syntheticId }) => {
    // The window is derived, not discovered: no governed record is consulted to
    // find it, so no governed record can withhold it.
    if (priorTo !== shiftDay(advanced, -1)) throw new Error('boundary window was not derived by arithmetic');
    const synthetic = records(root).find((item) => item.id === syntheticId);
    if (isExpired(synthetic, priorTo) || !isExpired(synthetic, advanced)) {
      throw new Error('the synthetic record alone does not span the boundary');
    }
    // And it is not merely riding on a governed boundary that happens to exist.
    const governed = records(root).filter((item) => item.id !== syntheticId);
    const governedVector = (asOf) => governed.map((item) => `${item.id}:${isExpired(item, asOf)}`).join('|');
    const governedHelps = governedVector(advanced) !== governedVector(priorTo);
    if (governedHelps) return; // harmless, but today it must not be load-bearing
    if (renderVector(root, advanced) === renderVector(root, priorTo)) {
      throw new Error('with no governed boundary in the window the rendered change vanished');
    }
  });
});

record('an advanced committed baseline no longer breaks the normal ready path', () => {
  withSyntheticBoundaryRepository({}, ({ root, advanced }) => {
    withPacket(advanced, ({ file }) => expectPrepared(prepare(file, root)), root);
  });
});

/**
 * The negative control. It pins the packet to the day the synthetic record
 * expires on, which is strictly before the repository's committed baseline, so
 * preparing it rewinds that record back into its current rendering and
 * regenerates surfaces no packet owns. Guaranteed by construction rather than
 * by the governed corpus or by the fixture file's stored date.
 */
record('a packet rewinding the advanced repository is refused', () => {
  withSyntheticBoundaryRepository({}, ({ root, advanced, priorTo }) => {
    if (!(priorTo < advanced)) throw new Error(`rewind date ${priorTo} does not precede ${advanced}`);
    withPacket(priorTo, ({ file }) => {
      expectBoundedDiffRefusal(prepare(file, root), `rewind to ${priorTo} from ${advanced}`);
    }, root);
  });
});

/**
 * The same control aimed at the fixture's own stored date. Whether that date
 * rewinds the temporary repository is data-dependent, so this asserts the
 * canonical resolver's verdict either way rather than assuming a refusal -- a
 * fixture date that no longer diverges must be PREPARED, not refused.
 */
record('the fixture stored date is judged by the canonical resolver, not assumed', () => {
  withSyntheticBoundaryRepository({}, ({ root, advanced }) => {
    const stored = loadPacket(path.join(ROOT, FIXTURE)).control.as_of;
    const rewinds = renderVector(root, stored) !== renderVector(root, advanced) && !hasReviewDue(root, stored);
    withPacket(stored, ({ file }) => {
      const result = prepare(file, root);
      if (rewinds) expectBoundedDiffRefusal(result, `stored fixture date ${stored} from ${advanced}`);
      else expectPrepared(result);
    }, root);
  });
});

// --- Deliberate as_of divergence, kept explicit ---------------------------

record('authorized divergence within one lifecycle window stays REVIEW_READY', () => {
  const asOf = divergentAsOf(ROOT, { crossesLifecycle: false });
  if (asOf === committedAsOf()) throw new Error('divergence date did not diverge');
  withPacket(asOf, ({ file }) => {
    const result = prepare(file);
    expectPrepared(result);
    if (!result.stdout.includes('- data/things-to-do-currentness.json')) {
      throw new Error('a diverging packet must declare the currentness file in its bounded diff');
    }
  });
});

record('divergence across a lifecycle boundary is refused, not absorbed', () => {
  const asOf = divergentAsOf(ROOT, { crossesLifecycle: true });
  withPacket(asOf, ({ file }) => {
    const result = prepare(file);
    if (result.status === 0) {
      throw new Error('divergence that regenerates non-packet surfaces must be refused');
    }
    if (!/STATUS: VALIDATION_FAILED/.test(result.stdout) || !/Unexpected dry-run diff scope/.test(result.stdout)) {
      throw new Error(`expected a bounded-diff refusal, got: ${result.stdout.trim()}`);
    }
  });
});

// --- The real-packet contract is untouched --------------------------------

record('real packets still require an explicit governed control.as_of', () => {
  const packet = loadPacket(path.join(ROOT, FIXTURE));
  for (const value of [undefined, null, '', '2026-9-1', '2026-02-30', 'today']) {
    const candidate = JSON.parse(JSON.stringify(packet));
    if (value === undefined) delete candidate.control.as_of;
    else candidate.control.as_of = value;
    const result = validatePacket(candidate, { root: ROOT, checkRepository: false });
    if (result.ok || result.state !== 'INVALID_INPUT') {
      throw new Error(`control.as_of ${JSON.stringify(value)} was accepted as ${result.state}`);
    }
  }
});

record('REVIEW_READY remains the only success token of publication preparation', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare-event-publication.mjs'), 'utf8');
  if (!source.includes(`'${SUCCESS_TOKEN}'`)) throw new Error('the REVIEW_READY success token was renamed');
  withPacket(committedAsOf(), ({ file }) => {
    const result = prepare(file);
    expectPrepared(result);
    if (/STATUS: (?!REVIEW_READY)/.test(result.stdout)) throw new Error('preparation emitted a second status');
    if (result.stdout.includes('READY_FOR_IMPLEMENTATION')) {
      throw new Error('preflight and preparation vocabularies must stay distinct');
    }
  });
});

record('publication preparation still refuses every real-write authorization', () => {
  const packet = loadPacket(path.join(ROOT, FIXTURE));
  for (const field of ['allow_branch', 'allow_commit', 'allow_pr', 'merge_allowed']) {
    if (packet.control[field] !== false) throw new Error(`ready fixture must keep control.${field} false`);
  }
  const escalated = JSON.parse(JSON.stringify(packet));
  escalated.control.merge_allowed = true;
  const result = validatePacket(escalated, { root: ROOT, checkRepository: false });
  if (result.ok) throw new Error('merge_allowed=true was accepted');
});

for (const result of results) {
  console.log(`${result.status} — ${result.name}${result.reason ? `: ${result.reason}` : ''}`);
}
const failures = results.filter((result) => result.status === 'FAIL');
console.log(`\nPhase 1 publication-packet currentness contract: ${results.length - failures.length}/${results.length} passed.`);
if (failures.length) process.exit(1);
