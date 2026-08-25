#!/usr/bin/env node
// Generates pt/mindelo-essentials/ from the EN source + governed locale
// data. Canonical directory records (mindelo-essentials/data/*.json,
// *.geojson) are never duplicated or forked — the PT page renders the same
// markup with record prose translated by stable record_id, provider
// identity/location/coordinates unchanged in both locales.
//
// This file gets its own build script rather than reusing
// build-static-pages.mjs because its source HTML is differently formatted
// (self-closing tags, reordered attributes, already has a .header-actions
// wrapper) — the regex-based head/nav injection needs to tolerate that.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './lib/locale.mjs';
import { localizeStaticHtml } from './lib/static-page-transform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const write = process.argv.includes('--write');

const enPath = path.join(root, 'mindelo-essentials', 'index.html');
const ptPath = path.join(root, 'pt', 'mindelo-essentials', 'index.html');
const canonicalEn = 'https://aprasa.org/mindelo-essentials/';
const canonicalPt = 'https://aprasa.org/pt/mindelo-essentials/';

function injectHeadLinks(html, { selfCanonical, lang }) {
  let out = html.replace(/<html lang="[a-z]+">/, `<html lang="${lang}">`);
  out = out.replace(/<link rel="canonical" href="[^"]*"\/?>/, `<link rel="canonical" href="${selfCanonical}"/>`);
  if (/hreflang="pt"/.test(out)) {
    out = out.replace(/<link rel="alternate" hreflang="en" href="[^"]*"\/?>/, `<link rel="alternate" hreflang="en" href="${canonicalEn}"/>`);
    out = out.replace(/<link rel="alternate" hreflang="pt" href="[^"]*"\/?>/, `<link rel="alternate" hreflang="pt" href="${canonicalPt}"/>`);
    out = out.replace(/<link rel="alternate" hreflang="x-default" href="[^"]*"\/?>/, `<link rel="alternate" hreflang="x-default" href="${canonicalEn}"/>`);
  } else {
    out = out.replace(
      /(<link rel="canonical" href="[^"]*"\/?>)/,
      (m) => `${m}\n<link rel="alternate" hreflang="en" href="${canonicalEn}"/>\n<link rel="alternate" hreflang="pt" href="${canonicalPt}"/>\n<link rel="alternate" hreflang="x-default" href="${canonicalEn}"/>`
    );
  }
  out = out.replace(/<meta property="og:url" content="[^"]*"\/?>/, `<meta property="og:url" content="${selfCanonical}"/>`);
  if (!/og:locale/.test(out)) {
    out = out.replace(/(<meta property="og:url" content="[^"]*"\/?>)/, `$1\n<meta property="og:locale" content="${lang === 'pt' ? 'pt_PT' : 'en_US'}"/>`);
  } else {
    out = out.replace(/<meta property="og:locale" content="[^"]*"\/?>/, `<meta property="og:locale" content="${lang === 'pt' ? 'pt_PT' : 'en_US'}"/>`);
  }
  return out;
}

// This page already has a .header-actions wrapper around .site-nav (a
// pre-existing hook per the earlier repo inspection) — insert the
// lang-switch nav as a sibling inside it rather than adding a new wrapper.
// Leaves the existing site-nav's aria-label ("Site navigation") as literal
// English text — the generic localizeStaticHtml pass below translates it
// like any other attribute via the governed nav.site_navigation key, so
// this function never bakes in PT text itself (which would otherwise be
// re-scanned as unmatched English on the next run).
function injectLangSwitch(html, { enHref, ptHref, locale }) {
  const switchNav = `<nav class="lang-switch" aria-label="Language / Idioma"><a href="${enHref}" lang="en" hreflang="en"${locale === 'en' ? ' aria-current="true" class="lang-current"' : ''}>EN</a><a href="${ptHref}" lang="pt" hreflang="pt"${locale === 'pt' ? ' aria-current="true" class="lang-current"' : ''}>PT</a></nav>`;
  if (/class="lang-switch"/.test(html)) {
    return html.replace(/<nav class="lang-switch"[\s\S]*?<\/nav>/, switchNav);
  }
  return html.replace(/(<nav[^>]*class="site-nav"[^>]*>[\s\S]*?<\/nav>)/, `$1${switchNav}`);
}

// "TRANSCOR information ... go directly to <a>TRANSCOR's official Carreiras
// page ↗</a>." embeds the link's own label mid-sentence (unlike the other
// two TRANSCOR links on this page, which are appended after a colon and
// already translate cleanly via the generic matcher). Reconstructs the PT
// sentence around the same anchor by locating the link-label key's PT text
// inside the full-sentence key's PT text.
function applyGettingAroundLinkFixup(html, locale) {
  if (locale !== 'pt') return html;
  return html.replace(
    /TRANSCOR information is treated as operator-supported route orientation only: A PRASA does not infer official route geometry from stop lists\. For current schedules and live bus location by line, go directly to (<a[^>]*>)([^<]*)(<span aria-hidden="true">↗<\/span><\/a>)\./,
    (whole, openTag, anchorLabel, arrowClose) => {
      const fullPt = t('mindelo.guide.getting_around.body_1', 'pt');
      const linkPt = t('mindelo.guide.getting_around.link', 'pt');
      // Mid-sentence the link phrase is naturally lowercased ("...consulte
      // diretamente a página oficial Carreiras da TRANSCOR.") while the
      // standalone link-label key is capitalized as its own sentence
      // fragment — match case-insensitively but split on the sentence's
      // own casing so the surrounding PT text is untouched.
      const idx = fullPt.toLocaleLowerCase().indexOf(linkPt.toLocaleLowerCase());
      if (idx === -1) throw new Error(`getting_around link fixup: PT sentence does not contain PT link text "${linkPt}"`);
      const before = fullPt.slice(0, idx);
      const after = fullPt.slice(idx + linkPt.length);
      return `<!--i18n:skip-->${before}<!--/i18n:skip-->${openTag}<!--i18n:skip-->${linkPt} <!--/i18n:skip-->${arrowClose}<!--i18n:skip-->${after}<!--/i18n:skip-->`;
    }
  );
}

// "<span class=\"provider-name\">Medicentro</span><span class=\"provider-meta\">2 locations</span>"
// — the branch count is a runtime-agnostic template (ui.locations_count =
// "{count} locations"); the static page bakes in today's branch count per
// group the same way it already bakes in today's initial search-result
// count.
function applyLocationsCountFixup(html, locale) {
  if (locale !== 'pt') return html;
  const template = t('ui.locations_count', 'pt'); // "{count} localizações" (or similar)
  return html.replace(/<span class="provider-meta">(\d+) locations<\/span>/g, (whole, n) => `<span class="provider-meta"><!--i18n:skip-->${template.replace('{count}', n)}<!--/i18n:skip--></span>`);
}

// Provider/place identity is canonical and locale-independent — collected
// straight from the published directory records rather than duplicated
// into the locale overlay, matching how Things-to-Do never puts
// provider/location into its event.<id>.* keys either.
function collectCanonicalIdentityStrings() {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'mindelo-essentials', 'data', 'mindelo-essentials.json'), 'utf8'));
  const strings = new Set();
  for (const record of data.records) {
    if (record.publication_status !== 'published') continue;
    for (const field of ['name', 'location', 'provider', 'branch_label']) {
      if (record[field]) strings.add(record[field]);
    }
  }
  // Provider group header names shown once per grouped provider (Medicentro,
  // Alou, Simabo) — derived display names, not literal JSON field values.
  for (const name of ['Medicentro', 'Alou', 'Simabo']) strings.add(name);
  strings.add('Language / Idioma');
  return strings;
}

// Runtime strings mindelo-essentials.js needs at runtime (search result
// count pluralization, map guidance/fallback text, marker accessible-name
// templates) — embedded as a JSON island rather than hardcoded in the
// shared JS file, so the same script renders correct EN or PT text based
// on which page loaded it. The r3 delta governs the marker accessible-name
// templates and fallback names in full; the {name} placeholder is
// interpolated client-side by mindelo-essentials.js, never here.
function runtimeStringsScript(locale) {
  const strings = {
    searchCountOne: t('mindelo.search.result_count.one', locale),
    searchCountManyTemplate: t('mindelo.search.result_count.many', locale),
    mapEnhancedGuidance: t('mindelo.map.enhanced_guidance', locale),
    mapDefaultMarkerTitle: t('mindelo.map.default_marker_title', locale),
    markerOrientationAccessibleNameTemplate: t('mindelo.map.marker.orientation_accessible_name', locale),
    markerDirectoryAccessibleNameTemplate: t('mindelo.map.marker.directory_accessible_name', locale),
    markerOrientationDefaultName: t('mindelo.map.marker.orientation_default_name', locale),
    markerDirectoryDefaultName: t('mindelo.map.marker.directory_default_name', locale),
  };
  return `<script type="application/json" id="i18n-strings">${JSON.stringify(strings)}</script>`;
}

function injectRuntimeStrings(html, locale) {
  const script = runtimeStringsScript(locale);
  if (/id="i18n-strings"/.test(html)) {
    return html.replace(/<script type="application\/json" id="i18n-strings">.*?<\/script>/, script);
  }
  return html.replace(/(<script defer(?:="")? src="mindelo-essentials\.js"><\/script>)/, `${script}\n$1`);
}

// --- Locale-independent EN/PT search index (spec 12K) ---
//
// Deterministic normalization mirrored in mindelo-essentials.js: NFKD
// decompose, strip diacritics/punctuation, lowercase, collapse whitespace.
// No stemming/fuzzy matching/aliases — just enough that "farmacia"
// (no accent) finds "Farmácia", and an EN-locale user can find a record via
// its approved Portuguese category/type term and vice versa.
function normalizeToken(s) {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function buildSearchIndex() {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'mindelo-essentials', 'data', 'mindelo-essentials.json'), 'utf8'));
  const locale = JSON.parse(fs.readFileSync(path.join(root, 'data', 'locales', 'locale-data.generated.json'), 'utf8'));
  const categoryByEn = {};
  for (const row of Object.values(locale.keys)) {
    if (row.key.startsWith('mindelo.category.')) categoryByEn[row.en] = row.pt;
  }
  const index = {};
  for (const record of data.records) {
    if (record.publication_status !== 'published') continue;
    const typeLabelEn = locale.keys[`record.${record.id}.type_label`]?.en || record.context || '';
    const typeLabelPt = locale.keys[`record.${record.id}.type_label`]?.pt || typeLabelEn;
    const categoryPt = categoryByEn[record.category] || record.category;
    const parts = [record.name, record.location, record.provider, record.category, categoryPt, typeLabelEn, typeLabelPt];
    index[record.id] = normalizeToken(parts.filter(Boolean).join(' '));
  }
  return index;
}

function injectSearchIndex(html) {
  const index = buildSearchIndex();
  const script = `<script type="application/json" id="search-index">${JSON.stringify(index)}</script>`;
  if (/id="search-index"/.test(html)) {
    return html.replace(/<script type="application\/json" id="search-index">.*?<\/script>/, script);
  }
  return html.replace(/(<script type="application\/json" id="i18n-strings">.*?<\/script>)/, `$1\n${script}`);
}

let enSource = fs.readFileSync(enPath, 'utf8');
enSource = injectHeadLinks(enSource, { selfCanonical: canonicalEn, lang: 'en' });
enSource = injectRuntimeStrings(enSource, 'en');
enSource = injectSearchIndex(enSource);
enSource = injectLangSwitch(enSource, {
  enHref: '../mindelo-essentials/',
  ptHref: '../pt/mindelo-essentials/',
  locale: 'en',
});

let ptSource = injectHeadLinks(enSource, { selfCanonical: canonicalPt, lang: 'pt' });
ptSource = injectLangSwitch(ptSource, {
  enHref: '../../mindelo-essentials/',
  ptHref: '../mindelo-essentials/',
  locale: 'pt',
});
// assets/ and prasa-launch.* live at the true repo root, one directory
// above mindelo-essentials/ — from pt/mindelo-essentials/ (one directory
// deeper again) they need exactly one extra "../" hop, same rule as every
// other page. mindelo-essentials.css/.js are different: they live INSIDE
// mindelo-essentials/ itself, referenced here as bare filenames (same
// directory as this index.html) — from pt/mindelo-essentials/ that's not
// "one more ../", it's a full path back down into the sibling directory:
// ../../mindelo-essentials/mindelo-essentials.{css,js}.
ptSource = ptSource
  .replace(/((?:href|src)=")((?:\.\.\/)*)(assets\/|prasa-launch\.css|prasa-launch\.js)/g, (m, p1, ups, target) => `${p1}../${ups}${target}`)
  .replace(/((?:href|src)=")(mindelo-essentials\.(?:css|js))(")/g, (m, p1, target, p3) => `${p1}../../mindelo-essentials/${target}${p3}`);
ptSource = injectRuntimeStrings(ptSource, 'pt');
ptSource = injectSearchIndex(ptSource);
ptSource = applyGettingAroundLinkFixup(ptSource, 'pt');
ptSource = applyLocationsCountFixup(ptSource, 'pt');

const { html: rawLocalized, unmatchedEnglish } = localizeStaticHtml(ptSource, 'pt');
const localized = rawLocalized.replaceAll('<!--i18n:skip-->', '').replaceAll('<!--/i18n:skip-->', '');
const canonicalIdentity = collectCanonicalIdentityStrings();
const realGaps = unmatchedEnglish.filter((u) => !canonicalIdentity.has(u.text));

// Atomicity invariant: never write EN infrastructure (hreflang/lang-switch
// advertising a PT counterpart) unless the PT page itself actually
// generates. A blocked run leaves both files untouched on disk.
if (realGaps.length) {
  console.error(`[build-mindelo-pt] BLOCKED: ${realGaps.length} required English string(s) have no governed PT value — neither EN infrastructure nor PT page written:`);
  for (const g of realGaps) console.error(`  - [${g.where}] "${g.text}"`);
  process.exitCode = 1;
} else if (write) {
  fs.mkdirSync(path.dirname(enPath), { recursive: true });
  fs.writeFileSync(enPath, enSource);
  fs.mkdirSync(path.dirname(ptPath), { recursive: true });
  fs.writeFileSync(ptPath, localized);
  console.log(`[build-mindelo-pt] wrote mindelo-essentials/index.html (infra-updated) and pt/mindelo-essentials/index.html`);
} else {
  console.log(`[build-mindelo-pt] prepared: ${canonicalIdentity.size} canonical identity string(s) allowed, 0 gaps`);
}
