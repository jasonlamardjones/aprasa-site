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
//      runtime fallback strings all resolve per locale, including the section
//      fallback note Project 09 approved after the hub tranche shipped it
//      unresolved.
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
import { t } from './lib/locale.mjs';
import { THINGS_TO_DO_HUB_PUBLIC, hubOutputPath, hubCanonical, homePreviewRecords, isPubliclyPublishable } from './lib/things-to-do-collection.mjs';

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

/**
 * Reactivate the collection hub inside a sandbox — the WHOLE republication,
 * not just the flag.
 *
 * The hub is temporarily unpublished in the repository
 * (THINGS_TO_DO_HUB_PUBLIC in scripts/lib/things-to-do-collection.mjs), so the
 * generator no longer emits it. Every hub assertion in this file is coverage of
 * architecture we intend to REACTIVATE, not of something we removed, so rather
 * than delete that coverage the sandbox republishes and exercises the real
 * renderer end to end: membership, canonical ordering, the empty state,
 * canonical/hreflang, EN/PT equivalence, determinism, and the negative gates.
 *
 * Three things have to be restored, and that is the point of doing it here
 * rather than by flipping a boolean: republication is NOT flag-only.
 *
 *   1. the flag, which restores hub emission, the sitemap route and the
 *      breadcrumb on GENERATED detail pages;
 *   2. the Home call to action, which lives in the authored index.html;
 *   3. the breadcrumb on the two HAND-AUTHORED detail pages, which no
 *      generator owns.
 *
 * If a future change makes republication need a fourth step, this helper stops
 * producing a valid published baseline and the negative-coverage cases below
 * fail — which is the alarm we want, rather than discovering it at reactivation.
 *
 * Every edit is confined to the throwaway copy; the repository stays dormant.
 */
const HOME_HUB_CTA = '      <p><a class="primary-cta" href="things-to-do/">Explore Things to Do <span aria-hidden="true">\u2192</span></a></p>\n';
const AUTHORED_DETAIL_PAGES = [
  'things-to-do/water-adventure-activities-mindelo/index.html',
  'things-to-do/street-art-mindelo/index.html',
];

function enableHub(dir) {
  const file = path.join(dir, 'scripts', 'lib', 'things-to-do-collection.mjs');
  const source = fs.readFileSync(file, 'utf8');
  const disabled = 'export const THINGS_TO_DO_HUB_PUBLIC = false;';
  const enabled = 'export const THINGS_TO_DO_HUB_PUBLIC = true;';
  // Idempotent: the determinism cases generate twice into one sandbox.
  if (source.includes(enabled)) return;
  if (!source.includes(disabled)) {
    throw new Error('enableHub: THINGS_TO_DO_HUB_PUBLIC declaration not found — update this helper');
  }
  fs.writeFileSync(file, source.replace(disabled, enabled));

  // 2. The Home call to action, in the authored EN source.
  //
  // It belongs at the END OF THE THINGS-TO-DO SHELF, and the closing-tag
  // sequence that ends that shelf is NOT unique: it ends six sections in
  // index.html, the first of them the hero. Matching the sequence alone would
  // restore the call to action in the wrong section, and the CTA assertion —
  // which reads the page, not the section — would still pass, so the sandbox
  // would quietly stop being a faithful reactivation. The shelf is therefore
  // located first and the sequence is accepted only as that shelf's own close.
  const homeFile = path.join(dir, 'index.html');
  const home = fs.readFileSync(homeFile, 'utf8');
  const shelfOpen = '<section class="shelf" id="things-to-do"';
  const shelfStart = home.indexOf(shelfOpen);
  if (shelfStart === -1) {
    throw new Error('enableHub: Home Things-to-Do shelf not found — update this helper');
  }
  const anchor = '      </div>\n    </div>\n  </section>';
  const anchorAt = home.indexOf(anchor, shelfStart);
  if (anchorAt === -1) {
    throw new Error('enableHub: Home Things-to-Do section anchor not found — update this helper');
  }
  // The anchor's own </section> must be the shelf's closing tag; anything else
  // means the match belongs to a later section.
  if (home.indexOf('</section>', shelfStart) !== anchorAt + anchor.indexOf('</section>')) {
    throw new Error('enableHub: Home Things-to-Do section anchor is not the shelf close — update this helper');
  }
  const restored =
    home.slice(0, anchorAt) +
    `      </div>\n${HOME_HUB_CTA}    </div>\n  </section>` +
    home.slice(anchorAt + anchor.length);
  // Prove the restored call to action really is inside the shelf.
  const ctaAt = restored.indexOf(HOME_HUB_CTA.trim());
  if (ctaAt < shelfStart || ctaAt > restored.indexOf('</section>', shelfStart)) {
    throw new Error('enableHub: restored Home call to action landed outside the Things-to-Do shelf');
  }
  fs.writeFileSync(homeFile, restored);

  // 3. The breadcrumb on the two hand-authored detail pages.
  for (const relative of AUTHORED_DETAIL_PAGES) {
    const target = path.join(dir, relative);
    const html = fs.readFileSync(target, 'utf8');
    const marker = '    <!-- Collection breadcrumb removed while';
    const start = html.indexOf(marker);
    if (start === -1) throw new Error(`enableHub: dormancy note not found in ${relative} — update this helper`);
    const end = html.indexOf('-->', start) + '-->\n'.length;
    const nav = '    <nav class="breadcrumb" aria-label="Breadcrumb">\n      <a href="../">\u2190 Things to Do</a>\n    </nav>\n';
    fs.writeFileSync(target, html.slice(0, start) + nav + html.slice(end));
  }

  // Propagate the restored EN copy into the PT surfaces the localizer owns.
  const localized = run(dir, 'build-static-pages.mjs', ['--write']);
  if (localized.status !== 0) throw new Error(`enableHub: PT localization failed: ${localized.out}`);
}

/** Full both-locale generation, exactly as scripts/build-all.mjs sequences it. */
function generate(dir, asOf) {
  enableHub(dir);
  const en = run(dir, 'generate-things-to-do.mjs', [`--as-of=${asOf}`, '--locale=en', '--write']);
  if (en.status !== 0) throw new Error(`EN generation failed: ${en.out}`);
  const pt = run(dir, 'generate-things-to-do.mjs', [`--as-of=${asOf}`, '--locale=pt', '--home=pt/index.html', '--write']);
  if (pt.status !== 0) throw new Error(`PT generation failed: ${pt.out}`);
  // The sitemap is derived from what was just emitted, and while the hub is
  // republished in this sandbox it must list the hub routes the validator now
  // expects. The committed sitemap has no hub routes (the repository is
  // dormant), so a sandbox that skipped this would fail on a stale artifact
  // rather than on anything it is testing.
  const sitemap = run(dir, 'build-sitemap.mjs', ['--write']);
  if (sitemap.status !== 0) throw new Error(`sitemap generation failed: ${sitemap.out}`);
}

const cardIds = (html) => [...html.matchAll(/<article class="resource-card" data-event-id="([^"]+)"/g)].map((m) => m[1]);
const read = (dir, relative) => fs.readFileSync(path.join(dir, relative), 'utf8');

/**
 * One record's hub card, or null when it has none.
 *
 * The synthesized-closing-day rule below is a statement about ONE record's own
 * card -- a month-precision record must never acquire a closing day it does not
 * have -- so it has to be evaluated against that card, not against the whole
 * page. Scanned page-wide it also reads every OTHER card, and a day-precision
 * record whose governed copy legitimately names a day in the same month (an
 * exhibition closing 15 November, say) would fail an assertion about a record
 * it is not.
 */
function cardFor(html, id) {
  const open = `<article class="resource-card" data-event-id="${id}"`;
  const start = html.indexOf(open);
  if (start === -1) return null;
  const end = html.indexOf('</article>', start);
  return end === -1 ? null : html.slice(start, end + '</article>'.length);
}

/**
 * Ids of the canonical records that actually carry month precision. This
 * selects the SUBJECTS of the rule from canonical data; the expected outcome
 * below is still stated independently, so a record silently losing its month
 * precision drops out of the subject list and the count assertion catches it.
 */
function monthPrecisionIds(dir) {
  const records = JSON.parse(read(dir, EVENTS)).records;
  return records.filter((record) => record.end_precision === 'month').map((record) => record.id);
}

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

    // Home membership is the GOVERNED CURATED SELECTION (Project 03,
    // EXPAND_HOME_PREVIEW, 17 September 2026), not a count and not a prefix of
    // hub order. The expected ids are stated here independently of the module
    // that produces them, so a change to HOME_PREVIEW_IDS has to be made
    // deliberately in two places rather than silently redefining "approved".
    const APPROVED_HOME_PREVIEW = [
      'cartinha-dholanda-mindelo-2026',
      'sinergia-da-materia',
      'voyage-obi-margo-kafe-djan-djan-2026',
      'taverna-live-music',
      'nautilus-live-music',
    ];
    check('Home preview is exactly the approved curated selection (EN)',
      JSON.stringify(enHome) === JSON.stringify(APPROVED_HOME_PREVIEW), `got [${enHome}]`);
    check('Home preview is exactly the approved curated selection (PT)',
      JSON.stringify(ptHome) === JSON.stringify(APPROVED_HOME_PREVIEW), `got [${ptHome}]`);
    check('Home preview shows exactly 5 records (EN)', enHome.length === 5, `got ${enHome.length}`);
    check('Home preview shows exactly 5 records (PT)', ptHome.length === 5, `got ${ptHome.length}`);
    // The eligible record Project 03 deliberately did NOT select stays off Home
    // while remaining a full member of the collection. This is the assertion
    // that would fail if the curated selection ever decayed back into
    // "the first N eligible records".
    check('the unselected eligible record is absent from Home but present on the hub (EN)',
      !enHome.includes('50-anos-de-memoria-criacao-e-resistencia')
      && enHub.includes('50-anos-de-memoria-criacao-e-resistencia'),
      `home=[${enHome}] hub=[${enHub}]`);
    check('the unselected eligible record is absent from Home (PT)',
      !ptHome.includes('50-anos-de-memoria-criacao-e-resistencia'), `home=[${ptHome}]`);
    // Home is a SUBSEQUENCE of hub order, not a prefix of it: every Home record
    // is a collection member, and the two surfaces never contradict each other
    // on relative order, but the curated selection may skip records.
    check('every Home preview record is a hub collection member (EN)',
      enHome.every((id) => enHub.includes(id)), `home=[${enHome}] hub=[${enHub}]`);
    check('Home preview preserves hub relative order (EN)',
      JSON.stringify(enHub.filter((id) => enHome.includes(id))) === JSON.stringify(enHome),
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
      const monthIds = monthPrecisionIds(dir);
      check(`${locale} hub has a card for every month-precision record`,
        monthIds.length > 0 && monthIds.every((id) => cardFor(html, id) !== null), `month-precision ids [${monthIds}]`);
      for (const id of monthIds) {
        const card = cardFor(html, id) ?? '';
        check(`${locale} hub publishes no synthesized closing day for month-precision record ${id}`,
          !/(\b[0-9]{1,2}\b[ ]+(de[ ]+)?(November|novembro))|((November|novembro)[ ]+\b[0-9]{1,2}\b)/.test(card), card);
        check(`${locale} hub emits no data-event-end for month-precision record ${id}`,
          !card.includes('data-event-end'), card);
      }
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
    check('EN section fallback note is unchanged',
      enBlock.sectionThumbnailNote === 'A PRASA section thumbnail — not provider-specific imagery.');
    check('PT section fallback note resolves to approved Portuguese',
      ptBlock.sectionThumbnailNote === 'Miniatura da secção A PRASA — imagem não específica do prestador.');
    check('PT section fallback note preserves the protected brand string',
      ptBlock.sectionThumbnailNote.includes('A PRASA'));
    check('no governed runtime string is left in English on the PT block',
      Object.entries(ptBlock).every(([key, value]) => value !== enBlock[key]));
    check('prasa-launch.js hardcodes no Portuguese fallback copy',
      !read(dir, 'prasa-launch.js').includes('Miniatura editorial da A PRASA')
      && !read(dir, 'prasa-launch.js').includes('Miniatura da secção A PRASA'));

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
    // Needs the REPUBLISHED state: detail pages carry no breadcrumb while the
    // collection is dormant, so there is nothing to revert. The rule itself is
    // retained for reactivation, so the case is kept and run against a
    // republished sandbox rather than deleted.
    ['canonical-link gate rejects: a breadcrumb reverted to a Home fragment', 'validate-canonical-internal-links.mjs', (dir) => {
      const file = path.join('things-to-do', 'eclipse-yuran-henrique', 'index.html');
      const html = read(dir, file);
      fs.writeFileSync(path.join(dir, file), html.replace('<a href="../">', '<a href="../../index.html#things-to-do">'));
    }, { republished: true }],
    ['canonical-link gate rejects: an index.html URL in the sitemap', 'validate-canonical-internal-links.mjs', (dir) => {
      const xml = read(dir, 'sitemap.xml');
      fs.writeFileSync(path.join(dir, 'sitemap.xml'), xml.replace('<loc>https://aprasa.org/</loc>', '<loc>https://aprasa.org/index.html</loc>'));
    }],
    ['runtime-string gate rejects: English left in the PT block', 'validate-runtime-locale-strings.mjs', (dir) => {
      const html = read(dir, 'pt/index.html');
      fs.writeFileSync(path.join(dir, 'pt/index.html'), html.replace('"mediaFallbackLabel":"O que fazer"', '"mediaFallbackLabel":"Things to Do"'));
    }],
    ['runtime-string gate rejects: an ungoverned string written into a block', 'validate-runtime-locale-strings.mjs', (dir) => {
      const html = read(dir, 'pt/index.html');
      fs.writeFileSync(path.join(dir, 'pt/index.html'), html.replace('{"mediaFallbackLabel"', '{"inventedNote":"nota inventada","mediaFallbackLabel"'));
    }],
    ['runtime-string gate rejects: a runtime default with no governed key', 'validate-runtime-locale-strings.mjs', (dir) => {
      const js = read(dir, 'prasa-launch.js');
      fs.writeFileSync(path.join(dir, 'prasa-launch.js'), js.replace(
        '    mediaFallbackLabel: "Things to Do",',
        '    mediaFallbackLabel: "Things to Do",\n    untrackedNote: "Untracked runtime copy.",'
      ));
    }],
    ['runtime-string gate rejects: the newly approved PT note reverted to English', 'validate-runtime-locale-strings.mjs', (dir) => {
      const html = read(dir, 'pt/index.html');
      fs.writeFileSync(path.join(dir, 'pt/index.html'), html.replace(
        '"sectionThumbnailNote":"Miniatura da secção A PRASA — imagem não específica do prestador."',
        '"sectionThumbnailNote":"A PRASA section thumbnail — not provider-specific imagery."'
      ));
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

  for (const [name, validator, mutate, options = {}] of auditMutations) {
    const dir = sandbox();
    try {
      if (options.republished) {
        const asOfRepublished = JSON.parse(read(dir, 'data/things-to-do-currentness.json')).as_of;
        generate(dir, asOfRepublished);
      }
      const before = run(dir, validator, []);
      if (before.status !== 0) throw new Error(`baseline already fails ${validator}: ${before.out}`);
      mutate(dir);
      check(name, run(dir, validator, []).status !== 0, 'validator passed a surface it should reject');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Temporary unpublishing of the collection hub.
//
//    Everything above proves the hub still WORKS when republished. This
//    section proves it is currently NOT published — the two claims the
//    founder's approval actually rests on, kept apart so neither can quietly
//    stand in for the other.
// ---------------------------------------------------------------------------
{
  const asOf = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'things-to-do-currentness.json'), 'utf8')).as_of;

  check('the repository declares the collection hub unpublished',
    THINGS_TO_DO_HUB_PUBLIC === false, `THINGS_TO_DO_HUB_PUBLIC is ${THINGS_TO_DO_HUB_PUBLIC}`);

  for (const locale of ['en', 'pt']) {
    check(`${hubOutputPath(locale)} is absent from the committed tree`,
      !fs.existsSync(path.join(ROOT, hubOutputPath(locale))));
  }

  // Absence must be genuine, not a stale artifact: a full generation must not
  // put the hub back.
  const dir = sandbox();
  try {
    const en = run(dir, 'generate-things-to-do.mjs', [`--as-of=${asOf}`, '--locale=en', '--write']);
    const pt = run(dir, 'generate-things-to-do.mjs', [`--as-of=${asOf}`, '--locale=pt', '--home=pt/index.html', '--write']);
    check('a dormant full generation exits cleanly', en.status === 0 && pt.status === 0);
    for (const locale of ['en', 'pt']) {
      check(`a dormant generation does not emit ${hubOutputPath(locale)}`,
        !fs.existsSync(path.join(dir, hubOutputPath(locale))));
    }
    // ...and it must still produce every detail page and the Home preview.
    const records = JSON.parse(read(dir, EVENTS)).records.filter((r) => r.kind === 'dated-event');
    check('a dormant generation still writes every EN detail page',
      records.every((r) => fs.existsSync(path.join(dir, r.detail_page, 'index.html'))));
    check('a dormant generation still writes every PT detail page',
      records.every((r) => fs.existsSync(path.join(dir, 'pt', r.detail_page, 'index.html'))));
    check('a dormant generation still renders the Home preview',
      cardIds(read(dir, 'index.html')).length > 0 && cardIds(read(dir, 'pt/index.html')).length > 0);

    const sitemapRun = run(dir, 'build-sitemap.mjs', ['--write']);
    check('a dormant sitemap build exits cleanly', sitemapRun.status === 0);
    const sitemap = read(dir, 'sitemap.xml');
    for (const locale of ['en', 'pt']) {
      check(`the sitemap omits the unpublished ${locale.toUpperCase()} hub route`,
        !sitemap.includes(`<loc>${hubCanonical(locale)}</loc>`));
    }
    check('the sitemap retains every dated-event detail route',
      records.every((r) => sitemap.includes(`<loc>https://aprasa.org/${r.detail_page}</loc>`)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // No shipped surface may link into either unpublished route.
  const htmlFiles = [];
  (function walk(rel) {
    for (const entry of fs.readdirSync(path.join(ROOT, rel || '.'), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.html')) htmlFiles.push(next);
    }
  })('');
  const linking = htmlFiles.filter((rel) => {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return /href="(?:\.\.\/)*(?:pt\/)?things-to-do\/"/.test(html) || html.includes('href="/things-to-do/"') || html.includes('href="/pt/things-to-do/"');
  });
  check('no shipped page links into either unpublished hub route',
    linking.length === 0, linking.join(', '));

  // The Home call to action is gone in BOTH locales, by governed label.
  for (const [locale, homeFile] of [['en', 'index.html'], ['pt', 'pt/index.html']]) {
    const html = fs.readFileSync(path.join(ROOT, homeFile), 'utf8');
    check(`${homeFile} no longer carries the governed hub call to action`,
      !html.includes(t('home.things.hub_action', locale)));
  }

  // Detail pages keep a same-locale Home route in the header, so suppressing
  // the breadcrumb strands nobody.
  for (const [locale, prefix, homeHref] of [['en', '', '../../'], ['pt', 'pt/', '../../../pt/']]) {
    const sample = `${prefix}things-to-do/mon-pikenin/index.html`;
    const html = fs.readFileSync(path.join(ROOT, sample), 'utf8');
    check(`${sample} keeps a same-locale Home link in the header`,
      html.includes(`href="${homeHref}"`));
    check(`${sample} carries no collection breadcrumb while dormant`,
      !html.includes('<nav class="breadcrumb"'));
  }

  // The governed hub copy is retained, not deleted — reactivation needs it.
  for (const key of ['home.things.hub_action', 'things.hub.h1', 'things.hub.intro', 'things.hub.empty_state']) {
    check(`governed key ${key} is retained for reactivation`,
      Boolean(t(key, 'en')) && Boolean(t(key, 'pt')));
  }
}

// ---------------------------------------------------------------------------
// N. The curated selection is NECESSARY, NOT SUFFICIENT.
//
// Naming a record in HOME_PREVIEW_IDS may add it to Home; it must never keep a
// record there that may not be shown. Two independent axes decide that, and
// selection satisfies neither:
//
//   currentness        collectionRecords() / isPubliclyCurrent()
//   publication state  isPubliclyPublishable() -- a whitelist of "published"
//
// Independent review (Codex, PR #106) found the second axis missing: membership
// resolved through currentness alone, and isPubliclyCurrent() treats only
// publication_state "expired" as expired, so a WITHDRAWN or DRAFT record read as
// perfectly current and would have stayed on Home. Each state is driven through
// the real generator, in both locales, end to end.
// ---------------------------------------------------------------------------
for (const state of ['expired', 'withdrawn', 'draft']) {
  const asOf = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'things-to-do-currentness.json'), 'utf8')).as_of;
  const dir = sandbox();
  try {
    // Move one SELECTED record out of public publication, in the sandbox only.
    const eventsPath = path.join(dir, EVENTS);
    const doc = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
    const target = doc.records.find((record) => record.id === 'taverna-live-music');
    check(`${state}: the fixture found its selected subject`, Boolean(target));
    target.publication_state = state;
    fs.writeFileSync(eventsPath, `${JSON.stringify(doc, null, 2)}\n`);

    generate(dir, asOf);
    const enHome = cardIds(read(dir, 'index.html'));
    const ptHome = cardIds(read(dir, 'pt/index.html'));

    check(`${state}: a SELECTED record in this state is absent from Home (EN)`,
      !enHome.includes('taverna-live-music'), `home=[${enHome}]`);
    check(`${state}: a SELECTED record in this state is absent from Home (PT)`,
      !ptHome.includes('taverna-live-music'), `home=[${ptHome}]`);
    // The rest of the selection is untouched, and the gap is NOT backfilled by
    // the next eligible record -- that would be the count-based rule returning.
    check(`${state}: the remaining selected records are unaffected (EN)`,
      JSON.stringify(enHome) === JSON.stringify([
        'cartinha-dholanda-mindelo-2026',
        'sinergia-da-materia',
        'voyage-obi-margo-kafe-djan-djan-2026',
        'nautilus-live-music',
      ]), `home=[${enHome}]`);
    check(`${state}: EN and PT stay identical`,
      JSON.stringify(enHome) === JSON.stringify(ptHome), `en=[${enHome}] pt=[${ptHome}]`);
    check(`${state}: the unselected eligible record is NOT promoted into the freed slot`,
      !enHome.includes('50-anos-de-memoria-criacao-e-resistencia'), `home=[${enHome}]`);

    // Only "expired" removes a record from the COLLECTION. withdrawn/draft are
    // publication decisions, not currentness ones, so the hub's own membership
    // is deliberately left alone by this repair -- asserted so that a later
    // broadening of collectionRecords() is a visible decision, not a silent one.
    const onHub = cardIds(read(dir, EN_HUB)).includes('taverna-live-music');
    check(`${state}: collection membership follows currentness only, as before`,
      onHub === (state !== 'expired'), `onHub=${onHub}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The positive control for the same rule: published AND current IS visible.
// (The exhaustive five-ID/order assertions live in block 1 above; this states
// the pairing explicitly so the negative cases cannot pass vacuously.)
{
  const asOf = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'things-to-do-currentness.json'), 'utf8')).as_of;
  const records = JSON.parse(fs.readFileSync(path.join(ROOT, EVENTS), 'utf8')).records;
  const selected = records.find((record) => record.id === 'taverna-live-music');
  check('control: the subject really is published and current in the committed corpus',
    selected?.publication_state === 'published' && isPubliclyPublishable(selected));
  check('control: selected + published + current IS visible',
    homePreviewRecords(records, asOf).map((record) => record.id).includes('taverna-live-music'));
}

// ---------------------------------------------------------------------------
// N+1. A selected id that matches no record is reported, not silently dropped.
//
// A missing Home card is indistinguishable from an expired one by eye, so the
// hub validator names the bad id instead of letting Home quietly shrink.
// ---------------------------------------------------------------------------
{
  const asOf = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'things-to-do-currentness.json'), 'utf8')).as_of;
  const dir = sandbox();
  try {
    const modulePath = path.join(dir, 'scripts', 'lib', 'things-to-do-collection.mjs');
    const module = fs.readFileSync(modulePath, 'utf8');
    const patched = module.replace("'nautilus-live-music',", "'nautilus-live-music',\n  'no-such-record',");
    check('the unknown-id fixture patched the governed list', patched !== module);
    fs.writeFileSync(modulePath, patched);

    const result = run(dir, 'validate-things-to-do-hub.mjs', [`--as-of=${asOf}`]);
    check('the hub validator rejects a selected id that matches no record',
      result.status !== 0 && /HOME_PREVIEW_IDS selects "no-such-record"/.test(result.out),
      `exit ${result.status}: ${String(result.out).trim().split('\n').slice(-2).join(' / ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
