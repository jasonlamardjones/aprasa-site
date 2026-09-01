#!/usr/bin/env node
// Deterministic generator for the nine governed Home training records
// (Trainings, Tools & Opportunities) from canonical structured data.
//
// Phase T1 scope. This script exists, is proven equivalent to the committed
// hand-authored markup, and is idempotent — but it is deliberately NOT yet
// wired into scripts/build-all.mjs. Wiring it into the production pipeline
// (and refactoring the currentness / card-media validators around it) is T2
// work and is out of scope here.
//
// Source of truth chain (do not invert):
//   data/training-opportunities.json  — structure, identity, provenance, linkage
//   data/locales/locale-data.generated.json — every presentation string
//
// The data file carries NO copy of its own: every rendered string is a
// reference into the governed Project 09 overlay under the canonical
// training.record.<record_id>.<field> namespace (or a shared ui.* key, or an
// explicit locale-independent identity literal). That is what makes the EN
// and PT surfaces provably the same record rather than two hand-kept copies.
//
// Fail-closed contract: a missing mandatory PT value throws out of
// scripts/lib/locale.mjs rather than silently falling back to English, so a
// PT gap fails generation instead of shipping English copy on a PT page.
//
// Usage:
//   node scripts/generate-training-opportunities.mjs --locale=en|pt \
//        --as-of=YYYY-MM-DD [--home=<path>] [--write]
//
// Without --write the rendered regions are checked against the existing file
// and the script reports whether they already match (the drift check), so it
// is safe to run in CI as a read-only assertion.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './lib/locale.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const DATA_PATH = path.join(root, 'data', 'training-opportunities.json');
const DEFAULT_HOME = { en: 'index.html', pt: path.join('pt', 'index.html') };

function fail(msg) {
  console.error(`[generate-training-opportunities] FAIL: ${msg}`);
  process.exit(1);
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const locale = arg('locale');
if (locale !== 'en' && locale !== 'pt') fail('--locale=en|pt is required');

const asOf = arg('as-of');
if (!asOf) fail('--as-of=YYYY-MM-DD is required');
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) fail(`invalid --as-of date: ${asOf}`);

const homeRel = arg('home') || DEFAULT_HOME[locale];
const homePath = path.join(root, homeRel);
const write = process.argv.includes('--write');

// Shared assets live at the repository root, so a Home surface nested one
// directory down (pt/index.html) refers to them one level up. Derived from
// the surface's own depth rather than hardcoded per locale, matching how
// scripts/lib/asset-paths.mjs deepens shared paths for PT pages.
const depth = path.dirname(path.normalize(homeRel)).split(path.sep).filter((s) => s && s !== '.').length;
const assetPrefix = '../'.repeat(depth);

// --- string helpers -------------------------------------------------------

// Only & < > need re-encoding for HTML validity; curly quotes, dashes and
// accented characters ship as literal UTF-8, matching how the rest of these
// files already write accented text (São, praça, ...) and matching
// scripts/lib/static-page-transform.mjs's encodeMinimal exactly.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replaceAll('"', '&quot;');

/**
 * Resolve a presentation slot. A slot is either a governed locale key or an
 * explicit locale-independent identity literal (provider/place names that are
 * deliberately absent from the overlay). Anything else is a data defect.
 */
function text(slot, where) {
  if (slot == null) fail(`${where}: missing required presentation slot`);
  if (typeof slot.literal_identity === 'string') return slot.literal_identity;
  if (typeof slot.locale_key !== 'string') fail(`${where}: slot has neither locale_key nor literal_identity`);
  try {
    return t(slot.locale_key, locale);
  } catch (err) {
    fail(`${where}: ${err.message}`);
    return '';
  }
}

const EXTERNAL_MARKER = '<span aria-hidden="true">↗</span>';
const LINK_ATTRS = 'target="_blank" rel="noopener noreferrer"';

function attrString(attributes) {
  if (!attributes) return '';
  return Object.entries(attributes).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
}

function imgTag(media, where) {
  const values = {
    src: assetPrefix + media.asset,
    width: String(media.width),
    height: String(media.height),
    loading: media.loading,
    decoding: media.decoding,
    alt: text(media.alt, `${where} alt`),
  };
  const attrs = media.attribute_order
    .map((name) => {
      if (!(name in values)) fail(`${where}: unknown media attribute "${name}"`);
      return `${name}="${escAttr(values[name])}"`;
    })
    .join(' ');
  return `<img ${attrs}>`;
}

function mediaBlock(media, className, indent, where) {
  const img = imgTag(media, where);
  if (media.layout === 'inline') return [`${indent}<div class="${className}">${img}</div>`];
  if (media.layout !== 'block') fail(`${where}: unsupported media layout "${media.layout}"`);
  return [`${indent}<div class="${className}">`, `${indent}  ${img}`, `${indent}</div>`];
}

function actionTags(tags, indent, where) {
  if (!tags || !tags.length) return [];
  const spans = tags.map((tg, i) => `<span>${esc(text(tg, `${where} tag[${i}]`))}</span>`).join('');
  return [`${indent}<p class="action-tags">${spans}</p>`];
}

// --- rendering ------------------------------------------------------------

function renderCard(record) {
  const I = '          '; // 10 spaces — inside <article>
  const where = `record ${record.id} card`;
  const card = record.card;
  const lines = [];

  lines.push(`        <article class="resource-card"${attrString(card.attributes)}>`);
  if (record.media) lines.push(...mediaBlock(record.media, record.media.card_class, I, where));
  if (card.spotlight_label) lines.push(`${I}<p class="spotlight-label">${esc(text(card.spotlight_label, `${where} spotlight`))}</p>`);
  lines.push(...actionTags(card.action_tags, I, where));
  lines.push(`${I}<p class="card-status">${esc(text(card.status, `${where} status`))}</p>`);
  lines.push(`${I}<h3>${esc(text(card.title, `${where} title`))}</h3>`);
  if (card.meta) lines.push(`${I}<p class="card-meta">${esc(text(card.meta, `${where} meta`))}</p>`);
  lines.push(`${I}<p class="provider">${esc(record.provider)}</p>`);
  if (card.body) lines.push(`${I}<p>${esc(text(card.body, `${where} body`))}</p>`);
  lines.push(`${I}<p class="checked">${esc(text(card.checked, `${where} checked`))}</p>`);

  lines.push(`${I}<div class="card-actions">`);
  lines.push(`${I}  <button class="details-button" type="button" data-details>${esc(t('ui.details', locale))}</button>`);
  if (card.action) {
    const label = esc(text(card.action.label, `${where} action label`));
    lines.push(`${I}  <a class="resource-link" href="${escAttr(card.action.href)}" ${LINK_ATTRS}>${label} ${EXTERNAL_MARKER}</a>`);
  }
  lines.push(`${I}</div>`);

  lines.push(`${I}<template class="details-template">`);
  lines.push(`${I}  <div class="dialog-record">`);
  lines.push(...renderDetail(record));
  lines.push(`${I}  </div>`);
  lines.push(`${I}</template>`);
  lines.push('        </article>');
  return lines;
}

function renderDetail(record) {
  const I = '              '; // 14 spaces — inside <div class="dialog-record">
  const where = `record ${record.id} detail`;
  const d = record.detail;
  const lines = [];

  if (record.media) lines.push(...mediaBlock(record.media, record.media.detail_class, I, where));
  if (d.spotlight_label) lines.push(`${I}<p class="spotlight-label">${esc(text(d.spotlight_label, `${where} spotlight`))}</p>`);
  lines.push(...actionTags(d.action_tags, I, where));
  lines.push(`${I}<p class="provider">${esc(record.provider)}</p>`);
  lines.push(`${I}<h2>${esc(text(d.title, `${where} title`))}</h2>`);

  if (d.facts && d.facts.length) {
    lines.push(`${I}<dl class="detail-list">`);
    for (const [i, fact] of d.facts.entries()) {
      const label = esc(text(fact.label, `${where} fact[${i}] label`));
      const value = esc(text(fact.value, `${where} fact[${i}] value`));
      lines.push(`${I}  <div><dt>${label}</dt><dd>${value}</dd></div>`);
    }
    lines.push(`${I}</dl>`);
  }

  if (d.details_body) {
    lines.push(`${I}<h3>${esc(t('ui.details', locale))}</h3>`);
    lines.push(`${I}<p>${esc(text(d.details_body, `${where} details body`))}</p>`);
  }
  if (d.requirements) {
    lines.push(`${I}<h3>${esc(t('ui.requirements', locale))}</h3>`);
    lines.push(`${I}<p>${esc(text(d.requirements, `${where} requirements`))}</p>`);
  }
  if (d.original_posting) {
    const op = d.original_posting;
    lines.push(`${I}<h3>${esc(text(op.heading, `${where} original heading`))}</h3>`);
    for (const [i, para] of op.paragraphs.entries()) {
      lines.push(`${I}<p lang="${escAttr(op.lang)}">${esc(text(para, `${where} original[${i}]`))}</p>`);
    }
  }

  lines.push(`${I}<h3>${esc(t('ui.good_to_know', locale))}</h3>`);
  lines.push(`${I}<p>${esc(text(d.good_to_know, `${where} good to know`))}</p>`);
  lines.push(`${I}<p class="checked">${esc(text(d.checked, `${where} checked`))}</p>`);
  if (d.action) {
    const label = esc(text(d.action.label, `${where} action label`));
    lines.push(`${I}<a class="dialog-link" href="${escAttr(d.action.href)}" ${LINK_ATTRS}>${label} ${EXTERNAL_MARKER}</a>`);
  }
  return lines;
}

function renderRegion(record) {
  return [
    `        <!-- BEGIN GENERATED TRAINING: ${record.id} -->`,
    ...renderCard(record),
    `        <!-- END GENERATED TRAINING: ${record.id} -->`,
  ].join('\n');
}

// --- surface rewrite ------------------------------------------------------

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
if (data.version !== 1) fail(`unsupported data version ${data.version}`);

// Which publication states appear on the current surface, per the Project 03
// approved Home behavior. REVIEW-DUE is visible: review age alone never
// expires or removes a record, so a record awaiting human reverification keeps
// its existing approved presentation unchanged. Encoding that here is what
// lets publication_state carry the governance state without the generator
// silently dropping ownership of a still-published record.
const VISIBLE_STATES = new Set(['CURRENT', 'REVIEW-DUE']);
const REMOVED_STATES = new Set(['EXPIRED', 'WITHDRAWN', 'SUPERSEDED']);

// TEMPORARILY UNAVAILABLE is retained on the surface, but only with an
// explicitly approved unavailable status treatment. No such treatment is
// authorized in T1, so rather than render the record as though it were
// ordinary (asserting an availability nobody approved) or drop it (removing a
// record governance says to retain), generation fails closed until that
// treatment is approved.
for (const record of data.records) {
  const state = record.publication_state;
  if (VISIBLE_STATES.has(state) || REMOVED_STATES.has(state)) continue;
  if (state === 'TEMPORARILY UNAVAILABLE') {
    fail(`record ${record.id}: TEMPORARILY UNAVAILABLE has no approved status treatment in T1`);
  }
  fail(`record ${record.id}: unsupported publication_state "${state}"`);
}

const records = data.records.filter((r) => VISIBLE_STATES.has(r.publication_state));

let html;
try {
  html = fs.readFileSync(homePath, 'utf8');
} catch {
  fail(`Home surface not found: ${homeRel}`);
}

let out = html;
const missing = [];
const drifted = [];

for (const record of records) {
  const begin = `<!-- BEGIN GENERATED TRAINING: ${record.id} -->`;
  const end = `<!-- END GENERATED TRAINING: ${record.id} -->`;
  const startIdx = out.indexOf(begin);
  const endIdx = out.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    missing.push(record.id);
    continue;
  }
  // Re-anchor to the start of the marker's own indented line so the region
  // owns its full leading indentation and re-runs cannot drift it.
  const lineStart = out.lastIndexOf('\n', startIdx) + 1;
  const regionEnd = endIdx + end.length;
  const current = out.slice(lineStart, regionEnd);
  const rendered = renderRegion(record);
  if (current !== rendered) drifted.push(record.id);
  out = out.slice(0, lineStart) + rendered + out.slice(regionEnd);
}

if (missing.length) {
  fail(`${homeRel}: no generated-training markers for record(s): ${missing.join(', ')}`);
}

if (write) {
  if (out === html) {
    console.log(`[generate-training-opportunities] ${homeRel} (${locale}) already current as of ${asOf} — ${records.length} record(s), no change.`);
  } else {
    fs.writeFileSync(homePath, out);
    console.log(`[generate-training-opportunities] wrote ${homeRel} (${locale}) as of ${asOf} — ${records.length} record(s), ${drifted.length} region(s) updated.`);
  }
} else if (drifted.length) {
  console.error(`[generate-training-opportunities] DRIFT in ${homeRel} (${locale}) as of ${asOf}: ${drifted.join(', ')}`);
  console.error('Re-run with --write to regenerate these regions from data/training-opportunities.json.');
  process.exit(1);
} else {
  console.log(`[generate-training-opportunities] ${homeRel} (${locale}) matches generated output as of ${asOf} — ${records.length} record(s).`);
}
