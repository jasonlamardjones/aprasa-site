#!/usr/bin/env node
// Stage 2B-S: shadow-only EN/PT generator parity. All writes are confined
// to a disposable copy; no production generator or public HTML is modified.
// Stage 2B-L: the generator and collection selection now take their temporal
// state from the parity-gated universal resolver; the cases after the shadow
// boundaries cover that production integration and its fail-closed paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compareThingsToDoCurrentness } from './lib/things-to-do-currentness-adapter.mjs';
import {
  HOME_PREVIEW_IDS, THINGS_TO_DO_HUB_PUBLIC, collectionRecords, homePreviewRecords,
} from './lib/things-to-do-collection.mjs';
import { currentnessState as incumbentState } from './lib/things-to-do-currentness.mjs';
import {
  currentnessState as universalState, isExpired, isPubliclyCurrent,
} from './lib/things-to-do-universal-resolver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS = 'data/things-to-do-events.json';
const FRAGMENT = 'data/locales/pt-home-emergency-events-20261022.fragment.txt';
const TRAINING = 'data/training-opportunities.json';
const MANXI = 'manxi-liliane-reis-exhibition-2026';
const FICASE = 'ficase-scholarship-renewals-2026-2027';
const CARTINHA = 'cartinha-dholanda-mindelo-2026';
const GENERATED = /<!-- BEGIN GENERATED EVENT: ([a-z0-9-]+) -->[\s\S]*?<!-- END GENERATED EVENT: \1 -->/g;
let assertions = 0;
function eq(actual, expected, reason) {
  assert.deepEqual(actual, expected, reason);
  assertions++;
}
function read(dir, file) { return fs.readFileSync(path.join(dir, file), 'utf8'); }
function marker(edge, type, id) { return '<!-- ' + edge + ' ' + type + ': ' + id + ' -->'; }
function region(html, type, id) {
  const begin = marker('BEGIN', type, id);
  const end = marker('END', type, id);
  const start = html.indexOf(begin), stop = html.indexOf(end);
  assert(start >= 0 && stop > start && html.indexOf(begin, start + 1) < 0 &&
    html.indexOf(end, stop + 1) < 0, 'missing/duplicate ' + type + ' ' + id);
  assertions++;
  return html.slice(start, stop + end.length);
}
function stripGenerated(html, count) {
  let seen = 0;
  const stripped = html.replace(GENERATED, (_match, id) => {
    seen++;
    return marker('BEGIN', 'GENERATED EVENT', id) + marker('END', 'GENERATED EVENT', id);
  });
  eq(seen, count, 'all generated event markers must remain balanced');
  return stripped;
}
function runGenerator(dir, day, locale) {
  const args = ['scripts/generate-things-to-do.mjs', '--as-of=' + day,
    '--locale=' + locale, '--write'];
  if (locale === 'pt') args.splice(3, 0, '--home=pt/index.html');
  return spawnSync(process.execPath, args, {
    cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
}
function generate(dir, day) {
  for (const locale of ['en', 'pt']) {
    const run = runGenerator(dir, day, locale);
    assert.equal(run.status, 0, 'generator ' + locale + ' ' + day + ': ' +
      run.stdout + '\n' + run.stderr);
    assertions++;
  }
}
function throwsCode(fn, pattern, reason) {
  assert.throws(fn, pattern, reason);
  assertions++;
}
function snapshot(dir, records) {
  const files = ['index.html', 'pt/index.html'];
  for (const r of records) files.push(r.detail_page + 'index.html',
    'pt/' + r.detail_page + 'index.html');
  return files.map(file => [file, read(dir, file)]);
}
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-stage2bs-'));
try {
  // Exactly one copy, reused at all dates. Exclude working-tree internals.
  fs.cpSync(ROOT, sandbox, { recursive: true, filter: src =>
    !src.split(path.sep).some(part => ['.git', 'node_modules', '.netlify'].includes(part)) });
  const source = read(sandbox, EVENTS);
  const canonical = JSON.parse(source);
  const records = canonical.records;
  const original = Object.fromEntries(['index.html', 'pt/index.html', FRAGMENT, TRAINING]
    .map(file => [file, read(sandbox, file)]));
  const baseline = { en: original['index.html'], pt: original['pt/index.html'] };
  eq(THINGS_TO_DO_HUB_PUBLIC, false, 'unpublished hubs must stay dormant');

  // MANXI is a static emergency card that is retired by a separate patch, so
  // its presence is read from the checked-out Homes instead of hard-coded. The
  // two locales must agree; the generator must then preserve whichever state
  // the checkout is in.
  const manxiCard = '<article class="resource-card" data-emergency-event="' + MANXI + '"';
  const manxiLive = {};
  for (const locale of ['en', 'pt']) {
    const manxiRegion = region(baseline[locale], 'EMERGENCY EN-PT EVENT', MANXI);
    manxiLive[locale] = manxiRegion.includes(manxiCard);
    if (manxiLive[locale]) {
      eq(manxiRegion.includes('data-emergency-expire-at="2026-10-30T01:00:00Z"'), true,
        locale + ' present MANXI card carries its Cabo Verde midnight expiry');
    } else {
      eq(manxiRegion, marker('BEGIN', 'EMERGENCY EN-PT EVENT', MANXI) + '\n        ' +
        marker('END', 'EMERGENCY EN-PT EVENT', MANXI),
        locale + ' retired MANXI region is an empty marker pair');
      eq(baseline[locale].includes('data-emergency-event="' + MANXI + '"'), false,
        locale + ' retired MANXI leaves no card elsewhere on Home');
    }
  }
  eq(manxiLive.en, manxiLive.pt, 'MANXI EN/PT presence parity');

  let syntheticText = '';
  function verify(day, candidate) {
    generate(sandbox, day);
    const homes = { en: read(sandbox, 'index.html'), pt: read(sandbox, 'pt/index.html') };
    const selected = [];
    for (const record of candidate) {
      const parity = compareThingsToDoCurrentness(record, day);
      eq(['match', 'editorial-override'].includes(parity.comparison), true,
        'universal and incumbent parity for ' + record.id + ' ' + day);
      eq(universalState(record, day), parity.incumbentState,
        'production resolver state for ' + record.id + ' ' + day);
      const published = record.publication_state === 'published';
      const expectedCard = published && parity.temporalState !== 'expired' &&
        HOME_PREVIEW_IDS.includes(record.id);
      if (expectedCard) selected.push(record.id);
      for (const locale of ['en', 'pt']) {
        const card = region(homes[locale], 'GENERATED EVENT', record.id);
        eq(card.includes('<article class="resource-card" data-event-id="' + record.id + '"'),
          expectedCard, locale + ' Home membership ' + record.id + ' ' + day);
        const detail = read(sandbox, (locale === 'pt' ? 'pt/' : '') +
          record.detail_page + 'index.html');
        eq(detail.includes('<html lang="' + locale + '">'), true, locale + ' document');
        eq(detail.includes('data-event-id="' + record.id + '"'), true, 'historical detail kept');
        eq(detail.includes('<p class="card-status">'), parity.incumbentState === 'expired',
          locale + ' historic/current detail ' + record.id + ' ' + day);
        if (record.end_precision === 'month') {
          eq(parity.evaluation.activityExpiryInstant, null, 'month has no expiry instant');
          eq(card.includes('data-event-end='), false, 'month Home has no invented day');
          eq(detail.includes('"endDate"'), false, 'month schema has no invented day');
        }
      }
      if (record.id === CARTINHA && record.end_date === '2026-10-29') {
        eq(parity.evaluation.activityExpiryInstant, '2026-10-30T01:00:00.000Z',
          'inclusive Oct 29 ends at Cabo Verde midnight Oct 30');
      }
    }
    const ordered = HOME_PREVIEW_IDS.filter(id => selected.includes(id));
    for (const locale of ['en', 'pt']) {
      const home = homes[locale];
      eq(stripGenerated(home, candidate.length), stripGenerated(baseline[locale], candidate.length),
        locale + ' non-generated Home content must be byte-identical');
      for (const [type, id] of [
        ['EMERGENCY EN-PT EVENT', MANXI],
        ['EMERGENCY EN-PT EVENT', 'kutumbaia-edicao-03-2026'],
        ['GENERATED TRAINING', FICASE],
      ]) {
        eq(region(home, type, id), region(baseline[locale], type, id),
          locale + ' unchanged protected ' + id);
      }
      const locations = ordered.map(id => home.indexOf('data-event-id="' + id + '"'));
      eq(locations.every((x, i) => x >= 0 && (!i || x > locations[i - 1])),
        true, locale + ' curated Home ordering');
      // Date-independent: the generator neither adds nor removes MANXI, and a
      // present card keeps its expiry attribute (retirement is a patch, not a
      // generator side effect).
      const manxiRegion = region(home, 'EMERGENCY EN-PT EVENT', MANXI);
      const hasManxiCard = manxiRegion.includes('data-emergency-event="' + MANXI + '"');
      eq(hasManxiCard, manxiLive[locale],
        locale + ' MANXI state unchanged by generation on ' + day);
      eq(manxiRegion.includes('data-emergency-expire-at="2026-10-30T01:00:00Z"'), hasManxiCard,
        locale + ' MANXI expiry attribute matches card presence on ' + day);
      eq(!hasManxiCard && /<article\b/.test(manxiRegion), false,
        locale + ' retired MANXI region contains no article on ' + day);
      eq(home.split('data-emergency-event="' + MANXI + '"').length - 1, hasManxiCard ? 1 : 0,
        locale + ' whole-page MANXI card count on ' + day);
    }
    eq(read(sandbox, FRAGMENT), original[FRAGMENT], 'PT emergency fragment untouched');
    eq(read(sandbox, TRAINING), original[TRAINING], 'FICASE canonical source untouched');
    eq(read(sandbox, EVENTS), candidate === records ? source : syntheticText,
      'synthetic data restricted to sandbox fixture');
    return snapshot(sandbox, candidate);
  }
  // This is NOT a factual change to Cartinha's real November closing date.
  // Only an isolated clone of its existing record tests the October boundary.
  const fixture = records.map(r => r.id === CARTINHA ?
    { ...r, end_date: '2026-10-29' } : r);
  syntheticText = JSON.stringify({ ...canonical, records: fixture }, null, 2) + '\n';
  fs.writeFileSync(path.join(sandbox, EVENTS), syntheticText);
  verify('2026-10-29', fixture);
  verify('2026-10-30', fixture);
  fs.writeFileSync(path.join(sandbox, EVENTS), source);
  // Real canonical boundaries: month-review and Cartinha's Nov 15/16 expiry.
  // 2027-01-15 is well past November: month-only ends must still never expire.
  for (const day of ['2026-10-12', '2026-10-31', '2026-11-01',
    '2026-11-15', '2026-11-16', '2027-01-15']) {
    const before = verify(day, records);
    if (day === '2026-11-16') {
      const after = verify(day, records);
      eq(after, before, 'repeat EN/PT generation is byte-identical');
    }
  }
  eq(read(sandbox, EVENTS), source, 'canonical events restored unmodified');

  // --- Stage 2B-L: production resolver, in process -------------------------
  const byId = Object.fromEntries(records.map(r => [r.id, r]));
  const MONTH_IDS = ['sinergia-da-materia', '50-anos-de-memoria-criacao-e-resistencia'];
  for (const id of MONTH_IDS) {
    eq(byId[id].end_precision, 'month', id + ' is month precision');
    eq(universalState(byId[id], '2026-10-31'), 'current', id + ' current before November');
    eq(universalState(byId[id], '2026-11-01'), 'review-due', id + ' review-due on Nov 1');
    eq(universalState(byId[id], '2027-06-01'), 'review-due', id + ' never auto-expires');
    eq(isPubliclyCurrent(byId[id], '2027-06-01'), true, id + ' review-due stays public');
  }
  eq(byId[CARTINHA].end_date, '2026-11-15', 'Cartinha keeps its real closing day');
  eq(universalState(byId[CARTINHA], '2026-11-15'), 'current', 'Cartinha current on Nov 15');
  eq(universalState(byId[CARTINHA], '2026-11-16'), 'expired', 'Cartinha expired on Nov 16');

  // Editorial expiry is independent of the dates and always wins.
  const editorial = { ...byId[CARTINHA], publication_state: 'expired' };
  eq(compareThingsToDoCurrentness(editorial, '2026-10-12').temporalState, 'current',
    'editorial fixture is temporally current');
  eq(universalState(editorial, '2026-10-12'), 'expired', 'editorial expiry overrides dates');
  eq(collectionRecords([editorial], '2026-10-12').length, 0, 'editorial expiry leaves the collection');

  // Temporal eligibility never grants publication: draft/withdrawn stay off Home.
  for (const state of ['draft', 'withdrawn']) {
    const fixture = records.map(r => r.id === CARTINHA ? { ...r, publication_state: state } : r);
    const record = fixture.find(r => r.id === CARTINHA);
    eq(isPubliclyCurrent(record, '2026-10-12'), true, state + ' record is temporally current');
    eq(homePreviewRecords(fixture, '2026-10-12').some(r => r.id === CARTINHA), false,
      state + ' record cannot enter Home through temporal eligibility');
  }
  eq(homePreviewRecords(records, '2026-10-12').map(r => r.id),
    HOME_PREVIEW_IDS.filter(id => byId[id].publication_state === 'published' &&
      incumbentState(byId[id], '2026-10-12') !== 'expired'),
    'Home preview keeps the curated order');

  // Offset-bearing timestamps never acquire exact-time expiry.
  const offsetOnly = { id: 'synthetic-offset-only', publication_state: 'published',
    start_date: '2026-10-01', end_datetime: '2026-10-02T23:00:00-01:00' };
  eq(universalState(offsetOnly, '2026-11-01'), 'current', 'end_datetime alone never expires');
  eq(compareThingsToDoCurrentness(offsetOnly, '2026-11-01').evaluation.activityExpiryInstant, null,
    'end_datetime produces no expiry instant');

  // Malformed or unsupported input fails closed, naming the record and date.
  const invalid = /TTD_UNIVERSAL_RESOLVER_INVALID_INPUT: cartinha-dholanda-mindelo-2026 as of 2026-10-12: /;
  throwsCode(() => universalState(byId[CARTINHA], '2026-02-30'),
    /TTD_UNIVERSAL_RESOLVER_INVALID_INPUT: cartinha-dholanda-mindelo-2026 as of 2026-02-30: /,
    'impossible asOf day is rejected');
  throwsCode(() => isExpired({ ...byId[MONTH_IDS[0]], end_month: '2026-13' }, '2026-10-12'),
    /TTD_UNIVERSAL_RESOLVER_INVALID_INPUT: sinergia-da-materia as of 2026-10-12: TTD_ADAPTER_INVALID_END_MONTH/,
    'impossible end_month is rejected');
  throwsCode(() => universalState({ ...byId[CARTINHA], end_precision: 'week' }, '2026-10-12'),
    /TTD_ADAPTER_UNSUPPORTED_END_PRECISION/, 'unsupported precision is rejected');
  throwsCode(() => universalState({ ...byId[CARTINHA], end_date: '2026-11-31' }, '2026-10-12'),
    invalid, 'impossible end_date is rejected');
  eq(incumbentState({ ...byId[MONTH_IDS[0]], end_month: '2026-13' }, '2026-10-12'), 'current',
    'the incumbent alone would have published the malformed month as current');

  // --- Stage 2B-L: production generator, in the disposable copy -------------
  function fixtureRun(fixture, day) {
    syntheticText = JSON.stringify({ ...canonical, records: fixture }, null, 2) + '\n';
    fs.writeFileSync(path.join(sandbox, EVENTS), syntheticText);
    return verify(day, fixture);
  }
  function refuses(day, pattern, reason) {
    const before = snapshot(sandbox, records);
    for (const locale of ['en', 'pt']) {
      const run = runGenerator(sandbox, day, locale);
      eq(run.status !== 0, true, reason + ' (' + locale + ') exits non-zero');
      eq(pattern.test(run.stderr), true, reason + ' (' + locale + ') diagnostic: ' + run.stderr);
      eq(/^Wrote /m.test(run.stdout), false, reason + ' (' + locale + ') wrote nothing');
    }
    eq(snapshot(sandbox, records), before, reason + ': no generated file changed');
  }
  generate(sandbox, '2026-10-12');
  fixtureRun(records.map(r => r.id === CARTINHA ? { ...r, publication_state: 'expired' } : r),
    '2026-10-12');
  for (const state of ['draft', 'withdrawn']) {
    fixtureRun(records.map(r => r.id === CARTINHA || r.id === 'taverna-live-music'
      ? { ...r, publication_state: state } : r), '2026-10-12');
  }
  fs.writeFileSync(path.join(sandbox, EVENTS), source);
  generate(sandbox, '2026-10-12');

  refuses('2026-02-30', /TTD_UNIVERSAL_RESOLVER_INVALID_INPUT: [a-z0-9-]+ as of 2026-02-30: /,
    'impossible --as-of day');
  fs.writeFileSync(path.join(sandbox, EVENTS), JSON.stringify({ ...canonical,
    records: records.map(r => r.id === MONTH_IDS[0] ? { ...r, end_month: '2026-13' } : r) },
  null, 2) + '\n');
  refuses('2026-10-12',
    /TTD_UNIVERSAL_RESOLVER_INVALID_INPUT: sinergia-da-materia as of 2026-10-12: TTD_ADAPTER_INVALID_END_MONTH/,
    'malformed end_month');
  fs.writeFileSync(path.join(sandbox, EVENTS), source);

  // A universal/incumbent disagreement is deterministic failure, never a
  // fallback. The disagreement is induced only inside the disposable copy by
  // disabling the incumbent's day-precision expiry.
  const INCUMBENT = 'scripts/lib/things-to-do-currentness.mjs';
  const incumbentSource = read(sandbox, INCUMBENT);
  const dayExpiry = 'if (record?.end_date && record.end_date < asOf) return EXPIRED;';
  eq(incumbentSource.split(dayExpiry).length, 2, 'incumbent day-expiry rule located once');
  fs.writeFileSync(path.join(sandbox, INCUMBENT), incumbentSource.replace(dayExpiry, ''));
  const firstStale = records.find(r => r.publication_state !== 'expired' &&
    r.end_date && r.end_date < '2026-11-16');
  refuses('2026-11-16', new RegExp('TTD_UNIVERSAL_PARITY_MISMATCH: ' + firstStale.id +
    ' as of 2026-11-16: universal=expired incumbent=current'), 'induced parity mismatch');
  fs.writeFileSync(path.join(sandbox, INCUMBENT), incumbentSource);
  eq(read(sandbox, EVENTS), source, 'canonical events restored unmodified');
  console.log('Stage 2B-S/2B-L EN/PT generator parity passed (' +
    assertions + ' assertions; synthetic and real boundaries, production resolver).');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
