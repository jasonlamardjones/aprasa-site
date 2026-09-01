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
import { loadPacket, validatePacket } from './lib/event-publication-contract.mjs';
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
 * cross a lifecycle boundary, whichever the caller asks for. Derived from the
 * committed events, so it moves with the data instead of pinning a calendar
 * day.
 *
 * `direction` is explicit because the two callers need different guarantees.
 * "any" searches outward in both directions and is what the divergence tests
 * want -- they only care that the date differs from the baseline, and the
 * nearest such date in either direction is equally valid.
 *
 * "forward" is REQUIRED by the historical-regression helper and is not an
 * optimization. A bidirectional search can return a date EARLIER than the
 * baseline whenever the nearest boundary lies behind it, which is the ordinary
 * case once the baseline has moved past its nearest end_date. Building the
 * "advanced" repository from such a date rewinds it instead, and the
 * historical-regression proof silently inverts: the negative control then
 * pins a packet at a date that no longer rewinds anything, is accepted, and
 * the test that is supposed to prove the bounded-diff guard is still armed
 * proves nothing. Reported by independent exact-SHA review.
 */
function divergentAsOf(root, { crossesLifecycle, direction = 'any' }) {
  const baseline = committedAsOf(root);
  const target = renderVector(root, baseline);
  const signs = direction === 'forward' ? [1] : [1, -1];
  for (let distance = 1; distance <= SEARCH_DAYS; distance += 1) {
    for (const sign of signs) {
      const candidate = shiftDay(baseline, sign * distance);
      // A review-due candidate is refused by the currentness validator before
      // the diff-scope check runs, so it cannot decide either divergence case.
      if (hasReviewDue(root, candidate)) continue;
      if ((renderVector(root, candidate) !== target) === crossesLifecycle) return candidate;
    }
  }
  throw new Error(
    `no ${direction === 'forward' ? 'forward ' : ''}${crossesLifecycle ? 'crossing' : 'non-crossing'} ` +
    `publication-viable as_of exists within ${SEARCH_DAYS} days of baseline ${baseline}`
  );
}

/**
 * A lifecycle crossing STRICTLY AFTER the committed baseline.
 *
 * Fails closed. It never falls back to an earlier date, because an earlier
 * date does not advance the repository -- it rewinds it -- and the negative
 * control built on top would then pin a packet that no longer diverges, be
 * accepted, and report a pass while proving nothing.
 *
 * Failing closed is reachable: it means no unexpired day-precision record
 * remains within the search window, so no future expiry exists to advance
 * across and the historical-regression scenario is not constructible from
 * committed data. That is a real precondition, reported rather than papered
 * over.
 */
function forwardCrossingAsOf(root) {
  const baseline = committedAsOf(root);
  let advanced;
  try {
    advanced = divergentAsOf(root, { crossesLifecycle: true, direction: 'forward' });
  } catch {
    throw new Error(
      `no forward lifecycle crossing within ${SEARCH_DAYS} days of baseline ${baseline}: ` +
      'no unexpired day-precision record remains, so the historical-regression ' +
      'scenario is not constructible from committed event data'
    );
  }
  if (!(advanced > baseline)) {
    throw new Error(`forward crossing search returned ${advanced}, which does not advance baseline ${baseline}`);
  }
  if (renderVector(root, advanced) === renderVector(root, baseline)) {
    throw new Error(`${advanced} regenerates no surface from baseline ${baseline}`);
  }
  if (hasReviewDue(root, advanced)) {
    throw new Error(`${advanced} carries a review-due record and cannot test the diff-scope contract`);
  }
  return { baseline, advanced };
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

/**
 * A copy of the repository whose committed baseline has already advanced past
 * a lifecycle boundary and whose surfaces were regenerated by the canonical
 * generator -- i.e. the state a merged currentness repair leaves behind. This
 * is the exact condition that used to break the pinned ready fixture.
 */
function withAdvancedRepository(fn) {
  // Resolve and assert the direction BEFORE copying or regenerating anything,
  // so a repository that cannot produce a forward crossing fails loudly here
  // rather than being built backwards and quietly proving the wrong thing.
  const { baseline, advanced } = forwardCrossingAsOf(ROOT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-advanced-currentness-'));
  const root = path.join(dir, 'repo');
  try {
    fs.cpSync(ROOT, root, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
    const currentnessPath = path.join(root, 'data', 'things-to-do-currentness.json');
    writeJson(currentnessPath, { ...readJson(currentnessPath), as_of: advanced });
    run(root, ['scripts/generate-things-to-do.mjs', `--as-of=${advanced}`, '--write']);
    run(root, ['scripts/generate-things-to-do.mjs', `--as-of=${advanced}`, '--locale=pt', '--write']);
    run(root, ['scripts/build-sitemap.mjs', '--write']);
    if (committedAsOf(root) !== advanced) throw new Error('advanced repository did not adopt the advanced baseline');
    return fn({ root, asOf: advanced, baseline });
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

// --- Historical regression: an advanced repository baseline ---------------

record('the advanced repository is built strictly forward of the baseline', () => {
  withAdvancedRepository(({ root, asOf, baseline }) => {
    if (!(asOf > baseline)) throw new Error(`advanced ${asOf} does not follow baseline ${baseline}`);
    if (renderVector(root, asOf) === renderVector(root, baseline)) {
      throw new Error(`${asOf} regenerates no surface from ${baseline}`);
    }
    if (hasReviewDue(root, asOf)) throw new Error(`${asOf} carries a review-due record`);
    if (committedAsOf(root) !== asOf) throw new Error('advanced repository baseline was not adopted');
  });
});

record('advanced committed baseline no longer breaks the normal ready path', () => {
  withAdvancedRepository(({ root, asOf, baseline }) => {
    if (!(asOf > baseline)) throw new Error(`advanced ${asOf} does not follow baseline ${baseline}`);
    withPacket(committedAsOf(root), ({ file }) => expectPrepared(prepare(file, root)), root);
  });
});

/**
 * The negative control. It pins the packet to the ORIGINAL baseline inside the
 * advanced repository, which is a rewind across a lifecycle boundary by
 * construction -- forwardCrossingAsOf() guarantees advanced > baseline and
 * that the two resolve different state vectors. It therefore does not depend
 * on the fixture file's stored date happening to be older, which is a
 * coincidence of today's data rather than a property of the contract.
 */
record('a packet rewinding the advanced repository is refused', () => {
  withAdvancedRepository(({ root, asOf, baseline }) => {
    if (!(baseline < asOf)) throw new Error(`rewind date ${baseline} does not precede ${asOf}`);
    withPacket(baseline, ({ file }) => {
      const result = prepare(file, root);
      if (result.status === 0) throw new Error('a rewinding packet was accepted; the bounded-diff guard is not holding');
      if (!/STATUS: VALIDATION_FAILED/.test(result.stdout) || !/Unexpected dry-run diff scope/.test(result.stdout)) {
        throw new Error(`expected a bounded-diff refusal, got: ${result.stdout.trim()}`);
      }
    }, root);
  });
});

/**
 * The same control, aimed at the fixture's own stored date. Whether that date
 * rewinds the advanced repository is data-dependent, so this asserts the
 * canonical resolver's verdict either way rather than assuming a refusal --
 * a fixture date that no longer diverges must be PREPARED, not refused.
 */
record('the fixture stored date is judged by the canonical resolver, not assumed', () => {
  withAdvancedRepository(({ root, asOf }) => {
    const stored = loadPacket(path.join(ROOT, FIXTURE)).control.as_of;
    const rewinds = renderVector(root, stored) !== renderVector(root, asOf) && !hasReviewDue(root, stored);
    withPacket(stored, ({ file }) => {
      const result = prepare(file, root);
      if (rewinds && result.status === 0) {
        throw new Error(`stored fixture date ${stored} crosses a boundary from ${asOf} but was accepted`);
      }
      if (!rewinds) expectPrepared(result);
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
