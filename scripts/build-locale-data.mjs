#!/usr/bin/env node
// Normalizes the governed Project 09 PT overlay export into
// data/locales/locale-data.generated.json, preserving provenance.
//
// Source of truth: data/locales/pt-overlay-r2.source.json (raw governed r2
// export, 732 rows) PLUS data/locales/pt-overlay-r3-delta.source.json (the
// r3 additive delta, 21 rows) PLUS data/locales/pt-overlay-r4-delta.source.json
// (the r4 additive delta, 26 rows, adding the two EMAR / Kre+ opportunity
// records) merged on top, in order. The r2->r5 deltas are strictly additive:
// every r3/r4/r5 key must be new, never an existing key from an earlier
// revision — none of those deltas is authorized to reopen or replace an
// earlier approved value.
//
// data/locales/pt-overlay-r8-delta.source.json continues the additive chain on
// top of r7, adding the 21 rows for the same-day PART_ILHAS / Artemisa Ferreira
// dated event (13 record-level keys plus two keys for each of its four detail
// facts). Strictly additive, applied last.
//
// data/locales/pt-overlay-r7-delta.source.json continues the additive chain on
// top of r6, adding the 19 rows for the single governed Simabo Organizations &
// Ways to Help record. Like r3/r4/r5 it is strictly additive and is applied
// after r6 so it cannot be silently reverted by the brand-voice override.
//
// data/locales/pt-overlay-r9-delta.source.json is a THIRD class again:
// revision_class "OVERRIDE_EXISTING_KEYS_WITH_SOURCE_CORRECTION". r6 reopens
// approved PT wording while holding the English source immutable, which is
// right for a brand-voice pass but structurally unable to carry a correction
// where the underlying FACT changed. r9 exists for that case: Project 03 ruled
// on 01 September 2026 that Sinergia da Matéria's governed 31 July - 31 August
// 2026 date meaning is superseded by authoritative CNAD evidence, so both the
// English source value and its PT translation must move together, and the
// change is openly semantic.
//
// Because it can rewrite approved English, its guard is the strictest of the
// three. Every row must name its target key, declare byte-exact old_en AND
// old_pt that match the currently effective values, supply both replacements,
// and carry the full authorization chain (semantic_change,
// source_correction_authorized, owning_project, superseding_ruling). Any
// missing link, any drift, any undeclared key, or any attempt to introduce a
// new key fails the build. It is deliberately NOT a general rewrite lane: the
// additive guards and r6 are untouched by it.
//
// data/locales/pt-overlay-r6-delta.source.json is the one exception, and it is
// a different class of revision: revision_class "OVERRIDE_EXISTING_KEYS". It
// carries the governed Project 09 package P09-PT-BRAND-VOICE-2026-08-26-v1, a
// Portuguese-only brand-voice refinement that deliberately restates the PT
// value of 42 keys that already exist in the r1/r2 baseline. It introduces no
// new keys and changes no English source value. Because it reopens approved PT
// values, its guard is the strict inverse of the additive guard and is
// tighter: every r6 key MUST already exist, and its declared old_pt MUST match
// the currently effective PT value byte-for-byte before the new_pt is written.
// Any drift fails the build rather than silently overwriting.
// This script performs no translation and no wording changes — it only
// reshapes and merges the row lists into a keyed lookup table for
// scripts/lib/locale.mjs.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SOURCE_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r2.source.json");
const DELTA_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r3-delta.source.json");
const DELTA4_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r4-delta.source.json");
const DELTA5_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r5-delta.source.json");
const DELTA6_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r6-delta.source.json");
const DELTA7_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r7-delta.source.json");
const DELTA8_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r8-delta.source.json");
const DELTA9_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r9-delta.source.json");
const R10_MIGRATION_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r10-migration.source.json");
const DELTA13_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r13-things-to-do-hub.source.json");
const DELTA14_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r14-section-fallback-note.source.json");
const DELTA15_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r15-weekly-opportunity-2026-09.source.json");
const DELTA16_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r16-provider-media-alt.source.json");
const DELTA17_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r17-runtime-whatsapp-launcher.source.json");
const DELTA18_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r18-ui-scroll-down.source.json");
const DELTA19_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r19-runtime-whatsapp-prefill.source.json");
const DELTA20_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r20-start-cv-learning-spotlight.source.json");
const DELTA21_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r21-privacy-link.source.json");
const DELTA22_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r22-lang-switch-note.source.json");
const DELTA23_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r23-mindelo-fragata-selected-branches.source.json");
const DELTA25_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r25-trainings-home-expansion-timbuktoo.source.json");
const DELTA26_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r26-trainings-home-expansion-edtech.source.json");
const LOCALE_DIR = path.join(ROOT, "data", "locales");
const OUT_PATH = path.join(ROOT, "data", "locales", "locale-data.generated.json");

const EXPECTED = {
  source_revision: "P03-PT-SOURCE-2026-08-25-r2",
  total_rows: 732,
  required_for_pt_launch: 705,
  intentionally_unchanged: 27,
  approved_rows_total: 732,
  missing_pt_values_in_supplied_required_rows: 0,
  duplicate_keys: 0,
};

const EXPECTED_DELTA = {
  source_revision: "P03-PT-SOURCE-2026-08-25-r3",
  previous_revision: "P03-PT-SOURCE-2026-08-25-r2",
  row_count: 21,
  approved: 21,
  required_for_pt_launch: 20,
  intentionally_unchanged: 1,
  review_required: 0,
};

function fail(msg) {
  console.error(`[build-locale-data] FAIL: ${msg}`);
  process.exit(1);
}

const source = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
const { package: pkg, qa_summary, rows } = source;

if (pkg.source_revision !== EXPECTED.source_revision) {
  fail(`source_revision mismatch: got "${pkg.source_revision}", expected "${EXPECTED.source_revision}"`);
}
if (rows.length !== EXPECTED.total_rows) {
  fail(`row count mismatch: got ${rows.length}, expected ${EXPECTED.total_rows}`);
}
if (qa_summary.required_for_pt_launch !== EXPECTED.required_for_pt_launch) {
  fail(`required_for_pt_launch mismatch: got ${qa_summary.required_for_pt_launch}`);
}
if (qa_summary.intentionally_unchanged !== EXPECTED.intentionally_unchanged) {
  fail(`intentionally_unchanged mismatch: got ${qa_summary.intentionally_unchanged}`);
}
if (qa_summary.approved_rows_total !== EXPECTED.approved_rows_total) {
  fail(`approved_rows_total mismatch: got ${qa_summary.approved_rows_total}`);
}
if (qa_summary.missing_pt_values_in_supplied_required_rows !== 0) {
  fail(`missing_pt_values_in_supplied_required_rows is non-zero: ${qa_summary.missing_pt_values_in_supplied_required_rows}`);
}
if (qa_summary.duplicate_keys !== 0) {
  fail(`duplicate_keys is non-zero: ${qa_summary.duplicate_keys}`);
}
if (qa_summary.a_prasa_to_a_praca_violations !== 0) {
  fail(`a_prasa_to_a_praca_violations is non-zero: ${qa_summary.a_prasa_to_a_praca_violations}`);
}

const keys = {};
const seen = new Set();
for (const row of rows) {
  if (seen.has(row.key)) fail(`duplicate key detected during normalization: ${row.key}`);
  seen.add(row.key);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (row.translation_status !== "APPROVED") {
    fail(`key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  }
  // Brand-name violation ("A PRASA" localized to "A PRAÇA") is verified via
  // qa_summary.a_prasa_to_a_praca_violations above, which the overlay itself
  // computes with full context; a naive text scan here would false-positive
  // on the ordinary Portuguese word "praça" ("square") used generically.

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

// --- r3 delta: additive merge on top of the r2 base above ---
const delta = JSON.parse(readFileSync(DELTA_PATH, "utf8"));

if (delta.source_revision !== EXPECTED_DELTA.source_revision) {
  fail(`r3 source_revision mismatch: got "${delta.source_revision}", expected "${EXPECTED_DELTA.source_revision}"`);
}
if (delta.previous_revision !== EXPECTED_DELTA.previous_revision) {
  fail(`r3 previous_revision mismatch: got "${delta.previous_revision}", expected "${EXPECTED_DELTA.previous_revision}"`);
}
if (delta.rows.length !== EXPECTED_DELTA.row_count) {
  fail(`r3 row count mismatch: got ${delta.rows.length}, expected ${EXPECTED_DELTA.row_count}`);
}
if (delta.supplied_rows_approved !== EXPECTED_DELTA.approved) {
  fail(`r3 supplied_rows_approved mismatch: got ${delta.supplied_rows_approved}`);
}
if (delta.review_required !== EXPECTED_DELTA.review_required) {
  fail(`r3 review_required is non-zero: ${delta.review_required}`);
}
if (delta.missing_or_unaccounted_row_count !== 0) {
  fail(`r3 missing_or_unaccounted_row_count is non-zero: ${delta.missing_or_unaccounted_row_count}`);
}
if ((delta.duplicate_keys || []).length !== 0) {
  fail(`r3 duplicate_keys is non-empty: ${JSON.stringify(delta.duplicate_keys)}`);
}
if ((delta.placeholder_mismatches || []).length !== 0) {
  fail(`r3 placeholder_mismatches is non-empty: ${JSON.stringify(delta.placeholder_mismatches)}`);
}
if ((delta.a_prasa_to_a_praca_violations || []).length !== 0) {
  fail(`r3 a_prasa_to_a_praca_violations is non-empty: ${JSON.stringify(delta.a_prasa_to_a_praca_violations)}`);
}
if (delta.packaging_correction?.change_control_status?.existing_r2_keys_modified !== 0) {
  fail(`r3 existing_r2_keys_modified is non-zero`);
}
if (delta.packaging_correction?.change_control_status?.existing_r2_portuguese_values_reopened !== 0) {
  fail(`r3 existing_r2_portuguese_values_reopened is non-zero`);
}
if (delta.packaging_correction?.change_control_status?.additional_languages_authorized !== 0) {
  fail(`r3 additional_languages_authorized is non-zero`);
}

let deltaRequired = 0;
let deltaUnchanged = 0;
for (const row of delta.rows) {
  if (seen.has(row.key)) {
    fail(`r3 key "${row.key}" collides with an existing r1/r2 key — r3 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") deltaRequired += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") deltaUnchanged += 1;

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r3 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (row.translation_status !== "APPROVED") {
    fail(`r3 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  }
  // Placeholder preservation: a key whose EN value contains a "{...}"
  // template placeholder must preserve the exact same placeholder(s) in PT.
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r3 key "${row.key}" placeholder mismatch: en=${JSON.stringify(enPlaceholders)} pt=${JSON.stringify(ptPlaceholders)}`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (deltaRequired !== EXPECTED_DELTA.required_for_pt_launch) {
  fail(`r3 required_for_pt_launch mismatch: got ${deltaRequired}, expected ${EXPECTED_DELTA.required_for_pt_launch}`);
}
if (deltaUnchanged !== EXPECTED_DELTA.intentionally_unchanged) {
  fail(`r3 intentionally_unchanged mismatch: got ${deltaUnchanged}, expected ${EXPECTED_DELTA.intentionally_unchanged}`);
}

// --- r4 delta: additive merge on top of the r2+r3 base above ---
const EXPECTED_DELTA4 = {
  source_revision: "P03-PT-SOURCE-2026-08-25-r4",
  previous_revision: "P03-PT-SOURCE-2026-08-25-r3",
  row_count: 26,
  approved: 26,
  required_for_pt_launch: 26,
  intentionally_unchanged: 0,
  review_required: 0,
};

const delta4 = JSON.parse(readFileSync(DELTA4_PATH, "utf8"));

if (delta4.source_revision !== EXPECTED_DELTA4.source_revision) {
  fail(`r4 source_revision mismatch: got "${delta4.source_revision}", expected "${EXPECTED_DELTA4.source_revision}"`);
}
if (delta4.previous_revision !== EXPECTED_DELTA4.previous_revision) {
  fail(`r4 previous_revision mismatch: got "${delta4.previous_revision}", expected "${EXPECTED_DELTA4.previous_revision}"`);
}
if (delta4.rows.length !== EXPECTED_DELTA4.row_count) {
  fail(`r4 row count mismatch: got ${delta4.rows.length}, expected ${EXPECTED_DELTA4.row_count}`);
}
if (delta4.supplied_rows_approved !== EXPECTED_DELTA4.approved) {
  fail(`r4 supplied_rows_approved mismatch: got ${delta4.supplied_rows_approved}`);
}
if (delta4.review_required !== EXPECTED_DELTA4.review_required) {
  fail(`r4 review_required is non-zero: ${delta4.review_required}`);
}
if (delta4.missing_or_unaccounted_row_count !== 0) {
  fail(`r4 missing_or_unaccounted_row_count is non-zero: ${delta4.missing_or_unaccounted_row_count}`);
}
if ((delta4.duplicate_keys || []).length !== 0) {
  fail(`r4 duplicate_keys is non-empty: ${JSON.stringify(delta4.duplicate_keys)}`);
}
if ((delta4.placeholder_mismatches || []).length !== 0) {
  fail(`r4 placeholder_mismatches is non-empty: ${JSON.stringify(delta4.placeholder_mismatches)}`);
}
if ((delta4.a_prasa_to_a_praca_violations || []).length !== 0) {
  fail(`r4 a_prasa_to_a_praca_violations is non-empty: ${JSON.stringify(delta4.a_prasa_to_a_praca_violations)}`);
}

let delta4Required = 0;
let delta4Unchanged = 0;
for (const row of delta4.rows) {
  if (seen.has(row.key)) {
    fail(`r4 key "${row.key}" collides with an existing r1/r2/r3 key — r4 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta4Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta4Unchanged += 1;

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r4 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (row.translation_status !== "APPROVED") {
    fail(`r4 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  }
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r4 key "${row.key}" placeholder mismatch: en=${JSON.stringify(enPlaceholders)} pt=${JSON.stringify(ptPlaceholders)}`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta4Required !== EXPECTED_DELTA4.required_for_pt_launch) {
  fail(`r4 required_for_pt_launch mismatch: got ${delta4Required}, expected ${EXPECTED_DELTA4.required_for_pt_launch}`);
}
if (delta4Unchanged !== EXPECTED_DELTA4.intentionally_unchanged) {
  fail(`r4 intentionally_unchanged mismatch: got ${delta4Unchanged}, expected ${EXPECTED_DELTA4.intentionally_unchanged}`);
}

// --- r5 delta: additive merge on top of the r2+r3+r4 base above ---
const EXPECTED_DELTA5 = {
  source_revision: "P03-PT-SOURCE-2026-08-25-r5",
  previous_revision: "P03-PT-SOURCE-2026-08-25-r4",
  row_count: 2,
  approved: 2,
  required_for_pt_launch: 2,
  intentionally_unchanged: 0,
  review_required: 0,
};

const delta5 = JSON.parse(readFileSync(DELTA5_PATH, "utf8"));

if (delta5.source_revision !== EXPECTED_DELTA5.source_revision) {
  fail(`r5 source_revision mismatch: got "${delta5.source_revision}", expected "${EXPECTED_DELTA5.source_revision}"`);
}
if (delta5.previous_revision !== EXPECTED_DELTA5.previous_revision) {
  fail(`r5 previous_revision mismatch: got "${delta5.previous_revision}", expected "${EXPECTED_DELTA5.previous_revision}"`);
}
if (delta5.rows.length !== EXPECTED_DELTA5.row_count) {
  fail(`r5 row count mismatch: got ${delta5.rows.length}, expected ${EXPECTED_DELTA5.row_count}`);
}
if (delta5.supplied_rows_approved !== EXPECTED_DELTA5.approved) {
  fail(`r5 supplied_rows_approved mismatch: got ${delta5.supplied_rows_approved}`);
}
if (delta5.review_required !== EXPECTED_DELTA5.review_required) {
  fail(`r5 review_required is non-zero: ${delta5.review_required}`);
}
if (delta5.missing_or_unaccounted_row_count !== 0) {
  fail(`r5 missing_or_unaccounted_row_count is non-zero: ${delta5.missing_or_unaccounted_row_count}`);
}
if ((delta5.duplicate_keys || []).length !== 0) {
  fail(`r5 duplicate_keys is non-empty: ${JSON.stringify(delta5.duplicate_keys)}`);
}
if ((delta5.placeholder_mismatches || []).length !== 0) {
  fail(`r5 placeholder_mismatches is non-empty: ${JSON.stringify(delta5.placeholder_mismatches)}`);
}
if ((delta5.a_prasa_to_a_praca_violations || []).length !== 0) {
  fail(`r5 a_prasa_to_a_praca_violations is non-empty: ${JSON.stringify(delta5.a_prasa_to_a_praca_violations)}`);
}

let delta5Required = 0;
let delta5Unchanged = 0;
for (const row of delta5.rows) {
  if (seen.has(row.key)) {
    fail(`r5 key "${row.key}" collides with an existing r1/r2/r3/r4 key — r5 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta5Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta5Unchanged += 1;

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r5 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (row.translation_status !== "APPROVED") {
    fail(`r5 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  }
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r5 key "${row.key}" placeholder mismatch: en=${JSON.stringify(enPlaceholders)} pt=${JSON.stringify(ptPlaceholders)}`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta5Required !== EXPECTED_DELTA5.required_for_pt_launch) {
  fail(`r5 required_for_pt_launch mismatch: got ${delta5Required}, expected ${EXPECTED_DELTA5.required_for_pt_launch}`);
}
if (delta5Unchanged !== EXPECTED_DELTA5.intentionally_unchanged) {
  fail(`r5 intentionally_unchanged mismatch: got ${delta5Unchanged}, expected ${EXPECTED_DELTA5.intentionally_unchanged}`);
}

// --- r6 delta: PT-only brand-voice OVERRIDE on top of the r2+r3+r4+r5 base ---
// Unlike r3/r4/r5 this delta reopens existing approved PT values by design.
// It is bounded by an inverse guard: the key must already exist and the
// declared old_pt must match the currently effective PT value exactly.
const EXPECTED_DELTA6 = {
  package_id: "P09-PT-BRAND-VOICE-2026-08-26-v1",
  revision_class: "OVERRIDE_EXISTING_KEYS",
  source_revision: "P03-PT-SOURCE-2026-08-26-r6",
  previous_revision: "P03-PT-SOURCE-2026-08-25-r5",
  row_count: 42,
  approved: 42,
  review_required: 0,
  new_keys_introduced: 0,
};

const delta6 = JSON.parse(readFileSync(DELTA6_PATH, "utf8"));

if (delta6.package_id !== EXPECTED_DELTA6.package_id) {
  fail(`r6 package_id mismatch: got "${delta6.package_id}", expected "${EXPECTED_DELTA6.package_id}"`);
}
if (delta6.revision_class !== EXPECTED_DELTA6.revision_class) {
  fail(`r6 revision_class mismatch: got "${delta6.revision_class}", expected "${EXPECTED_DELTA6.revision_class}"`);
}
if (delta6.source_revision !== EXPECTED_DELTA6.source_revision) {
  fail(`r6 source_revision mismatch: got "${delta6.source_revision}", expected "${EXPECTED_DELTA6.source_revision}"`);
}
if (delta6.previous_revision !== EXPECTED_DELTA6.previous_revision) {
  fail(`r6 previous_revision mismatch: got "${delta6.previous_revision}", expected "${EXPECTED_DELTA6.previous_revision}"`);
}
if (delta6.rows.length !== EXPECTED_DELTA6.row_count) {
  fail(`r6 row count mismatch: got ${delta6.rows.length}, expected ${EXPECTED_DELTA6.row_count}`);
}
if (delta6.supplied_rows_approved !== EXPECTED_DELTA6.approved) {
  fail(`r6 supplied_rows_approved mismatch: got ${delta6.supplied_rows_approved}`);
}
if (delta6.review_required !== EXPECTED_DELTA6.review_required) {
  fail(`r6 review_required is non-zero: ${delta6.review_required}`);
}
if (delta6.missing_or_unaccounted_row_count !== 0) {
  fail(`r6 missing_or_unaccounted_row_count is non-zero: ${delta6.missing_or_unaccounted_row_count}`);
}
if (delta6.semantic_escalations_required !== 0) {
  fail(`r6 semantic_escalations_required is non-zero: ${delta6.semantic_escalations_required}`);
}
if (delta6.source_english_changed !== false) {
  fail(`r6 declares source_english_changed — English source is immutable in this delta`);
}
if ((delta6.duplicate_keys || []).length !== 0) {
  fail(`r6 duplicate_keys is non-empty: ${JSON.stringify(delta6.duplicate_keys)}`);
}
if ((delta6.placeholder_mismatches || []).length !== 0) {
  fail(`r6 placeholder_mismatches is non-empty: ${JSON.stringify(delta6.placeholder_mismatches)}`);
}
if ((delta6.a_prasa_to_a_praca_violations || []).length !== 0) {
  fail(`r6 a_prasa_to_a_praca_violations is non-empty: ${JSON.stringify(delta6.a_prasa_to_a_praca_violations)}`);
}
if (delta6.change_control_status?.new_keys_introduced !== EXPECTED_DELTA6.new_keys_introduced) {
  fail(`r6 new_keys_introduced must be 0 — r6 may not add keys`);
}
if (delta6.change_control_status?.english_source_values_modified !== 0) {
  fail(`r6 english_source_values_modified is non-zero`);
}
if (delta6.change_control_status?.additional_languages_authorized !== 0) {
  fail(`r6 additional_languages_authorized is non-zero`);
}

const delta6Seen = new Set();
let delta6Overridden = 0;
for (const row of delta6.rows) {
  if (delta6Seen.has(row.key)) {
    fail(`r6 duplicate key in supplied rows: "${row.key}"`);
  }
  delta6Seen.add(row.key);

  const existing = keys[row.key];
  if (!existing) {
    fail(`r6 key "${row.key}" does not exist in the r1/r2/r3/r4/r5 baseline — r6 may only override existing keys, never introduce new ones`);
  }
  if (existing.en !== row.source_en) {
    fail(`r6 key "${row.key}" source_en drift: baseline=${JSON.stringify(existing.en)} delta=${JSON.stringify(row.source_en)}`);
  }
  if (existing.pt !== row.old_pt) {
    fail(`r6 key "${row.key}" old_pt does not match the currently effective PT value: effective=${JSON.stringify(existing.pt)} declared_old_pt=${JSON.stringify(row.old_pt)}`);
  }
  if (row.new_pt == null || row.new_pt === "") {
    fail(`r6 key "${row.key}" has no new_pt value`);
  }
  if (row.new_pt === row.old_pt) {
    fail(`r6 key "${row.key}" is a no-op: new_pt equals old_pt`);
  }
  if (row.translation_status !== "APPROVED") {
    fail(`r6 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  }
  if (row.semantic_change !== false) {
    fail(`r6 key "${row.key}" declares a semantic change — out of scope for a brand-voice delta`);
  }
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.new_pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r6 key "${row.key}" placeholder mismatch: en=${JSON.stringify(enPlaceholders)} pt=${JSON.stringify(ptPlaceholders)}`);
  }
  const oldAPrasa = (row.old_pt.match(/A PRASA/g) || []).length;
  const newAPrasa = (row.new_pt.match(/A PRASA/g) || []).length;
  if (oldAPrasa !== newAPrasa) {
    fail(`r6 key "${row.key}" changes the number of "A PRASA" occurrences (${oldAPrasa} -> ${newAPrasa})`);
  }
  if (/A PRA[CÇ]A/.test(row.new_pt)) {
    fail(`r6 key "${row.key}" corrupts the A PRASA identity into "A PRACA"`);
  }

  // Override the PT value only. en, scope_status, identity_policy and
  // record_id are carried through from the baseline untouched, so this delta
  // structurally cannot alter English source or factual record wiring.
  keys[row.key] = {
    ...existing,
    pt: row.new_pt,
    source_revision: row.source_revision,
    linguistic_notes: row.linguistic_notes || existing.linguistic_notes || "",
  };
  delta6Overridden += 1;
}

if (delta6Overridden !== EXPECTED_DELTA6.row_count) {
  fail(`r6 overridden count mismatch: got ${delta6Overridden}, expected ${EXPECTED_DELTA6.row_count}`);
}

// --- r7 delta: additive merge on top of the r2+r3+r4+r5 base, applied after
// the r6 PT-only override. r7 introduces the single governed Simabo
// Organizations & Ways to Help record; like r3/r4/r5 it is strictly additive
// and may never reopen an existing key (including any key r6 restated).
const EXPECTED_DELTA7 = {
  package_id: "aprasa-pt-simabo-ways-to-help-r7-delta",
  source_revision: "P03-PT-SOURCE-2026-08-28-r7",
  previous_revision: "P03-PT-SOURCE-2026-08-26-r6",
  row_count: 19,
  approved: 19,
  required_for_pt_launch: 19,
  intentionally_unchanged: 0,
  review_required: 0,
};

const delta7 = JSON.parse(readFileSync(DELTA7_PATH, "utf8"));

if (delta7.package_id !== EXPECTED_DELTA7.package_id) {
  fail(`r7 package_id mismatch: got "${delta7.package_id}", expected "${EXPECTED_DELTA7.package_id}"`);
}
if (delta7.source_revision !== EXPECTED_DELTA7.source_revision) {
  fail(`r7 source_revision mismatch: got "${delta7.source_revision}", expected "${EXPECTED_DELTA7.source_revision}"`);
}
if (delta7.previous_revision !== EXPECTED_DELTA7.previous_revision) {
  fail(`r7 previous_revision mismatch: got "${delta7.previous_revision}", expected "${EXPECTED_DELTA7.previous_revision}"`);
}
if (delta7.rows.length !== EXPECTED_DELTA7.row_count) {
  fail(`r7 row count mismatch: got ${delta7.rows.length}, expected ${EXPECTED_DELTA7.row_count}`);
}
if (delta7.supplied_rows_approved !== EXPECTED_DELTA7.approved) {
  fail(`r7 supplied_rows_approved mismatch: got ${delta7.supplied_rows_approved}`);
}
if (delta7.review_required !== EXPECTED_DELTA7.review_required) {
  fail(`r7 review_required is non-zero: ${delta7.review_required}`);
}
if (delta7.missing_or_unaccounted_row_count !== 0) {
  fail(`r7 missing_or_unaccounted_row_count is non-zero: ${delta7.missing_or_unaccounted_row_count}`);
}
if ((delta7.duplicate_keys || []).length !== 0) {
  fail(`r7 duplicate_keys is non-empty: ${JSON.stringify(delta7.duplicate_keys)}`);
}
if ((delta7.placeholder_mismatches || []).length !== 0) {
  fail(`r7 placeholder_mismatches is non-empty: ${JSON.stringify(delta7.placeholder_mismatches)}`);
}
if ((delta7.a_prasa_to_a_praca_violations || []).length !== 0) {
  fail(`r7 a_prasa_to_a_praca_violations is non-empty: ${JSON.stringify(delta7.a_prasa_to_a_praca_violations)}`);
}

let delta7Required = 0;
let delta7Unchanged = 0;
for (const row of delta7.rows) {
  if (seen.has(row.key)) {
    fail(`r7 key "${row.key}" collides with an existing r1/r2/r3/r4/r5 key — r7 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta7Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta7Unchanged += 1;

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r7 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (row.translation_status !== "APPROVED") {
    fail(`r7 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  }
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r7 key "${row.key}" placeholder mismatch: en=${JSON.stringify(enPlaceholders)} pt=${JSON.stringify(ptPlaceholders)}`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta7Required !== EXPECTED_DELTA7.required_for_pt_launch) {
  fail(`r7 required_for_pt_launch mismatch: got ${delta7Required}, expected ${EXPECTED_DELTA7.required_for_pt_launch}`);
}
if (delta7Unchanged !== EXPECTED_DELTA7.intentionally_unchanged) {
  fail(`r7 intentionally_unchanged mismatch: got ${delta7Unchanged}, expected ${EXPECTED_DELTA7.intentionally_unchanged}`);
}

// --- r8 delta: additive merge on top of r2+r3+r4+r5+r7, applied after the r6
// PT-only override. r8 introduces the governed PT presentation for the
// same-day PART_ILHAS / Artemisa Ferreira dated event. Strictly additive: it
// may never reopen an existing key (including any key r6 restated).
const EXPECTED_DELTA8 = {
  package_id: "aprasa-pt-part-ilhas-artemisa-ferreira-r8-delta",
  source_revision: "P03-PT-SOURCE-2026-08-29-r8",
  previous_revision: "P03-PT-SOURCE-2026-08-28-r7",
  row_count: 21,
  approved: 21,
  required_for_pt_launch: 21,
  intentionally_unchanged: 0,
  review_required: 0,
};

const delta8 = JSON.parse(readFileSync(DELTA8_PATH, "utf8"));

if (delta8.package_id !== EXPECTED_DELTA8.package_id) {
  fail(`r8 package_id mismatch: got "${delta8.package_id}", expected "${EXPECTED_DELTA8.package_id}"`);
}
if (delta8.source_revision !== EXPECTED_DELTA8.source_revision) {
  fail(`r8 source_revision mismatch: got "${delta8.source_revision}", expected "${EXPECTED_DELTA8.source_revision}"`);
}
if (delta8.previous_revision !== EXPECTED_DELTA8.previous_revision) {
  fail(`r8 previous_revision mismatch: got "${delta8.previous_revision}", expected "${EXPECTED_DELTA8.previous_revision}"`);
}
if (delta8.rows.length !== EXPECTED_DELTA8.row_count) {
  fail(`r8 row count mismatch: got ${delta8.rows.length}, expected ${EXPECTED_DELTA8.row_count}`);
}
if (delta8.supplied_rows_approved !== EXPECTED_DELTA8.approved) {
  fail(`r8 supplied_rows_approved mismatch: got ${delta8.supplied_rows_approved}`);
}
if (delta8.review_required !== EXPECTED_DELTA8.review_required) {
  fail(`r8 review_required is non-zero: ${delta8.review_required}`);
}
if (delta8.missing_or_unaccounted_row_count !== 0) {
  fail(`r8 missing_or_unaccounted_row_count is non-zero: ${delta8.missing_or_unaccounted_row_count}`);
}
if ((delta8.duplicate_keys || []).length !== 0) {
  fail(`r8 duplicate_keys is non-empty: ${JSON.stringify(delta8.duplicate_keys)}`);
}
if ((delta8.placeholder_mismatches || []).length !== 0) {
  fail(`r8 placeholder_mismatches is non-empty: ${JSON.stringify(delta8.placeholder_mismatches)}`);
}
if ((delta8.a_prasa_to_a_praca_violations || []).length !== 0) {
  fail(`r8 a_prasa_to_a_praca_violations is non-empty: ${JSON.stringify(delta8.a_prasa_to_a_praca_violations)}`);
}

let delta8Required = 0;
let delta8Unchanged = 0;
for (const row of delta8.rows) {
  if (seen.has(row.key)) {
    fail(`r8 key "${row.key}" collides with an existing r1/r2/r3/r4/r5/r7 key — r8 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta8Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta8Unchanged += 1;

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r8 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (row.translation_status !== "APPROVED") {
    fail(`r8 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  }
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r8 key "${row.key}" placeholder mismatch: en=${JSON.stringify(enPlaceholders)} pt=${JSON.stringify(ptPlaceholders)}`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta8Required !== EXPECTED_DELTA8.required_for_pt_launch) {
  fail(`r8 required_for_pt_launch mismatch: got ${delta8Required}, expected ${EXPECTED_DELTA8.required_for_pt_launch}`);
}
if (delta8Unchanged !== EXPECTED_DELTA8.intentionally_unchanged) {
  fail(`r8 intentionally_unchanged mismatch: got ${delta8Unchanged}, expected ${EXPECTED_DELTA8.intentionally_unchanged}`);
}

// --- r9 delta: authorized SOURCE CORRECTION on top of r2..r8 ---
// Rewrites approved EN *and* PT for a bounded, explicitly ruled-on set of keys
// whose underlying fact was superseded. See the header note for why neither
// the additive guards nor r6 can carry this.
const EXPECTED_DELTA9 = {
  package_id: "aprasa-pt-sinergia-da-materia-source-correction-r9-delta",
  revision_class: "OVERRIDE_EXISTING_KEYS_WITH_SOURCE_CORRECTION",
  source_revision: "P03-PT-SOURCE-2026-09-01-r9",
  previous_revision: "P03-PT-SOURCE-2026-08-29-r8",
  owning_project: "Project 03",
  superseding_ruling: "P03-SINERGIA-CURRENTNESS-2026-09-01",
  row_count: 3,
  approved: 3,
  review_required: 0,
  new_keys_introduced: 0,
  // Every authorized target, named here as well as in the package. A key the
  // build does not already expect cannot be corrected by editing the package
  // alone.
  authorized_keys: [
    "event.sinergia-da-materia.display.status",
    "event.sinergia-da-materia.detail.fact.dates.value_display",
    "event.sinergia-da-materia.seo.description",
  ],
};

const delta9 = JSON.parse(readFileSync(DELTA9_PATH, "utf8"));

if (delta9.package_id !== EXPECTED_DELTA9.package_id) {
  fail(`r9 package_id mismatch: got "${delta9.package_id}", expected "${EXPECTED_DELTA9.package_id}"`);
}
if (delta9.revision_class !== EXPECTED_DELTA9.revision_class) {
  fail(`r9 revision_class mismatch: got "${delta9.revision_class}", expected "${EXPECTED_DELTA9.revision_class}"`);
}
if (delta9.source_revision !== EXPECTED_DELTA9.source_revision) {
  fail(`r9 source_revision mismatch: got "${delta9.source_revision}"`);
}
if (delta9.previous_revision !== EXPECTED_DELTA9.previous_revision) {
  fail(`r9 previous_revision mismatch: got "${delta9.previous_revision}"`);
}
if (delta9.owning_project !== EXPECTED_DELTA9.owning_project) {
  fail(`r9 owning_project mismatch: got "${delta9.owning_project}"`);
}
if (delta9.superseding_ruling !== EXPECTED_DELTA9.superseding_ruling) {
  fail(`r9 superseding_ruling mismatch: got "${delta9.superseding_ruling}"`);
}
if (delta9.source_correction_authorized !== true) {
  fail("r9 is not declared source_correction_authorized");
}
if (delta9.semantic_change !== true) {
  fail("r9 must declare semantic_change — a source correction is semantic by definition");
}
if (delta9.superseded_source_status !== "SUPERSEDED") {
  fail(`r9 superseded_source_status must be SUPERSEDED, got "${delta9.superseded_source_status}"`);
}
if (delta9.rows.length !== EXPECTED_DELTA9.row_count) {
  fail(`r9 row count mismatch: got ${delta9.rows.length}, expected ${EXPECTED_DELTA9.row_count}`);
}
if (delta9.supplied_rows_approved !== EXPECTED_DELTA9.approved) {
  fail(`r9 supplied_rows_approved mismatch: got ${delta9.supplied_rows_approved}`);
}
if (delta9.review_required !== 0) fail(`r9 review_required is non-zero: ${delta9.review_required}`);
if (delta9.blocking_issue != null) fail(`r9 has an unresolved blocking issue: ${JSON.stringify(delta9.blocking_issue)}`);
if (delta9.missing_or_unaccounted_row_count !== 0) {
  fail(`r9 missing_or_unaccounted_row_count is non-zero: ${delta9.missing_or_unaccounted_row_count}`);
}
if (delta9.semantic_escalations_required !== 0) {
  fail(`r9 semantic_escalations_required is non-zero: ${delta9.semantic_escalations_required}`);
}
if ((delta9.duplicate_keys || []).length !== 0) fail(`r9 duplicate_keys is non-empty`);
if ((delta9.placeholder_mismatches || []).length !== 0) fail(`r9 placeholder_mismatches is non-empty`);
if ((delta9.a_prasa_to_a_praca_violations || []).length !== 0) fail(`r9 a_prasa_to_a_praca_violations is non-empty`);
if (delta9.change_control_status?.new_keys_introduced !== EXPECTED_DELTA9.new_keys_introduced) {
  fail("r9 new_keys_introduced must be 0 — a source correction may not add keys");
}
if (delta9.change_control_status?.additional_languages_authorized !== 0) {
  fail("r9 additional_languages_authorized is non-zero");
}
if (delta9.change_control_status?.unrelated_keys_touched !== 0) {
  fail("r9 unrelated_keys_touched is non-zero");
}

const delta9Seen = new Set();
let delta9Corrected = 0;
for (const row of delta9.rows) {
  if (delta9Seen.has(row.key)) fail(`r9 duplicate key in supplied rows: "${row.key}"`);
  delta9Seen.add(row.key);

  // Undeclared target: the package cannot widen its own scope.
  if (!EXPECTED_DELTA9.authorized_keys.includes(row.key)) {
    fail(`r9 key "${row.key}" is not an authorized source-correction target`);
  }
  if (row.target_key !== row.key) {
    fail(`r9 key "${row.key}" declares a mismatched target_key "${row.target_key}"`);
  }

  const existing = keys[row.key];
  if (!existing) fail(`r9 key "${row.key}" does not exist in the r2..r8 baseline — a correction may not introduce keys`);

  // Byte-exact old-value match, on BOTH sides. Drift fails rather than
  // overwriting a value the ruling never actually saw.
  if (existing.en !== row.old_en) {
    fail(`r9 key "${row.key}" old_en does not match the effective value: effective=${JSON.stringify(existing.en)} declared=${JSON.stringify(row.old_en)}`);
  }
  if (existing.pt !== row.old_pt) {
    fail(`r9 key "${row.key}" old_pt does not match the effective value: effective=${JSON.stringify(existing.pt)} declared=${JSON.stringify(row.old_pt)}`);
  }
  if (!row.new_en) fail(`r9 key "${row.key}" has no new_en value`);
  if (!row.new_pt) fail(`r9 key "${row.key}" has no new_pt value`);
  if (row.new_en === row.old_en && row.new_pt === row.old_pt) {
    fail(`r9 key "${row.key}" is a no-op`);
  }

  // Full authorization chain, per row — never inherited from the package alone.
  if (row.semantic_change !== true) fail(`r9 key "${row.key}" must declare semantic_change: true`);
  if (row.source_correction_authorized !== true) fail(`r9 key "${row.key}" is not source_correction_authorized`);
  if (row.owning_project !== EXPECTED_DELTA9.owning_project) fail(`r9 key "${row.key}" owning_project mismatch`);
  if (row.superseding_ruling !== EXPECTED_DELTA9.superseding_ruling) fail(`r9 key "${row.key}" superseding_ruling mismatch`);
  if (row.superseded_source_status !== "SUPERSEDED") fail(`r9 key "${row.key}" superseded_source_status must be SUPERSEDED`);
  if (!row.replacement_status) fail(`r9 key "${row.key}" has no replacement_status`);
  if (row.revision_class !== EXPECTED_DELTA9.revision_class) fail(`r9 key "${row.key}" revision_class mismatch`);
  if (row.source_revision !== EXPECTED_DELTA9.source_revision) fail(`r9 key "${row.key}" source_revision mismatch`);
  if (row.translation_status !== "APPROVED") fail(`r9 key "${row.key}" is not APPROVED`);

  const enPlaceholders = (row.new_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.new_pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r9 key "${row.key}" placeholder mismatch`);
  }
  if (/A PRA[CÇ]A/.test(row.new_pt) || /A PRA[CÇ]A/.test(row.new_en)) {
    fail(`r9 key "${row.key}" corrupts the A PRASA identity`);
  }
  // No inferred factual value: a month-precision correction must not smuggle
  // an exact day back in through the localized text.
  for (const [side, text] of [["new_en", row.new_en], ["new_pt", row.new_pt]]) {
    if (/\b(\d{1,2})\s+(de\s+)?(November|novembro)\b/i.test(text) || /\b(November|novembro)\s+\d{1,2}\b/i.test(text)) {
      fail(`r9 key "${row.key}" ${side} infers an exact November day: ${JSON.stringify(text)}`);
    }
  }

  // Correct EN and PT together, preserving the superseded provenance so the
  // prior approved meaning stays auditable after the swap.
  keys[row.key] = {
    ...existing,
    en: row.new_en,
    pt: row.new_pt,
    source_revision: row.source_revision,
    context_notes: row.context_notes || existing.context_notes || "",
    linguistic_notes: row.linguistic_notes || existing.linguistic_notes || "",
    source_correction: {
      revision_class: row.revision_class,
      owning_project: row.owning_project,
      superseding_ruling: row.superseding_ruling,
      superseded_source_status: row.superseded_source_status,
      replacement_status: row.replacement_status,
      semantic_change: true,
      superseded_en: row.old_en,
      superseded_pt: row.old_pt,
      superseded_source_revision: existing.source_revision,
    },
  };
  delta9Corrected += 1;
}

if (delta9Corrected !== EXPECTED_DELTA9.row_count) {
  fail(`r9 corrected count mismatch: got ${delta9Corrected}, expected ${EXPECTED_DELTA9.row_count}`);
}

// Phase 1B event deltas are complete Project 09-approved, strictly additive
// packages. Discovery removes the need to edit this build script for each
// ordinary event while retaining the same fail-closed row checks as r3-r8.
const eventDeltaFiles = readdirSync(LOCALE_DIR)
  .filter((name) => /^pt-overlay-event-[a-z0-9]+(?:-[a-z0-9]+)*\.source\.json$/.test(name))
  .sort();
const eventDeltaPackages = [];
let eventDeltaRequired = 0;
let eventDeltaUnchanged = 0;

for (const fileName of eventDeltaFiles) {
  const packagePath = path.join(LOCALE_DIR, fileName);
  const eventDelta = JSON.parse(readFileSync(packagePath, "utf8"));
  const expectedId = fileName.replace(/^pt-overlay-event-/, "").replace(/\.source\.json$/, "");
  if (eventDelta.event_id !== expectedId) fail(`${fileName}: event_id must equal ${expectedId}`);
  if (eventDelta.project_09_status !== "approved") fail(`${fileName}: Project 09 status is not approved`);
  if (!eventDelta.package_id || !eventDelta.source_revision) fail(`${fileName}: missing package_id/source_revision`);
  if (!Array.isArray(eventDelta.rows) || eventDelta.rows.length === 0) fail(`${fileName}: rows must be non-empty`);
  if (eventDelta.supplied_rows_approved !== eventDelta.rows.length) fail(`${fileName}: approved row count mismatch`);
  if (eventDelta.review_required !== 0 || eventDelta.blocking_issue != null) fail(`${fileName}: unresolved localization review state`);

  for (const row of eventDelta.rows) {
    if (seen.has(row.key)) fail(`${fileName}: key "${row.key}" is not strictly additive`);
    seen.add(row.key);
    if (!row.key.startsWith(`event.${eventDelta.event_id}.`) || row.record_id !== eventDelta.event_id) {
      fail(`${fileName}: row ${row.key} is outside event ${eventDelta.event_id}`);
    }
    if (row.source_revision !== eventDelta.source_revision) fail(`${fileName}: ${row.key} source_revision mismatch`);
    if (row.translation_status !== "APPROVED") fail(`${fileName}: ${row.key} is not APPROVED`);
    if (!row.source_en || !row.pt) fail(`${fileName}: ${row.key} is missing EN/PT approved text`);
    if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") eventDeltaRequired += 1;
    else if (row.scope_status === "INTENTIONALLY_UNCHANGED") eventDeltaUnchanged += 1;
    else fail(`${fileName}: ${row.key} has invalid scope_status`);
    const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
    const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
    if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
      fail(`${fileName}: ${row.key} placeholder mismatch`);
    }
    if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
      fail(`${fileName}: ${row.key} violates protected A PRASA brand spelling`);
    }
    keys[row.key] = {
      key: row.key,
      en: row.source_en,
      pt: row.pt,
      scope_status: row.scope_status,
      identity_policy: row.identity_policy,
      record_id: row.record_id,
      translation_status: row.translation_status,
      source_revision: row.source_revision,
      context_notes: row.context_notes || "",
      linguistic_notes: row.linguistic_notes || "",
    };
  }
  eventDeltaPackages.push({
    file: `data/locales/${fileName}`,
    event_id: eventDelta.event_id,
    package_id: eventDelta.package_id,
    source_revision: eventDelta.source_revision,
    row_count: eventDelta.rows.length,
  });
}

// --- r13 delta: additive merge for the Things-to-Do collection hub ----------
// Introduces the governed EN/PT presentation copy for the dedicated
// Things-to-Do collection surfaces (/things-to-do/ and /pt/things-to-do/) and
// the Home preview call to action. Same class as r3/r4/r5/r7/r8: strictly
// additive, so it may never reopen an existing key (including any key r6
// restated or r9/r11/r12 corrected). It introduces no record-scoped key and
// retranslates no event copy — every per-record string on the hub is the
// existing governed `event.<id>.*` presentation, reused unchanged.
//
// Two keys Project 09 proposed are deliberately NOT introduced here, and the
// package documents both bindings in its own incumbent_key_bindings block:
//   things.hub.collection_label -> bound to the incumbent
//     things.shared.back_to_things, which already carries the approved
//     collection wording. A second key with the identical English string
//     "Things to Do" would make the EN->PT static-page index ambiguous for
//     that string and break Home's own localization.
//   things.hub.return_label     -> not bound. The incumbent detail-page
//     pattern has a single breadcrumb control, not a separate return control,
//     so the approved optional return wording is not required by it.
const EXPECTED_DELTA13 = {
  package_id: "aprasa-pt-things-to-do-hub-r13-delta",
  revision_class: "ADDITIVE_NEW_KEYS",
  source_revision: "P03-PT-SOURCE-2026-09-04-r13",
  previous_revision: "P03-PT-SOURCE-2026-09-01-r12",
  row_count: 8,
  approved: 8,
  required_for_pt_launch: 8,
  intentionally_unchanged: 0,
  review_required: 0,
};

const delta13 = JSON.parse(readFileSync(DELTA13_PATH, "utf8"));

for (const field of ["package_id", "revision_class", "source_revision", "previous_revision"]) {
  if (delta13[field] !== EXPECTED_DELTA13[field]) {
    fail(`r13 ${field} mismatch: got ${JSON.stringify(delta13[field])}, expected ${JSON.stringify(EXPECTED_DELTA13[field])}`);
  }
}
if (delta13.project_09_status !== "approved") {
  fail(`r13 Project 09 status is not approved: ${JSON.stringify(delta13.project_09_status)}`);
}
if (!Array.isArray(delta13.rows) || delta13.rows.length !== EXPECTED_DELTA13.row_count) {
  fail(`r13 row count mismatch: got ${delta13.rows?.length}, expected ${EXPECTED_DELTA13.row_count}`);
}
if (delta13.supplied_rows_approved !== EXPECTED_DELTA13.approved) {
  fail(`r13 supplied_rows_approved mismatch: got ${delta13.supplied_rows_approved}`);
}
if (delta13.review_required !== EXPECTED_DELTA13.review_required || delta13.blocking_issue != null) {
  fail(`r13 has unresolved localization review state`);
}
if (delta13.missing_or_unaccounted_row_count !== 0) {
  fail(`r13 missing_or_unaccounted_row_count is non-zero: ${delta13.missing_or_unaccounted_row_count}`);
}
if ((delta13.duplicate_keys || []).length !== 0) {
  fail(`r13 duplicate_keys is non-empty: ${JSON.stringify(delta13.duplicate_keys)}`);
}
if ((delta13.placeholder_mismatches || []).length !== 0) {
  fail(`r13 placeholder_mismatches is non-empty: ${JSON.stringify(delta13.placeholder_mismatches)}`);
}
if ((delta13.a_prasa_to_a_praca_violations || []).length !== 0) {
  fail(`r13 a_prasa_to_a_praca_violations is non-empty: ${JSON.stringify(delta13.a_prasa_to_a_praca_violations)}`);
}
// An additive package must not be able to smuggle in a source-English rewrite
// or a lifecycle change under a different revision_class's guarantees.
if (delta13.source_english_changed !== false || delta13.change_control_status?.existing_keys_overridden !== 0) {
  fail(`r13 declares a non-additive change (source_english_changed/existing_keys_overridden)`);
}
if (delta13.change_control_status?.new_keys_introduced !== EXPECTED_DELTA13.row_count) {
  fail(`r13 new_keys_introduced mismatch: got ${delta13.change_control_status?.new_keys_introduced}`);
}
if (delta13.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail(`r13 must not modify lifecycle or publication state`);
}

let delta13Required = 0;
let delta13Unchanged = 0;
for (const row of delta13.rows) {
  if (seen.has(row.key)) {
    fail(`r13 key "${row.key}" collides with an existing key — r13 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  // The hub package is site-chrome copy, not record presentation: a
  // record-scoped key here would mean event copy was reopened outside the
  // governed event-delta lane.
  if (row.record_id != null) fail(`r13 key "${row.key}" is record-scoped; the hub package carries no record copy`);
  if (!/^(things\.hub\.|home\.things\.hub_action$)/.test(row.key)) {
    fail(`r13 key "${row.key}" is outside the authorized things.hub.* / home.things.hub_action namespace`);
  }
  if (row.source_revision !== EXPECTED_DELTA13.source_revision) fail(`r13 ${row.key} source_revision mismatch`);
  if (row.translation_status !== "APPROVED") fail(`r13 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta13Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta13Unchanged += 1;
  else fail(`r13 key "${row.key}" has invalid scope_status`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r13 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (!row.source_en) fail(`r13 key "${row.key}" is missing approved English text`);
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r13 key "${row.key}" placeholder mismatch: en=${JSON.stringify(enPlaceholders)} pt=${JSON.stringify(ptPlaceholders)}`);
  }
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r13 key "${row.key}" violates protected A PRASA brand spelling`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta13Required !== EXPECTED_DELTA13.required_for_pt_launch) {
  fail(`r13 required_for_pt_launch mismatch: got ${delta13Required}, expected ${EXPECTED_DELTA13.required_for_pt_launch}`);
}
if (delta13Unchanged !== EXPECTED_DELTA13.intentionally_unchanged) {
  fail(`r13 intentionally_unchanged mismatch: got ${delta13Unchanged}, expected ${EXPECTED_DELTA13.intentionally_unchanged}`);
}

// --- r14 delta: additive merge for the runtime section fallback note --------
// Supplies the approved Portuguese value for the generic runtime section
// fallback-media explanatory label. The r13 collection-hub tranche deliberately
// shipped that one string unresolved — prasa-launch.js kept its English default
// and the item was reported BLOCKED_ON_PROJECT_09_STRING_APPROVAL — rather than
// translate it without approval. This is that approval arriving, on the same
// strictly additive lane as r13: it may never reopen an existing key, and its
// English source value is the incumbent runtime string carried over unchanged.
const EXPECTED_DELTA14 = {
  package_id: "aprasa-pt-section-fallback-note-r14-delta",
  revision_class: "ADDITIVE_NEW_KEYS",
  source_revision: "P03-PT-SOURCE-2026-09-06-r14",
  previous_revision: "P03-PT-SOURCE-2026-09-04-r13",
  row_count: 1,
  approved: 1,
  required_for_pt_launch: 1,
  intentionally_unchanged: 0,
  review_required: 0,
};

const delta14 = JSON.parse(readFileSync(DELTA14_PATH, "utf8"));

for (const field of ["package_id", "revision_class", "source_revision", "previous_revision"]) {
  if (delta14[field] !== EXPECTED_DELTA14[field]) {
    fail(`r14 ${field} mismatch: got ${JSON.stringify(delta14[field])}, expected ${JSON.stringify(EXPECTED_DELTA14[field])}`);
  }
}
if (delta14.project_09_status !== "approved") {
  fail(`r14 Project 09 status is not approved: ${JSON.stringify(delta14.project_09_status)}`);
}
if (!Array.isArray(delta14.rows) || delta14.rows.length !== EXPECTED_DELTA14.row_count) {
  fail(`r14 row count mismatch: got ${delta14.rows?.length}, expected ${EXPECTED_DELTA14.row_count}`);
}
if (delta14.supplied_rows_approved !== EXPECTED_DELTA14.approved) {
  fail(`r14 supplied_rows_approved mismatch: got ${delta14.supplied_rows_approved}`);
}
if (delta14.review_required !== EXPECTED_DELTA14.review_required || delta14.blocking_issue != null) {
  fail(`r14 has unresolved localization review state`);
}
if (delta14.missing_or_unaccounted_row_count !== 0) {
  fail(`r14 missing_or_unaccounted_row_count is non-zero: ${delta14.missing_or_unaccounted_row_count}`);
}
if ((delta14.duplicate_keys || []).length !== 0) {
  fail(`r14 duplicate_keys is non-empty: ${JSON.stringify(delta14.duplicate_keys)}`);
}
if ((delta14.placeholder_mismatches || []).length !== 0) {
  fail(`r14 placeholder_mismatches is non-empty: ${JSON.stringify(delta14.placeholder_mismatches)}`);
}
if ((delta14.a_prasa_to_a_praca_violations || []).length !== 0) {
  fail(`r14 a_prasa_to_a_praca_violations is non-empty: ${JSON.stringify(delta14.a_prasa_to_a_praca_violations)}`);
}
if (delta14.source_english_changed !== false || delta14.change_control_status?.existing_keys_overridden !== 0) {
  fail(`r14 declares a non-additive change (source_english_changed/existing_keys_overridden)`);
}
if (delta14.change_control_status?.new_keys_introduced !== EXPECTED_DELTA14.row_count) {
  fail(`r14 new_keys_introduced mismatch: got ${delta14.change_control_status?.new_keys_introduced}`);
}
if (delta14.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail(`r14 must not modify lifecycle or publication state`);
}

let delta14Required = 0;
let delta14Unchanged = 0;
for (const row of delta14.rows) {
  if (seen.has(row.key)) {
    fail(`r14 key "${row.key}" collides with an existing key — r14 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (row.record_id != null) fail(`r14 key "${row.key}" is record-scoped; this package carries no record copy`);
  if (!/^system\.media_fallback\./.test(row.key)) {
    fail(`r14 key "${row.key}" is outside the authorized system.media_fallback.* namespace`);
  }
  if (row.source_revision !== EXPECTED_DELTA14.source_revision) fail(`r14 ${row.key} source_revision mismatch`);
  if (row.translation_status !== "APPROVED") fail(`r14 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta14Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta14Unchanged += 1;
  else fail(`r14 key "${row.key}" has invalid scope_status`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r14 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (!row.source_en) fail(`r14 key "${row.key}" is missing approved English text`);
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r14 key "${row.key}" placeholder mismatch: en=${JSON.stringify(enPlaceholders)} pt=${JSON.stringify(ptPlaceholders)}`);
  }
  // Project 09 identity policy for this row is "TRANSLATE — preserve A PRASA":
  // the brand string is translated around, never translated away.
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r14 key "${row.key}" violates protected A PRASA brand spelling`);
  }
  if (row.source_en.includes("A PRASA") && !row.pt.includes("A PRASA")) {
    fail(`r14 key "${row.key}" drops the protected brand string A PRASA from its Portuguese value`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta14Required !== EXPECTED_DELTA14.required_for_pt_launch) {
  fail(`r14 required_for_pt_launch mismatch: got ${delta14Required}, expected ${EXPECTED_DELTA14.required_for_pt_launch}`);
}
if (delta14Unchanged !== EXPECTED_DELTA14.intentionally_unchanged) {
  fail(`r14 intentionally_unchanged mismatch: got ${delta14Unchanged}, expected ${EXPECTED_DELTA14.intentionally_unchanged}`);
}

// --- r15 delta: additive merge for the weekly opportunity publication -------
// Introduces the governed EN/PT presentation for the eight approved
// fixed-window opportunity records (Uni-CV Erasmus+ x3, Uni-CV third-phase
// admissions, Laç(z)os Artísticos, China Ambassador Scholarship, Confucius
// Institute courses, REGEA oral communications). Same class as r3/r4/r5/r7/r8/
// r13: strictly additive, so it may never reopen an existing key.
//
// Every value is transcribed verbatim from the governed Project 03 English
// packet and the Project 09 Portuguese localization packet, including the
// final presentation supplement that carried the per-record checked lines and
// call-to-action labels. Nothing here is composed.
const EXPECTED_DELTA15 = {
  package_id: "aprasa-pt-weekly-opportunity-2026-09-r15-delta",
  revision_class: "ADDITIVE_NEW_KEYS",
  source_revision: "P03-PT-SOURCE-2026-09-07-r15",
  previous_revision: "P03-PT-SOURCE-2026-09-06-r14",
  row_count: 96,
  approved: 96,
  required_for_pt_launch: 96,
  intentionally_unchanged: 0,
  review_required: 0,
  // The eight canonical record ids this package is authorized to carry copy
  // for. A row outside this set means a record was smuggled into the batch.
  records: [
    "unicv-erasmus-viana-do-castelo-edital-027-2026",
    "unicv-erasmus-bielefeld-edital-028-2026",
    "unicv-erasmus-ca-foscari-edital-029-2026",
    "unicv-undergraduate-admissions-third-phase-2026-2027",
    "laczos-artisticos-2nd-edition-2026",
    "unicv-china-ambassador-scholarship-2026",
    "unicv-confucius-chinese-language-courses-2026-2027",
    "regea-oral-communications-call-2026",
  ],
};

const delta15 = JSON.parse(readFileSync(DELTA15_PATH, "utf8"));

for (const field of ["package_id", "revision_class", "source_revision", "previous_revision"]) {
  if (delta15[field] !== EXPECTED_DELTA15[field]) {
    fail(`r15 ${field} mismatch: got ${JSON.stringify(delta15[field])}, expected ${JSON.stringify(EXPECTED_DELTA15[field])}`);
  }
}
if (delta15.project_09_status !== "approved") {
  fail(`r15 Project 09 status is not approved: ${JSON.stringify(delta15.project_09_status)}`);
}
if (!Array.isArray(delta15.rows) || delta15.rows.length !== EXPECTED_DELTA15.row_count) {
  fail(`r15 row count mismatch: got ${delta15.rows?.length}, expected ${EXPECTED_DELTA15.row_count}`);
}
if (delta15.supplied_rows_approved !== EXPECTED_DELTA15.approved) {
  fail(`r15 supplied_rows_approved mismatch: got ${delta15.supplied_rows_approved}`);
}
if (delta15.review_required !== EXPECTED_DELTA15.review_required || delta15.blocking_issue != null) {
  fail(`r15 has unresolved localization review state`);
}
if (delta15.missing_or_unaccounted_row_count !== 0) {
  fail(`r15 missing_or_unaccounted_row_count is non-zero: ${delta15.missing_or_unaccounted_row_count}`);
}
for (const listField of ["duplicate_keys", "placeholder_mismatches", "a_prasa_to_a_praca_violations"]) {
  if ((delta15[listField] || []).length !== 0) fail(`r15 ${listField} is non-empty: ${JSON.stringify(delta15[listField])}`);
}
if (delta15.source_english_changed !== false || delta15.change_control_status?.existing_keys_overridden !== 0) {
  fail(`r15 declares a non-additive change (source_english_changed/existing_keys_overridden)`);
}
if (delta15.change_control_status?.new_keys_introduced !== EXPECTED_DELTA15.row_count) {
  fail(`r15 new_keys_introduced mismatch: got ${delta15.change_control_status?.new_keys_introduced}`);
}
if (delta15.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail(`r15 must not modify lifecycle or publication state`);
}

const DELTA15_RECORDS = new Set(EXPECTED_DELTA15.records);
let delta15Required = 0;
let delta15Unchanged = 0;
const delta15Seen = new Map();
for (const row of delta15.rows) {
  if (seen.has(row.key)) {
    fail(`r15 key "${row.key}" collides with an existing key — r15 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  // Every row is record-scoped, and only to an authorized record.
  if (typeof row.record_id !== "string" || !DELTA15_RECORDS.has(row.record_id)) {
    fail(`r15 key "${row.key}" targets unauthorized record ${JSON.stringify(row.record_id)}`);
  }
  if (!row.key.startsWith(`training.record.${row.record_id}.`)) {
    fail(`r15 key "${row.key}" is outside its own record namespace`);
  }
  if (row.source_revision !== EXPECTED_DELTA15.source_revision) fail(`r15 ${row.key} source_revision mismatch`);
  if (row.translation_status !== "APPROVED") fail(`r15 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta15Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta15Unchanged += 1;
  else fail(`r15 key "${row.key}" has invalid scope_status`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r15 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (!row.source_en) fail(`r15 key "${row.key}" is missing approved English text`);
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r15 key "${row.key}" placeholder mismatch: en=${JSON.stringify(enPlaceholders)} pt=${JSON.stringify(ptPlaceholders)}`);
  }
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r15 key "${row.key}" violates protected A PRASA brand spelling`);
  }

  // The EN->PT index the static-page localizer builds is keyed on the English
  // string, so one English string that maps to two different Portuguese values
  // makes that string untranslatable on every page. Caught here, at the source.
  const priorPt = delta15Seen.get(row.source_en);
  if (priorPt !== undefined && priorPt !== row.pt) {
    fail(`r15 English string ${JSON.stringify(row.source_en.slice(0, 60))} maps to two different Portuguese values`);
  }
  delta15Seen.set(row.source_en, row.pt);

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta15Required !== EXPECTED_DELTA15.required_for_pt_launch) {
  fail(`r15 required_for_pt_launch mismatch: got ${delta15Required}, expected ${EXPECTED_DELTA15.required_for_pt_launch}`);
}
if (delta15Unchanged !== EXPECTED_DELTA15.intentionally_unchanged) {
  fail(`r15 intentionally_unchanged mismatch: got ${delta15Unchanged}, expected ${EXPECTED_DELTA15.intentionally_unchanged}`);
}
// Every authorized record must actually be present: a package that silently
// drops a record would publish a partial batch.
for (const recordId of EXPECTED_DELTA15.records) {
  if (!delta15.rows.some((row) => row.record_id === recordId)) {
    fail(`r15 is missing every row for authorized record "${recordId}"`);
  }
}

// --- r16 delta: four founder-authorized provider-media alt descriptions ----
//
// These strings are presentation content and therefore stay in the governed
// locale chain rather than being embedded in the training generator or data
// record. The package is deliberately one key per cleared record and additive
// only: it cannot rewrite the previously approved r15 opportunity copy.
const EXPECTED_DELTA16 = {
  package_id: "aprasa-provider-media-alt-r16-delta",
  revision_class: "ADDITIVE_NEW_KEYS",
  source_revision: "P04-MEDIA-ALT-2026-09-11-r16",
  previous_revision: "P03-PT-SOURCE-2026-09-07-r15",
  row_count: 4,
  approval_status: "FOUNDER_AUTHORIZED_FOR_IMPLEMENTATION",
  records: [
    "unicv-undergraduate-admissions-third-phase-2026-2027",
    "laczos-artisticos-2nd-edition-2026",
    "unicv-confucius-chinese-language-courses-2026-2027",
    "regea-oral-communications-call-2026",
  ],
};

const delta16 = JSON.parse(readFileSync(DELTA16_PATH, "utf8"));
for (const field of ["package_id", "revision_class", "source_revision", "previous_revision", "approval_status"]) {
  if (delta16[field] !== EXPECTED_DELTA16[field]) {
    fail(`r16 ${field} mismatch: got ${JSON.stringify(delta16[field])}, expected ${JSON.stringify(EXPECTED_DELTA16[field])}`);
  }
}
if (!Array.isArray(delta16.rows) || delta16.rows.length !== EXPECTED_DELTA16.row_count) {
  fail(`r16 row count mismatch: got ${delta16.rows?.length}, expected ${EXPECTED_DELTA16.row_count}`);
}
if (delta16.supplied_rows_approved !== EXPECTED_DELTA16.row_count
    || delta16.review_required !== 0
    || delta16.semantic_escalations_required !== 0
    || delta16.blocking_issue != null) {
  fail("r16 has unresolved accessibility-copy approval state");
}
if (delta16.missing_or_unaccounted_row_count !== 0) {
  fail(`r16 missing_or_unaccounted_row_count is non-zero: ${delta16.missing_or_unaccounted_row_count}`);
}
for (const listField of ["duplicate_keys", "placeholder_mismatches", "a_prasa_to_a_praca_violations"]) {
  if ((delta16[listField] || []).length !== 0) fail(`r16 ${listField} is non-empty: ${JSON.stringify(delta16[listField])}`);
}
if (delta16.source_english_changed !== false
    || delta16.change_control_status?.new_keys_introduced !== EXPECTED_DELTA16.row_count
    || delta16.change_control_status?.existing_keys_overridden !== 0
    || delta16.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail("r16 declares a change outside the four additive accessibility keys");
}

const DELTA16_RECORDS = new Set(EXPECTED_DELTA16.records);
const delta16SeenRecords = new Set();
for (const row of delta16.rows) {
  if (seen.has(row.key)) fail(`r16 key "${row.key}" collides with an existing key`);
  seen.add(row.key);
  if (!DELTA16_RECORDS.has(row.record_id)) fail(`r16 key "${row.key}" targets unauthorized record ${JSON.stringify(row.record_id)}`);
  if (row.key !== `training.record.${row.record_id}.alt`) fail(`r16 key "${row.key}" is not its record's alt key`);
  if (delta16SeenRecords.has(row.record_id)) fail(`r16 declares more than one alt key for record "${row.record_id}"`);
  delta16SeenRecords.add(row.record_id);
  if (row.source_revision !== EXPECTED_DELTA16.source_revision) fail(`r16 ${row.key} source_revision mismatch`);
  if (row.scope_status !== "REQUIRED_FOR_PT_LAUNCH") fail(`r16 ${row.key} must be REQUIRED_FOR_PT_LAUNCH`);
  if (row.translation_status !== "APPROVED") fail(`r16 ${row.key} is not APPROVED`);
  if (!row.source_en || !row.pt) fail(`r16 ${row.key} requires non-empty EN and PT values`);
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) fail(`r16 ${row.key} placeholder mismatch`);
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) fail(`r16 ${row.key} violates protected A PRASA brand spelling`);

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}
for (const recordId of EXPECTED_DELTA16.records) {
  if (!delta16SeenRecords.has(recordId)) fail(`r16 is missing the alt key for authorized record "${recordId}"`);
}

// --- r20 delta: additive merge for the Start CV Learning Spotlight ----------
// Supplies the governed EN/PT presentation strings for the incoming Start CV
// Learning Spotlight record (Project 03 English source freeze of 07 September
// 2026 plus the Project 09 Portuguese localization packet of the same date,
// verdict READY_FOR_PROJECT_04_IMPLEMENTATION).
//
// PROVENANCE NOTE — reconciled by the Project 09 ruling of 14 September 2026.
//
// The recovered packet carried `source_revision` "P03-PT-SOURCE-2026-09-07-r15"
// and `previous_revision` "P03-PT-SOURCE-2026-09-06-r14". That r15 label already
// names a DIFFERENT package on main (the weekly-opportunity delta in the r15 FILE
// slot), so it cannot serve as this package's current durable revision identity:
// two distinct approved packages would otherwise stamp the same revision onto
// their generated rows. Project 09 resolved the collision by issuing this package
// its own durable identity,
//
//   P09-PT-LEARNING-SPOTLIGHT-START-CV-2026-09-14-r1
//
// and demoting the two P03 labels to explicit historical provenance fields on the
// package (`legacy_recovered_revision_label`, `legacy_previous_revision_label`,
// `legacy_recovered_from`, `provenance_status`). The demotion is a provenance-only
// reconciliation: the ruling is START_CV_ROWS_CHANGED = 0, and all 13 governed
// EN/PT values remain byte-for-byte as Project 09 approved them. The legacy labels
// are recorded as history and assert no equivalence with main's r15 package.
//
// The FILE slot stays r20. A file-slot name and a governed revision identity are
// separate concerns, no validator ties them together, and renaming the file would
// be churn outside this reconciliation.
//
// Same strictly additive lane as r13/r14/r15: every key must be new, under this
// record's own canonical training.record.start-cv.* namespace, and the package
// may never reopen an approved key. The outgoing Myrtle record keeps all of its
// approved rows untouched — the rotation withdraws only its spotlight
// presentation treatment in data/training-opportunities.json, which is not a
// locale-overlay concern.
//
// Applied BEFORE the r10 rename so the post-condition below (no migrated record
// may retain a legacy home.training.record.* key) still sees the complete key
// table. start-cv has no legacy namespace to migrate: it is authored directly
// on the canonical namespace, which is why it is absent from the r10 manifest.
const EXPECTED_DELTA20 = {
  package_id: "aprasa-pt-start-cv-learning-spotlight-r15-delta",
  revision_class: "ADDITIVE_NEW_KEYS",
  source_revision: "P09-PT-LEARNING-SPOTLIGHT-START-CV-2026-09-14-r1",
  legacy_recovered_revision_label: "P03-PT-SOURCE-2026-09-07-r15",
  legacy_previous_revision_label: "P03-PT-SOURCE-2026-09-06-r14",
  legacy_recovered_from_branch: "origin/feature/learning-spotlight-start-cv-2026-09-v1",
  legacy_recovered_from_commit: "fce564558bbf4ef40943dfe050c53acc7a1b5848",
  record_id: "start-cv",
  row_count: 13,
  approved: 13,
  required_for_pt_launch: 13,
  intentionally_unchanged: 0,
  review_required: 0,
};

const delta20 = JSON.parse(readFileSync(DELTA20_PATH, "utf8"));

for (const field of [
  "package_id",
  "revision_class",
  "source_revision",
  "legacy_recovered_revision_label",
  "legacy_previous_revision_label",
]) {
  if (delta20[field] !== EXPECTED_DELTA20[field]) {
    fail(`r20 ${field} mismatch: got ${JSON.stringify(delta20[field])}, expected ${JSON.stringify(EXPECTED_DELTA20[field])}`);
  }
}
// The current durable identity must be this package's alone. A package that
// re-adopts the recovered P03 label would stamp main's r15 revision onto these
// rows again, which is exactly the collision the 14 September ruling resolved.
if (delta20.source_revision === EXPECTED_DELTA20.legacy_recovered_revision_label) {
  fail(`r20 source_revision must be the durable P09 identity, not the legacy recovered label ${JSON.stringify(EXPECTED_DELTA20.legacy_recovered_revision_label)}`);
}
// `previous_revision` is retired for this package: its chain is recorded in the
// legacy_* provenance fields, so a reintroduced chain field would be ambiguous.
if ("previous_revision" in delta20) {
  fail(`r20 must not declare previous_revision; the legacy chain is recorded in legacy_previous_revision_label`);
}
if (delta20.legacy_recovered_from?.branch !== EXPECTED_DELTA20.legacy_recovered_from_branch) {
  fail(`r20 legacy_recovered_from.branch mismatch: got ${JSON.stringify(delta20.legacy_recovered_from?.branch)}`);
}
if (delta20.legacy_recovered_from?.commit !== EXPECTED_DELTA20.legacy_recovered_from_commit) {
  fail(`r20 legacy_recovered_from.commit mismatch: got ${JSON.stringify(delta20.legacy_recovered_from?.commit)}`);
}
if (typeof delta20.provenance_status !== "string" || delta20.provenance_status.trim() === "") {
  fail(`r20 must record provenance_status describing the legacy label's historical-only standing`);
}
if (delta20.project_09_status !== "approved") {
  fail(`r20 Project 09 status is not approved: ${JSON.stringify(delta20.project_09_status)}`);
}
if (delta20.project_09_verdict !== "READY_FOR_PROJECT_04_IMPLEMENTATION") {
  fail(`r20 Project 09 verdict is not implementation-ready: ${JSON.stringify(delta20.project_09_verdict)}`);
}
if (JSON.stringify(delta20.affected_records) !== JSON.stringify([EXPECTED_DELTA20.record_id])) {
  fail(`r20 affected_records must be exactly ${JSON.stringify([EXPECTED_DELTA20.record_id])}, got ${JSON.stringify(delta20.affected_records)}`);
}
if (!Array.isArray(delta20.rows) || delta20.rows.length !== EXPECTED_DELTA20.row_count) {
  fail(`r20 row count mismatch: got ${delta20.rows?.length}, expected ${EXPECTED_DELTA20.row_count}`);
}
if (delta20.supplied_rows_approved !== EXPECTED_DELTA20.approved) {
  fail(`r20 supplied_rows_approved mismatch: got ${delta20.supplied_rows_approved}`);
}
if (delta20.review_required !== EXPECTED_DELTA20.review_required || delta20.semantic_escalations_required !== 0 || delta20.blocking_issue != null) {
  fail(`r20 has unresolved localization review state`);
}
if (delta20.missing_or_unaccounted_row_count !== 0) {
  fail(`r20 missing_or_unaccounted_row_count is non-zero: ${delta20.missing_or_unaccounted_row_count}`);
}
for (const listField of ["duplicate_keys", "placeholder_mismatches", "a_prasa_to_a_praca_violations"]) {
  if ((delta20[listField] || []).length !== 0) fail(`r20 ${listField} is non-empty: ${JSON.stringify(delta20[listField])}`);
}
if (delta20.source_english_changed !== false || delta20.change_control_status?.existing_keys_overridden !== 0) {
  fail(`r20 declares a non-additive change (source_english_changed/existing_keys_overridden)`);
}
if (delta20.change_control_status?.new_keys_introduced !== EXPECTED_DELTA20.row_count) {
  fail(`r20 new_keys_introduced mismatch: got ${delta20.change_control_status?.new_keys_introduced}`);
}
if (delta20.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail(`r20 must not modify lifecycle or publication state`);
}
if (delta20.change_control_status?.protected_identities_modified !== 0) {
  fail(`r20 must not modify protected identities`);
}

let delta20Required = 0;
let delta20Unchanged = 0;
for (const row of delta20.rows) {
  if (seen.has(row.key)) {
    fail(`r20 key "${row.key}" collides with an existing key — r20 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (row.record_id !== EXPECTED_DELTA20.record_id) {
    fail(`r20 key "${row.key}" declares record "${row.record_id}", outside the authorized record "${EXPECTED_DELTA20.record_id}"`);
  }
  if (!row.key.startsWith(`training.record.${EXPECTED_DELTA20.record_id}.`)) {
    fail(`r20 key "${row.key}" is outside the authorized training.record.${EXPECTED_DELTA20.record_id}.* namespace`);
  }
  if (row.key.startsWith("home.training.record.")) {
    fail(`r20 key "${row.key}" uses the retired home.training.record.* namespace`);
  }
  if (row.source_revision !== EXPECTED_DELTA20.source_revision) fail(`r20 ${row.key} source_revision mismatch`);
  if (row.legacy_recovered_revision_label !== EXPECTED_DELTA20.legacy_recovered_revision_label) {
    fail(`r20 ${row.key} legacy_recovered_revision_label mismatch`);
  }
  if (row.translation_status !== "APPROVED") fail(`r20 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta20Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta20Unchanged += 1;
  else fail(`r20 key "${row.key}" has invalid scope_status`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r20 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (!row.source_en) fail(`r20 key "${row.key}" is missing approved English text`);
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r20 key "${row.key}" placeholder mismatch: en=${JSON.stringify(enPlaceholders)} pt=${JSON.stringify(ptPlaceholders)}`);
  }
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r20 key "${row.key}" violates protected A PRASA brand spelling`);
  }
  if (row.source_en.includes("A PRASA") && !row.pt.includes("A PRASA")) {
    fail(`r20 key "${row.key}" drops the protected brand string A PRASA from its Portuguese value`);
  }
  // Provider identity is locale-independent: it is carried verbatim, never
  // translated away, in every row that names it.
  if (row.source_en.includes("Start CV") && !row.pt.includes("Start CV")) {
    fail(`r20 key "${row.key}" drops the protected provider identity "Start CV" from its Portuguese value`);
  }
  // Project 03 omitted every total language count because the current
  // first-party sources conflict between eight and nine. Neither locale may
  // reintroduce one.
  if (/\b(eight|nine|oito|nove)\b/i.test(`${row.source_en} ${row.pt}`)) {
    fail(`r20 key "${row.key}" states a total language count, which Project 03 intentionally omitted`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta20Required !== EXPECTED_DELTA20.required_for_pt_launch) {
  fail(`r20 required_for_pt_launch mismatch: got ${delta20Required}, expected ${EXPECTED_DELTA20.required_for_pt_launch}`);
}
if (delta20Unchanged !== EXPECTED_DELTA20.intentionally_unchanged) {
  fail(`r20 intentionally_unchanged mismatch: got ${delta20Unchanged}, expected ${EXPECTED_DELTA20.intentionally_unchanged}`);
}

// --- r10 migration: ATOMIC namespace rename, applied last -------------------
//
// Project 09 approved moving the governed Home training presentation keys off
// the legacy `home.training.record.<record_id>.<field>` namespace onto the
// canonical `training.record.<record_id>.<field>` namespace. This is a
// different revision class again: not additive (r3/r4/r5/r7/r8) and not a PT
// value override (r6), but revision_class "RENAME_KEYS".
//
// A rename is the one operation that can silently lose approved text, so the
// guard here is deliberately the strictest in this file. For every row:
//   - the from_key MUST currently exist (nothing renamed out of thin air);
//   - the to_key MUST NOT already exist (no collision, and no possibility of
//     the new namespace quietly shadowing an existing approved value);
//   - the currently effective EN and PT values MUST match the package's
//     declared expected_en / expected_pt BYTE-FOR-BYTE, and the scope_status
//     must match too.
// Only then is the row moved. Every other field of the row (provenance,
// identity_policy, translation_status, source_revision, notes) is carried
// across untouched — the only thing that changes is `key`.
//
// The migration is ATOMIC by construction: the legacy key is deleted in the
// same pass that writes the new one, so the generated table never carries
// both. There is no alias layer and no fallback — a stale consumer that still
// asks for a legacy key gets a hard LocaleLookupError from scripts/lib/locale.mjs,
// which is the intended fail-closed behavior, not a regression.
//
// Scope is exactly the nine currently published Home training records. The
// retired EMAR / Kre+ records keep their legacy keys: they have no generator
// consumer and no counterpart in data/training-opportunities.json, so
// migrating them would move dead rows for no benefit.
const r10Migration = JSON.parse(readFileSync(R10_MIGRATION_PATH, "utf8"));

const EXPECTED_R10 = {
  package_id: "aprasa-pt-training-record-namespace-migration-r10",
  source_revision: "P03-PT-SOURCE-2026-09-01-r10",
  previous_revision: "P03-PT-SOURCE-2026-09-01-r9",
  revision_class: "RENAME_KEYS",
  row_count: 76,
};

if (r10Migration.package_id !== EXPECTED_R10.package_id) {
  fail(`r10 package_id mismatch: got "${r10Migration.package_id}", expected "${EXPECTED_R10.package_id}"`);
}
if (r10Migration.source_revision !== EXPECTED_R10.source_revision) {
  fail(`r10 source_revision mismatch: got "${r10Migration.source_revision}", expected "${EXPECTED_R10.source_revision}"`);
}
if (r10Migration.previous_revision !== EXPECTED_R10.previous_revision) {
  fail(`r10 previous_revision mismatch: got "${r10Migration.previous_revision}", expected "${EXPECTED_R10.previous_revision}"`);
}
if (r10Migration.revision_class !== EXPECTED_R10.revision_class) {
  fail(`r10 revision_class must be ${EXPECTED_R10.revision_class}, got "${r10Migration.revision_class}"`);
}
if (r10Migration.project_09_status !== "approved") {
  fail(`r10 Project 09 status is not approved: "${r10Migration.project_09_status}"`);
}
if (r10Migration.review_required !== 0 || r10Migration.blocking_issue != null) {
  fail(`r10 has unresolved localization review state`);
}
if (!Array.isArray(r10Migration.rows) || r10Migration.rows.length !== EXPECTED_R10.row_count) {
  fail(`r10 row count mismatch: got ${Array.isArray(r10Migration.rows) ? r10Migration.rows.length : "n/a"}, expected ${EXPECTED_R10.row_count}`);
}
if (r10Migration.supplied_rows_approved !== r10Migration.rows.length) {
  fail(`r10 supplied_rows_approved mismatch: got ${r10Migration.supplied_rows_approved}, expected ${r10Migration.rows.length}`);
}

const r10Records = new Set(r10Migration.records || []);
const r10Renamed = [];
const r10Plan = new Map();
const r10SeenFrom = new Set();
const r10SeenTo = new Set();

for (const row of r10Migration.rows) {
  const { from_key: fromKey, to_key: toKey } = row;

  if (!fromKey || !toKey) fail(`r10 row is missing from_key/to_key: ${JSON.stringify(row)}`);
  if (r10SeenFrom.has(fromKey)) fail(`r10 renames "${fromKey}" more than once`);
  if (r10SeenTo.has(toKey)) fail(`r10 targets "${toKey}" more than once`);
  r10SeenFrom.add(fromKey);
  r10SeenTo.add(toKey);

  // The rename must be a pure namespace move of a governed record field: the
  // record_id and field are declared explicitly and both key names must be
  // exactly reconstructible from them, so a row can never smuggle in a
  // renamed/normalized field name alongside the namespace change.
  if (!r10Records.has(row.record_id)) {
    fail(`r10 row "${fromKey}" targets record "${row.record_id}", which is not in the package's declared record list`);
  }
  if (fromKey !== `home.training.record.${row.record_id}.${row.field}`) {
    fail(`r10 from_key "${fromKey}" is not the legacy form of record "${row.record_id}" field "${row.field}"`);
  }
  if (toKey !== `training.record.${row.record_id}.${row.field}`) {
    fail(`r10 to_key "${toKey}" is not the canonical form of record "${row.record_id}" field "${row.field}"`);
  }

  const current = keys[fromKey];
  if (!current) fail(`r10 cannot rename "${fromKey}": key does not exist in the merged overlay`);
  if (keys[toKey]) fail(`r10 cannot rename "${fromKey}" to "${toKey}": target key already exists`);
  if (r10Plan.has(toKey)) fail(`r10 cannot rename "${fromKey}" to "${toKey}": another row is already being renamed away from that key`);

  // Byte-for-byte equivalence assertion across the rename. This is what makes
  // the migration provably text-preserving rather than merely intended to be.
  if (current.en !== row.expected_en) {
    fail(`r10 EN drift on "${fromKey}": overlay has ${JSON.stringify(current.en)}, package declares ${JSON.stringify(row.expected_en)}`);
  }
  if (current.pt !== row.expected_pt) {
    fail(`r10 PT drift on "${fromKey}": overlay has ${JSON.stringify(current.pt)}, package declares ${JSON.stringify(row.expected_pt)}`);
  }
  if (current.scope_status !== row.expected_scope_status) {
    fail(`r10 scope_status drift on "${fromKey}": overlay has "${current.scope_status}", package declares "${row.expected_scope_status}"`);
  }
  if (current.record_id !== row.record_id) {
    fail(`r10 record_id drift on "${fromKey}": overlay has "${current.record_id}", package declares "${row.record_id}"`);
  }
  if (row.translation_status !== "APPROVED") {
    fail(`r10 row "${fromKey}" is not APPROVED (status: ${row.translation_status})`);
  }

  r10Plan.set(fromKey, toKey);
  r10Renamed.push(toKey);
}

// Apply the whole plan in a single ordered rebuild. Renaming in place would
// move every renamed key to the end of the emitted object and turn a 76-key
// rename into a whole-file diff; rebuilding in the original insertion order
// keeps each row where it already was, so the generated table's diff shows
// exactly the key names that changed and nothing else.
const r10Ordered = Object.entries(keys).map(([key, row]) => {
  const toKey = r10Plan.get(key);
  return toKey ? [toKey, { ...row, key: toKey }] : [key, row];
});
for (const key of Object.keys(keys)) delete keys[key];
for (const [key, row] of r10Ordered) keys[key] = row;
for (const [fromKey, toKey] of r10Plan) {
  seen.delete(fromKey);
  seen.add(toKey);
}

// Post-condition: no key from a migrated record may survive under the legacy
// namespace. This catches a partially-declared package (a record field added
// to the overlay later but never added to the rename manifest) rather than
// letting it ship as a silent dual namespace.
for (const key of Object.keys(keys)) {
  if (!key.startsWith("home.training.record.")) continue;
  const rest = key.slice("home.training.record.".length);
  const orphanRecord = [...r10Records].find((id) => rest === id || rest.startsWith(`${id}.`));
  if (orphanRecord) {
    fail(`r10 left "${key}" behind under the legacy namespace — record "${orphanRecord}" is migrated, so every one of its keys must be in the rename manifest (no dual canonical namespace)`);
  }
}

if (r10Renamed.length !== EXPECTED_R10.row_count) {
  fail(`r10 renamed ${r10Renamed.length} keys, expected ${EXPECTED_R10.row_count}`);
}

// --- Governed override packages: FIXED, CODE-SIDE AUTHORIZATION -----------
//
// These packages are the only mechanism that may restate an already-approved
// EN/PT value, so they are the one place where a generic "override" lane could
// quietly become an ungoverned semantic-rewrite lane.
//
// An earlier version of this stage read the package's own `affected_records`,
// `semantic_authority` and row list and validated the package against itself.
// Independent review proved that fence worthless: a probe swapped in unrelated
// authority strings and an unrelated Myrtle rewrite and the builder accepted
// them, because the file being checked was also the file defining what "valid"
// meant. Authority cannot be self-asserted by editable data.
//
// So the authorization contract now lives HERE, in code, frozen, and the
// package is checked against it — never the other way round. The contract
// pins, per package: its file, package/revision identifiers, the exact
// semantic and linguistic authority references, the authorized record ids, and
// the complete set of authorized (key, old_en, new_en, old_pt, new_pt) tuples,
// plus a SHA-256 digest over those tuples. The package supplies no authority of
// its own; every field it declares must equal the pinned value.
//
// Consequence: a package can only ever apply exactly the replacements already
// enumerated below. An extra row, a missing row, a different key, a different
// record, a nudged replacement string, an altered baseline, a renamed package
// or a reworded authority reference all fail closed, because none of them can
// match the frozen tuple map or its digest. Changing what is authorized
// requires a reviewed code change, not a data edit.
const GOVERNED_OVERRIDE_CONTRACTS = Object.freeze([
  Object.freeze({
    label: "r11",
    file: "pt-overlay-r11-review-due-copy.source.json",
    package_id: "aprasa-training-review-due-copy-r11",
    revision_class: "OVERRIDE_EXISTING_KEYS",
    source_revision: "P03-PT-SOURCE-2026-09-01-r11",
    previous_revision: "P03-PT-SOURCE-2026-09-01-r10",
    semantic_authority: "Project 03 — REVIEW-DUE public-copy ruling of 01 September 2026",
    linguistic_authority: "Project 09 — approved EN/PT strings",
    records: Object.freeze(["kafe-djan-djan", "academia-crescer"]),
    tuples_digest: "3dfb05ec5518cf382d23b4109534d29c81c3917b6eb64225db56fcf55e354d3f",
    tuples: Object.freeze([
      Object.freeze({
        key: "training.record.kafe-djan-djan.status",
        old_en: "Hiring now · Mindelo",
        new_en: "Assistente de Restauração · Mindelo",
        old_pt: "A contratar agora · Mindelo",
        new_pt: "Assistente de Restauração · Mindelo",
      }),
      Object.freeze({
        key: "training.record.kafe-djan-djan.meta",
        old_en: "Kafê Livraria Galeria · walk-in interviews Mon–Fri 11:00–14:00",
        new_en: "Kafê Livraria Galeria",
        old_pt: "Kafê Livraria Galeria · entrevistas presenciais de segunda a sexta, 11:00–14:00",
        new_pt: "Kafê Livraria Galeria",
      }),
      Object.freeze({
        key: "training.record.kafe-djan-djan.good",
        old_en: "Prior experience is a plus but not required. No salary, benefits, phone number, email or application deadline were shown on the flyer, so none are listed here. Apply in person during the stated hours.",
        new_en: "Prior experience is a plus but not required. No salary, benefits, phone number, email or application deadline were shown on the flyer, so none are listed here.",
        old_pt: "A experiência prévia é valorizada, mas não obrigatória. O folheto não indicava salário, benefícios, número de telefone, e-mail nem prazo de candidatura, por isso esses elementos não são apresentados aqui. Candidate-se presencialmente durante o horário indicado.",
        new_pt: "A experiência prévia é valorizada, mas não obrigatória. O folheto não indicava salário, benefícios, número de telefone, e-mail nem prazo de candidatura, por isso esses elementos não são apresentados aqui.",
      }),
      Object.freeze({
        key: "training.record.academia-crescer.status",
        old_en: "Recruiting for 2026/2027 · Confirm current availability",
        new_en: "2026/2027 study-room monitor recruitment",
        old_pt: "A recrutar para 2026/2027 · Confirme a disponibilidade atual",
        new_pt: "Recrutamento de monitor de sala de estudo 2026/2027",
      }),
      Object.freeze({
        key: "training.record.academia-crescer.body",
        old_en: "Academia de Estudo Crescer is recruiting study-room monitors for Mathematics, Basic Education, Special Education and Physics/Chemistry for the 2026/2027 school year.",
        new_en: "Confirm current availability with Academia de Estudo Crescer.",
        old_pt: "A Academia de Estudo Crescer está a recrutar monitores de sala de estudo para Matemática, Ensino Básico, Educação Especial e Física/Química para o ano letivo de 2026/2027.",
        new_pt: "Confirme a disponibilidade atual junto da Academia de Estudo Crescer.",
      }),
    ]),
  }),
  Object.freeze({
    label: "r12",
    file: "pt-overlay-r12-academia-cv-statement.source.json",
    package_id: "aprasa-academia-cv-statement-removal-r12",
    revision_class: "OVERRIDE_EXISTING_KEYS",
    source_revision: "P03-PT-SOURCE-2026-09-01-r12",
    previous_revision: "P03-PT-SOURCE-2026-09-01-r11",
    semantic_authority: "Project 03 — REVIEW-DUE public-copy ruling of 01 September 2026",
    linguistic_authority: "Project 09 — approved EN/PT strings",
    records: Object.freeze(["academia-crescer"]),
    tuples_digest: "bd6f76798ad163aea53d8b3c9dcd58a532ea6ca70979f239bfef66271b9752cb",
    tuples: Object.freeze([
      Object.freeze({
        key: "training.record.academia-crescer.good",
        old_en: "CVs are accepted at the Madeiralzinho or Monte Sossego secretariats during the hours published on the recruitment notice. No application deadline is shown on the poster, so confirm that recruitment is still open before submitting.",
        new_en: "No application deadline is shown on the poster, so confirm that recruitment is still open before submitting.",
        old_pt: "Os CV são aceites nas secretarias de Madeiralzinho ou Monte Sossego durante o horário publicado no anúncio de recrutamento. O cartaz não indica prazo de candidatura, por isso confirme se o recrutamento continua aberto antes de entregar a candidatura.",
        new_pt: "O cartaz não indica prazo de candidatura, por isso confirme se o recrutamento continua aberto antes de entregar a candidatura.",
      }),
    ]),
  }),
  Object.freeze({
    label: "r24",
    file: "pt-overlay-r24-ibm-skillsbuild-checked-refresh.source.json",
    package_id: "aprasa-ibm-skillsbuild-checked-refresh-r24",
    revision_class: "OVERRIDE_EXISTING_KEYS",
    source_revision: "P03-PT-SOURCE-2026-09-17-r24",
    previous_revision: "P03-PT-SOURCE-2026-09-01-r12",
    semantic_authority:
      'Project 03 — IMPLEMENTATION_INPUTS_COMPLETE, relayed by the Project 04 Manager / Control Tower task order "Trainings & Opportunities Home Expansion", 18 September 2026',
    linguistic_authority: "Project 09 — approved EN/PT strings",
    records: Object.freeze(["ibm-skillsbuild"]),
    tuples_digest: "5df8ee064e9e030fc62e990a0d0ecd814cbc76c43a81d55de23b83100f6d90eb",
    tuples: Object.freeze([
      Object.freeze({
        key: "training.record.ibm-skillsbuild.checked",
        old_en: "Checked 10 August 2026",
        new_en: "Checked 17 September 2026",
        old_pt: "Revisto em 10 de agosto de 2026",
        new_pt: "Revisto em 17 de setembro de 2026",
      }),
      Object.freeze({
        key: "training.record.ibm-skillsbuild.detail_checked",
        old_en: "Checked 10 August 2026 against information published by the provider.",
        new_en: "Checked 17 September 2026 against information published by the provider.",
        old_pt: "Revisto em 10 de agosto de 2026 com base em informações publicadas pela entidade.",
        new_pt: "Revisto em 17 de setembro de 2026 com base em informações publicadas pelo prestador.",
      }),
    ]),
  }),,
  Object.freeze({
    label: "r27",
    file: "pt-overlay-r27-unicv-erasmus-unipvc-deadline-extension.source.json",
    package_id: "aprasa-unicv-erasmus-unipvc-deadline-extension-r27",
    revision_class: "OVERRIDE_EXISTING_KEYS",
    source_revision: "P03-PT-SOURCE-2026-09-22-r27",
    previous_revision: "P03-PT-SOURCE-2026-09-07-r15",
    semantic_authority: "Project 03 → Project 04 — URGENT ERASMUS+ UNIPVC PUBLICATION, 22 September 2026",
    linguistic_authority: "Approved EN/PT public payload supplied in the Project 03 → Project 04 urgent implementation handoff of 22 September 2026; no separate Project 09 package/revision ID supplied.",
    records: Object.freeze(["unicv-erasmus-viana-do-castelo-edital-027-2026"]),
    tuples_digest: "89ed7056100d378e44f683dfeb43b9caaf85ddf2b51f7b89a9c9a5067641e8f3",
    tuples: Object.freeze([
      Object.freeze({
        key: "training.record.unicv-erasmus-viana-do-castelo-edital-027-2026.title",
        old_en: "Uni-CV Erasmus+ Student Mobility — Universidade Politécnica de Viana do Castelo",
        new_en: "Erasmus+ Study Mobility — UNIPVC, Portugal",
        old_pt: "Mobilidade de Estudantes Erasmus+ da Uni-CV — Universidade Politécnica de Viana do Castelo",
        new_pt: "Mobilidade de Estudos Erasmus+ — UNIPVC, Portugal",
      }),
      Object.freeze({
        key: "training.record.unicv-erasmus-viana-do-castelo-edital-027-2026.status",
        old_en: "10 September 2026",
        new_en: "Apply by 25 September",
        old_pt: "10 de setembro de 2026",
        new_pt: "Candidate-se até 25 de setembro",
      }),
      Object.freeze({
        key: "training.record.unicv-erasmus-viana-do-castelo-edital-027-2026.meta",
        old_en: "2 Erasmus+ student mobility scholarships. No monetary scholarship amount is established in the approved evidence.",
        new_en: "The call provides two Erasmus+ student-mobility scholarships for four months. The governing edital does not state the exact grant amount or a detailed covered-cost schedule.",
        old_pt: "2 bolsas de mobilidade de estudantes Erasmus+. Não está estabelecido, na documentação aprovada, qualquer montante monetário da bolsa.",
        new_pt: "A chamada disponibiliza duas bolsas de mobilidade Erasmus+ para estudantes, com a duração de quatro meses. O edital aplicável não indica o montante exato da bolsa nem uma discriminação detalhada dos custos cobertos.",
      }),
      Object.freeze({
        key: "training.record.unicv-erasmus-viana-do-castelo-edital-027-2026.body",
        old_en: "Uni-CV is accepting applications for two Erasmus+ student mobility scholarships with Universidade Politécnica de Viana do Castelo in Portugal.",
        new_en: "Uni-CV students can apply for one of two four-month Erasmus+ study mobilities at Universidade Politécnica de Viana do Castelo in Portugal, planned for the second semester of 2026/27.",
        old_pt: "A Uni-CV está a aceitar candidaturas para duas bolsas de mobilidade de estudantes Erasmus+ com a Universidade Politécnica de Viana do Castelo, em Portugal.",
        new_pt: "Os estudantes da Uni-CV podem candidatar-se a uma de duas mobilidades de estudos Erasmus+ com a duração de quatro meses na Universidade Politécnica de Viana do Castelo, em Portugal, previstas para o segundo semestre de 2026/27.",
      }),
      Object.freeze({
        key: "training.record.unicv-erasmus-viana-do-castelo-edital-027-2026.how_to_apply",
        old_en: "Apply by email to gepc.mobilidade@unicv.cv with the required documents: updated academic transcript, proof of enrolment, CV, identification document and passport copy, motivation letter, institutional nomination or support declaration, proposed study plan, and English-proficiency certificate.",
        new_en: "Applications must be submitted exclusively by email to gepc.mobilidade@unicv.cv.\n\nOpen to current Uni-CV students. The governing edital does not state a campus restriction or a closed list of eligible study areas.\n\nApplications are assessed on study-plan relevance (30%), motivation (30%), language proficiency (20%) and no previous participation in mobility (20%).\n\nNo closing hour stated",
        old_pt: "Candidate-se por email para gepc.mobilidade@unicv.cv, enviando os documentos exigidos: histórico académico atualizado, comprovativo de matrícula, CV, documento de identificação e cópia do passaporte, carta de motivação, declaração institucional de nomeação ou apoio, plano de estudos proposto e certificado de proficiência em inglês.",
        new_pt: "As candidaturas devem ser submetidas exclusivamente por email para gepc.mobilidade@unicv.cv.\n\nAberto a atuais estudantes da Uni-CV. O edital aplicável não estabelece uma restrição de campus nem uma lista fechada de áreas de estudo elegíveis.\n\nAs candidaturas são avaliadas com base na relevância do plano de estudos (30%), motivação (30%), proficiência linguística (20%) e ausência de participação anterior em mobilidade (20%).\n\nNão é indicada qualquer hora de encerramento",
      }),
      Object.freeze({
        key: "training.record.unicv-erasmus-viana-do-castelo-edital-027-2026.requirements",
        old_en: "Applicants must be students at Uni-CV.",
        new_en: "Applicants must submit an updated academic transcript, proof of current enrollment, CV, copy of an identification document, passport, motivation letter, a valid support declaration from their Uni-CV academic department, a proposed study plan and an English-proficiency certificate. English proficiency must be at least B2.",
        old_pt: "Os candidatos devem ser estudantes da Uni-CV.",
        new_pt: "Os candidatos devem apresentar um histórico académico atualizado, comprovativo de matrícula atual, CV, cópia de um documento de identificação, passaporte, carta de motivação, uma declaração de apoio válida do respetivo departamento académico da Uni-CV, uma proposta de plano de estudos e um certificado de proficiência em inglês. A proficiência em inglês deve ser, no mínimo, de nível B2.",
      }),
      Object.freeze({
        key: "training.record.unicv-erasmus-viana-do-castelo-edital-027-2026.good",
        old_en: "Applications are competitive. Missing documentation or applications submitted after the deadline are not considered. Selection criteria include study-plan relevance, motivation, language proficiency and previous mobility participation.",
        new_en: "The mobility is planned for the second semester of 2026/27, between February and July 2027. The mobility itself lasts four months. The governing edital does not state the exact scholarship amount, travel allowance, monthly support, green-travel supplement or detailed covered-cost structure.",
        old_pt: "As candidaturas são sujeitas a seleção. Candidaturas incompletas ou submetidas após o prazo não são consideradas. Os critérios de seleção incluem a relevância do plano de estudos, a motivação, a proficiência linguística e a participação anterior em programas de mobilidade.",
        new_pt: "A mobilidade está prevista para o segundo semestre de 2026/27, entre fevereiro e julho de 2027. A mobilidade propriamente dita tem a duração de quatro meses. O edital aplicável não indica o montante exato da bolsa, qualquer subsídio de viagem, apoio mensal, suplemento para viagens ecológicas nem uma estrutura detalhada dos custos cobertos.",
      }),
      Object.freeze({
        key: "training.record.unicv-erasmus-viana-do-castelo-edital-027-2026.checked",
        old_en: "Checked 7 September 2026 against the official Uni-CV Erasmus+ announcement and the supplied Edital 027.",
        new_en: "Checked 22 September 2026",
        old_pt: "Revisto em 7 de setembro de 2026 com base no anúncio oficial da Uni-CV sobre o Erasmus+ e no Edital 027 fornecido.",
        new_pt: "Revisto em 22 de setembro de 2026",
      }),
      Object.freeze({
        key: "training.record.unicv-erasmus-viana-do-castelo-edital-027-2026.detail_checked",
        old_en: "Checked 7 September 2026 against the official Uni-CV Erasmus+ announcement and the supplied Edital 027.",
        new_en: "Checked 22 September 2026 against the governing Uni-CV edital and the current deadline-extension notice.",
        old_pt: "Revisto em 7 de setembro de 2026 com base no anúncio oficial da Uni-CV sobre o Erasmus+ e no Edital 027 fornecido.",
        new_pt: "Revisto em 22 de setembro de 2026 com base no edital aplicável da Uni-CV e no aviso atual de prorrogação do prazo.",
      }),
      Object.freeze({
        key: "training.record.unicv-erasmus-viana-do-castelo-edital-027-2026.action",
        old_en: "View application details",
        new_en: "Apply by email",
        old_pt: "Ver detalhes da candidatura",
        new_pt: "Candidatar-se por email",
      }),
      Object.freeze({
        key: "training.record.unicv-erasmus-viana-do-castelo-edital-027-2026.fact.programme_dates",
        old_en: "4-month mobility during the second semester of 2027; the official edital identifies February to July 2027 as the mobility period.",
        new_en: "The mobility is planned for the second semester of 2026/27, between February and July 2027. The mobility itself lasts four months.",
        old_pt: "Mobilidade de 4 meses durante o segundo semestre de 2027; o edital oficial identifica fevereiro a julho de 2027 como o período de mobilidade.",
        new_pt: "A mobilidade está prevista para o segundo semestre de 2026/27, entre fevereiro e julho de 2027. A mobilidade propriamente dita tem a duração de quatro meses.",
      })
    ]),
  }),
);

function tuplesDigest(tuples) {
  const canonical = [...tuples]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((t) => [t.key, t.old_en, t.new_en, t.old_pt, t.new_pt]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const governedOverrideResults = [];

for (const contract of GOVERNED_OVERRIDE_CONTRACTS) {
  const tag = contract.label;

  // Self-check: the frozen tuples must still hash to the pinned digest. This
  // catches an edit to the contract itself that did not go through the digest.
  if (tuplesDigest(contract.tuples) !== contract.tuples_digest) {
    fail(`${tag} contract tuples do not match their pinned digest — the authorization contract has been edited without updating tuples_digest`);
  }

  const pkg = JSON.parse(readFileSync(path.join(LOCALE_DIR, contract.file), "utf8"));

  // Every identity/authority field is compared against the pinned value. The
  // package declares them; it does not get to define them.
  for (const field of ["package_id", "revision_class", "source_revision", "previous_revision", "semantic_authority", "linguistic_authority"]) {
    if (pkg[field] !== contract[field]) {
      fail(`${tag} ${field} is not the authorized value: got ${JSON.stringify(pkg[field])}, authorized ${JSON.stringify(contract[field])}`);
    }
  }
  if (pkg.project_09_status !== "approved") fail(`${tag} Project 09 status is not approved: ${JSON.stringify(pkg.project_09_status)}`);
  if (pkg.review_required !== 0 || pkg.semantic_escalations_required !== 0 || pkg.blocking_issue != null) {
    fail(`${tag} has unresolved localization review state`);
  }
  if (pkg.change_control_status?.new_keys_introduced !== 0) fail(`${tag} must introduce no new keys`);
  if (pkg.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
    fail(`${tag} must not modify lifecycle or publication state`);
  }

  // The declared record set must equal the authorized record set exactly.
  const declaredRecords = [...(pkg.affected_records || [])].sort();
  const authorizedRecords = [...contract.records].sort();
  if (JSON.stringify(declaredRecords) !== JSON.stringify(authorizedRecords)) {
    fail(`${tag} affected_records is not the authorized set: got ${JSON.stringify(declaredRecords)}, authorized ${JSON.stringify(authorizedRecords)}`);
  }

  if (!Array.isArray(pkg.rows)) fail(`${tag} rows must be an array`);
  if (pkg.rows.length !== contract.tuples.length) {
    fail(`${tag} row count is not authorized: got ${pkg.rows.length}, authorized ${contract.tuples.length}`);
  }
  if (pkg.supplied_rows_approved !== pkg.rows.length) {
    fail(`${tag} supplied_rows_approved mismatch: got ${pkg.supplied_rows_approved}`);
  }

  const authorizedByKey = new Map(contract.tuples.map((t) => [t.key, t]));
  const appliedKeys = new Set();

  for (const row of pkg.rows) {
    const tuple = authorizedByKey.get(row.key);
    if (!tuple) {
      fail(`${tag} row "${row.key}" is not an authorized target key`);
    }
    if (appliedKeys.has(row.key)) fail(`${tag} overrides "${row.key}" more than once`);
    appliedKeys.add(row.key);

    // The full tuple must match the frozen contract, in both directions and
    // both locales. This is what stops a replacement string being nudged.
    for (const field of ["old_en", "new_en", "old_pt", "new_pt"]) {
      if (row[field] !== tuple[field]) {
        fail(`${tag} row "${row.key}" ${field} is not the authorized value: got ${JSON.stringify(row[field])}, authorized ${JSON.stringify(tuple[field])}`);
      }
    }
    if (!contract.records.includes(row.record_id) || !row.key.startsWith(`training.record.${row.record_id}.`)) {
      fail(`${tag} row "${row.key}" targets record "${row.record_id}", which is outside the authorized records`);
    }
    if (row.translation_status !== "APPROVED") fail(`${tag} row "${row.key}" is not APPROVED`);

    // Baseline drift guard: the live overlay must still hold the authorized
    // old_en/old_pt before anything is written.
    const current = keys[row.key];
    if (!current) fail(`${tag} cannot override "${row.key}": key does not exist in the merged overlay`);
    if (current.en !== tuple.old_en) {
      fail(`${tag} EN baseline drift on "${row.key}": overlay has ${JSON.stringify(current.en)}, authorized old_en ${JSON.stringify(tuple.old_en)}`);
    }
    if (current.pt !== tuple.old_pt) {
      fail(`${tag} PT baseline drift on "${row.key}": overlay has ${JSON.stringify(current.pt)}, authorized old_pt ${JSON.stringify(tuple.old_pt)}`);
    }

    keys[row.key] = { ...current, en: tuple.new_en, pt: tuple.new_pt, source_revision: contract.source_revision };
  }

  // Every authorized tuple must actually have been applied — a package that
  // silently drops a row cannot leave a governed value un-corrected.
  for (const key of authorizedByKey.keys()) {
    if (!appliedKeys.has(key)) fail(`${tag} is missing authorized row "${key}"`);
  }

  governedOverrideResults.push({
    label: tag,
    package_id: contract.package_id,
    source_revision: contract.source_revision,
    revision_class: contract.revision_class,
    overridden_keys: appliedKeys.size,
    tuples_digest: contract.tuples_digest,
  });
}

const governedOverrideCount = governedOverrideResults.reduce((n, r) => n + r.overridden_keys, 0);

// --- r17 delta: additive merge for the runtime contact-panel copy ----------
// Supplies the approved EN/PT values for the on-site contact panel opened by
// the floating WhatsApp launcher. Like the media-fallback strings, this copy is
// injected by prasa-launch.js at runtime rather than baked into the page, so it
// reaches the surface through the governed i18n-strings block and never through
// a translation hardcoded in the runtime. Strictly additive on the same lane as
// r13/r14: it may never reopen an existing key.
const EXPECTED_DELTA17 = {
  package_id: "aprasa-pt-runtime-whatsapp-launcher",
  revision_class: "ADDITIVE_RUNTIME_KEYS",
  source_revision: "P09-PT-RUNTIME-WHATSAPP-LAUNCHER-2026-09-12-r1",
  previous_revision: "P04-MEDIA-ALT-2026-09-11-r16",
  row_count: 8,
  approved: 8,
  required_for_pt_launch: 8,
  intentionally_unchanged: 0,
  review_required: 0,
};

const delta17 = JSON.parse(readFileSync(DELTA17_PATH, "utf8"));

for (const field of ["package_id", "revision_class", "source_revision", "previous_revision"]) {
  if (delta17[field] !== EXPECTED_DELTA17[field]) {
    fail(`r17 ${field} mismatch: got ${JSON.stringify(delta17[field])}, expected ${JSON.stringify(EXPECTED_DELTA17[field])}`);
  }
}
if (delta17.project_09_status !== "approved") {
  fail(`r17 Project 09 status is not approved: ${JSON.stringify(delta17.project_09_status)}`);
}
if (!Array.isArray(delta17.rows) || delta17.rows.length !== EXPECTED_DELTA17.row_count) {
  fail(`r17 row count mismatch: got ${delta17.rows?.length}, expected ${EXPECTED_DELTA17.row_count}`);
}
if (delta17.supplied_rows_approved !== EXPECTED_DELTA17.approved) {
  fail(`r17 supplied_rows_approved mismatch: got ${delta17.supplied_rows_approved}`);
}
if (delta17.review_required !== EXPECTED_DELTA17.review_required
  || delta17.blocking_issue != null
  || delta17.semantic_escalations_required !== 0) {
  // semantic_escalations_required is part of the unresolved-state gate here
  // for the same reason it is for r6/r9/r16 and the governed override
  // packages: a package can declare itself linguistically approved while
  // still holding an open semantic escalation, and publishing those rows
  // would ship copy whose meaning is still in dispute.
  fail("r17 has unresolved localization review state");
}
if (delta17.missing_or_unaccounted_row_count !== 0) {
  fail(`r17 missing_or_unaccounted_row_count is non-zero: ${delta17.missing_or_unaccounted_row_count}`);
}
for (const listField of ["duplicate_keys", "placeholder_mismatches", "a_prasa_to_a_praca_violations"]) {
  if ((delta17[listField] || []).length !== 0) fail(`r17 ${listField} is non-empty: ${JSON.stringify(delta17[listField])}`);
}
if (delta17.source_english_changed !== false || delta17.change_control_status?.existing_keys_overridden !== 0) {
  fail("r17 declares a non-additive change (source_english_changed/existing_keys_overridden)");
}
if (delta17.change_control_status?.new_keys_introduced !== EXPECTED_DELTA17.row_count) {
  fail(`r17 new_keys_introduced mismatch: got ${delta17.change_control_status?.new_keys_introduced}`);
}
if (delta17.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail("r17 must not modify lifecycle or publication state");
}
if (delta17.semantic_change !== false) {
  fail("r17 declares a semantic change; this package is runtime presentation copy only");
}
if (delta17.target_language !== "pt") {
  fail(`r17 target_language mismatch: got ${JSON.stringify(delta17.target_language)}`);
}

let delta17Required = 0;
let delta17Unchanged = 0;
for (const row of delta17.rows) {
  if (seen.has(row.key)) {
    fail(`r17 key "${row.key}" collides with an existing key — r17 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (row.record_id != null) fail(`r17 key "${row.key}" is record-scoped; this package carries no record copy`);
  if (!/^runtime\.whatsapp_launcher\./.test(row.key)) {
    fail(`r17 key "${row.key}" is outside the authorized runtime.whatsapp_launcher.* namespace`);
  }
  if (row.source_revision !== EXPECTED_DELTA17.source_revision) fail(`r17 ${row.key} source_revision mismatch`);
  if (row.translation_status !== "APPROVED") fail(`r17 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta17Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta17Unchanged += 1;
  else fail(`r17 key "${row.key}" has invalid scope_status`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r17 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (!row.source_en) fail(`r17 key "${row.key}" is missing approved English text`);
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r17 key "${row.key}" placeholder mismatch: en=${JSON.stringify(enPlaceholders)} pt=${JSON.stringify(ptPlaceholders)}`);
  }
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r17 key "${row.key}" violates protected A PRASA brand spelling`);
  }
  if (row.source_en.includes("A PRASA") && !row.pt.includes("A PRASA")) {
    fail(`r17 key "${row.key}" drops the protected brand string A PRASA from its Portuguese value`);
  }
  // WhatsApp is a third-party product name: it is never translated away.
  if (row.source_en.includes("WhatsApp") && !row.pt.includes("WhatsApp")) {
    fail(`r17 key "${row.key}" drops the product name WhatsApp from its Portuguese value`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta17Required !== EXPECTED_DELTA17.required_for_pt_launch) {
  fail(`r17 required_for_pt_launch mismatch: got ${delta17Required}, expected ${EXPECTED_DELTA17.required_for_pt_launch}`);
}
if (delta17Unchanged !== EXPECTED_DELTA17.intentionally_unchanged) {
  fail(`r17 intentionally_unchanged mismatch: got ${delta17Unchanged}, expected ${EXPECTED_DELTA17.intentionally_unchanged}`);
}

// --- r18 delta: additive merge for the floating Down control's name --------
// Supplies the approved EN/PT accessible name for the floating Down control on
// surfaces with no governed in-page section nav. Home is unaffected: it keeps
// its section-aware Down, named from its own nav anchors. Same strictly
// additive lane as r17, and it may never reopen an existing key.
const EXPECTED_DELTA18 = {
  package_id: "aprasa-pt-ui-scroll-down",
  revision_class: "ADDITIVE_RUNTIME_KEYS",
  source_revision: "P09-PT-UI-SCROLL-DOWN-2026-09-13-r1",
  previous_revision: "P09-PT-RUNTIME-WHATSAPP-LAUNCHER-2026-09-12-r1",
  row_count: 1,
  approved: 1,
  required_for_pt_launch: 1,
  intentionally_unchanged: 0,
  review_required: 0,
};

const delta18 = JSON.parse(readFileSync(DELTA18_PATH, "utf8"));

for (const field of ["package_id", "revision_class", "source_revision", "previous_revision"]) {
  if (delta18[field] !== EXPECTED_DELTA18[field]) {
    fail(`r18 ${field} mismatch: got ${JSON.stringify(delta18[field])}, expected ${JSON.stringify(EXPECTED_DELTA18[field])}`);
  }
}
if (delta18.project_09_status !== "approved") {
  fail(`r18 Project 09 status is not approved: ${JSON.stringify(delta18.project_09_status)}`);
}
if (!Array.isArray(delta18.rows) || delta18.rows.length !== EXPECTED_DELTA18.row_count) {
  fail(`r18 row count mismatch: got ${delta18.rows?.length}, expected ${EXPECTED_DELTA18.row_count}`);
}
if (delta18.supplied_rows_approved !== EXPECTED_DELTA18.approved) {
  fail(`r18 supplied_rows_approved mismatch: got ${delta18.supplied_rows_approved}`);
}
if (delta18.review_required !== EXPECTED_DELTA18.review_required
  || delta18.blocking_issue != null
  || delta18.semantic_escalations_required !== 0) {
  fail("r18 has unresolved localization review state");
}
if (delta18.missing_or_unaccounted_row_count !== 0) {
  fail(`r18 missing_or_unaccounted_row_count is non-zero: ${delta18.missing_or_unaccounted_row_count}`);
}
for (const listField of ["duplicate_keys", "placeholder_mismatches", "a_prasa_to_a_praca_violations"]) {
  if ((delta18[listField] || []).length !== 0) fail(`r18 ${listField} is non-empty: ${JSON.stringify(delta18[listField])}`);
}
if (delta18.source_english_changed !== false || delta18.change_control_status?.existing_keys_overridden !== 0) {
  fail("r18 declares a non-additive change (source_english_changed/existing_keys_overridden)");
}
if (delta18.change_control_status?.new_keys_introduced !== EXPECTED_DELTA18.row_count) {
  fail(`r18 new_keys_introduced mismatch: got ${delta18.change_control_status?.new_keys_introduced}`);
}
if (delta18.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail("r18 must not modify lifecycle or publication state");
}
if (delta18.semantic_change !== false) {
  fail("r18 declares a semantic change; this package is runtime presentation copy only");
}
if (delta18.target_language !== "pt") {
  fail(`r18 target_language mismatch: got ${JSON.stringify(delta18.target_language)}`);
}

let delta18Required = 0;
let delta18Unchanged = 0;
for (const row of delta18.rows) {
  if (seen.has(row.key)) {
    fail(`r18 key "${row.key}" collides with an existing key — r18 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (row.record_id != null) fail(`r18 key "${row.key}" is record-scoped; this package carries no record copy`);
  if (row.key !== "ui.scroll_down") {
    fail(`r18 key "${row.key}" is outside the single authorized key ui.scroll_down`);
  }
  if (row.source_revision !== EXPECTED_DELTA18.source_revision) fail(`r18 ${row.key} source_revision mismatch`);
  if (row.translation_status !== "APPROVED") fail(`r18 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta18Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta18Unchanged += 1;
  else fail(`r18 key "${row.key}" has invalid scope_status`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r18 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (!row.source_en) fail(`r18 key "${row.key}" is missing approved English text`);
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r18 key "${row.key}" placeholder mismatch`);
  }
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r18 key "${row.key}" violates protected A PRASA brand spelling`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta18Required !== EXPECTED_DELTA18.required_for_pt_launch) {
  fail(`r18 required_for_pt_launch mismatch: got ${delta18Required}`);
}
if (delta18Unchanged !== EXPECTED_DELTA18.intentionally_unchanged) {
  fail(`r18 intentionally_unchanged mismatch: got ${delta18Unchanged}`);
}

// --- r19 delta: additive merge for the WhatsApp quick-action prefills -------
// Four starter messages, one per governed quick action. There is deliberately
// no fifth generic message: a visitor who selects nothing keeps the incumbent
// short-link destination. Same strictly additive lane as r17/r18.
const EXPECTED_DELTA19 = {
  package_id: "aprasa-pt-runtime-whatsapp-prefill",
  revision_class: "ADDITIVE_RUNTIME_KEYS",
  source_revision: "P09-PT-RUNTIME-WHATSAPP-PREFILL-2026-09-13-r1",
  previous_revision: "P09-PT-UI-SCROLL-DOWN-2026-09-13-r1",
  row_count: 4,
  approved: 4,
  required_for_pt_launch: 4,
  intentionally_unchanged: 0,
  review_required: 0,
};

// The four authorized keys, pinned. A fifth prefill would be an ungoverned
// generic message, which this tranche explicitly refuses.
const DELTA19_KEYS = new Set([
  "runtime.whatsapp_launcher.prefill.share",
  "runtime.whatsapp_launcher.prefill.correction",
  "runtime.whatsapp_launcher.prefill.question",
  "runtime.whatsapp_launcher.prefill.submissions",
]);

const delta19 = JSON.parse(readFileSync(DELTA19_PATH, "utf8"));

for (const field of ["package_id", "revision_class", "source_revision", "previous_revision"]) {
  if (delta19[field] !== EXPECTED_DELTA19[field]) {
    fail(`r19 ${field} mismatch: got ${JSON.stringify(delta19[field])}, expected ${JSON.stringify(EXPECTED_DELTA19[field])}`);
  }
}
if (delta19.project_09_status !== "approved") {
  fail(`r19 Project 09 status is not approved: ${JSON.stringify(delta19.project_09_status)}`);
}
if (!Array.isArray(delta19.rows) || delta19.rows.length !== EXPECTED_DELTA19.row_count) {
  fail(`r19 row count mismatch: got ${delta19.rows?.length}, expected ${EXPECTED_DELTA19.row_count}`);
}
if (delta19.supplied_rows_approved !== EXPECTED_DELTA19.approved) {
  fail(`r19 supplied_rows_approved mismatch: got ${delta19.supplied_rows_approved}`);
}
if (delta19.review_required !== EXPECTED_DELTA19.review_required
  || delta19.blocking_issue != null
  || delta19.semantic_escalations_required !== 0) {
  fail("r19 has unresolved localization review state");
}
if (delta19.missing_or_unaccounted_row_count !== 0) {
  fail(`r19 missing_or_unaccounted_row_count is non-zero: ${delta19.missing_or_unaccounted_row_count}`);
}
for (const listField of ["duplicate_keys", "placeholder_mismatches", "a_prasa_to_a_praca_violations"]) {
  if ((delta19[listField] || []).length !== 0) fail(`r19 ${listField} is non-empty: ${JSON.stringify(delta19[listField])}`);
}
if (delta19.source_english_changed !== false || delta19.change_control_status?.existing_keys_overridden !== 0) {
  fail("r19 declares a non-additive change (source_english_changed/existing_keys_overridden)");
}
if (delta19.change_control_status?.new_keys_introduced !== EXPECTED_DELTA19.row_count) {
  fail(`r19 new_keys_introduced mismatch: got ${delta19.change_control_status?.new_keys_introduced}`);
}
if (delta19.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail("r19 must not modify lifecycle or publication state");
}
if (delta19.semantic_change !== false) {
  fail("r19 declares a semantic change; this package is runtime presentation copy only");
}
if (delta19.target_language !== "pt") {
  fail(`r19 target_language mismatch: got ${JSON.stringify(delta19.target_language)}`);
}

let delta19Required = 0;
let delta19Unchanged = 0;
const delta19Seen = new Set();
for (const row of delta19.rows) {
  if (seen.has(row.key)) {
    fail(`r19 key "${row.key}" collides with an existing key — r19 must be strictly additive`);
  }
  seen.add(row.key);

  if (row.record_id != null) fail(`r19 key "${row.key}" is record-scoped; this package carries no record copy`);
  if (!DELTA19_KEYS.has(row.key)) {
    fail(`r19 key "${row.key}" is outside the four authorized quick-action prefill keys`);
  }
  if (delta19Seen.has(row.key)) fail(`r19 declares "${row.key}" more than once`);
  delta19Seen.add(row.key);
  if (row.source_revision !== EXPECTED_DELTA19.source_revision) fail(`r19 ${row.key} source_revision mismatch`);
  if (row.translation_status !== "APPROVED") fail(`r19 key "${row.key}" is not APPROVED`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta19Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta19Unchanged += 1;
  else fail(`r19 key "${row.key}" has invalid scope_status`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r19 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (!row.source_en) fail(`r19 key "${row.key}" is missing approved English text`);
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r19 key "${row.key}" placeholder mismatch`);
  }
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r19 key "${row.key}" violates protected A PRASA brand spelling`);
  }
  // The governed source channel is part of the approved copy in both locales.
  for (const [locale, value] of [["EN", row.source_en], ["PT", row.pt]]) {
    if (!value.includes("aprasa.org")) {
      fail(`r19 key "${row.key}" ${locale} value drops the governed aprasa.org source channel`);
    }
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

for (const key of DELTA19_KEYS) {
  if (!delta19Seen.has(key)) fail(`r19 is missing the authorized prefill key "${key}"`);
}
if (delta19Required !== EXPECTED_DELTA19.required_for_pt_launch) {
  fail(`r19 required_for_pt_launch mismatch: got ${delta19Required}`);
}
if (delta19Unchanged !== EXPECTED_DELTA19.intentionally_unchanged) {
  fail(`r19 intentionally_unchanged mismatch: got ${delta19Unchanged}`);
}

// --- r21 delta: additive merge for the About-footer Privacy link label -----
// Single key, same strictly additive lane as r17/r18/r19: it must be new,
// never reopen an existing key. The English source and Portuguese value are
// both already the approved Privacy v1.0 title (P09-PRIVACY-PT-2026-09-15-v1.0),
// so this package is a pure implementation binding, not a new translation.
const EXPECTED_DELTA21 = {
  package_id: "aprasa-pt-privacy-link-r21",
  revision_class: "ADDITIVE_NEW_KEYS",
  source_revision: "P09-PRIVACY-PT-2026-09-15-v1.0",
  previous_revision: "P09-PT-LEARNING-SPOTLIGHT-START-CV-2026-09-14-r1",
  row_count: 1,
  approved: 1,
  required_for_pt_launch: 1,
  intentionally_unchanged: 0,
  review_required: 0,
};

const delta21 = JSON.parse(readFileSync(DELTA21_PATH, "utf8"));

for (const field of ["package_id", "revision_class", "source_revision", "previous_revision"]) {
  if (delta21[field] !== EXPECTED_DELTA21[field]) {
    fail(`r21 ${field} mismatch: got ${JSON.stringify(delta21[field])}, expected ${JSON.stringify(EXPECTED_DELTA21[field])}`);
  }
}
if (delta21.project_09_status !== "approved") {
  fail(`r21 Project 09 status is not approved: ${JSON.stringify(delta21.project_09_status)}`);
}
if (delta21.project_09_verdict !== "READY_FOR_PROJECT_04") {
  fail(`r21 Project 09 verdict is not implementation-ready: ${JSON.stringify(delta21.project_09_verdict)}`);
}
if (!Array.isArray(delta21.rows) || delta21.rows.length !== EXPECTED_DELTA21.row_count) {
  fail(`r21 row count mismatch: got ${delta21.rows?.length}, expected ${EXPECTED_DELTA21.row_count}`);
}
if (delta21.supplied_rows_approved !== EXPECTED_DELTA21.approved) {
  fail(`r21 supplied_rows_approved mismatch: got ${delta21.supplied_rows_approved}`);
}
if (delta21.review_required !== EXPECTED_DELTA21.review_required
  || delta21.blocking_issue != null
  || delta21.semantic_escalations_required !== 0) {
  fail("r21 has unresolved localization review state");
}
if (delta21.missing_or_unaccounted_row_count !== 0) {
  fail(`r21 missing_or_unaccounted_row_count is non-zero: ${delta21.missing_or_unaccounted_row_count}`);
}
for (const listField of ["duplicate_keys", "placeholder_mismatches", "a_prasa_to_a_praca_violations"]) {
  if ((delta21[listField] || []).length !== 0) fail(`r21 ${listField} is non-empty: ${JSON.stringify(delta21[listField])}`);
}
if (delta21.source_english_changed !== false || delta21.change_control_status?.existing_keys_overridden !== 0) {
  fail("r21 declares a non-additive change (source_english_changed/existing_keys_overridden)");
}
if (delta21.change_control_status?.new_keys_introduced !== EXPECTED_DELTA21.row_count) {
  fail(`r21 new_keys_introduced mismatch: got ${delta21.change_control_status?.new_keys_introduced}`);
}
if (delta21.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail("r21 must not modify lifecycle or publication state");
}
if (delta21.semantic_change !== false) {
  fail("r21 declares a semantic change; this package is a pure implementation binding");
}
if (delta21.localization_architecture_reopened !== false) {
  fail("r21 must not reopen the localization architecture");
}
if (delta21.target_language !== "pt") {
  fail(`r21 target_language mismatch: got ${JSON.stringify(delta21.target_language)}`);
}

let delta21Required = 0;
let delta21Unchanged = 0;
for (const row of delta21.rows) {
  if (seen.has(row.key)) {
    fail(`r21 key "${row.key}" collides with an existing key — r21 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (row.record_id != null) fail(`r21 key "${row.key}" is record-scoped; this package carries no record copy`);
  if (row.key !== "nav.privacy") {
    fail(`r21 key "${row.key}" is outside the single authorized key nav.privacy`);
  }
  if (row.source_revision !== EXPECTED_DELTA21.source_revision) fail(`r21 ${row.key} source_revision mismatch`);
  if (row.translation_status !== "APPROVED") fail(`r21 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  if (row.source_en !== "Privacy") fail(`r21 key "${row.key}" source_en must be exactly "Privacy"`);
  if (row.pt !== "Privacidade") fail(`r21 key "${row.key}" pt must be exactly "Privacidade"`);
  if (row.scope_status !== "REQUIRED_FOR_PT_LAUNCH") fail(`r21 key "${row.key}" scope_status must be REQUIRED_FOR_PT_LAUNCH`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta21Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta21Unchanged += 1;
  else fail(`r21 key "${row.key}" has invalid scope_status`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r21 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (!row.source_en) fail(`r21 key "${row.key}" is missing approved English text`);
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r21 key "${row.key}" placeholder mismatch`);
  }
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r21 key "${row.key}" violates protected A PRASA brand spelling`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta21Required !== EXPECTED_DELTA21.required_for_pt_launch) {
  fail(`r21 required_for_pt_launch mismatch: got ${delta21Required}`);
}
if (delta21Unchanged !== EXPECTED_DELTA21.intentionally_unchanged) {
  fail(`r21 intentionally_unchanged mismatch: got ${delta21Unchanged}`);
}

// --- r22 delta: additive merge for the shared lang-switch secondary note ---
// Single key, same strictly additive lane as r17/r18/r19/r21: it must be new,
// never reopen an existing key. A Project 09 public-language review of this
// exact EN/PT pair was later recovered (17 September 2026, disposition
// APPROVED_FOR_PUBLIC_USE) — Project 03 remains the semantic/product
// authority for the bounded implementation itself (Project 04 task order,
// 17 September 2026), and Project 09 is the linguistic authority for the
// wording. That recovered approval record carries no formal Project 09
// package/revision ID, so none is fabricated below: this package's own
// source_revision (P04-2026-09-17-PORTUGUESE-IN-PROGRESS-SIGNAL) stays the
// technical identity for THIS implementation binding, never restated as a
// substitute Project 09 revision label.
const EXPECTED_DELTA22 = {
  package_id: "aprasa-pt-lang-switch-note-r22",
  revision_class: "ADDITIVE_NEW_KEYS",
  source_revision: "P04-2026-09-17-PORTUGUESE-IN-PROGRESS-SIGNAL",
  previous_revision: "P09-PRIVACY-PT-2026-09-15-v1.0",
  row_count: 1,
  approved: 1,
  required_for_pt_launch: 1,
  intentionally_unchanged: 0,
  review_required: 0,
};

const delta22 = JSON.parse(readFileSync(DELTA22_PATH, "utf8"));

for (const field of ["package_id", "revision_class", "source_revision", "previous_revision"]) {
  if (delta22[field] !== EXPECTED_DELTA22[field]) {
    fail(`r22 ${field} mismatch: got ${JSON.stringify(delta22[field])}, expected ${JSON.stringify(EXPECTED_DELTA22[field])}`);
  }
}
if (delta22.project_09_status !== "approved") {
  fail(`r22 Project 09 status is not approved: ${JSON.stringify(delta22.project_09_status)}`);
}
if (delta22.project_09_verdict !== "APPROVED_FOR_PUBLIC_USE") {
  fail(`r22 Project 09 verdict is not APPROVED_FOR_PUBLIC_USE: ${JSON.stringify(delta22.project_09_verdict)}`);
}
if (delta22.project_09_review_date !== "2026-09-17") {
  fail(`r22 project_09_review_date mismatch: got ${JSON.stringify(delta22.project_09_review_date)}`);
}
// No formal Project 09 package/revision ID exists in the recovered approval
// record — these must stay null rather than carrying a fabricated P09-*
// label. This is the honesty check, not an oversight: a future edit that
// invents one to "fill in" these fields fails here.
if (delta22.project_09_package_id !== null) {
  fail(`r22 must not fabricate a Project 09 package id: got ${JSON.stringify(delta22.project_09_package_id)}`);
}
if (delta22.project_09_revision_id !== null) {
  fail(`r22 must not fabricate a Project 09 revision id: got ${JSON.stringify(delta22.project_09_revision_id)}`);
}
if (!Array.isArray(delta22.rows) || delta22.rows.length !== EXPECTED_DELTA22.row_count) {
  fail(`r22 row count mismatch: got ${delta22.rows?.length}, expected ${EXPECTED_DELTA22.row_count}`);
}
if (delta22.supplied_rows_approved !== EXPECTED_DELTA22.approved) {
  fail(`r22 supplied_rows_approved mismatch: got ${delta22.supplied_rows_approved}`);
}
if (delta22.review_required !== EXPECTED_DELTA22.review_required
  || delta22.blocking_issue != null
  || delta22.semantic_escalations_required !== 0) {
  fail("r22 has unresolved localization review state");
}
if (delta22.missing_or_unaccounted_row_count !== 0) {
  fail(`r22 missing_or_unaccounted_row_count is non-zero: ${delta22.missing_or_unaccounted_row_count}`);
}
for (const listField of ["duplicate_keys", "placeholder_mismatches", "a_prasa_to_a_praca_violations"]) {
  if ((delta22[listField] || []).length !== 0) fail(`r22 ${listField} is non-empty: ${JSON.stringify(delta22[listField])}`);
}
if (delta22.source_english_changed !== false || delta22.change_control_status?.existing_keys_overridden !== 0) {
  fail("r22 declares a non-additive change (source_english_changed/existing_keys_overridden)");
}
if (delta22.change_control_status?.new_keys_introduced !== EXPECTED_DELTA22.row_count) {
  fail(`r22 new_keys_introduced mismatch: got ${delta22.change_control_status?.new_keys_introduced}`);
}
if (delta22.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail("r22 must not modify lifecycle or publication state");
}
if (delta22.semantic_change !== false) {
  fail("r22 declares a semantic change; this package is a pure implementation binding");
}
if (delta22.localization_architecture_reopened !== false) {
  fail("r22 must not reopen the localization architecture");
}
if (delta22.target_language !== "pt") {
  fail(`r22 target_language mismatch: got ${JSON.stringify(delta22.target_language)}`);
}

let delta22Required = 0;
let delta22Unchanged = 0;
for (const row of delta22.rows) {
  if (seen.has(row.key)) {
    fail(`r22 key "${row.key}" collides with an existing key — r22 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (row.record_id != null) fail(`r22 key "${row.key}" is record-scoped; this package carries no record copy`);
  if (row.key !== "ui.pt_expansion_note") {
    fail(`r22 key "${row.key}" is outside the single authorized key ui.pt_expansion_note`);
  }
  if (row.source_revision !== EXPECTED_DELTA22.source_revision) fail(`r22 ${row.key} source_revision mismatch`);
  if (row.translation_status !== "APPROVED") fail(`r22 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  if (row.source_en !== "More Portuguese content is coming soon.") fail(`r22 key "${row.key}" source_en must be the exact approved EN copy`);
  if (row.pt !== "Mais conteúdos em português estarão disponíveis em breve.") fail(`r22 key "${row.key}" pt must be the exact approved PT copy`);
  if (row.scope_status !== "REQUIRED_FOR_PT_LAUNCH") fail(`r22 key "${row.key}" scope_status must be REQUIRED_FOR_PT_LAUNCH`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta22Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta22Unchanged += 1;
  else fail(`r22 key "${row.key}" has invalid scope_status`);

  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH" && (row.pt == null || row.pt === "")) {
    fail(`r22 REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
  }
  if (!row.source_en) fail(`r22 key "${row.key}" is missing approved English text`);
  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r22 key "${row.key}" placeholder mismatch`);
  }
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r22 key "${row.key}" violates protected A PRASA brand spelling`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}

if (delta22Required !== EXPECTED_DELTA22.required_for_pt_launch) {
  fail(`r22 required_for_pt_launch mismatch: got ${delta22Required}`);
}
if (delta22Unchanged !== EXPECTED_DELTA22.intentionally_unchanged) {
  fail(`r22 intentionally_unchanged mismatch: got ${delta22Unchanged}`);
}

// --- r23 delta: additive merge for the two Project 03-selected Fragata branch
// records (Mindelo Essentials — Fragata Selected Branches, Project 04 task
// order dated 17 September 2026). Supplies record-scoped type_label and
// description keys for SV-MIN-MKT-003 (Fragata — Central) and SV-MIN-MKT-004
// (Fragata — Monte Sossego). Like r22, the task order carries Project 09
// EN/PT localization authority as an upstream authority and supplies the
// exact approved EN/PT description/type values directly, so no formal
// Project 09 package/revision ID is fabricated below.
//
// checked_display was originally withheld: the task order supplied only the
// raw checked_at date (2026-09-17), not approved display copy, and no generic
// checked-date-to-display-string formatting rule exists anywhere in this
// pipeline to inherit from (every checked_display in the corpus is an
// individually hand-governed Project 09 string pair). Project 09 has since
// approved the exact EN/PT checked-date pair for reuse across both selected
// Fragata branches (Project 04 Manager relay, 17 September 2026, reuse_ruling
// APPROVED, FINAL_STATUS READY_FOR_PROJECT_04) — see the r23 package's
// project_09_provenance_note and checked_display_approval. Those two rows
// carry their own, later source_revision tag (CHECKED_DATE_SOURCE_REVISION
// below) distinct from the type_label/description rows', so the two-step
// provenance stays auditable rather than being folded into the original
// task-order date.
const EXPECTED_DELTA23 = {
  package_id: "aprasa-pt-mindelo-fragata-selected-branches-r23",
  revision_class: "ADDITIVE_NEW_KEYS",
  source_revision: "P04-2026-09-17-MINDELO-FRAGATA-SELECTED-BRANCHES",
  previous_revision: "P04-2026-09-17-PORTUGUESE-IN-PROGRESS-SIGNAL",
  row_count: 6,
  approved: 6,
  required_for_pt_launch: 6,
  intentionally_unchanged: 0,
  review_required: 0,
  records: ["SV-MIN-MKT-003", "SV-MIN-MKT-004"],
};
const CHECKED_DATE_SOURCE_REVISION = "P04-2026-09-17-MINDELO-FRAGATA-CHECKED-DATE-APPROVED";
const APPROVED_CHECKED_DISPLAY_EN = "Checked 17 September 2026";
const APPROVED_CHECKED_DISPLAY_PT = "Revisto em 17 de setembro de 2026";

const delta23 = JSON.parse(readFileSync(DELTA23_PATH, "utf8"));

for (const field of ["package_id", "revision_class", "source_revision", "previous_revision"]) {
  if (delta23[field] !== EXPECTED_DELTA23[field]) {
    fail(`r23 ${field} mismatch: got ${JSON.stringify(delta23[field])}, expected ${JSON.stringify(EXPECTED_DELTA23[field])}`);
  }
}
if (delta23.project_09_status !== "approved") {
  fail(`r23 Project 09 status is not approved: ${JSON.stringify(delta23.project_09_status)}`);
}
if (delta23.project_09_verdict !== "APPROVED_FOR_PUBLIC_USE") {
  fail(`r23 Project 09 verdict is not APPROVED_FOR_PUBLIC_USE: ${JSON.stringify(delta23.project_09_verdict)}`);
}
if (delta23.project_09_review_date !== "2026-09-17") {
  fail(`r23 project_09_review_date mismatch: got ${JSON.stringify(delta23.project_09_review_date)}`);
}
if (delta23.project_09_package_id !== null) {
  fail(`r23 must not fabricate a Project 09 package id: got ${JSON.stringify(delta23.project_09_package_id)}`);
}
if (delta23.project_09_revision_id !== null) {
  fail(`r23 must not fabricate a Project 09 revision id: got ${JSON.stringify(delta23.project_09_revision_id)}`);
}
// The checked_display approval arrived as a separate, later Project 04
// Manager relay of a Project 09 ruling — its own honesty gate, parallel to
// the package-level project_09_package_id/revision_id checks above but
// scoped to that specific approval rather than the whole package.
const approval = delta23.checked_display_approval;
if (approval?.relayed_by !== "Project 04 Manager / Control Tower") {
  fail(`r23 checked_display_approval.relayed_by mismatch: got ${JSON.stringify(approval?.relayed_by)}`);
}
if (approval?.relay_date !== "2026-09-17") {
  fail(`r23 checked_display_approval.relay_date mismatch: got ${JSON.stringify(approval?.relay_date)}`);
}
if (approval?.reuse_ruling !== "APPROVED — the exact same EN/PT checked-date pair may be reused for both Fragata — Central and Fragata — Monte Sossego.") {
  fail(`r23 checked_display_approval.reuse_ruling is not the exact authorized ruling: got ${JSON.stringify(approval?.reuse_ruling)}`);
}
if (approval?.project_09_package_id !== null) {
  fail(`r23 checked_display_approval must not fabricate a Project 09 package id: got ${JSON.stringify(approval?.project_09_package_id)}`);
}
if (approval?.project_09_revision_id !== null) {
  fail(`r23 checked_display_approval must not fabricate a Project 09 revision id: got ${JSON.stringify(approval?.project_09_revision_id)}`);
}
if (approval?.final_status_cited !== "READY_FOR_PROJECT_04") {
  fail(`r23 checked_display_approval.final_status_cited mismatch: got ${JSON.stringify(approval?.final_status_cited)}`);
}
if (!Array.isArray(delta23.rows) || delta23.rows.length !== EXPECTED_DELTA23.row_count) {
  fail(`r23 row count mismatch: got ${delta23.rows?.length}, expected ${EXPECTED_DELTA23.row_count}`);
}
if (delta23.supplied_rows_approved !== EXPECTED_DELTA23.approved) {
  fail(`r23 supplied_rows_approved mismatch: got ${delta23.supplied_rows_approved}`);
}
if (delta23.review_required !== EXPECTED_DELTA23.review_required
  || delta23.blocking_issue != null
  || delta23.semantic_escalations_required !== 0) {
  fail("r23 has unresolved localization review state");
}
if (delta23.missing_or_unaccounted_row_count !== 0) {
  fail(`r23 missing_or_unaccounted_row_count is non-zero: ${delta23.missing_or_unaccounted_row_count}`);
}
for (const listField of ["duplicate_keys", "placeholder_mismatches", "a_prasa_to_a_praca_violations"]) {
  if ((delta23[listField] || []).length !== 0) fail(`r23 ${listField} is non-empty: ${JSON.stringify(delta23[listField])}`);
}
if (delta23.source_english_changed !== false || delta23.change_control_status?.existing_keys_overridden !== 0) {
  fail("r23 declares a non-additive change (source_english_changed/existing_keys_overridden)");
}
if (delta23.change_control_status?.new_keys_introduced !== EXPECTED_DELTA23.row_count) {
  fail(`r23 new_keys_introduced mismatch: got ${delta23.change_control_status?.new_keys_introduced}`);
}
if (delta23.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail("r23 must not modify lifecycle or publication state");
}
if (delta23.semantic_change !== false) {
  fail("r23 declares a semantic change; this package is a pure implementation binding");
}
if (delta23.localization_architecture_reopened !== false) {
  fail("r23 must not reopen the localization architecture");
}
if (delta23.target_language !== "pt") {
  fail(`r23 target_language mismatch: got ${JSON.stringify(delta23.target_language)}`);
}

const DELTA23_RECORDS = new Set(EXPECTED_DELTA23.records);
const delta23SeenKeysByRecord = new Map(EXPECTED_DELTA23.records.map((id) => [id, new Set()]));
const DELTA23_ALLOWED_FIELDS = new Set(["type_label", "description", "checked_display"]);
let delta23Required = 0;
let delta23Unchanged = 0;
for (const row of delta23.rows) {
  if (seen.has(row.key)) {
    fail(`r23 key "${row.key}" collides with an existing key — r23 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (!DELTA23_RECORDS.has(row.record_id)) {
    fail(`r23 key "${row.key}" targets unauthorized record ${JSON.stringify(row.record_id)}`);
  }
  const expectedPrefix = `record.${row.record_id}.`;
  if (!row.key.startsWith(expectedPrefix) || !DELTA23_ALLOWED_FIELDS.has(row.key.slice(expectedPrefix.length))) {
    fail(`r23 key "${row.key}" is outside the authorized type_label/description/checked_display fields`);
  }
  const recordKeys = delta23SeenKeysByRecord.get(row.record_id);
  if (recordKeys.has(row.key)) fail(`r23 declares more than one row for key "${row.key}"`);
  recordKeys.add(row.key);

  const expectedRowRevision = row.key.endsWith(".checked_display") ? CHECKED_DATE_SOURCE_REVISION : EXPECTED_DELTA23.source_revision;
  if (row.source_revision !== expectedRowRevision) fail(`r23 ${row.key} source_revision mismatch: got ${JSON.stringify(row.source_revision)}, expected ${JSON.stringify(expectedRowRevision)}`);
  if (row.translation_status !== "APPROVED") fail(`r23 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  if (!row.source_en || !row.pt) fail(`r23 key "${row.key}" requires non-empty EN and PT values`);

  if (row.key.endsWith(".type_label")) {
    if (row.source_en !== "Supermarket") fail(`r23 key "${row.key}" source_en must be the exact approved type_en "Supermarket"`);
    if (row.pt !== "Supermercado") fail(`r23 key "${row.key}" pt must be the exact approved type_pt "Supermercado"`);
  }
  if (row.key.endsWith(".description")) {
    const approvedEn = "Fragata is a local supermarket network. The provider advertises customer support and scheduled delivery; check directly with Fragata for current availability and coverage.";
    const approvedPt = "A Fragata é uma rede local de supermercados. O prestador anuncia apoio ao cliente e entregas programadas; confirme diretamente com a Fragata a disponibilidade atual e a área de cobertura.";
    if (row.source_en !== approvedEn) fail(`r23 key "${row.key}" source_en must be the exact approved description_en`);
    if (row.pt !== approvedPt) fail(`r23 key "${row.key}" pt must be the exact approved description_pt`);
  }
  if (row.key.endsWith(".checked_display")) {
    if (row.source_en !== APPROVED_CHECKED_DISPLAY_EN) fail(`r23 key "${row.key}" source_en must be the exact Project 09-approved "${APPROVED_CHECKED_DISPLAY_EN}"`);
    if (row.pt !== APPROVED_CHECKED_DISPLAY_PT) fail(`r23 key "${row.key}" pt must be the exact Project 09-approved "${APPROVED_CHECKED_DISPLAY_PT}"`);
    if (row.identity_policy !== "TRANSLATE_AND_LOCALIZE_DATE_DISPLAY") fail(`r23 key "${row.key}" identity_policy must be TRANSLATE_AND_LOCALIZE_DATE_DISPLAY`);
  }

  if (row.scope_status !== "REQUIRED_FOR_PT_LAUNCH") fail(`r23 key "${row.key}" scope_status must be REQUIRED_FOR_PT_LAUNCH`);
  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta23Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta23Unchanged += 1;

  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r23 key "${row.key}" placeholder mismatch`);
  }
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r23 key "${row.key}" violates protected A PRASA brand spelling`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}
for (const recordId of EXPECTED_DELTA23.records) {
  for (const field of DELTA23_ALLOWED_FIELDS) {
    if (!delta23SeenKeysByRecord.get(recordId).has(`record.${recordId}.${field}`)) {
      fail(`r23 is missing the "${field}" key for authorized record "${recordId}"`);
    }
  }
}
if (delta23Required !== EXPECTED_DELTA23.required_for_pt_launch) {
  fail(`r23 required_for_pt_launch mismatch: got ${delta23Required}`);
}
if (delta23Unchanged !== EXPECTED_DELTA23.intentionally_unchanged) {
  fail(`r23 intentionally_unchanged mismatch: got ${delta23Unchanged}`);
}

// --- r25 delta: additive merge for the new timbuktoo rolling opportunity
// (Trainings & Opportunities Home expansion, Project 04 Manager / Control
// Tower closeout order dated 18 September 2026, carrying the Project 03
// return labeled IMPLEMENTATION_COPY_COMPLETE). Supplies the eight
// record-scoped presentation keys for timbuktoo-greentech-launchpad.
//
// Like r22/r23, the task order carries Project 09 EN/PT localization
// authority as an upstream authority and supplies the exact approved EN/PT
// values directly, so no formal Project 09 package/revision ID is fabricated
// below.
//
// The authorized field set is exactly the eight fields the governed package
// supplied a value for. It deliberately does NOT include meta, facts or
// original_posting: the package marked each of those NULL, and the order
// states explicitly not to invent optional filler copy, so no key exists for
// them rather than an empty or composed one. Adding a ninth field here would
// be a governance change, not an implementation detail.
//
// The second record in the same tranche
// (timbuktoo-edtech-pan-african-incubation) is NOT carried here. Its governed
// package declares lifecycle_class "fixed-window-opportunity" with
// end_date NULL, which the incumbent canonical schema rejects
// (scripts/validate-training-opportunities-data.mjs requires a valid end_date
// for that class). Publishing it would require inferring a deadline,
// redescribing it as rolling, or reopening the lifecycle invariant - all three
// expressly forbidden by the same order. It is therefore held for Project 03 /
// Project 04 adjudication rather than implemented under a guess, and no key,
// record or corpus entry for it is created anywhere.
const EXPECTED_DELTA25 = {
  package_id: "aprasa-trainings-home-expansion-timbuktoo-r25",
  revision_class: "ADDITIVE_NEW_KEYS",
  source_revision: "P04-2026-09-18-TRAININGS-HOME-EXPANSION-TIMBUKTOO",
  previous_revision: "P03-PT-SOURCE-2026-09-17-r24",
  row_count: 8,
  approved: 8,
  required_for_pt_launch: 8,
  intentionally_unchanged: 0,
  review_required: 0,
  records: ["timbuktoo-greentech-launchpad"],
};
// The governed programme identity. Pinned so a later edit cannot quietly
// capitalize or respell it in either locale.
const TIMBUKTOO_PROGRAMME_IDENTITY = "timbuktoo";

const delta25 = JSON.parse(readFileSync(DELTA25_PATH, "utf8"));

for (const field of ["package_id", "revision_class", "source_revision", "previous_revision"]) {
  if (delta25[field] !== EXPECTED_DELTA25[field]) {
    fail(`r25 ${field} mismatch: got ${JSON.stringify(delta25[field])}, expected ${JSON.stringify(EXPECTED_DELTA25[field])}`);
  }
}
if (delta25.project_09_status !== "approved") {
  fail(`r25 Project 09 status is not approved: ${JSON.stringify(delta25.project_09_status)}`);
}
if (delta25.project_09_verdict !== "APPROVED_FOR_PUBLIC_USE") {
  fail(`r25 Project 09 verdict is not APPROVED_FOR_PUBLIC_USE: ${JSON.stringify(delta25.project_09_verdict)}`);
}
if (delta25.project_09_package_id !== null) {
  fail(`r25 must not fabricate a Project 09 package id: got ${JSON.stringify(delta25.project_09_package_id)}`);
}
if (delta25.project_09_revision_id !== null) {
  fail(`r25 must not fabricate a Project 09 revision id: got ${JSON.stringify(delta25.project_09_revision_id)}`);
}
if (!Array.isArray(delta25.rows) || delta25.rows.length !== EXPECTED_DELTA25.row_count) {
  fail(`r25 row count mismatch: got ${delta25.rows?.length}, expected ${EXPECTED_DELTA25.row_count}`);
}
if (delta25.supplied_rows_approved !== EXPECTED_DELTA25.approved) {
  fail(`r25 supplied_rows_approved mismatch: got ${delta25.supplied_rows_approved}`);
}
if (delta25.review_required !== EXPECTED_DELTA25.review_required
  || delta25.semantic_escalations_required !== 0
  || delta25.blocking_issue != null) {
  fail("r25 has unresolved localization review state");
}
if (delta25.missing_or_unaccounted_row_count !== 0) {
  fail(`r25 missing_or_unaccounted_row_count is non-zero: ${delta25.missing_or_unaccounted_row_count}`);
}
for (const listField of ["duplicate_keys", "placeholder_mismatches", "a_prasa_to_a_praca_violations"]) {
  if ((delta25[listField] || []).length !== 0) fail(`r25 ${listField} is non-empty: ${JSON.stringify(delta25[listField])}`);
}
if (delta25.source_english_changed !== false || delta25.change_control_status?.existing_keys_overridden !== 0) {
  fail("r25 declares a non-additive change (source_english_changed/existing_keys_overridden)");
}
if (delta25.change_control_status?.new_keys_introduced !== EXPECTED_DELTA25.row_count) {
  fail(`r25 new_keys_introduced mismatch: got ${delta25.change_control_status?.new_keys_introduced}`);
}
if (delta25.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail("r25 must not modify lifecycle or publication state");
}
if (delta25.localization_architecture_reopened !== false) {
  fail("r25 must not reopen the localization architecture");
}
if (delta25.target_language !== "pt") {
  fail(`r25 target_language mismatch: got ${JSON.stringify(delta25.target_language)}`);
}
const DELTA25_RECORDS = new Set(EXPECTED_DELTA25.records);
const DELTA25_ALLOWED_FIELDS = new Set([
  "title", "status", "body", "requirements", "good", "action", "checked", "detail_checked",
]);
const delta25SeenKeysByRecord = new Map(EXPECTED_DELTA25.records.map((id) => [id, new Set()]));
let delta25Required = 0;
let delta25Unchanged = 0;
for (const row of delta25.rows) {
  if (seen.has(row.key)) {
    fail(`r25 key "${row.key}" collides with an existing key — r25 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (!DELTA25_RECORDS.has(row.record_id)) {
    fail(`r25 key "${row.key}" targets unauthorized record ${JSON.stringify(row.record_id)}`);
  }
  const expectedPrefix = `training.record.${row.record_id}.`;
  if (!row.key.startsWith(expectedPrefix) || !DELTA25_ALLOWED_FIELDS.has(row.key.slice(expectedPrefix.length))) {
    fail(`r25 key "${row.key}" is outside the authorized field set for its own record namespace`);
  }
  const recordKeys = delta25SeenKeysByRecord.get(row.record_id);
  if (recordKeys.has(row.key)) fail(`r25 declares more than one row for key "${row.key}"`);
  recordKeys.add(row.key);

  if (row.source_revision !== EXPECTED_DELTA25.source_revision) {
    fail(`r25 ${row.key} source_revision mismatch: got ${JSON.stringify(row.source_revision)}`);
  }
  if (row.translation_status !== "APPROVED") fail(`r25 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  // No silent PT fallback: both locales must carry a governed, non-empty
  // value. An identity-preserved key may legitimately hold the same string in
  // both, but it must still be supplied explicitly rather than inherited.
  if (!row.source_en || !row.pt) fail(`r25 key "${row.key}" requires non-empty EN and PT values`);
  if (row.scope_status !== "REQUIRED_FOR_PT_LAUNCH") fail(`r25 key "${row.key}" scope_status must be REQUIRED_FOR_PT_LAUNCH`);
  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta25Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta25Unchanged += 1;

  // The programme identity is preserved byte-exact in both locales, lowercase
  // initial included. The title is the key that carries it.
  if (row.key.endsWith(".title")) {
    for (const [locale, value] of [["EN", row.source_en], ["PT", row.pt]]) {
      if (!value.includes(TIMBUKTOO_PROGRAMME_IDENTITY)) {
        fail(`r25 governed programme identity "${TIMBUKTOO_PROGRAMME_IDENTITY}" is not preserved in the ${locale} title`);
      }
    }
  }

  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r25 key "${row.key}" placeholder mismatch`);
  }
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r25 key "${row.key}" violates protected A PRASA brand spelling`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}
// Every authorized field must actually be present: a package that silently
// omitted one would otherwise leave the record short a governed string and
// fail later, at render time, as a missing key.
for (const recordId of EXPECTED_DELTA25.records) {
  for (const field of DELTA25_ALLOWED_FIELDS) {
    if (!delta25SeenKeysByRecord.get(recordId).has(`training.record.${recordId}.${field}`)) {
      fail(`r25 is missing the "${field}" key for authorized record "${recordId}"`);
    }
  }
}
if (delta25Required !== EXPECTED_DELTA25.required_for_pt_launch) {
  fail(`r25 required_for_pt_launch mismatch: got ${delta25Required}`);
}
if (delta25Unchanged !== EXPECTED_DELTA25.intentionally_unchanged) {
  fail(`r25 intentionally_unchanged mismatch: got ${delta25Unchanged}`);
}

// --- r26 delta: additive merge for the new timbuktoo EdTech open call
// (Project 03 return EDTECH_LIFECYCLE_RESOLVED, 18 September 2026, relayed by
// the Project 04 Manager / Control Tower). Supplies the same bounded eight
// record-scoped presentation keys r25 established, for
// timbuktoo-edtech-pan-african-incubation.
//
// Same honest-provenance shape as r22/r23/r25: Project 09 EN/PT localization
// authority is an upstream authority on the order, which supplies the exact
// approved EN/PT values directly and states that no new Project 09 round is
// required, so no Project 09 package/revision ID is fabricated below.
//
// This record's lifecycle class is open-call-unknown-deadline. That token is
// governance architecture and must NEVER reach public copy, so it is asserted
// absent from every governed string here — a localization-side guard on top of
// the surface-side one. The approved status/body wording is carried verbatim
// and is deliberately NOT reworded to describe the internal class.
const EXPECTED_DELTA26 = {
  package_id: "aprasa-trainings-home-expansion-edtech-r26",
  revision_class: "ADDITIVE_NEW_KEYS",
  source_revision: "P04-2026-09-18-TRAININGS-HOME-EXPANSION-EDTECH",
  previous_revision: "P04-2026-09-18-TRAININGS-HOME-EXPANSION-TIMBUKTOO",
  row_count: 8,
  approved: 8,
  required_for_pt_launch: 8,
  intentionally_unchanged: 0,
  review_required: 0,
  records: ["timbuktoo-edtech-pan-african-incubation"],
};
// The internal lifecycle token this record carries. Pinned here so the guard
// below cannot drift away from the class it is guarding.
const EDTECH_INTERNAL_LIFECYCLE_TOKEN = "open-call-unknown-deadline";

const delta26 = JSON.parse(readFileSync(DELTA26_PATH, "utf8"));

for (const field of ["package_id", "revision_class", "source_revision", "previous_revision"]) {
  if (delta26[field] !== EXPECTED_DELTA26[field]) {
    fail(`r26 ${field} mismatch: got ${JSON.stringify(delta26[field])}, expected ${JSON.stringify(EXPECTED_DELTA26[field])}`);
  }
}
if (delta26.project_09_status !== "approved") {
  fail(`r26 Project 09 status is not approved: ${JSON.stringify(delta26.project_09_status)}`);
}
if (delta26.project_09_verdict !== "APPROVED_FOR_PUBLIC_USE") {
  fail(`r26 Project 09 verdict is not APPROVED_FOR_PUBLIC_USE: ${JSON.stringify(delta26.project_09_verdict)}`);
}
if (delta26.project_09_package_id !== null) {
  fail(`r26 must not fabricate a Project 09 package id: got ${JSON.stringify(delta26.project_09_package_id)}`);
}
if (delta26.project_09_revision_id !== null) {
  fail(`r26 must not fabricate a Project 09 revision id: got ${JSON.stringify(delta26.project_09_revision_id)}`);
}
if (delta26.lifecycle_disclosure_policy !== "INTERNAL_TOKEN_NEVER_PUBLIC") {
  fail(`r26 lifecycle_disclosure_policy mismatch: got ${JSON.stringify(delta26.lifecycle_disclosure_policy)}`);
}
if (!Array.isArray(delta26.rows) || delta26.rows.length !== EXPECTED_DELTA26.row_count) {
  fail(`r26 row count mismatch: got ${delta26.rows?.length}, expected ${EXPECTED_DELTA26.row_count}`);
}
if (delta26.supplied_rows_approved !== EXPECTED_DELTA26.approved) {
  fail(`r26 supplied_rows_approved mismatch: got ${delta26.supplied_rows_approved}`);
}
if (delta26.review_required !== EXPECTED_DELTA26.review_required
  || delta26.semantic_escalations_required !== 0
  || delta26.blocking_issue != null) {
  fail("r26 has unresolved localization review state");
}
if (delta26.missing_or_unaccounted_row_count !== 0) {
  fail(`r26 missing_or_unaccounted_row_count is non-zero: ${delta26.missing_or_unaccounted_row_count}`);
}
for (const listField of ["duplicate_keys", "placeholder_mismatches", "a_prasa_to_a_praca_violations"]) {
  if ((delta26[listField] || []).length !== 0) fail(`r26 ${listField} is non-empty: ${JSON.stringify(delta26[listField])}`);
}
if (delta26.source_english_changed !== false || delta26.change_control_status?.existing_keys_overridden !== 0) {
  fail("r26 declares a non-additive change (source_english_changed/existing_keys_overridden)");
}
if (delta26.change_control_status?.new_keys_introduced !== EXPECTED_DELTA26.row_count) {
  fail(`r26 new_keys_introduced mismatch: got ${delta26.change_control_status?.new_keys_introduced}`);
}
if (delta26.change_control_status?.lifecycle_or_publication_state_modified !== 0) {
  fail("r26 must not modify lifecycle or publication state");
}
if (delta26.localization_architecture_reopened !== false) {
  fail("r26 must not reopen the localization architecture");
}
if (delta26.target_language !== "pt") {
  fail(`r26 target_language mismatch: got ${JSON.stringify(delta26.target_language)}`);
}
const DELTA26_RECORDS = new Set(EXPECTED_DELTA26.records);
const DELTA26_ALLOWED_FIELDS = new Set([
  "title", "status", "body", "requirements", "good", "action", "checked", "detail_checked",
]);
const delta26SeenKeysByRecord = new Map(EXPECTED_DELTA26.records.map((id) => [id, new Set()]));
let delta26Required = 0;
let delta26Unchanged = 0;
for (const row of delta26.rows) {
  if (seen.has(row.key)) {
    fail(`r26 key "${row.key}" collides with an existing key — r26 must be strictly additive, never reopen an existing key`);
  }
  seen.add(row.key);

  if (!DELTA26_RECORDS.has(row.record_id)) {
    fail(`r26 key "${row.key}" targets unauthorized record ${JSON.stringify(row.record_id)}`);
  }
  const expectedPrefix = `training.record.${row.record_id}.`;
  if (!row.key.startsWith(expectedPrefix) || !DELTA26_ALLOWED_FIELDS.has(row.key.slice(expectedPrefix.length))) {
    fail(`r26 key "${row.key}" is outside the authorized field set for its own record namespace`);
  }
  const recordKeys = delta26SeenKeysByRecord.get(row.record_id);
  if (recordKeys.has(row.key)) fail(`r26 declares more than one row for key "${row.key}"`);
  recordKeys.add(row.key);

  if (row.source_revision !== EXPECTED_DELTA26.source_revision) {
    fail(`r26 ${row.key} source_revision mismatch: got ${JSON.stringify(row.source_revision)}`);
  }
  if (row.translation_status !== "APPROVED") fail(`r26 key "${row.key}" is not APPROVED (status: ${row.translation_status})`);
  // No silent PT fallback: both locales must carry a governed, non-empty value.
  if (!row.source_en || !row.pt) fail(`r26 key "${row.key}" requires non-empty EN and PT values`);
  if (row.scope_status !== "REQUIRED_FOR_PT_LAUNCH") fail(`r26 key "${row.key}" scope_status must be REQUIRED_FOR_PT_LAUNCH`);
  if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") delta26Required += 1;
  else if (row.scope_status === "INTENTIONALLY_UNCHANGED") delta26Unchanged += 1;

  // The internal lifecycle token never becomes public copy, in either locale.
  for (const [locale, value] of [["EN", row.source_en], ["PT", row.pt]]) {
    if (value.includes(EDTECH_INTERNAL_LIFECYCLE_TOKEN)) {
      fail(`r26 key "${row.key}" leaks the internal lifecycle token "${EDTECH_INTERNAL_LIFECYCLE_TOKEN}" into ${locale} public copy`);
    }
  }

  if (row.key.endsWith(".title")) {
    for (const [locale, value] of [["EN", row.source_en], ["PT", row.pt]]) {
      if (!value.includes(TIMBUKTOO_PROGRAMME_IDENTITY)) {
        fail(`r26 governed programme identity "${TIMBUKTOO_PROGRAMME_IDENTITY}" is not preserved in the ${locale} title`);
      }
    }
  }

  const enPlaceholders = (row.source_en.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  const ptPlaceholders = (row.pt.match(/\{[a-zA-Z_]+\}/g) || []).sort();
  if (JSON.stringify(enPlaceholders) !== JSON.stringify(ptPlaceholders)) {
    fail(`r26 key "${row.key}" placeholder mismatch`);
  }
  if ([row.source_en, row.pt].some((value) => value.includes("A PRAÇA"))) {
    fail(`r26 key "${row.key}" violates protected A PRASA brand spelling`);
  }

  keys[row.key] = {
    key: row.key,
    en: row.source_en,
    pt: row.pt,
    scope_status: row.scope_status,
    identity_policy: row.identity_policy,
    record_id: row.record_id,
    translation_status: row.translation_status,
    source_revision: row.source_revision,
    context_notes: row.context_notes || "",
    linguistic_notes: row.linguistic_notes || "",
  };
}
for (const recordId of EXPECTED_DELTA26.records) {
  for (const field of DELTA26_ALLOWED_FIELDS) {
    if (!delta26SeenKeysByRecord.get(recordId).has(`training.record.${recordId}.${field}`)) {
      fail(`r26 is missing the "${field}" key for authorized record "${recordId}"`);
    }
  }
}
if (delta26Required !== EXPECTED_DELTA26.required_for_pt_launch) {
  fail(`r26 required_for_pt_launch mismatch: got ${delta26Required}`);
}
if (delta26Unchanged !== EXPECTED_DELTA26.intentionally_unchanged) {
  fail(`r26 intentionally_unchanged mismatch: got ${delta26Unchanged}`);
}

// Aggregate tallies, read off the finished key map that is about to be written.
const assembled = (() => {
  const values = Object.values(keys);
  const tally = { total: values.length, required: 0, unchanged: 0, approved: 0 };
  for (const row of values) {
    if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") tally.required += 1;
    else if (row.scope_status === "INTENTIONALLY_UNCHANGED") tally.unchanged += 1;
    else fail(`assembled key "${row.key}" has an unrecognized scope_status: ${JSON.stringify(row.scope_status)}`);
    if (row.translation_status === "APPROVED") tally.approved += 1;
  }
  return tally;
})();

// The key map is final at this point: `assembled` has just described it, and
// every published count is derived from that description. Freezing it makes
// that finality ENFORCED rather than merely intended.
//
// This matters because the previous attempt at this guard was itself
// positional - it re-tallied before the write, so a merge appended between the
// guard and writeFileSync would have been serialized while the counts
// described the state before it. A frozen map has no such window: ES modules
// are strict mode, so ANY later `keys[...] = ...` throws wherever it is
// written, which is the invariant this is actually trying to state.
//
// Deep, not shallow. An earlier version of this froze only the map, on the
// reasoning that the pre-write re-tally would catch a row mutated in place.
// That reasoning was wrong, and wrong in the most damaging direction: the
// re-tally inspects only scope_status and translation_status, so
// `keys[k].pt = "..."` after this point changed GOVERNED PORTUGUESE COPY, kept
// every count identical, and was serialized without a word.
//
// So every row is frozen too. The map cannot gain or lose keys, and no row can
// have its values, provenance or notes rewritten after the point the counts
// describe it.
Object.freeze(keys);
for (const row of Object.values(keys)) Object.freeze(row);

const output = {
  provenance: {
    source_revision: eventDeltaPackages.at(-1)?.source_revision ?? delta8.source_revision,
    source_package_id: pkg.source_package_id,
    semantic_authority: pkg.semantic_authority,
    project_09_verdict: pkg.project_09_verdict,
    implementation_reference: pkg.implementation_reference,
    generated_by: "scripts/build-locale-data.mjs",
    generated_from: [
      "data/locales/pt-overlay-r2.source.json",
      "data/locales/pt-overlay-r3-delta.source.json",
      "data/locales/pt-overlay-r4-delta.source.json",
      "data/locales/pt-overlay-r5-delta.source.json",
      "data/locales/pt-overlay-r6-delta.source.json",
      "data/locales/pt-overlay-r7-delta.source.json",
      "data/locales/pt-overlay-r8-delta.source.json",
      "data/locales/pt-overlay-r9-delta.source.json",
      ...eventDeltaPackages.map((item) => item.file),
      "data/locales/pt-overlay-r10-migration.source.json",
      "data/locales/pt-overlay-r13-things-to-do-hub.source.json",
      "data/locales/pt-overlay-r14-section-fallback-note.source.json",
      "data/locales/pt-overlay-r15-weekly-opportunity-2026-09.source.json",
      "data/locales/pt-overlay-r16-provider-media-alt.source.json",
      "data/locales/pt-overlay-r17-runtime-whatsapp-launcher.source.json",
      "data/locales/pt-overlay-r18-ui-scroll-down.source.json",
      "data/locales/pt-overlay-r19-runtime-whatsapp-prefill.source.json",
      "data/locales/pt-overlay-r20-start-cv-learning-spotlight.source.json",
      "data/locales/pt-overlay-r21-privacy-link.source.json",
      "data/locales/pt-overlay-r22-lang-switch-note.source.json",
      "data/locales/pt-overlay-r23-mindelo-fragata-selected-branches.source.json",
      "data/locales/pt-overlay-r25-trainings-home-expansion-timbuktoo.source.json",
      "data/locales/pt-overlay-r26-trainings-home-expansion-edtech.source.json",
    ],
    base_revision: pkg.source_revision,
    delta_revision: delta.source_revision,
    delta4_revision: delta4.source_revision,
    delta5_revision: delta5.source_revision,
    delta6_revision: delta6.source_revision,
    delta6_package_id: delta6.package_id,
    delta6_revision_class: delta6.revision_class,
    delta7_revision: delta7.source_revision,
    delta7_package_id: delta7.package_id,
    delta8_revision: delta8.source_revision,
    delta8_package_id: delta8.package_id,
    delta9_revision: delta9.source_revision,
    delta9_package_id: delta9.package_id,
    delta9_revision_class: delta9.revision_class,
    delta13_package_id: delta13.package_id,
    delta13_revision: delta13.source_revision,
    delta13_revision_class: delta13.revision_class,
    delta13_row_count: delta13.rows.length,
    delta14_package_id: delta14.package_id,
    delta14_revision: delta14.source_revision,
    delta14_revision_class: delta14.revision_class,
    delta14_row_count: delta14.rows.length,
    delta15_package_id: delta15.package_id,
    delta15_revision: delta15.source_revision,
    delta15_revision_class: delta15.revision_class,
    delta15_row_count: delta15.rows.length,
    delta16_package_id: delta16.package_id,
    delta16_revision: delta16.source_revision,
    delta16_revision_class: delta16.revision_class,
    delta16_row_count: delta16.rows.length,
    delta17_package_id: delta17.package_id,
    delta17_revision: delta17.source_revision,
    delta17_revision_class: delta17.revision_class,
    delta17_row_count: delta17.rows.length,
    delta18_package_id: delta18.package_id,
    delta18_revision: delta18.source_revision,
    delta18_revision_class: delta18.revision_class,
    delta18_row_count: delta18.rows.length,
    delta19_package_id: delta19.package_id,
    delta19_revision: delta19.source_revision,
    delta19_revision_class: delta19.revision_class,
    delta19_row_count: delta19.rows.length,
    delta20_package_id: delta20.package_id,
    delta20_revision: delta20.source_revision,
    delta20_legacy_recovered_revision_label: delta20.legacy_recovered_revision_label,
    delta20_legacy_previous_revision_label: delta20.legacy_previous_revision_label,
    delta20_legacy_recovered_from: delta20.legacy_recovered_from,
    delta20_provenance_status: delta20.provenance_status,
    delta20_revision_class: delta20.revision_class,
    delta20_row_count: delta20.rows.length,
    delta20_affected_records: delta20.affected_records,
    delta21_package_id: delta21.package_id,
    delta21_revision: delta21.source_revision,
    delta21_revision_class: delta21.revision_class,
    delta21_row_count: delta21.rows.length,
    delta22_package_id: delta22.package_id,
    delta22_revision: delta22.source_revision,
    delta22_revision_class: delta22.revision_class,
    delta22_row_count: delta22.rows.length,
    delta22_project_09_status: delta22.project_09_status,
    delta22_project_09_verdict: delta22.project_09_verdict,
    delta22_project_09_review_date: delta22.project_09_review_date,
    delta22_project_09_package_id: delta22.project_09_package_id,
    delta22_project_09_revision_id: delta22.project_09_revision_id,
    delta23_package_id: delta23.package_id,
    delta23_revision: delta23.source_revision,
    delta23_revision_class: delta23.revision_class,
    delta23_row_count: delta23.rows.length,
    delta23_project_09_status: delta23.project_09_status,
    delta23_project_09_verdict: delta23.project_09_verdict,
    delta23_project_09_review_date: delta23.project_09_review_date,
    delta23_project_09_package_id: delta23.project_09_package_id,
    delta23_project_09_revision_id: delta23.project_09_revision_id,
    delta25_package_id: delta25.package_id,
    delta25_revision: delta25.source_revision,
    delta25_revision_class: delta25.revision_class,
    delta25_row_count: delta25.rows.length,
    delta25_project_09_status: delta25.project_09_status,
    delta25_project_09_verdict: delta25.project_09_verdict,
    delta25_project_09_review_date: delta25.project_09_review_date,
    delta25_project_09_package_id: delta25.project_09_package_id,
    delta25_project_09_revision_id: delta25.project_09_revision_id,
    delta26_package_id: delta26.package_id,
    delta26_revision: delta26.source_revision,
    delta26_revision_class: delta26.revision_class,
    delta26_row_count: delta26.rows.length,
    delta26_project_09_status: delta26.project_09_status,
    delta26_project_09_verdict: delta26.project_09_verdict,
    delta26_project_09_review_date: delta26.project_09_review_date,
    delta26_project_09_package_id: delta26.project_09_package_id,
    delta26_project_09_revision_id: delta26.project_09_revision_id,
    delta26_lifecycle_disclosure_policy: delta26.lifecycle_disclosure_policy,
    delta9_superseding_ruling: delta9.superseding_ruling,
    delta9_owning_project: delta9.owning_project,
    event_delta_packages: eventDeltaPackages,
    r10_revision: r10Migration.source_revision,
    r10_package_id: r10Migration.package_id,
    r10_revision_class: r10Migration.revision_class,
    r10_renamed_keys: r10Renamed.length,
    r10_canonical_namespace: "training.record.<record_id>.<field>",
    r10_retired_namespace: "home.training.record.<record_id>.<field>",
    governed_override_packages: governedOverrideResults,
    governed_override_authorization: "fixed code-side contract in scripts/build-locale-data.mjs (GOVERNED_OVERRIDE_CONTRACTS)",
  },
  // The aggregate counts are DERIVED from the finished key map, never re-summed
  // from the packages by hand.
  //
  // The hand-summed form was wrong, and wrong in the way that form always
  // eventually is: it enumerated r2 + r3 + r4 + r5 + r7 + r8 + event deltas and
  // simply never gained a term for r13, r14 or r15. The artifact carried 977
  // keys while reporting 872 — a 105-key lie (8 + 1 + 96) in the audit metadata,
  // silently growing every time an additive package shipped without someone
  // remembering to extend four separate expressions.
  //
  // Counting the assembled corpus removes that failure mode by construction: a
  // future additive package is counted because its rows are in the map, not
  // because anybody remembered it here. The per-package breakdown fields below
  // stay as they are — each is a genuine statement about one package, and
  // validate-locale-contract.mjs now reconciles the aggregates against the
  // artifact so the two can never drift apart again.
  counts: {
    total_rows: assembled.total,
    required_for_pt_launch: assembled.required,
    intentionally_unchanged: assembled.unchanged,
    approved_rows_total: assembled.approved,
    r3_delta_rows: delta.rows.length,
    r4_delta_rows: delta4.rows.length,
    r5_delta_rows: delta5.rows.length,
    r6_override_rows: delta6.rows.length,
    r7_delta_rows: delta7.rows.length,
    r8_delta_rows: delta8.rows.length,
    r9_source_correction_rows: delta9.rows.length,
    event_delta_rows: eventDeltaRequired + eventDeltaUnchanged,
    r16_delta_rows: delta16.rows.length,
    r17_delta_rows: delta17.rows.length,
    r18_delta_rows: delta18.rows.length,
    r19_delta_rows: delta19.rows.length,
    r20_delta_rows: delta20.rows.length,
    r21_delta_rows: delta21.rows.length,
    r22_delta_rows: delta22.rows.length,
    r23_delta_rows: delta23.rows.length,
    r10_renamed_rows: r10Renamed.length,
    governed_override_rows: governedOverrideCount,
  },
  keys,
};

// The audit counts must describe the artifact that actually ships. They are
// tallied from `keys` at the point `assembled` is computed, so ANY merge added
// below that point would leave every published count describing a smaller key
// map than the one written here - silently, and in the direction that looks
// correct. This series has already shipped that defect once, when an additive
// overlay was merged after the tally; positional correctness alone did not
// prevent it and will not prevent it again.
//
// Re-tallying immediately before the write makes the ordering enforced rather
// than merely observed: move a merge below `assembled` and this fails.
{
  const shipped = Object.values(output.keys);
  const required = shipped.filter((row) => row.scope_status === "REQUIRED_FOR_PT_LAUNCH").length;
  const unchanged = shipped.filter((row) => row.scope_status === "INTENTIONALLY_UNCHANGED").length;
  const approved = shipped.filter((row) => row.translation_status === "APPROVED").length;
  if (output.counts.total_rows !== shipped.length) {
    fail(`declared total_rows ${output.counts.total_rows} does not describe the ${shipped.length} keys being written; a merge ran after the tally`);
  }
  if (output.counts.required_for_pt_launch !== required) {
    fail(`declared required_for_pt_launch ${output.counts.required_for_pt_launch} does not match the ${required} shipped`);
  }
  if (output.counts.intentionally_unchanged !== unchanged) {
    fail(`declared intentionally_unchanged ${output.counts.intentionally_unchanged} does not match the ${unchanged} shipped`);
  }
  if (output.counts.approved_rows_total !== approved) {
    fail(`declared approved_rows_total ${output.counts.approved_rows_total} does not match the ${approved} shipped`);
  }
}

Object.freeze(output.counts);
Object.freeze(output);

writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
console.log(`[build-locale-data] wrote ${Object.keys(keys).length} keys to ${path.relative(ROOT, OUT_PATH)} (r6 overrode ${delta6Overridden} PT values; r9 corrected ${delta9Corrected} EN/PT source values; event deltas added ${eventDeltaRequired + eventDeltaUnchanged} keys; r10 renamed ${r10Renamed.length} keys onto training.record.*; governed overrides applied ${governedOverrideCount} value(s) across ${governedOverrideResults.length} authorized package(s))`);
