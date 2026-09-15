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
import { t } from './lib/locale.mjs';

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

// null deletes the field outright, to simulate a record with no linkage at
// all (the pre-fix state Start CV and the China scholarship record actually
// shipped in) rather than merely an empty string.
function setMediaManifestTitle(dir, id, title) {
  const p = path.join(dir, 'data', 'training-opportunities.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const record = data.records.find((r) => r.id === id);
  if (title === null) delete record.media_manifest_title;
  else record.media_manifest_title = title;
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

const CARD_MEDIA_COUNT = (html) => (html.match(/<div class="card-media(?:"|\s)/g) || []).length;
const DIALOG_MEDIA_COUNT = (html) => (html.match(/<div class="dialog-media(?:"|\s)/g) || []).length;

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
    // ibm-skillsbuild: ordinary_publication_eligibility ELIGIBLE, so it
    // renders normally and is unaffected by the eligibility/Spotlight
    // tranche — myrtle no longer starts populated (NOT_ELIGIBLE, no
    // Spotlight role), so it cannot exercise this populated-region
    // transition probe any more.
    const id = 'ibm-skillsbuild';
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
  // Needs a record that starts populated (ordinary_publication_eligibility
  // ELIGIBLE) so the state change actually leaves stale content behind;
  // myrtle no longer starts populated under the eligibility/Spotlight tranche.
  const id = 'ibm-skillsbuild';
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

// --- PROBE 6 — static editorial-fallback media for governed fallback records
//
// The defect these exist to prevent: an approved training record with no
// provider media (media_type "editorial-fallback" in the manifest) rendered
// with NO static .card-media/.dialog-media at all — the fallback existed
// only as a client-side DOM injection by prasa-launch.js, so a no-JS, slow-JS
// or blocked-JS page (and, live, whatever the founder actually saw) showed
// nothing where the approved A PRASA fallback should be. These parse only
// the generated static HTML — no script engine involved — so passing here is
// itself proof of requirement K (no-JS/progressive enhancement).
{
  const FALLBACK_COPY = {
    en: { label: 'Trainings, Tools &amp; Opportunities', note: 'A PRASA section thumbnail — not provider-specific imagery.' },
    pt: { label: 'Formações, Ferramentas e Oportunidades', note: 'Miniatura da secção A PRASA — imagem não específica do prestador.' },
  };
  // start-cv moved from the generic Plan C section fallback to its own Plan B
  // A PRASA category asset (see PLAN B / PLAN C tests below), so it is no
  // longer a Plan C fallback probe target. unicv-china-ambassador-scholarship
  // is the required PLAN C CONTROL: it must keep using the generic fallback
  // unchanged, proving Plan C was preserved rather than globally removed.
  const FALLBACK_IDS = ['unicv-china-ambassador-scholarship-2026'];

  for (const id of FALLBACK_IDS) {
    for (const locale of ['en', 'pt']) {
      const dir = sandbox();
      const written = run(dir, locale, ['--write']);
      check(`PROBE 6 (${id}): ${locale.toUpperCase()} generation succeeds`, written.status === 0, written.stderr.trim());
      const html = region(dir, locale, id);
      check(`PROBE 6 (${id}): ${locale.toUpperCase()} region exists`, html !== null);

      check(`PROBE 6 (${id}): ${locale.toUpperCase()} exactly one direct .card-media`, html !== null && CARD_MEDIA_COUNT(html) === 1);
      check(`PROBE 6 (${id}): ${locale.toUpperCase()} exactly one direct .dialog-media`, html !== null && DIALOG_MEDIA_COUNT(html) === 1);
      check(`PROBE 6 (${id}): ${locale.toUpperCase()} card fallback carries media-fallback + aria-hidden`,
        html !== null && /<div class="card-media media-fallback" aria-hidden="true">/.test(html));
      check(`PROBE 6 (${id}): ${locale.toUpperCase()} dialog fallback carries media-fallback + aria-hidden`,
        html !== null && /<div class="dialog-media media-fallback" aria-hidden="true">/.test(html));
      check(`PROBE 6 (${id}): ${locale.toUpperCase()} fallback symbol has alt=""`,
        html !== null && (html.match(/A_PRASA_Symbol_v2_Primary_Green\.svg"[^>]*alt=""/g) || []).length === 2);
      check(`PROBE 6 (${id}): ${locale.toUpperCase()} governed label present exactly twice (card + dialog)`,
        html !== null && (html.match(new RegExp(`<span class="media-fallback-label">${FALLBACK_COPY[locale].label}</span>`, 'g')) || []).length === 2,
        html ?? '');
      check(`PROBE 6 (${id}): ${locale.toUpperCase()} governed note present exactly twice (card + dialog)`,
        html !== null && (html.match(new RegExp(`<span class="media-fallback-note">${FALLBACK_COPY[locale].note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`, 'g')) || []).length === 2,
        html ?? '');

      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Start CV must remain the sole Learning Spotlight, unaffected by the new
  // media branch.
  {
    const dir = sandbox();
    run(dir, 'en', ['--write']);
    const html = fs.readFileSync(homePath(dir, 'en'), 'utf8');
    const spotlightCards = (html.match(/data-learning-spotlight="[^"]+"/g) || []);
    check('PROBE 6: exactly one Learning Spotlight record',
      spotlightCards.length === 1 && spotlightCards[0] === 'data-learning-spotlight="start-cv"', JSON.stringify(spotlightCards));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Myrtle is provider-owned (its real photo is injected at runtime by
  // prasa-launch.js's providerMedia map, keyed by title) and must NOT gain
  // any static fallback merely because it also has no record.media.
  {
    const dir = sandbox();
    run(dir, 'en', ['--write']);
    const html = region(dir, 'en', 'myrtle');
    check('PROBE 6 (myrtle): still has no static .card-media/.dialog-media of any kind',
      html !== null && CARD_MEDIA_COUNT(html) === 0 && DIALOG_MEDIA_COUNT(html) === 0, html ?? '');
    check('PROBE 6 (myrtle): no media-fallback markup added', html !== null && !html.includes('media-fallback'), html ?? '');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // A record with real record.media (academia-crescer) keeps rendering its
  // own poster media, untouched by the new fallback branch.
  {
    const dir = sandbox();
    run(dir, 'en', ['--write']);
    const html = region(dir, 'en', 'academia-crescer');
    check('PROBE 6 (academia-crescer): exactly one direct .card-media', html !== null && CARD_MEDIA_COUNT(html) === 1);
    check('PROBE 6 (academia-crescer): exactly one direct .dialog-media', html !== null && DIALOG_MEDIA_COUNT(html) === 1);
    check('PROBE 6 (academia-crescer): renders its own poster asset, not the fallback symbol',
      html !== null && html.includes('academia-crescer-recruitment-2026-2027.webp') && !html.includes('media-fallback'), html ?? '');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // GUARD — record.media absent is NEVER sufficient by itself. Point the
  // China scholarship record's linkage at a real manifest entry whose
  // media_type is NOT "editorial-fallback" (a provider-owned record) and
  // confirm no fallback is emitted, proving the generator checks media_type
  // and not just the presence of some media_manifest_title. (Retargeted from
  // start-cv, which now carries its own record.media under Plan B and so no
  // longer exercises this manifest-driven branch at all.)
  {
    const dir = sandbox();
    setMediaManifestTitle(dir, 'unicv-china-ambassador-scholarship-2026', 'Myrtle Atividades Educativas');
    const written = run(dir, 'en', ['--write']);
    check('PROBE 6 (guard: wrong media_type): generation still succeeds', written.status === 0, written.stderr.trim());
    const html = region(dir, 'en', 'unicv-china-ambassador-scholarship-2026');
    check('PROBE 6 (guard: wrong media_type): no fallback emitted for a provider-owned linkage',
      html !== null && !html.includes('media-fallback'), html ?? '');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // GUARD — the pre-fix shape (media_manifest_title entirely absent) must
  // also emit no fallback, proving the branch requires an explicit governed
  // linkage rather than defaulting to fallback whenever record.media is null.
  {
    const dir = sandbox();
    setMediaManifestTitle(dir, 'unicv-china-ambassador-scholarship-2026', null);
    const written = run(dir, 'en', ['--write']);
    check('PROBE 6 (guard: no linkage at all): generation still succeeds', written.status === 0, written.stderr.trim());
    const html = region(dir, 'en', 'unicv-china-ambassador-scholarship-2026');
    check('PROBE 6 (guard: no linkage at all): no fallback emitted with media_manifest_title absent',
      html !== null && !html.includes('media-fallback'), html ?? '');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- PROBE 7 — ordinary-publication eligibility + Spotlight visibility ----
//
// Project 03's approved semantic distinction: lifecycle/currentness
// (publication_state) is factual; ordinary-publication eligibility is
// editorial; the two are independent. A record must never be marked
// EXPIRED/WITHDRAWN/SUPERSEDED merely because it is NOT_ELIGIBLE for
// ordinary publication, and a NOT_ELIGIBLE record may still render if it
// carries an approved structured Spotlight role.
{
  const CANONICAL_DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'training-opportunities.json'), 'utf8'));
  const byId = (id) => CANONICAL_DATA.records.find((r) => r.id === id);

  // CASE 1 — MYRTLE: CURRENT but ordinary-ineligible, in both EN and PT.
  {
    const dir = sandbox();
    for (const locale of ['en', 'pt']) {
      const written = run(dir, locale, ['--write']);
      check(`CASE 1 (myrtle, ${locale.toUpperCase()}): generation succeeds`, written.status === 0, written.stderr.trim());
      const html = region(dir, locale, 'myrtle');
      check(`CASE 1 (myrtle, ${locale.toUpperCase()}): region is exactly the marker pair (no public article/card)`,
        html === MARKER_ONLY('myrtle'), html ?? '');
    }
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'training-opportunities.json'), 'utf8'));
    const myrtle = data.records.find((r) => r.id === 'myrtle');
    check('CASE 1 (myrtle): canonical publication_state remains CURRENT', myrtle.publication_state === 'CURRENT');
    check('CASE 1 (myrtle): eligibility is NOT_ELIGIBLE', myrtle.ordinary_publication_eligibility === 'NOT_ELIGIBLE');
    check('CASE 1 (myrtle): reason is PAID_LOCAL_SERVICE_TRAINING', myrtle.ordinary_publication_reason === 'PAID_LOCAL_SERVICE_TRAINING');
    check('CASE 1 (myrtle): marker ownership is preserved on EN',
      ownedMarkerIds(dir, 'en').includes('myrtle'));
    check('CASE 1 (myrtle): marker ownership is preserved on PT',
      ownedMarkerIds(dir, 'pt').includes('myrtle'));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // CASE 2 — START CV: CURRENT + ordinary-ineligible + Spotlight, in both EN
  // and PT. Renders exactly once, carrying the governed Spotlight role, with
  // no duplicate ordinary rendering. The duplicate check uses the record's
  // own governed/localized title (resolved from the real locale overlay, not
  // invented copy) rather than only counting the Spotlight attribute, so it
  // proves there is exactly one rendered Start CV CARD on the whole Home
  // surface, not merely exactly one Spotlight-marked attribute.
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  {
    const dir = sandbox();
    for (const locale of ['en', 'pt']) {
      const written = run(dir, locale, ['--write']);
      check(`CASE 2 (start-cv, ${locale.toUpperCase()}): generation succeeds`, written.status === 0, written.stderr.trim());
      const html = region(dir, locale, 'start-cv');
      check(`CASE 2 (start-cv, ${locale.toUpperCase()}): exactly one Start CV card is rendered`,
        html !== null && (html.match(/<article class="resource-card"/g) || []).length === 1, html ?? '');
      check(`CASE 2 (start-cv, ${locale.toUpperCase()}): rendered card carries the governed Spotlight role`,
        html !== null && html.includes('data-learning-spotlight="start-cv"'), html ?? '');

      const startCvTitle = t('training.record.start-cv.title', locale);
      const fullHome = fs.readFileSync(homePath(dir, locale), 'utf8');
      const cardTitleCount = (fullHome.match(new RegExp(`<h3>${escapeRegExp(startCvTitle)}</h3>`, 'g')) || []).length;
      const dialogTitleCount = (fullHome.match(new RegExp(`<h2>${escapeRegExp(startCvTitle)}</h2>`, 'g')) || []).length;
      check(`CASE 2 (start-cv, ${locale.toUpperCase()}): exactly one rendered Start CV card by governed title (not just the Spotlight attribute)`,
        cardTitleCount === 1, `card title occurrences=${cardTitleCount}`);
      check(`CASE 2 (start-cv, ${locale.toUpperCase()}): exactly one rendered Start CV detail dialog by governed title`,
        dialogTitleCount === 1, `dialog title occurrences=${dialogTitleCount}`);
      check(`CASE 2 (start-cv, ${locale.toUpperCase()}): no duplicate ordinary Start CV rendering (Spotlight attribute)`,
        (fullHome.match(/data-learning-spotlight="start-cv"/g) || []).length === 1);
    }
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'training-opportunities.json'), 'utf8'));
    const startCv = data.records.find((r) => r.id === 'start-cv');
    check('CASE 2 (start-cv): publication_state remains CURRENT', startCv.publication_state === 'CURRENT');
    check('CASE 2 (start-cv): eligibility is NOT_ELIGIBLE', startCv.ordinary_publication_eligibility === 'NOT_ELIGIBLE');
    check('CASE 2 (start-cv): reason is PAID_LOCAL_SERVICE_TRAINING', startCv.ordinary_publication_reason === 'PAID_LOCAL_SERVICE_TRAINING');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // CASE 3 — SPOTLIGHT REMOVAL NEGATIVE FIXTURE (sandbox only). Remove Start
  // CV's Spotlight role, leave publication_state CURRENT and eligibility
  // NOT_ELIGIBLE, regenerate: Start CV must disappear from public rendering
  // without any lifecycle mutation. This never touches the real repository —
  // the sandbox copy is discarded afterward.
  {
    const dir = sandbox();
    const p = path.join(dir, 'data', 'training-opportunities.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const startCv = data.records.find((r) => r.id === 'start-cv');
    delete startCv.card.attributes; // removes the sole "data-learning-spotlight" key
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');

    const written = run(dir, 'en', ['--write']);
    check('CASE 3 (spotlight removed): generation succeeds', written.status === 0, written.stderr.trim());
    const html = region(dir, 'en', 'start-cv');
    check('CASE 3 (spotlight removed): Start CV disappears from public rendering',
      html === MARKER_ONLY('start-cv'), html ?? '');

    const afterData = JSON.parse(fs.readFileSync(p, 'utf8'));
    const afterStartCv = afterData.records.find((r) => r.id === 'start-cv');
    check('CASE 3 (spotlight removed): publication_state is unchanged (still CURRENT)',
      afterStartCv.publication_state === 'CURRENT');
    check('CASE 3 (spotlight removed): eligibility is unchanged (still NOT_ELIGIBLE)',
      afterStartCv.ordinary_publication_eligibility === 'NOT_ELIGIBLE');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // CASE 4 — FREE ELIGIBLE CONTROL. An incumbent ELIGIBLE record (HP LIFE)
  // remains publicly rendered, proving this patch did not suppress ordinary
  // approved resources.
  {
    const dir = sandbox();
    for (const locale of ['en', 'pt']) {
      const written = run(dir, locale, ['--write']);
      const html = region(dir, locale, 'hp-life');
      check(`CASE 4 (hp-life control, ${locale.toUpperCase()}): still renders as an ordinary record`,
        written.status === 0 && html !== null && html.includes('<article class="resource-card"'), html ?? '');
    }
    check('CASE 4 (hp-life control): canonical eligibility is ELIGIBLE', byId('hp-life').ordinary_publication_eligibility === 'ELIGIBLE');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // CASE 5 — NO FALSE LIFECYCLE MUTATION. Static assertion against the
  // committed canonical data: Start CV and Myrtle are CURRENT, never
  // EXPIRED/WITHDRAWN/SUPERSEDED, despite being ordinary-publication
  // NOT_ELIGIBLE.
  {
    check('CASE 5: start-cv is canonically CURRENT', byId('start-cv').publication_state === 'CURRENT');
    check('CASE 5: myrtle is canonically CURRENT', byId('myrtle').publication_state === 'CURRENT');
  }

  // CASE 6 — IDEMPOTENCE. Generate EN and PT, then both (a) rerun as a
  // read-only drift check and (b) rerun a second --write, capturing the Home
  // bytes independently BEFORE and AFTER that second write. This is a real
  // comparison of two separately captured snapshots — not the same read
  // compared to itself — so it is capable of failing if the second
  // generation run changes output (e.g. a hidden source of non-determinism).
  {
    const dir = sandbox();
    for (const locale of ['en', 'pt']) {
      const first = run(dir, locale, ['--write']);
      check(`CASE 6 (idempotence, ${locale.toUpperCase()}): first --write run succeeds`, first.status === 0, first.stderr.trim());
      const beforeBytes = fs.readFileSync(homePath(dir, locale), 'utf8');

      const dryRun = run(dir, locale);
      check(`CASE 6 (idempotence, ${locale.toUpperCase()}): rerun reports no drift`, dryRun.status === 0, dryRun.stderr.trim());

      const second = run(dir, locale, ['--write']);
      check(`CASE 6 (idempotence, ${locale.toUpperCase()}): second --write run succeeds`, second.status === 0, second.stderr.trim());
      const afterBytes = fs.readFileSync(homePath(dir, locale), 'utf8');

      check(`CASE 6 (idempotence, ${locale.toUpperCase()}): Home bytes captured before and after the second run are byte-identical`,
        beforeBytes === afterBytes);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // CASE 7 — PLAN B MEDIA. Start CV card and detail use the approved A PRASA
  // category asset; the generic Plan-C fallback is no longer rendered; no
  // provider-specific authenticity claim appears in alt/provenance.
  {
    const dir = sandbox();
    for (const locale of ['en', 'pt']) {
      run(dir, locale, ['--write']);
      const html = region(dir, locale, 'start-cv');
      check(`CASE 7 (Plan B media, ${locale.toUpperCase()}): renders the approved A PRASA category asset`,
        html !== null && html.includes('assets/environment/praca-trainings-800.webp'), html ?? '');
      check(`CASE 7 (Plan B media, ${locale.toUpperCase()}): does not render the generic Plan-C fallback`,
        html !== null && !html.includes('media-fallback'), html ?? '');
      check(`CASE 7 (Plan B media, ${locale.toUpperCase()}): alt text makes no provider-authenticity claim about Start CV`,
        html !== null && !/alt="[^"]*(?:Start CV|student|classroom|premises|class)[^"]*"/i.test(html), html ?? '');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // CASE 8 — PLAN C CONTROL. At least one legitimate record still relies on
  // the generic Plan C fallback, proving Plan C was preserved rather than
  // globally removed.
  {
    const dir = sandbox();
    run(dir, 'en', ['--write']);
    const html = region(dir, 'en', 'unicv-china-ambassador-scholarship-2026');
    check('CASE 8 (Plan C control): unicv-china-ambassador-scholarship-2026 still renders the generic fallback',
      html !== null && html.includes('media-fallback'), html ?? '');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'internal', 'provider-media-manifest.json'), 'utf8'));
    const manifestEntry = manifest.records.find((r) => r.title === 'China Ambassador Scholarship for Uni-CV Students');
    check('CASE 8 (Plan C control): manifest entry is still media_type editorial-fallback',
      manifestEntry?.media_type === 'editorial-fallback');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // CASE 9 — EN/PT PARITY. Start CV Spotlight present in both; Myrtle absent
  // in both; same eligibility logic applies to both locales.
  {
    const dir = sandbox();
    for (const locale of ['en', 'pt']) run(dir, locale, ['--write']);
    check('CASE 9 (parity): Start CV Spotlight present in EN',
      (region(dir, 'en', 'start-cv') || '').includes('data-learning-spotlight="start-cv"'));
    check('CASE 9 (parity): Start CV Spotlight present in PT',
      (region(dir, 'pt', 'start-cv') || '').includes('data-learning-spotlight="start-cv"'));
    check('CASE 9 (parity): Myrtle absent (marker-only) in EN', region(dir, 'en', 'myrtle') === MARKER_ONLY('myrtle'));
    check('CASE 9 (parity): Myrtle absent (marker-only) in PT', region(dir, 'pt', 'myrtle') === MARKER_ONLY('myrtle'));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // CASE 10 — NEGATIVE: an unapproved "*-spotlight"-shaped attribute must
  // NOT authorize ordinary rendering of a NOT_ELIGIBLE record. The Spotlight
  // exception is bounded to APPROVED_SPOTLIGHT_ATTRS ("data-learning-
  // spotlight" only), never to any key merely matching a "-spotlight" naming
  // pattern. This never touches the real repository — the sandbox copy is
  // discarded afterward — and it never names myrtle's id in generator logic;
  // myrtle is used here only as an already-NOT_ELIGIBLE fixture record.
  {
    const dir = sandbox();
    const p = path.join(dir, 'data', 'training-opportunities.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const myrtle = data.records.find((r) => r.id === 'myrtle');
    myrtle.card.attributes = { 'data-fake-spotlight': 'myrtle' };
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');

    const written = run(dir, 'en', ['--write']);
    check('CASE 10 (fake spotlight, negative): generation succeeds', written.status === 0, written.stderr.trim());
    const html = region(dir, 'en', 'myrtle');
    check('CASE 10 (fake spotlight, negative): an unapproved data-fake-spotlight attribute does NOT authorize rendering',
      html === MARKER_ONLY('myrtle'), html ?? '');
    check('CASE 10 (fake spotlight, negative): the unapproved attribute itself is never emitted',
      !fs.readFileSync(homePath(dir, 'en'), 'utf8').includes('data-fake-spotlight'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nGenerator ownership/state tests: ${passed}/${passed + failures.length} passed.`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
