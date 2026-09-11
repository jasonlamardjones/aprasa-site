#!/usr/bin/env node
// Behavioural tests for scripts/generate-training-opportunities.mjs.
//
// The defect these exist to prevent: the generator used to filter canonical
// records down to the visible publication states BEFORE touching the surface.
// A populated record moved to EXPIRED/WITHDRAWN/SUPERSEDED therefore stopped
// being generator-owned, its stale card stayed visibly on Home, and the run
// still reported success — with a quietly smaller record count. These tests
// drive real state transitions against a populated surface and assert that
// ownership is total: every canonical record, in every state, on every run.
//
// Each case runs in its own throwaway copy of the repository, so nothing here
// can touch the working tree.
//
// Usage: node scripts/test-training-opportunities-generator.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AS_OF = '2026-09-01';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.log(`FAIL — ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-gen-test-'));
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  return dir;
}

function run(dir, locale, extra = []) {
  const args = [
    path.join(dir, 'scripts', 'generate-training-opportunities.mjs'),
    `--locale=${locale}`,
    `--as-of=${AS_OF}`,
    ...(locale === 'pt' ? [`--home=${path.join('pt', 'index.html')}`] : []),
    ...extra,
  ];
  const result = spawnSync('node', args, { cwd: dir, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function homePath(dir, locale) {
  return locale === 'pt' ? path.join(dir, 'pt', 'index.html') : path.join(dir, 'index.html');
}

function region(dir, locale, id) {
  const html = fs.readFileSync(homePath(dir, locale), 'utf8');
  const begin = `<!-- BEGIN GENERATED TRAINING: ${id} -->`;
  const end = `<!-- END GENERATED TRAINING: ${id} -->`;
  const a = html.indexOf(begin);
  const b = html.indexOf(end);
  if (a === -1 || b === -1) return null;
  return html.slice(html.lastIndexOf('\n', a) + 1, b + end.length);
}

function setState(dir, id, state) {
  const p = path.join(dir, 'data', 'training-opportunities.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data.records.find((r) => r.id === id).publication_state = state;
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

const MARKER_ONLY = (id) =>
  `        <!-- BEGIN GENERATED TRAINING: ${id} -->\n        <!-- END GENERATED TRAINING: ${id} -->`;

// --- corpus completeness, established INDEPENDENTLY of every candidate input -
//
// The generator's own report line is the thing under test, so its expected
// numbers must not be read back out of any input the generator itself consumes.
//
// An earlier version of this file used the committed Home surface's marker set
// as the witness. That is NOT independent, and it was shown not to be: delete a
// record from data/training-opportunities.json AND its marker regions from
// index.html and pt/index.html, and the marker count, the owned count and the
// rendered+cleared identity all shrink together in agreement. The structured
// data validator, both drift checks and this suite all passed while a governed
// record had silently left the site.
//
// The witness is therefore a committed manifest that no candidate input can
// shrink: automation/training-opportunities/canonical-corpus.json. It is
// maintained by hand, so removing a governed record means editing it in the
// same commit.
const CANONICAL_CORPUS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'automation', 'training-opportunities', 'canonical-corpus.json'), 'utf8')
);
const EXPECTED_RECORD_IDS = CANONICAL_CORPUS.record_ids;

function ownedMarkerIds(dir, locale) {
  const html = fs.readFileSync(homePath(dir, locale), 'utf8');
  return [...html.matchAll(/<!-- BEGIN GENERATED TRAINING: ([^>]+?) -->/g)].map((m) => m[1].trim());
}

function canonicalIds(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'training-opportunities.json'), 'utf8'))
    .records.map((record) => record.id);
}

/** Delete a canonical record from the sandbox copy. */
function deleteRecord(dir, id) {
  const file = path.join(dir, 'data', 'training-opportunities.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.records = data.records.filter((record) => record.id !== id);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Delete a record's whole marker region from one surface in the sandbox copy. */
function deleteRegion(dir, locale, id) {
  const file = homePath(dir, locale);
  let html = fs.readFileSync(file, 'utf8');
  const begin = html.indexOf(`<!-- BEGIN GENERATED TRAINING: ${id} -->`);
  const endMarker = `<!-- END GENERATED TRAINING: ${id} -->`;
  const end = html.indexOf(endMarker);
  if (begin === -1 || end === -1) throw new Error(`${locale}: no region for ${id}`);
  const from = html.lastIndexOf('\n', begin) + 1;
  const to = html.indexOf('\n', end + endMarker.length) + 1;
  fs.writeFileSync(file, html.slice(0, from) + html.slice(to));
}

function dataValidator(dir) {
  const r = spawnSync('node', [path.join(dir, 'scripts', 'validate-training-opportunities-data.mjs')],
    { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// Parse "N region(s) owned (R rendered, C cleared)" out of a generator run.
function reportCounts(stdout) {
  const m = /(\d+) region\(s\) owned \((\d+) rendered, (\d+) cleared\)/.exec(stdout);
  if (!m) return null;
  return { owned: Number(m[1]), rendered: Number(m[2]), cleared: Number(m[3]) };
}

// --- populated-region transition tests ------------------------------------
// CURRENT -> removed state -> CURRENT, against a genuinely populated region.
for (const removedState of ['EXPIRED', 'WITHDRAWN', 'SUPERSEDED']) {
  for (const locale of ['en', 'pt']) {
    const dir = sandbox();
    const id = 'myrtle';
    const label = `${locale.toUpperCase()} CURRENT -> ${removedState} -> CURRENT`;

    const populated = region(dir, locale, id);
    check(`${label}: starts populated`, populated !== null && populated.includes('<article class="resource-card"'));

    // Baseline, taken from a read-only run before any state is changed. The
    // surface's own marker set is the independent witness for the corpus size.
    const markers = ownedMarkerIds(dir, locale);
    const baseline = reportCounts(run(dir, locale).stdout);
    check(`${label}: baseline run reports its region counts`, baseline !== null);
    check(`${label}: every record in the committed corpus manifest is owned`,
      baseline !== null && baseline.owned === EXPECTED_RECORD_IDS.length,
      `owned=${baseline?.owned} manifest=${EXPECTED_RECORD_IDS.length}`);
    check(`${label}: the surface carries a marker region for every manifest record`,
      EXPECTED_RECORD_IDS.every((id) => markers.includes(id)),
      `missing [${EXPECTED_RECORD_IDS.filter((id) => !markers.includes(id))}]`);
    check(`${label}: baseline rendered + cleared accounts for every owned region`,
      baseline !== null && baseline.rendered + baseline.cleared === baseline.owned,
      JSON.stringify(baseline));

    // Forward transition.
    setState(dir, id, removedState);
    const fwd = run(dir, locale, ['--write']);
    const cleared = region(dir, locale, id);
    check(`${label}: generator succeeds on the transition`, fwd.status === 0, fwd.stderr.trim());
    check(`${label}: stale card content is gone`, cleared !== null && !cleared.includes('<article'));
    check(`${label}: region is exactly the marker pair`, cleared === MARKER_ONLY(id), JSON.stringify(cleared));
    check(`${label}: marker pair preserved`,
      cleared !== null && cleared.includes(`BEGIN GENERATED TRAINING: ${id}`) && cleared.includes(`END GENERATED TRAINING: ${id}`));
    // Ownership is total: the transition must not shrink the owned count, and
    // must move exactly one region from rendered to cleared.
    const after = reportCounts(fwd.stdout);
    check(`${label}: transition run reports its region counts`, after !== null, fwd.stdout.trim());
    check(`${label}: every region is still owned after the transition`,
      after !== null && baseline !== null && after.owned === baseline.owned, fwd.stdout.trim());
    check(`${label}: the surface still carries a region for every manifest record`,
      EXPECTED_RECORD_IDS.every((id) => ownedMarkerIds(dir, locale).includes(id)), fwd.stdout.trim());
    check(`${label}: exactly one more region is cleared`,
      after !== null && baseline !== null
        && after.cleared === baseline.cleared + 1
        && after.rendered === baseline.rendered - 1, fwd.stdout.trim());

    // Deterministic + idempotent in the removed state.
    const again = run(dir, locale, ['--write']);
    check(`${label}: removed state is idempotent`, again.status === 0 && region(dir, locale, id) === cleared);
    const dryRun = run(dir, locale);
    check(`${label}: read-only check agrees while cleared`, dryRun.status === 0, dryRun.stderr.trim());

    // Reverse transition restores canonical content byte-for-byte.
    setState(dir, id, 'CURRENT');
    const back = run(dir, locale, ['--write']);
    check(`${label}: reverse transition succeeds`, back.status === 0, back.stderr.trim());
    check(`${label}: canonical content restored byte-for-byte`, region(dir, locale, id) === populated);

    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- stale content inside a removed-state region is drift, never "matches" --
{
  const dir = sandbox();
  const id = 'myrtle';
  setState(dir, id, 'WITHDRAWN');
  const dry = run(dir, 'en');
  check('stale content in a removed-state region is reported as drift',
    dry.status === 1 && /DRIFT/.test(dry.stderr) && dry.stderr.includes(id), dry.stderr.trim());
  check('drift run never claims "matches"', !/matches generated output/.test(dry.stdout), dry.stdout.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- canonical publication-state token -------------------------------------
{
  const dir = sandbox();
  setState(dir, 'myrtle', 'TEMPORARILY_UNAVAILABLE');
  const r = run(dir, 'en');
  check('TEMPORARILY_UNAVAILABLE fails closed',
    r.status === 1 && /TEMPORARILY_UNAVAILABLE has no approved status treatment/.test(r.stderr), r.stderr.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const dir = sandbox();
  setState(dir, 'myrtle', 'TEMPORARILY UNAVAILABLE');
  const r = run(dir, 'en');
  check('space-form token is rejected (not an alias)',
    r.status === 1 && /unsupported publication_state "TEMPORARILY UNAVAILABLE"/.test(r.stderr), r.stderr.trim());
  const v = spawnSync('node', [path.join(dir, 'scripts', 'validate-training-opportunities-data.mjs')], { cwd: dir, encoding: 'utf8' });
  check('validator rejects the space-form token and names the canonical one',
    v.status === 1 && /retired spelling; the canonical token is "TEMPORARILY_UNAVAILABLE"/.test(v.stderr), (v.stderr || '').trim());
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- unknown state and orphan marker ---------------------------------------
{
  const dir = sandbox();
  setState(dir, 'myrtle', 'ARCHIVED');
  const r = run(dir, 'en');
  check('unknown publication_state fails closed',
    r.status === 1 && /unsupported publication_state "ARCHIVED"/.test(r.stderr), r.stderr.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const dir = sandbox();
  const p = path.join(dir, 'data', 'training-opportunities.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data.records = data.records.filter((r) => r.id !== 'microsoft-learn');
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  const r = run(dir, 'en');
  check('a marker region with no canonical record fails closed',
    r.status === 1 && /marker region "microsoft-learn" has no canonical record/.test(r.stderr), r.stderr.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- corpus-deletion probes ------------------------------------------------
//
// The exact independent-review finding this manifest exists to close: a record
// deleted from the canonical data file AND from both Home surfaces in the same
// commit used to pass every check, because every expectation was derived from
// one of the things being deleted.
//
// All three shapes must fail. The first two already failed through the
// generator's own orphan and missing checks; the third is the one that did not,
// and it is now caught by the manifest comparison in the structured-data
// validator.
{
  const PROBE_ID = 'hp-life';

  // PROBE 1 — canonical record only. The surfaces still carry its regions, so
  // the generator sees an orphan marker; the manifest still declares it, so the
  // validator sees a missing record. Both must refuse.
  {
    const dir = sandbox();
    deleteRecord(dir, PROBE_ID);
    const gen = run(dir, 'en');
    check('PROBE 1 (canonical record only): generator fails on the orphaned marker region',
      gen.status === 1 && new RegExp(`marker region "${PROBE_ID}" has no canonical record`).test(gen.stderr), gen.stderr.trim());
    const val = dataValidator(dir);
    check('PROBE 1 (canonical record only): structured-data validator fails against the manifest',
      val.status === 1 && val.out.includes(PROBE_ID) && /canonical-corpus\.json/.test(val.out), val.out.trim());
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // PROBE 2 — marker regions only, on both surfaces. The record is still
  // canonical, so the generator has nowhere to render it; the manifest still
  // declares it, so the validator sees an unowned record.
  {
    const dir = sandbox();
    deleteRegion(dir, 'en', PROBE_ID);
    deleteRegion(dir, 'pt', PROBE_ID);
    for (const locale of ['en', 'pt']) {
      const gen = run(dir, locale);
      check(`PROBE 2 (marker regions only): ${locale.toUpperCase()} generator fails on the missing region`,
        gen.status === 1 && new RegExp(`no generated-training markers for record\\(s\\): ${PROBE_ID}`).test(gen.stderr), gen.stderr.trim());
    }
    const val = dataValidator(dir);
    check('PROBE 2 (marker regions only): structured-data validator fails on lost surface ownership',
      val.status === 1 && val.out.includes(PROBE_ID) && /no generated-training marker region/.test(val.out), val.out.trim());
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // PROBE 3 — the coordinated deletion. Canonical record AND both marker
  // regions, exactly as independent review reproduced it. Every
  // candidate-derived expectation shrinks in agreement, so the generator is
  // genuinely self-consistent here and reports success: only the manifest can
  // tell that a governed record is gone.
  {
    const dir = sandbox();
    deleteRecord(dir, PROBE_ID);
    deleteRegion(dir, 'en', PROBE_ID);
    deleteRegion(dir, 'pt', PROBE_ID);

    check('PROBE 3 (coordinated): the record really is gone from every candidate input',
      !canonicalIds(dir).includes(PROBE_ID)
      && !ownedMarkerIds(dir, 'en').includes(PROBE_ID)
      && !ownedMarkerIds(dir, 'pt').includes(PROBE_ID));

    // Documents the blind spot rather than asserting it away: the generator is
    // internally consistent with the shrunken inputs and cannot detect this.
    for (const locale of ['en', 'pt']) {
      const gen = run(dir, locale);
      check(`PROBE 3 (coordinated): ${locale.toUpperCase()} drift check is self-consistent and cannot detect this alone`,
        gen.status === 0, gen.stderr.trim());
    }

    const val = dataValidator(dir);
    check('PROBE 3 (coordinated): structured-data validator FAILS against the independent manifest',
      val.status === 1, val.out.trim());
    check('PROBE 3 (coordinated): the failure names the deleted record and the manifest',
      val.out.includes(PROBE_ID) && /canonical-corpus\.json/.test(val.out), val.out.trim());
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // PROBE 4 — the state transition must stay unaffected. CURRENT -> EXPIRED is
  // a lifecycle change, not a corpus change: the record keeps its manifest
  // entry and its marker ownership, its region is cleared, and everything
  // passes. The manifest must never have to be edited for this.
  {
    const dir = sandbox();
    setState(dir, PROBE_ID, 'EXPIRED');
    for (const locale of ['en', 'pt']) {
      const written = run(dir, locale, ['--write']);
      check(`PROBE 4 (CURRENT -> EXPIRED): ${locale.toUpperCase()} generation succeeds`, written.status === 0, written.stderr.trim());
      check(`PROBE 4 (CURRENT -> EXPIRED): ${locale.toUpperCase()} region is cleared to its marker pair`,
        region(dir, locale, PROBE_ID) === MARKER_ONLY(PROBE_ID));
      check(`PROBE 4 (CURRENT -> EXPIRED): ${locale.toUpperCase()} still owns every manifest record`,
        EXPECTED_RECORD_IDS.every((id) => ownedMarkerIds(dir, locale).includes(id)));
    }
    const val = dataValidator(dir);
    check('PROBE 4 (CURRENT -> EXPIRED): structured-data validator still PASSES — lifecycle is not a corpus change',
      val.status === 0, val.out.trim());
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // PROBE 5 — the untouched corpus passes, so none of the above is vacuous.
  {
    const dir = sandbox();
    const val = dataValidator(dir);
    check('PROBE 5 (normal corpus): structured-data validator passes', val.status === 0, val.out.trim());
    for (const locale of ['en', 'pt']) {
      check(`PROBE 5 (normal corpus): ${locale.toUpperCase()} drift check passes`, run(dir, locale).status === 0);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nGenerator ownership/state tests: ${passed}/${passed + failures.length} passed.`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
