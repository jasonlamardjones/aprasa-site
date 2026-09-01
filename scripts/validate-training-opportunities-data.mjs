#!/usr/bin/env node
// Phase T1 integrity validator for data/training-opportunities.json.
//
// Deliberately narrow. This checks that the structured training foundation is
// internally sound and fully resolvable against the governed locale overlay
// and the media manifest. It is NOT the currentness system: it never decides
// whether a record should still be on Home, and it never infers expiry from a
// stale checked_at date. Lifecycle-driven surface removal, the build-all
// refactor and the card-media/currentness validator rework are T2 work.
//
// Usage: node scripts/validate-training-opportunities-data.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocaleData } from './lib/locale.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const DATA_PATH = path.join(root, 'data', 'training-opportunities.json');
const MANIFEST_PATH = path.join(root, 'internal', 'provider-media-manifest.json');

// Project 03 approved lifecycle classes and publication states. A value
// outside these sets is a governance error, not a typo to be tolerated.
const LIFECYCLE_CLASSES = new Set([
  'evergreen-learning-resource',
  'institutional-training-catalog',
  'fixed-window-opportunity',
  'rolling-opportunity',
  'recurring-opportunity',
]);
const PUBLICATION_STATES = new Set([
  'CURRENT',
  'REVIEW-DUE',
  'EXPIRED',
  'WITHDRAWN',
  'SUPERSEDED',
  'TEMPORARILY UNAVAILABLE',
]);

const MEDIA_LAYOUTS = new Set(['block', 'inline']);
const MEDIA_ATTRS = new Set(['src', 'alt', 'loading', 'decoding', 'width', 'height']);

const errors = [];
const fail = (msg) => errors.push(msg);

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const manifestTitles = new Set(manifest.records.map((r) => r.title));
const locale = loadLocaleData();

// --- document shape -------------------------------------------------------
if (data.version !== 1) fail(`version must be 1, got ${JSON.stringify(data.version)}`);
if (data.schema !== 'aprasa.training-opportunities.v1') fail(`unexpected schema id ${JSON.stringify(data.schema)}`);
if (!Array.isArray(data.records) || data.records.length === 0) fail('records[] must be a non-empty array');
if (!Array.isArray(data.lifecycle_classes)) fail('lifecycle_classes[] is required');
else {
  for (const cls of data.lifecycle_classes) {
    if (!LIFECYCLE_CLASSES.has(cls)) fail(`declared lifecycle class "${cls}" is not a Project 03 approved class`);
  }
  for (const cls of LIFECYCLE_CLASSES) {
    if (!data.lifecycle_classes.includes(cls)) fail(`approved lifecycle class "${cls}" is missing from lifecycle_classes[]`);
  }
}
if (!data.publication_states || typeof data.publication_states !== 'object') fail('publication_states is required');
else {
  for (const state of Object.keys(data.publication_states)) {
    if (!PUBLICATION_STATES.has(state)) fail(`declared publication state "${state}" is not a Project 03 approved state`);
  }
  for (const state of PUBLICATION_STATES) {
    if (!(state in data.publication_states)) fail(`approved publication state "${state}" is missing from publication_states`);
  }
}

/**
 * Every rendered string must resolve to a governed overlay key with a usable
 * PT value, or be an explicit locale-independent identity literal. This is the
 * data-side half of the generator's fail-closed contract: a PT gap is caught
 * here as a data defect rather than only at generation time.
 */
function checkSlot(slot, where, recordId) {
  if (slot == null) return;
  if (typeof slot !== 'object') return fail(`${where}: presentation slot must be an object`);

  if (typeof slot.literal_identity === 'string') {
    if (!slot.literal_identity.trim()) fail(`${where}: literal_identity is empty`);
    if ('locale_key' in slot) fail(`${where}: slot declares both locale_key and literal_identity`);
    return;
  }
  const key = slot.locale_key;
  if (typeof key !== 'string' || !key.trim()) return fail(`${where}: slot has neither locale_key nor literal_identity`);

  const row = locale.keys[key];
  if (!row) return fail(`${where}: locale key "${key}" is not present in the governed overlay`);
  if (typeof row.en !== 'string' || row.en === '') fail(`${where}: locale key "${key}" has no English source value`);
  if (row.scope_status !== 'INTENTIONALLY_UNCHANGED' && (row.pt == null || row.pt === '')) {
    fail(`${where}: locale key "${key}" is missing its mandatory governed Portuguese value`);
  }
  if (row.translation_status !== 'APPROVED') {
    fail(`${where}: locale key "${key}" is not APPROVED (status: ${row.translation_status})`);
  }

  // Canonical-namespace guard. A record-scoped key must live under
  // training.record.<this record>.*, never under the retired
  // home.training.record.* namespace and never under another record's keys.
  if (key.startsWith('home.training.record.')) {
    fail(`${where}: locale key "${key}" still uses the retired home.training.record.* namespace`);
  }
  if (key.startsWith('training.record.') && !key.startsWith(`training.record.${recordId}.`)) {
    fail(`${where}: locale key "${key}" belongs to another record`);
  }
}

function checkAction(action, where, recordId) {
  if (action == null) return;
  if (typeof action.href !== 'string' || !/^https:\/\//.test(action.href)) {
    fail(`${where}: action href must be an absolute https URL, got ${JSON.stringify(action.href)}`);
  }
  checkSlot(action.label, `${where} label`, recordId);
}

function checkTags(tags, where, recordId) {
  if (tags == null) return;
  if (!Array.isArray(tags) || tags.length === 0) return fail(`${where}: action_tags must be null or a non-empty array`);
  tags.forEach((tag, i) => checkSlot(tag, `${where}[${i}]`, recordId));
}

// --- records --------------------------------------------------------------
const seenIds = new Set();

for (const [index, record] of (data.records ?? []).entries()) {
  const id = record.id;
  const where = `record[${index}]${typeof id === 'string' ? ` (${id})` : ''}`;

  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    fail(`${where}: id must be a lowercase slug`);
    continue;
  }
  if (seenIds.has(id)) fail(`${where}: duplicate record id "${id}"`);
  seenIds.add(id);

  if (!LIFECYCLE_CLASSES.has(record.lifecycle_class)) {
    fail(`${where}: invalid lifecycle_class ${JSON.stringify(record.lifecycle_class)}`);
  }
  if (!PUBLICATION_STATES.has(record.publication_state)) {
    fail(`${where}: invalid publication_state ${JSON.stringify(record.publication_state)}`);
  }
  if (typeof record.provider !== 'string' || !record.provider.trim()) {
    fail(`${where}: provider identity is required`);
  }

  // Dates. checked_at is provenance, never an expiry signal: a stale
  // checked_at is explicitly NOT an error here (Project 03 governance).
  if (!isIsoDate(record.checked_at)) {
    fail(`${where}: checked_at must be a valid YYYY-MM-DD date, got ${JSON.stringify(record.checked_at)}`);
  }
  // end_date is supported only where the lifecycle class actually has a
  // governed window. Carrying one anywhere else would invite exactly the
  // inference Project 03 forbids — deducing rolling/expiry status from the
  // presence or absence of a deadline.
  if (record.lifecycle_class === 'fixed-window-opportunity') {
    if (!isIsoDate(record.end_date)) fail(`${where}: fixed-window-opportunity requires a valid end_date`);
  } else if (record.end_date != null) {
    fail(`${where}: end_date is only supported for fixed-window-opportunity, not ${record.lifecycle_class}`);
  }

  if (!record.source || typeof record.source !== 'object') {
    fail(`${where}: source/provenance block is required`);
  } else {
    const { source_url: url, provenance } = record.source;
    if (url != null && !/^https?:\/\//.test(url)) fail(`${where}: source_url must be absolute or null, got ${JSON.stringify(url)}`);
    if (typeof provenance !== 'string' || !provenance.trim()) fail(`${where}: source.provenance is required`);
  }

  // Media linkage.
  if (record.media_manifest_title != null && !manifestTitles.has(record.media_manifest_title)) {
    fail(`${where}: media_manifest_title ${JSON.stringify(record.media_manifest_title)} has no entry in internal/provider-media-manifest.json`);
  }
  if (record.media) {
    const m = record.media;
    const mw = `${where} media`;
    if (typeof m.asset !== 'string' || !m.asset) fail(`${mw}: asset path is required`);
    else if (!fs.existsSync(path.join(root, m.asset))) fail(`${mw}: asset "${m.asset}" does not exist in the repository`);
    for (const dim of ['width', 'height']) {
      if (!Number.isInteger(m[dim]) || m[dim] <= 0) fail(`${mw}: ${dim} must be a positive integer`);
    }
    if (!MEDIA_LAYOUTS.has(m.layout)) fail(`${mw}: unsupported layout ${JSON.stringify(m.layout)}`);
    if (typeof m.card_class !== 'string' || !m.card_class) fail(`${mw}: card_class is required`);
    if (typeof m.detail_class !== 'string' || !m.detail_class) fail(`${mw}: detail_class is required`);
    if (!Array.isArray(m.attribute_order) || m.attribute_order.length !== MEDIA_ATTRS.size) {
      fail(`${mw}: attribute_order must list all ${MEDIA_ATTRS.size} img attributes`);
    } else {
      const seenAttrs = new Set();
      for (const attr of m.attribute_order) {
        if (!MEDIA_ATTRS.has(attr)) fail(`${mw}: unknown img attribute "${attr}" in attribute_order`);
        if (seenAttrs.has(attr)) fail(`${mw}: duplicate img attribute "${attr}" in attribute_order`);
        seenAttrs.add(attr);
      }
    }
    if (record.media_manifest_title == null) fail(`${mw}: a record that renders media must declare media_manifest_title`);
    checkSlot(m.alt, `${mw} alt`, id);
  }

  // Card presentation.
  const card = record.card;
  if (!card || typeof card !== 'object') {
    fail(`${where}: card block is required`);
  } else {
    const cw = `${where} card`;
    for (const required of ['status', 'title', 'checked']) {
      if (!card[required]) fail(`${cw}: ${required} is required`);
      checkSlot(card[required], `${cw} ${required}`, id);
    }
    for (const optional of ['spotlight_label', 'meta', 'body']) checkSlot(card[optional], `${cw} ${optional}`, id);
    checkTags(card.action_tags, `${cw} action_tags`, id);
    checkAction(card.action, `${cw} action`, id);
    if (card.attributes != null) {
      if (typeof card.attributes !== 'object' || Array.isArray(card.attributes)) fail(`${cw}: attributes must be an object`);
      else {
        for (const [name, value] of Object.entries(card.attributes)) {
          if (!/^data-[a-z0-9-]+$/.test(name)) fail(`${cw}: attribute "${name}" must be a data-* attribute`);
          if (typeof value !== 'string' || !value) fail(`${cw}: attribute "${name}" must have a non-empty string value`);
        }
      }
    }
  }

  // Detail (dialog) presentation.
  const detail = record.detail;
  if (!detail || typeof detail !== 'object') {
    fail(`${where}: detail block is required`);
  } else {
    const dw = `${where} detail`;
    for (const required of ['title', 'good_to_know', 'checked']) {
      if (!detail[required]) fail(`${dw}: ${required} is required`);
      checkSlot(detail[required], `${dw} ${required}`, id);
    }
    for (const optional of ['spotlight_label', 'details_body', 'requirements']) {
      checkSlot(detail[optional], `${dw} ${optional}`, id);
    }
    checkTags(detail.action_tags, `${dw} action_tags`, id);
    checkAction(detail.action, `${dw} action`, id);

    if (detail.facts != null) {
      if (!Array.isArray(detail.facts) || detail.facts.length === 0) fail(`${dw}: facts must be null or a non-empty array`);
      else {
        detail.facts.forEach((fact, i) => {
          checkSlot(fact?.label, `${dw} fact[${i}] label`, id);
          checkSlot(fact?.value, `${dw} fact[${i}] value`, id);
        });
      }
    }
    if (detail.original_posting != null) {
      const op = detail.original_posting;
      checkSlot(op.heading, `${dw} original_posting heading`, id);
      if (typeof op.lang !== 'string' || !/^[a-z]{2}$/.test(op.lang)) fail(`${dw} original_posting: lang must be a 2-letter code`);
      if (!Array.isArray(op.paragraphs) || op.paragraphs.length === 0) fail(`${dw} original_posting: paragraphs must be a non-empty array`);
      else op.paragraphs.forEach((p, i) => checkSlot(p, `${dw} original_posting paragraph[${i}]`, id));
    }

    // A detail dialog must actually say something beyond its heading: at
    // least one substantive section has to be present.
    const hasSubstance = Boolean(detail.details_body || detail.requirements || detail.original_posting || (detail.facts && detail.facts.length));
    if (!hasSubstance) fail(`${dw}: dialog has no facts, details body, requirements or original posting`);
  }
}

if (errors.length) {
  console.error('Training opportunities structured-data errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const byClass = {};
for (const record of data.records) byClass[record.lifecycle_class] = (byClass[record.lifecycle_class] ?? 0) + 1;
const summary = Object.entries(byClass).map(([k, v]) => `${k}=${v}`).join(', ');
console.log(`Training opportunities structured-data validation passed: ${data.records.length} record(s) (${summary}).`);
