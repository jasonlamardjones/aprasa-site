#!/usr/bin/env node
// Regression guard for the defect where pt/index.html's generated Things-to-Do
// event regions ended up containing English presentation content — the
// static-page localizer deliberately passes those regions through
// unchanged (they're generate-things-to-do.mjs's territory), so a wrong
// pipeline order could silently leave English content committed there
// while every other locale-contract check (lang="pt", hreflang, etc.)
// still passed. This validator inspects the actual generated content of
// each event region, not just page-level metadata.
//
// For every current Things-to-Do record, it independently re-derives the
// expected PT presentation strings via the same governed locale keys the
// generator itself uses (scripts/lib/things-to-do-keys.mjs — shared, not
// duplicated, specifically to avoid the two derivations drifting apart),
// then requires each one to be present in that record's
// <!-- BEGIN/END GENERATED EVENT: <id> --> region of pt/index.html, and
// requires the corresponding EN value to be ABSENT wherever EN and PT
// differ (a preserved-identity field like an official event title is
// expected to be identical in both and is not checked for absence).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './lib/locale.mjs';
import { factKeyBase } from './lib/things-to-do-keys.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const events = JSON.parse(fs.readFileSync(path.join(root, 'data', 'things-to-do-events.json'), 'utf8')).records;
const homeHtml = fs.readFileSync(path.join(root, 'pt', 'index.html'), 'utf8');

const errors = [];

function extractRegion(recordId) {
  const begin = `<!-- BEGIN GENERATED EVENT: ${recordId} -->`;
  const end = `<!-- END GENERATED EVENT: ${recordId} -->`;
  const start = homeHtml.indexOf(begin);
  const stop = homeHtml.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return null;
  return homeHtml.slice(start + begin.length, stop);
}

function checkPair(recordId, field, region, enValue, ptValue) {
  if (!ptValue) {
    errors.push(`${recordId}: expected PT value for "${field}" is empty — cannot validate`);
    return;
  }
  if (!region.includes(ptValue)) {
    errors.push(`${recordId}: PT Home region missing expected PT "${field}": "${ptValue}"`);
  }
  // Skip the absence check when the EN string is itself a substring of the
  // correct PT string (e.g. EN "Artist" vs PT "Artista") — that's a false
  // positive, not a regression.
  if (enValue && enValue !== ptValue && !ptValue.includes(enValue) && region.includes(enValue)) {
    errors.push(`${recordId}: PT Home region still contains English "${field}": "${enValue}" (expected PT: "${ptValue}")`);
  }
}

// Chrome strings present on every card regardless of record content (same
// governed keys the generator uses). "Good to know" is checked separately
// below, only for records that actually have a good_to_know section.
const chromeChecks = [
  ['Details heading', t('things.shared.details_heading', 'en'), t('things.shared.details_heading', 'pt')],
  ['View page', t('ui.view_page', 'en'), t('ui.view_page', 'pt')],
];

let checkedRecords = 0;
for (const record of events) {
  const region = extractRegion(record.id);
  if (!region) {
    // Expired/unpublished records are legitimately absent from Home —
    // that's covered by the existing currentness validator, not this one.
    continue;
  }
  checkedRecords += 1;

  checkPair(record.id, 'title', region, t(`event.${record.id}.title`, 'en'), t(`event.${record.id}.title`, 'pt'));
  checkPair(record.id, 'display.status (date)', region, t(`event.${record.id}.display.status`, 'en'), t(`event.${record.id}.display.status`, 'pt'));
  checkPair(record.id, 'display.meta', region, t(`event.${record.id}.display.meta`, 'en'), t(`event.${record.id}.display.meta`, 'pt'));
  checkPair(record.id, 'display.checked (currentness)', region, t(`event.${record.id}.display.checked`, 'en'), t(`event.${record.id}.display.checked`, 'pt'));
  checkPair(record.id, 'detail.body', region, t(`event.${record.id}.detail.body`, 'en'), t(`event.${record.id}.detail.body`, 'pt'));
  checkPair(record.id, 'detail.checked', region, t(`event.${record.id}.detail.checked`, 'en'), t(`event.${record.id}.detail.checked`, 'pt'));

  if (record.card_action) {
    checkPair(record.id, 'card_action label', region, t(`event.${record.id}.card_action.label`, 'en'), t(`event.${record.id}.card_action.label`, 'pt'));
  }
  if (record.detail?.action_label) {
    checkPair(record.id, 'detail.action_label', region, t(`event.${record.id}.detail.action_label`, 'en'), t(`event.${record.id}.detail.action_label`, 'pt'));
  }
  if (record.detail?.good_to_know) {
    checkPair(record.id, 'detail.good_to_know', region, t(`event.${record.id}.detail.good_to_know`, 'en'), t(`event.${record.id}.detail.good_to_know`, 'pt'));
    checkPair(record.id, 'Good to know heading', region, t('ui.good_to_know', 'en'), t('ui.good_to_know', 'pt'));
  }

  for (const fact of record.detail?.facts || []) {
    const base = factKeyBase(record.id, fact);
    checkPair(record.id, `fact.${base}.label`, region, t(`event.${record.id}.detail.fact.${base}.label`, 'en'), t(`event.${record.id}.detail.fact.${base}.label`, 'pt'));
    if (!fact.value_html) {
      checkPair(record.id, `fact.${base}.value_display`, region, t(`event.${record.id}.detail.fact.${base}.value_display`, 'en'), t(`event.${record.id}.detail.fact.${base}.value_display`, 'pt'));
    }
  }

  for (const [field, enValue, ptValue] of chromeChecks) {
    checkPair(record.id, field, region, enValue, ptValue);
  }
}

if (checkedRecords === 0) {
  errors.push('no current generated event regions found in pt/index.html — nothing was validated (is pt/index.html generated?)');
}

if (errors.length) {
  console.error(`[validate-pt-home-events] FAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`[validate-pt-home-events] OK — ${checkedRecords} generated event region(s) on pt/index.html verified free of English presentation content.`);
