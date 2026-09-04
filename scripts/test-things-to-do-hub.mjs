#!/usr/bin/env node
// Bounded regression tests for behaviour the Things-to-Do collection hub
// introduces and that no incumbent test already covers:
//
//   1. Home is the approved limited preview and the hub is the full eligible
//      collection, in canonical order, in both locales.
//   2. The empty state is reachable from canonical currentness output, and no
//      expired record is surfaced as filler in its place. Live inventory is
//      never zero, so this is exercised through a synthetic fixture.
//   3. Generation is deterministic and idempotent for a given --as-of.
//   4. REVIEW_DUE records stay ordinary public hub cards: not dropped, not
//      labelled a past event, and given no new badge or copy.
//   5. The hub gate is not vacuous — each membership, locale, CTA and schema
//      rule is shown to actually fail when the surface is wrong.
//   6. The technical-SEO audit follow-ups hold and cannot regress: internal
//      Home links stay in canonical directory form, every Things-to-Do return
//      control resolves to its own locale's collection route, and the governed
//      runtime fallback strings resolve per locale without inventing copy for
//      the one string Project 09 has not yet approved.
//
// Every case runs the SHIPPED generator and the SHIPPED validator inside a
// throwaway copy of the repository, so what is under test is the real
// pipeline, not a reimplementation of it.
//
// Usage: node scripts/test-things-to-do-hub.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EVENTS = path.join('data', 'things-to-do-events.json');
const EN_HUB = path.join('things-to-do', 'index.html');
const PT_HUB = path.join('pt', 'things-to-do', 'index.html');

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS — ${name}`); }
  else { failures.push(`${name}${detail ? `: ${detail}` : ''}`); console.log(`FAIL — ${name}${detail ? `: ${detail}` : ''}`); }
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-hub-test-'));
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  return dir;
}

function run(dir, script, args) {
  const r = spawnSync('node', [path.join(dir, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** Full both-locale generation, exactly as scripts/build-all.mjs sequences it. */
function generate(dir, asOf) {
  const en = run(dir, 'generate-things-to-do.mjs', [`--as-of=${asOf}`, '--locale=en', '--write']);
  if (en.status !== 0) throw new Error(`EN generation failed: ${en.out}`);
  const pt = run(dir, 'generate-things-to-do.mjs', [`--as-of=${asOf}`, '--locale=pt', '--home=pt/index.html', '--write']);
  if (pt.status !== 0) throw new Error(`PT generation failed: ${pt.out}`);
}

const cardIds = (html) => [...html.matchAll(/<article class="resource-card" data-event-id="([^"]+)"/g)].map((m) => m[1]);
const read = (dir, relative) => fs.readFileSync(path.join(dir, relative), 'utf8');

// ---------------------------------------------------------------------------
// 1. Preview / collection split, both locales, at the committed as_of.
// ---------------------------------------------------------------------------
{
  const asOf = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'things-to-do-currentness.json'), 'utf8')).as_of;
  const dir = sandbox();
  try {
    generate(dir, asOf);
    const enHub = cardIds(read(dir, EN_HUB));
    const ptHub = cardIds(read(dir, PT_HUB));
    const enHome = cardIds(read(dir, 'index.html'));
    const ptHome = cardIds(read(dir, 'pt/index.html'));

    check('Home preview is capped at 3 records (EN)', enHome.length <= 3, `got ${enHome.length}`);
    check('Home preview is capped at 3 records (PT)', ptHome.length <= 3, `got ${ptHome.length}`);
    check('Home preview is the first eligible records in hub order (EN)',
      JSON.stringify(enHome) === JSON.stringify(enHub.slice(0, enHome.length)),
      `home=[${enHome}] hub=[${enHub}]`);
    check('EN and PT hubs present identical record membership and order',
      JSON.stringify(enHub) === JSON.stringify(ptHub), `en=[${enHub}] pt=[${ptHub}]`);
    check('EN and PT Home previews present identical record membership and order',
      JSON.stringify(enHome) === JSON.stringify(ptHome), `en=[${enHome}] pt=[${ptHome}]`);
    check('hub carries at least as many records as the Home preview', enHub.length >= enHome.length);
    check('hub validator passes on freshly generated surfaces',
      run(dir, 'validate-things-to-do-hub.mjs', [`--as-of=${asOf}`]).status === 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. Empty state from canonical currentness output (synthetic fixture).
//    Live inventory is never zero, so zero eligibility is produced the only
//    honest way: by marking every canonical record expired in a throwaway copy.
// ---------------------------------------------------------------------------
{
  const asOf = '2026-09-02';
  const dir = sandbox();
  try {
    const data = JSON.parse(read(dir, EVENTS));
    const allTitles = data.records.map((r) => r.title);
    data.records = data.records.map((r) => ({ ...r, publication_state: 'expired' }));
    fs.writeFileSync(path.join(dir, EVENTS), `${JSON.stringify(data, null, 2)}\n`);
    generate(dir, asOf);

    for (const [locale, file, expected] of [
      ['EN', EN_HUB, 'There aren’t any current Things-to-Do listings available right now.'],
      ['PT', PT_HUB, 'Neste momento, não há propostas atuais disponíveis em O que fazer na A PRASA.'],
    ]) {
      const html = read(dir, file);
      check(`${locale} hub renders the approved empty state when nothing is eligible`, html.includes(expected));
      check(`${locale} hub renders no cards when nothing is eligible`, cardIds(html).length === 0, `got [${cardIds(html)}]`);
      check(`${locale} hub surfaces no expired record as filler`,
        !allTitles.some((title) => html.includes(`<h3>${title}</h3>`)));
    }
    check('EN Home shows no preview cards when nothing is eligible', cardIds(read(dir, 'index.html')).length === 0);
    check('PT Home shows no preview cards when nothing is eligible', cardIds(read(dir, 'pt/index.html')).length === 0);
    check('hub validator passes on the empty-state surfaces',
      run(dir, 'validate-things-to-do-hub.mjs', [`--as-of=${asOf}`]).status === 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. Determinism and idempotence.
// ---------------------------------------------------------------------------
{
  const dir = sandbox();
  try {
    generate(dir, '2026-08-24');
    const firstEn = read(dir, EN_HUB);
    const firstPt = read(dir, PT_HUB);
    generate(dir, '2026-08-24');
    check('repeated generation for the same --as-of is byte-identical (EN hub)', read(dir, EN_HUB) === firstEn);
    check('repeated generation for the same --as-of is byte-identical (PT hub)', read(dir, PT_HUB) === firstPt);

    // A different tracked date must produce a different, correct membership,
    // and returning to the first date must reproduce the first output exactly.
    generate(dir, '2026-08-30');
    const laterEn = read(dir, EN_HUB);
    check('a different --as-of changes hub membership', laterEn !== firstEn);
    generate(dir, '2026-08-24');
    check('generation depends only on canonical data and --as-of, not on prior output',
      read(dir, EN_HUB) === firstEn);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. REVIEW_DUE preservation at the November month boundary.
// ---------------------------------------------------------------------------
{
  const asOf = '2026-11-01';
  const dir = sandbox();
  try {
    generate(dir, asOf);
    for (const [locale, file] of [['EN', EN_HUB], ['PT', PT_HUB]]) {
      const html = read(dir, file);
      check(`${locale} hub keeps the review-due record`, cardIds(html).includes('sinergia-da-materia'), `got [${cardIds(html)}]`);
      check(`${locale} hub does not label a review-due record a past event`,
        !html.includes('Past event') && !html.includes('Evento já realizado'));
      check(`${locale} hub introduces no REVIEW_DUE badge or copy`, !/REVIEW.?DUE/i.test(html));
      check(`${locale} hub publishes no synthesized closing day for a month-precision record`,
        !/(\b[0-9]{1,2}\b[ ]+(de[ ]+)?(November|novembro))|((November|novembro)[ ]+\b[0-9]{1,2}\b)/.test(html));
      check(`${locale} hub serializes no endDate for a month-precision record`, !html.includes('"endDate"'));
    }
    check('hub validator passes at the review-due boundary',
      run(dir, 'validate-things-to-do-hub.mjs', [`--as-of=${asOf}`]).status === 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5. Negative coverage — the hub gate must actually fail on a wrong surface.
// ---------------------------------------------------------------------------
{
  const asOf = '2026-09-02';
  const mutations = [
    ['a hub card removed', (dir) => {
      const html = read(dir, EN_HUB);
      const start = html.indexOf('<article class="resource-card" data-event-id="4-campeonato-nacional-senior-de-boxe"');
      const end = html.indexOf('</article>', start) + '</article>'.length;
      fs.writeFileSync(path.join(dir, EN_HUB), html.slice(0, start) + html.slice(end));
    }],
    ['an expired record added to the hub', (dir) => {
      const html = read(dir, EN_HUB);
      fs.writeFileSync(path.join(dir, EN_HUB), html.replace(
        '<div class="resource-grid things-grid">',
        '<div class="resource-grid things-grid">\n      <article class="resource-card" data-event-id="mon-pikenin" data-checked="2026-08-17">\n        <h3>Mon Pikenin</h3>\n      </article>'
      ));
    }],
    ['a fourth card added to the Home preview', (dir) => {
      const html = read(dir, 'index.html');
      fs.writeFileSync(path.join(dir, 'index.html'), html.replace(
        '<!-- BEGIN GENERATED EVENT: 4-campeonato-nacional-senior-de-boxe -->',
        '<!-- BEGIN GENERATED EVENT: 4-campeonato-nacional-senior-de-boxe -->\n        <article class="resource-card" data-event-id="4-campeonato-nacional-senior-de-boxe" data-checked="2026-09-02"><h3>4.º Campeonato Nacional Sénior de Boxe</h3></article>'
      ));
    }],
    ['English chrome left on the PT hub', (dir) => {
      const html = read(dir, PT_HUB);
      fs.writeFileSync(path.join(dir, PT_HUB), html.replace(
        '<h1>O que fazer em Mindelo e São Vicente</h1>',
        '<h1>Things to Do in Mindelo &amp; São Vicente</h1>'
      ));
    }],
    ['the hub CTA replaced by another surface’s label', (dir) => {
      const html = read(dir, EN_HUB);
      fs.writeFileSync(path.join(dir, EN_HUB), html.replaceAll('>View details</a>', '>See event</a>'));
    }],
    ['Event schema duplicated onto the hub', (dir) => {
      const html = read(dir, EN_HUB);
      fs.writeFileSync(path.join(dir, EN_HUB), html.replace(
        '</head>',
        '<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "Event",\n  "name": "duplicate"\n}\n</script>\n</head>'
      ));
    }],
    ['the hub route dropped from the sitemap', (dir) => {
      const xml = read(dir, 'sitemap.xml');
      fs.writeFileSync(path.join(dir, 'sitemap.xml'), xml.replace('  <url>\n    <loc>https://aprasa.org/things-to-do/</loc>\n  </url>\n', ''));
    }],
    ['a detail breadcrumb pointed away from the collection', (dir) => {
      const file = path.join('things-to-do', 'eclipse-yuran-henrique', 'index.html');
      const html = read(dir, file);
      fs.writeFileSync(path.join(dir, file), html.replace('<a href="../">← Things to Do</a>', '<a href="../../index.html#things-to-do">← Things to Do</a>'));
    }],
    ['the Home hub call to action removed', (dir) => {
      const html = read(dir, 'index.html');
      fs.writeFileSync(path.join(dir, 'index.html'), html.replace(/<p><a class="primary-cta" href="things-to-do\/">[\s\S]*?<\/a><\/p>\n/, ''));
    }],
  ];

  for (const [name, mutate] of mutations) {
    const dir = sandbox();
    try {
      generate(dir, asOf);
      run(dir, 'build-sitemap.mjs', ['--write']);
      const before = run(dir, 'validate-things-to-do-hub.mjs', [`--as-of=${asOf}`]);
      if (before.status !== 0) throw new Error(`baseline surface already fails the hub gate: ${before.out}`);
      mutate(dir);
      const after = run(dir, 'validate-things-to-do-hub.mjs', [`--as-of=${asOf}`]);
      check(`hub gate rejects: ${name}`, after.status !== 0, 'validator passed a surface it should reject');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Technical-SEO audit follow-ups: canonical internal links and governed
//    runtime strings, with negative coverage for both gates.
// ---------------------------------------------------------------------------
{
  const asOf = '2026-09-02';
  const dir = sandbox();
  try {
    check('canonical internal-link gate passes on the committed tree',
      run(dir, 'validate-canonical-internal-links.mjs', []).status === 0);
    check('governed runtime-string gate passes on the committed tree',
      run(dir, 'validate-runtime-locale-strings.mjs', []).status === 0);

    // EN detail pages return to /things-to-do/, PT detail pages to
    // /pt/things-to-do/ — asserted here on resolved routes, independently of
    // the validator that also checks it.
    generate(dir, asOf);
    for (const [prefix, expected] of [['', '/things-to-do/'], ['pt/', '/pt/things-to-do/']]) {
      const file = `${prefix}things-to-do/eclipse-yuran-henrique/index.html`;
      const html = read(dir, file);
      const href = html.match(/<nav class="breadcrumb"[\s\S]*?<a href="([^"]+)"/)[1];
      const resolved = `/${path.relative(dir, path.resolve(path.dirname(path.join(dir, file)), href))}/`;
      check(`${expected} is where the ${prefix ? 'PT' : 'EN'} detail return control resolves`, resolved === expected, `got ${resolved}`);
      check(`${prefix || 'EN'} detail return control is not a Home fragment`, !href.includes('#'));
    }

    // Touched/generated surfaces use canonical directory Home links.
    for (const file of ['index.html', 'pt/index.html', EN_HUB, PT_HUB, 'things-to-do/eclipse-yuran-henrique/index.html', 'about/index.html', 'mindelo-essentials/index.html']) {
      check(`${file} carries no index.html Home document link`,
        !/href="(\.\.\/)*index\.html/.test(read(dir, file)));
    }
    check('sitemap publishes no index.html variant', !read(dir, 'sitemap.xml').includes('index.html'));

    // EN runtime fallback strings are unchanged from the audited English.
    const enBlock = JSON.parse(read(dir, 'index.html').match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1]);
    check('EN runtime fallback label is unchanged', enBlock.mediaFallbackLabel === 'Things to Do');
    check('EN runtime fallback note is unchanged',
      enBlock.mediaFallbackNote === 'A PRASA editorial thumbnail — not an image of this specific activity.');
    const ptBlock = JSON.parse(read(dir, 'pt/index.html').match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1]);
    check('PT runtime fallback label resolves to approved Portuguese', ptBlock.mediaFallbackLabel === 'O que fazer');
    check('PT runtime fallback note resolves to approved Portuguese',
      ptBlock.mediaFallbackNote === 'Miniatura editorial da A PRASA — não é uma imagem desta atividade específica.');
    check('the unapproved section-thumbnail note is left unresolved in both locales',
      !('sectionThumbnailNote' in enBlock) && !('sectionThumbnailNote' in ptBlock));
    check('prasa-launch.js hardcodes no Portuguese fallback copy',
      !read(dir, 'prasa-launch.js').includes('Miniatura editorial da A PRASA'));

    // Locale switching / fallback rendering is deterministic: the same build
    // reproduces byte-identical governed blocks.
    const beforeEn = read(dir, 'index.html').match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1];
    const beforePt = read(dir, 'pt/index.html').match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1];
    run(dir, 'build-static-pages.mjs', ['--write']);
    check('governed runtime blocks are deterministic across rebuilds (EN)',
      read(dir, 'index.html').match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1] === beforeEn);
    check('governed runtime blocks are deterministic across rebuilds (PT)',
      read(dir, 'pt/index.html').match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1] === beforePt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const auditMutations = [
    ['canonical-link gate rejects: a Home link reverted to index.html', 'validate-canonical-internal-links.mjs', (dir) => {
      const html = read(dir, 'about/index.html');
      fs.writeFileSync(path.join(dir, 'about/index.html'), html.replace('href="../"', 'href="../index.html"'));
    }],
    ['canonical-link gate rejects: a breadcrumb reverted to a Home fragment', 'validate-canonical-internal-links.mjs', (dir) => {
      const file = path.join('things-to-do', 'eclipse-yuran-henrique', 'index.html');
      const html = read(dir, file);
      fs.writeFileSync(path.join(dir, file), html.replace('<a href="../">', '<a href="../../index.html#things-to-do">'));
    }],
    ['canonical-link gate rejects: an index.html URL in the sitemap', 'validate-canonical-internal-links.mjs', (dir) => {
      const xml = read(dir, 'sitemap.xml');
      fs.writeFileSync(path.join(dir, 'sitemap.xml'), xml.replace('<loc>https://aprasa.org/</loc>', '<loc>https://aprasa.org/index.html</loc>'));
    }],
    ['runtime-string gate rejects: English left in the PT block', 'validate-runtime-locale-strings.mjs', (dir) => {
      const html = read(dir, 'pt/index.html');
      fs.writeFileSync(path.join(dir, 'pt/index.html'), html.replace('"mediaFallbackLabel":"O que fazer"', '"mediaFallbackLabel":"Things to Do"'));
    }],
    ['runtime-string gate rejects: an unapproved string written into a block', 'validate-runtime-locale-strings.mjs', (dir) => {
      const html = read(dir, 'pt/index.html');
      fs.writeFileSync(path.join(dir, 'pt/index.html'), html.replace('{"mediaFallbackLabel"', '{"sectionThumbnailNote":"nota inventada","mediaFallbackLabel"'));
    }],
    ['runtime-string gate rejects: the governed block removed from PT Home', 'validate-runtime-locale-strings.mjs', (dir) => {
      const html = read(dir, 'pt/index.html');
      fs.writeFileSync(path.join(dir, 'pt/index.html'), html.replace(/<script type="application\/json" id="i18n-strings">[\s\S]*?<\/script>\n?/, ''));
    }],
    ['runtime-string gate rejects: a Portuguese value hardcoded into the runtime', 'validate-runtime-locale-strings.mjs', (dir) => {
      const js = read(dir, 'prasa-launch.js');
      fs.writeFileSync(path.join(dir, 'prasa-launch.js'), js.replace(
        'mediaFallbackLabel: "Things to Do",',
        'mediaFallbackLabel: "Things to Do", ptLabel: "O que fazer",'
      ));
    }],
  ];

  for (const [name, validator, mutate] of auditMutations) {
    const dir = sandbox();
    try {
      const before = run(dir, validator, []);
      if (before.status !== 0) throw new Error(`baseline already fails ${validator}: ${before.out}`);
      mutate(dir);
      check(name, run(dir, validator, []).status !== 0, 'validator passed a surface it should reject');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
