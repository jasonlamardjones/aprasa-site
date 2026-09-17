#!/usr/bin/env node
// Regression coverage for the EVERGREEN RECURRING-VENUE discovery cards
// (Project 03 ruling, 16 September 2026): Taverna and Nautilus.
//
// scripts/test-things-to-do-event-schema.mjs proves the validator enforces the
// recurring-venue SHAPE. This file proves the shipped RESULT: what the two
// records actually say, where they actually point, what media they actually
// use, that both locales resolve from governed copy with no English fallback,
// that the committed surfaces are exactly what the generator produces, and --
// most importantly -- that none of the claims this card type exists to avoid
// made it onto a public page.
//
// It also holds the standing negative assertions for the three venues that
// remain on HOLD: CineMindelo must not be published, and neither Jazzy Bird
// nor Le Metalo may appear on any Things-to-Do surface.
//
// Usage: node scripts/test-ttd-recurring-venue-cards.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { t } from './lib/locale.mjs';
import { RECURRING_VENUE, OCCURRENCE_DATE_FIELDS } from './lib/things-to-do-kinds.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS — ${name}`); }
  else { failures.push(`${name}${detail ? `: ${detail}` : ''}`); console.log(`FAIL — ${name}${detail ? `: ${detail}` : ''}`); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const events = JSON.parse(read(path.join('data', 'things-to-do-events.json')));
const manifest = JSON.parse(read(path.join('internal', 'provider-media-manifest.json')));
const asOf = JSON.parse(read(path.join('data', 'things-to-do-currentness.json'))).as_of;

const SHARED_ASSET = 'assets/card-media/things-to-do/live-performance-category-fallback.webp';
const SOURCE_MASTER = 'assets/card-media/things-to-do/source/A_PRASA_TTD_Fallback_Live_Performance_4x3_v1.png';

const EXPECTED = {
  'taverna-live-music': {
    provider: 'Taverna',
    url: 'https://cvcultural.cv/eventos/agenda-semanal-musica-ao-vivo-na-taverna-11',
    sourceType: 'third-party-cultural-schedule-listing',
    en: {
      title: 'Live Music at Taverna / Rua Pedonal',
      where: 'Taverna · Rua Pedonal, Mindelo',
      body: 'Taverna hosts recurring live-music programming on Rua Pedonal in Mindelo. Check the current schedule source for the latest details.',
      action: 'View current schedule',
      checked: 'Checked 16 September 2026 against the approved current schedule source.',
    },
    pt: {
      title: 'Música ao vivo na Taverna / Rua Pedonal',
      where: 'Taverna · Rua Pedonal, Mindelo',
      body: 'A Taverna apresenta regularmente música ao vivo na Rua Pedonal, em Mindelo. Consulte a fonte da programação atual para ver as informações mais recentes.',
      action: 'Ver programação atual',
      checked: 'Revisto em 16 de setembro de 2026 com base na fonte aprovada da programação atual.',
    },
  },
  'nautilus-live-music': {
    provider: 'Nautilus',
    url: 'https://cvcultural.cv/eventos/agenda-musica-ao-vivo-no-nautilus',
    sourceType: 'third-party-cultural-schedule-listing',
    en: {
      title: 'Live Music at Nautilus',
      where: 'Nautilus · Avenida Marginal, beside Centro Cultural do Mindelo',
      body: 'Nautilus hosts recurring live-music programming on Avenida Marginal in Mindelo. Check the current schedule source for the latest details.',
      action: 'View current schedule',
      checked: 'Checked 16 September 2026 against the approved current schedule source.',
    },
    pt: {
      title: 'Música ao vivo no Nautilus',
      where: 'Nautilus · Avenida Marginal, junto ao Centro Cultural do Mindelo',
      body: 'O Nautilus apresenta regularmente música ao vivo na Avenida Marginal, em Mindelo. Consulte a fonte da programação atual para ver as informações mais recentes.',
      action: 'Ver programação atual',
      checked: 'Revisto em 16 de setembro de 2026 com base na fonte aprovada da programação atual.',
    },
  },
};

const ids = Object.keys(EXPECTED);
const byId = new Map(events.records.map((r) => [r.id, r]));

// --- 1. canonical records ---------------------------------------------------
for (const id of ids) {
  const rec = byId.get(id);
  check(`${id}: canonical record exists`, Boolean(rec));
  if (!rec) continue;
  const spec = EXPECTED[id];
  check(`${id}: kind is ${RECURRING_VENUE}`, rec.kind === RECURRING_VENUE, rec.kind);
  check(`${id}: governed provider`, rec.provider === spec.provider, rec.provider);
  // The governed checked date, byte-exact. Nothing may derive it from a build
  // clock, a commit time, a file mtime or the source page.
  check(`${id}: governed checked_at is 2026-09-16`, rec.checked_at === '2026-09-16', rec.checked_at);
  check(`${id}: outbound source_url is the approved source`, rec.source_url === spec.url, rec.source_url);
  // Project 03 classified these sources on 17 September 2026. cvcultural.cv is
  // a THIRD-PARTY cultural agenda, not the venue's own channel, and the
  // classification is what tells a later reader how much weight the linked
  // schedule carries. It is internal metadata and renders nowhere, which is
  // exactly why it needs pinning here: no public surface would ever reveal a
  // regression in it.
  check(`${id}: governed source_type classification`, rec.source_type === spec.sourceType, rec.source_type);
  check(`${id}: card action points at the approved source`, rec.card_action?.url === spec.url, rec.card_action?.url);
  check(`${id}: makes no admission claim`, rec.free_admission === null, String(rec.free_admission));
  check(`${id}: carries no occurrence field`,
    OCCURRENCE_DATE_FIELDS.every((f) => !(f in rec)),
    OCCURRENCE_DATE_FIELDS.filter((f) => f in rec).join(', '));
}

// --- 2. shared category media ----------------------------------------------
check('the approved Live Performance master is committed as the source asset', exists(SOURCE_MASTER));
check('the derived web asset is committed', exists(SHARED_ASSET));
for (const id of ids) {
  const rec = byId.get(id);
  check(`${id}: uses the shared Live Performance category asset`, rec?.media?.asset === SHARED_ASSET, rec?.media?.asset);
  check(`${id}: declares the master's 4:3 1200x900 geometry`,
    rec?.media?.width === 1200 && rec?.media?.height === 900, `${rec?.media?.width}x${rec?.media?.height}`);
  // Generic category art carries no alt-text claim about the specific record:
  // it depicts neither this venue nor any performance at it.
  check(`${id}: shared category art is decorative (empty alt)`, rec?.media?.alt === '', JSON.stringify(rec?.media?.alt));
}
const venueManifest = ids.map((id) => manifest.records.find((m) => m.title === byId.get(id)?.media_manifest_title));
check('both records resolve to exactly one media-manifest entry each', venueManifest.every(Boolean));
for (const entry of venueManifest.filter(Boolean)) {
  check(`manifest "${entry.title}": declared as A PRASA category media, not provider-authentic`,
    entry.media_type === 'aprasa-category' && entry.media_state === 'fallback-final',
    `${entry.media_type}/${entry.media_state}`);
  check(`manifest "${entry.title}": points at the shared asset`, entry.media_asset === SHARED_ASSET, entry.media_asset);
}
check('both manifest entries share one asset (it is a category fallback, not venue media)',
  new Set(venueManifest.filter(Boolean).map((m) => m.media_asset)).size === 1);

// --- 3. EN/PT resolve from governed copy, with no English fallback ----------
const GOVERNED_SUFFIXES = [
  'title', 'summary', 'display.status', 'display.meta', 'display.checked',
  'card_action.label', 'detail.body', 'detail.checked', 'detail.action_label',
  'detail.fact.where.label', 'detail.fact.where.value_display',
  'seo.description', 'seo.title',
];
for (const id of ids) {
  for (const suffix of GOVERNED_SUFFIXES) {
    const key = `event.${id}.${suffix}`;
    let en = null;
    let pt = null;
    let error = '';
    try { en = t(key, 'en'); pt = t(key, 'pt'); } catch (e) { error = e.message; }
    check(`${key}: resolves in EN and PT`, Boolean(en) && Boolean(pt), error);
  }
  // A PT page must never silently show the English string. Where the approved
  // PT copy legitimately equals the EN copy it is a proper name plus an
  // address, so the two are compared only on the prose keys.
  for (const suffix of ['title', 'summary', 'detail.body', 'card_action.label', 'seo.title', 'seo.description']) {
    const key = `event.${id}.${suffix}`;
    check(`${key}: PT differs from EN (no silent English fallback)`, t(key, 'en') !== t(key, 'pt'));
  }
}

// --- 4. rendered surfaces ---------------------------------------------------
for (const id of ids) {
  const spec = EXPECTED[id];
  for (const [locale, prefix] of [['en', ''], ['pt', 'pt/']]) {
    const rel = `${prefix}things-to-do/${id}/index.html`;
    check(`${rel}: exists`, exists(rel));
    if (!exists(rel)) continue;
    const html = read(rel);
    const want = spec[locale];
    check(`${rel}: renders the approved ${locale.toUpperCase()} title`, html.includes(`<h1>${want.title}</h1>`));
    check(`${rel}: renders the approved venue summary`, html.includes(want.where));
    check(`${rel}: renders the approved evergreen description`, html.includes(want.body));
    check(`${rel}: renders the approved outbound action label`, html.includes(want.action));
    check(`${rel}: renders the approved checked line`, html.includes(want.checked));
    check(`${rel}: links the exact approved source`, html.includes(`href="${spec.url}"`));
    check(`${rel}: uses the shared category asset`, html.includes('live-performance-category-fallback.webp'));
    // Evergreen cards state no occurrence, so no Event node may be serialized.
    check(`${rel}: serializes no Event structured data`,
      html.includes('"@type": "WebPage"') && !/"@type":\s*"\w*Event"/.test(html));
    check(`${rel}: publishes no startDate/endDate/eventStatus`,
      !/"(startDate|endDate|eventStatus)"/.test(html));
  }
}

// --- 5. no claim this card type exists to avoid ----------------------------
// Scoped to the record article, so unrelated site chrome cannot trip it, and
// with the governed provenance line removed from that scope.
//
// The checked line is the ONE place a date is authorized on this card type,
// and it is a verification date, not an occurrence: "Checked 16 September 2026
// against the approved current schedule source". Leaving it inside the scan
// would make the calendar-date rule fire on the very string Project 09
// approved. So it is excised here and asserted byte-exact immediately below --
// the rule being enforced is "no occurrence claim ANYWHERE OUTSIDE the
// governed provenance line", which is the actual product rule.
const CHECKED_LINE = /<p class="checked">[\s\S]*?<\/p>/g;
const FORBIDDEN = [
  [/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i, 'weekday name'],
  [/\b(segunda|terça|quarta|quinta|sexta|sábado|domingo)(-feira)?\b/i, 'PT weekday name'],
  [/\b\d{1,2}[h:]\d{2}\b/, 'clock time'],
  [/\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i, 'calendar date'],
  [/\b\d{1,2}\s+de\s+(janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i, 'PT calendar date'],
  [/\bevery\s+(week|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i, 'weekly-schedule promise'],
  [/\b(todas as semanas|todos os (sábados|domingos))\b/i, 'PT weekly-schedule promise'],
  [/\b(free admission|entrada livre|entrada gratuita|grátis)\b/i, 'admission claim'],
];
for (const id of ids) {
  for (const [locale, prefix] of [['en', ''], ['pt', 'pt/']]) {
    const rel = `${prefix}things-to-do/${id}/index.html`;
    if (!exists(rel)) continue;
    const html = read(rel);
    const article = html
      .slice(html.indexOf('<article'), html.indexOf('</article>'))
      .replace(CHECKED_LINE, '');
    for (const [pattern, what] of FORBIDDEN) {
      const hit = article.match(pattern);
      check(`${rel}: asserts no ${what}`, hit === null, hit ? `found ${JSON.stringify(hit[0])}` : '');
    }
    // Excised above, so prove it is present and is exactly the approved string.
    check(`${rel}: still carries its governed checked line`, html.includes(EXPECTED[id][locale].checked));
    // ...and prove the excision cannot hide a second, unapproved date: the
    // article must contain exactly one checked line.
    check(`${rel}: carries exactly one provenance line`,
      (html.slice(html.indexOf('<article'), html.indexOf('</article>')).match(CHECKED_LINE) || []).length === 1);
  }
}

// --- 6. HOLD venues stay absent --------------------------------------------
const HOLD = [
  ['CineMindelo', /cine\s*mindelo/i],
  ['Jazzy Bird', /jazzy/i],
  ['Le Metalo', /metalo/i],
];
const ttdSurfaces = [];
for (const rec of events.records) {
  for (const prefix of ['', 'pt/']) {
    const rel = `${prefix}${rec.detail_page}index.html`;
    if (exists(rel)) ttdSurfaces.push(rel);
  }
}
const homeThingsRegion = (rel) => {
  const html = read(rel);
  const start = html.indexOf('<!-- BEGIN GENERATED EVENT:');
  const end = html.lastIndexOf('<!-- END GENERATED EVENT:');
  return start === -1 || end === -1 ? '' : html.slice(start, end);
};
for (const [name, pattern] of HOLD) {
  check(`${name}: has no canonical Things-to-Do record`,
    !events.records.some((r) => pattern.test(r.id) || pattern.test(r.title)));
  check(`${name}: has no Things-to-Do detail route`,
    !ttdSurfaces.some((rel) => pattern.test(rel)));
  check(`${name}: appears on no Things-to-Do detail page`,
    !ttdSurfaces.some((rel) => pattern.test(read(rel))));
  check(`${name}: absent from the generated Home Things-to-Do regions`,
    !pattern.test(homeThingsRegion('index.html')) && !pattern.test(homeThingsRegion('pt/index.html')));
  check(`${name}: absent from the sitemap`, !pattern.test(read('sitemap.xml')));
}
// The Cinema master is approved future media. It must not have been installed,
// because installing it here would have no published record to belong to.
check('the Movie Night / Cinema master is not committed',
  !fs.existsSync(path.join(ROOT, 'assets', 'card-media', 'things-to-do', 'source',
    'A_PRASA_TTD_Fallback_Movie_Night_Cinema_4x3_v1.png')));

// --- 7. determinism / committed output is in sync --------------------------
// Runs the real generator for both locales into a throwaway copy of the
// repository and compares what it produces against what is committed. A
// difference means either the generator is non-deterministic or the committed
// surfaces drifted from their source of truth.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-recurring-venue-'));
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  const runs = [
    ['--locale=en', '--write'],
    ['--locale=pt', '--home=pt/index.html', '--write'],
  ];
  let ok = true;
  let detail = '';
  for (const args of runs) {
    const r = spawnSync('node', [path.join(dir, 'scripts', 'generate-things-to-do.mjs'), `--as-of=${asOf}`, ...args],
      { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) { ok = false; detail = `generator exited ${r.status}: ${r.stderr}`; }
  }
  if (ok) {
    const compared = ['index.html', 'pt/index.html'];
    for (const id of ids) compared.push(`things-to-do/${id}/index.html`, `pt/things-to-do/${id}/index.html`);
    for (const rel of compared) {
      if (read(rel) !== fs.readFileSync(path.join(dir, rel), 'utf8')) {
        ok = false;
        detail = `${rel} differs from a fresh generation`;
        break;
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  check('regenerating both locales reproduces the committed surfaces byte-for-byte', ok, detail);
}

// The superseded classification must not reappear anywhere in the corpus --
// on these two records or on any record added later.
{
  const offenders = events.records
    .filter((r) => r.source_type === 'official-schedule-listing')
    .map((r) => r.id);
  check('the superseded "official-schedule-listing" classification is absent from the corpus',
    offenders.length === 0, offenders.join(', '));
}

console.log(`\nRecurring-venue card tests: ${passed}/${passed + failures.length} passed.`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
