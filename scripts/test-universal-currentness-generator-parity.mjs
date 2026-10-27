#!/usr/bin/env node
// Stage 2B-S: shadow-only EN/PT generator parity. All writes are confined
// to a disposable copy; no production generator or public HTML is modified.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compareThingsToDoCurrentness } from './lib/things-to-do-currentness-adapter.mjs';
import { HOME_PREVIEW_IDS, THINGS_TO_DO_HUB_PUBLIC } from './lib/things-to-do-collection.mjs';

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
function generate(dir, day) {
  for (const locale of ['en', 'pt']) {
    const args = ['scripts/generate-things-to-do.mjs', '--as-of=' + day,
      '--locale=' + locale, '--write'];
    if (locale === 'pt') args.splice(3, 0, '--home=pt/index.html');
    const run = spawnSync(process.execPath, args, {
      cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(run.status, 0, 'generator ' + locale + ' ' + day + ': ' +
      run.stdout + '\n' + run.stderr);
    assertions++;
  }
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
  for (const day of ['2026-10-12', '2026-10-31', '2026-11-01',
    '2026-11-15', '2026-11-16']) {
    const before = verify(day, records);
    if (day === '2026-11-16') {
      const after = verify(day, records);
      eq(after, before, 'repeat EN/PT generation is byte-identical');
    }
  }
  eq(read(sandbox, EVENTS), source, 'canonical events restored unmodified');
  console.log('Stage 2B-S EN/PT generator shadow parity passed (' +
    assertions + ' assertions; synthetic and real boundaries).');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
