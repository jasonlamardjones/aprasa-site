#!/usr/bin/env node
// Strict gate for the Things-to-Do collection hub in BOTH locales.
//
// scripts/validate-things-to-do-surface-equivalence.mjs polices what Home and
// the EN hub must contain and runs inside the Phase 2B bounded single-record
// repair lane, so it deliberately asserts hub membership only in the positive
// direction. This validator is the whole-collection gate: it runs after a full
// generator run and asserts the exact membership, ordering, locale
// completeness and metadata contract of both hub surfaces.
//
// It re-derives everything from canonical inputs — data/things-to-do-events.json
// plus the shared currentness and collection modules plus the governed locale
// overlay — and never from a second list of its own.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './lib/locale.mjs';
import { currentnessState, isExpired, isReviewDue, EXPIRED } from './lib/things-to-do-currentness.mjs';
import {
  HOME_PREVIEW_LIMIT,
  HUB_ROUTE,
  collectionRecords,
  homePreviewRecords,
  hubCanonical,
  hubOutputPath,
} from './lib/things-to-do-collection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const asOfArg = process.argv.find((arg) => arg.startsWith('--as-of='));
if (!asOfArg) {
  console.error('Missing required --as-of=YYYY-MM-DD');
  process.exit(1);
}
const asOf = asOfArg.split('=')[1];
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error(`Invalid --as-of date: ${asOf}`);
  process.exit(1);
}

const records = JSON.parse(fs.readFileSync(path.join(root, 'data', 'things-to-do-events.json'), 'utf8')).records ?? [];
const eligible = collectionRecords(records, asOf);
const preview = homePreviewRecords(records, asOf);
const errors = [];

function read(relative) {
  const file = path.join(root, relative);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// Card order on a hub page, read back from the rendered markup.
function renderedOrder(html) {
  return [...html.matchAll(/<article class="resource-card" data-event-id="([^"]+)"/g)].map((m) => m[1]);
}

// --- Home preview -----------------------------------------------------------
// Home shows exactly the approved preview: the first HOME_PREVIEW_LIMIT
// eligible records in canonical order, no more and no fewer.
for (const [locale, homeFile] of [['en', 'index.html'], ['pt', 'pt/index.html']]) {
  const html = read(homeFile);
  if (html === null) {
    errors.push(`${homeFile}: Home surface does not exist`);
    continue;
  }
  const order = renderedOrder(html);
  const expected = preview.map((record) => record.id);
  if (JSON.stringify(order) !== JSON.stringify(expected)) {
    errors.push(
      `${homeFile}: Home preview is [${order.join(', ')}] but the approved ${HOME_PREVIEW_LIMIT}-record preview as of ${asOf} is [${expected.join(', ')}]`
    );
  }
  if (order.length > HOME_PREVIEW_LIMIT) {
    errors.push(`${homeFile}: Home shows ${order.length} generated cards; the approved preview is at most ${HOME_PREVIEW_LIMIT}`);
  }
  // Home must offer the approved same-locale route into the full collection.
  const hubAction = t('home.things.hub_action', locale);
  if (!html.includes(hubAction)) {
    errors.push(`${homeFile}: approved hub call to action "${hubAction}" is missing`);
  }
  if (!html.includes('href="things-to-do/"')) {
    errors.push(`${homeFile}: hub call to action does not link to the same-locale collection route`);
  }
}

// --- Hub surfaces -----------------------------------------------------------
const renderedByLocale = {};

for (const locale of ['en', 'pt']) {
  const relative = hubOutputPath(locale);
  const html = read(relative);
  if (html === null) {
    errors.push(`${relative}: collection hub does not exist`);
    continue;
  }

  // Membership and ordering: exactly the eligible records, in canonical order.
  const order = renderedOrder(html);
  renderedByLocale[locale] = order;
  const expected = eligible.map((record) => record.id);
  if (JSON.stringify(order) !== JSON.stringify(expected)) {
    errors.push(`${relative}: hub membership/order is [${order.join(', ')}] but canonical eligible order as of ${asOf} is [${expected.join(', ')}]`);
  }

  // No expired record may be surfaced here, as filler or otherwise.
  for (const record of records) {
    if (!isExpired(record, asOf)) continue;
    if (order.includes(record.id)) errors.push(`${relative}: expired record ${record.id} is surfaced on the hub as of ${asOf}`);
  }

  // Empty state comes from canonical currentness output, and only then.
  const emptyState = t('things.hub.empty_state', locale);
  const hasEmptyState = html.includes(emptyState);
  if (eligible.length === 0 && !hasEmptyState) {
    errors.push(`${relative}: no eligible record as of ${asOf} but the approved empty state is not rendered`);
  }
  if (eligible.length > 0 && hasEmptyState) {
    errors.push(`${relative}: the empty state is rendered while ${eligible.length} record(s) are eligible as of ${asOf}`);
  }

  // Governed chrome copy, in this locale.
  for (const key of ['things.hub.h1', 'things.hub.intro', 'things.hub.boundary', 'things.hub.meta.title', 'things.hub.meta.description']) {
    const value = t(key, locale);
    if (!html.includes(value.replaceAll('&', '&amp;'))) {
      errors.push(`${relative}: governed ${locale.toUpperCase()} value for "${key}" is missing`);
    }
  }
  // Locale completeness: no English chrome may survive on the PT hub where the
  // governed EN and PT values actually differ.
  if (locale === 'pt') {
    for (const key of ['things.hub.h1', 'things.hub.intro', 'things.hub.boundary', 'things.hub.card_action.label', 'things.hub.meta.title', 'things.hub.meta.description', 'home.things.kicker']) {
      const en = t(key, 'en');
      const pt = t(key, 'pt');
      if (en !== pt && !pt.includes(en) && html.includes(en.replaceAll('&', '&amp;'))) {
        errors.push(`${relative}: PT hub still contains the English value for "${key}": "${en}"`);
      }
    }
  }

  // Per-record presentation is the governed event copy for this locale, reused
  // unchanged — the hub retranslates nothing.
  const cardAction = t('things.hub.card_action.label', locale);
  for (const record of eligible) {
    for (const suffix of ['title', 'display.status', 'display.meta', 'display.checked']) {
      const value = t(`event.${record.id}.${suffix}`, locale);
      if (!html.includes(value.replaceAll('&', '&amp;'))) {
        errors.push(`${relative}: ${record.id} is missing the governed ${locale.toUpperCase()} "${suffix}" value`);
      }
    }
    // Canonical provider identity is locale-independent and must be identical.
    if (!html.includes(record.provider)) errors.push(`${relative}: ${record.id} provider identity missing`);
    // Same-record, same-locale detail link, expressed as a bare child slug.
    const href = record.detail_page.replace(/^things-to-do\//, '');
    if (!html.includes(`<a class="resource-link" href="${href}">${cardAction}</a>`)) {
      errors.push(`${relative}: ${record.id} does not carry the approved hub CTA linking to its same-locale detail route`);
    }
    // The hub must not link out of its own locale.
    if (locale === 'en' && html.includes(`href="pt/`)) errors.push(`${relative}: EN hub links into the PT tree outside the language switch`);
    if (record.media?.asset && !html.includes(record.media.asset)) {
      errors.push(`${relative}: ${record.id} governed media asset is missing from its hub card`);
    }
  }

  // The hub must not become a second event-schema surface. Detail pages remain
  // the primary (and only) Event/ExhibitionEvent carriers.
  if (/"@type":\s*"(?:\w*Event)"/.test(html)) {
    errors.push(`${relative}: hub emits Event schema; detail pages are the event-schema surface`);
  }
  if (!/"@type":\s*"WebPage"/.test(html)) {
    errors.push(`${relative}: hub does not carry ordinary WebPage semantics`);
  }

  // Metadata / canonical / hreflang, consistent with the incumbent locale
  // architecture used by every other generated page.
  const expectations = [
    [`<html lang="${locale}">`, 'lang attribute'],
    [`<title>${t('things.hub.meta.title', locale).replaceAll('&', '&amp;')}</title>`, 'title'],
    [`<link rel="canonical" href="${hubCanonical(locale)}">`, 'self canonical'],
    [`<link rel="alternate" hreflang="en" href="${hubCanonical('en')}">`, 'hreflang en'],
    [`<link rel="alternate" hreflang="pt" href="${hubCanonical('pt')}">`, 'hreflang pt'],
    [`<link rel="alternate" hreflang="x-default" href="${hubCanonical('en')}">`, 'hreflang x-default'],
    [`<meta property="og:locale" content="${locale === 'pt' ? 'pt_PT' : 'en_US'}">`, 'og:locale'],
  ];
  for (const [needle, what] of expectations) {
    if (!html.includes(needle)) errors.push(`${relative}: incorrect or missing ${what}`);
  }

  // REVIEW_DUE preservation: a review-due record stays a normal public card.
  // No badge, no past-event label, and no new REVIEW_DUE copy is introduced.
  for (const record of records) {
    if (!isReviewDue(record, asOf)) continue;
    if (!order.includes(record.id)) errors.push(`${relative}: review-due record ${record.id} was dropped from the hub (review-due is not expired)`);
  }
  if (html.includes(t('ui.past_event', locale))) {
    errors.push(`${relative}: hub renders a past-event label; expired records are removed, never labelled here`);
  }
  if (/REVIEW.?DUE/i.test(html)) {
    errors.push(`${relative}: hub introduces REVIEW_DUE copy or a badge on a public surface`);
  }
}

// --- EN/PT record membership equivalence ------------------------------------
if (renderedByLocale.en && renderedByLocale.pt) {
  if (JSON.stringify(renderedByLocale.en) !== JSON.stringify(renderedByLocale.pt)) {
    errors.push(
      `EN and PT hubs do not present the same records in the same order: en=[${renderedByLocale.en.join(', ')}] pt=[${renderedByLocale.pt.join(', ')}]`
    );
  }
}

// --- Sitemap ----------------------------------------------------------------
{
  const sitemap = read('sitemap.xml');
  if (sitemap === null) errors.push('sitemap.xml does not exist');
  else {
    for (const locale of ['en', 'pt']) {
      if (!fs.existsSync(path.join(root, hubOutputPath(locale)))) continue;
      if (!sitemap.includes(`<loc>${hubCanonical(locale)}</loc>`)) {
        errors.push(`sitemap.xml is missing the ${locale.toUpperCase()} collection hub route ${hubCanonical(locale)}`);
      }
    }
  }
}

// --- Detail-page collection relationship ------------------------------------
// Each detail page's breadcrumb carries the governed collection label and
// RESOLVES to its own locale's collection route: EN -> /things-to-do/,
// PT -> /pt/things-to-do/. The resolved route is checked rather than the
// literal href, so the assertion holds whatever relative form is emitted and
// catches a link that leaves the locale or points back at a Home fragment.
for (const record of records) {
  for (const [locale, prefix] of [['en', ''], ['pt', 'pt/']]) {
    const relative = `${prefix}${record.detail_page}index.html`;
    const html = read(relative);
    if (html === null) continue;
    const label = t('things.shared.back_to_things', locale);
    const match = html.match(/<nav class="breadcrumb"[\s\S]*?<a href="([^"]+)">([^<]*)<\/a>/);
    if (!match) {
      errors.push(`${relative}: no breadcrumb collection control found`);
      continue;
    }
    const [, href, text] = match;
    if (text !== label) {
      errors.push(`${relative}: breadcrumb label is ${JSON.stringify(text)}, expected the governed ${locale.toUpperCase()} collection label ${JSON.stringify(label)}`);
    }
    if (href.includes('#')) {
      errors.push(`${relative}: breadcrumb points at a fragment (${href}) instead of the collection route`);
      continue;
    }
    const resolved = `/${path.relative(root, path.resolve(path.dirname(path.join(root, relative)), href))}/`.replace(/\/+$/, '/');
    const expected = `/${prefix}${HUB_ROUTE}`;
    if (resolved !== expected) {
      errors.push(`${relative}: breadcrumb resolves to ${resolved}, expected the same-locale collection route ${expected}`);
    }
  }
}

if (errors.length) {
  console.error(`[validate-things-to-do-hub] FAILED with ${errors.length} error(s) as of ${asOf}:`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

const reviewDue = records.filter((record) => isReviewDue(record, asOf)).length;
const expired = records.filter((record) => currentnessState(record, asOf) === EXPIRED).length;
console.log(
  `[validate-things-to-do-hub] OK as of ${asOf} — ${eligible.length} eligible record(s) on both hubs`
  + ` (${reviewDue} review-due, ${expired} expired and absent), ${preview.length} on the Home preview.`
);
