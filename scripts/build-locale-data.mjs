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
const R9_MIGRATION_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r9-migration.source.json");
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

// --- r9 migration: ATOMIC namespace rename, applied last -------------------
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
const r9 = JSON.parse(readFileSync(R9_MIGRATION_PATH, "utf8"));

const EXPECTED_R9 = {
  package_id: "aprasa-pt-training-record-namespace-migration-r9",
  source_revision: "P03-PT-SOURCE-2026-09-01-r9",
  previous_revision: "P03-PT-SOURCE-2026-08-29-r8",
  revision_class: "RENAME_KEYS",
  row_count: 76,
};

if (r9.package_id !== EXPECTED_R9.package_id) {
  fail(`r9 package_id mismatch: got "${r9.package_id}", expected "${EXPECTED_R9.package_id}"`);
}
if (r9.source_revision !== EXPECTED_R9.source_revision) {
  fail(`r9 source_revision mismatch: got "${r9.source_revision}", expected "${EXPECTED_R9.source_revision}"`);
}
if (r9.previous_revision !== EXPECTED_R9.previous_revision) {
  fail(`r9 previous_revision mismatch: got "${r9.previous_revision}", expected "${EXPECTED_R9.previous_revision}"`);
}
if (r9.revision_class !== EXPECTED_R9.revision_class) {
  fail(`r9 revision_class must be ${EXPECTED_R9.revision_class}, got "${r9.revision_class}"`);
}
if (r9.project_09_status !== "approved") {
  fail(`r9 Project 09 status is not approved: "${r9.project_09_status}"`);
}
if (r9.review_required !== 0 || r9.blocking_issue != null) {
  fail(`r9 has unresolved localization review state`);
}
if (!Array.isArray(r9.rows) || r9.rows.length !== EXPECTED_R9.row_count) {
  fail(`r9 row count mismatch: got ${Array.isArray(r9.rows) ? r9.rows.length : "n/a"}, expected ${EXPECTED_R9.row_count}`);
}
if (r9.supplied_rows_approved !== r9.rows.length) {
  fail(`r9 supplied_rows_approved mismatch: got ${r9.supplied_rows_approved}, expected ${r9.rows.length}`);
}

const r9Records = new Set(r9.records || []);
const r9Renamed = [];
const r9Plan = new Map();
const r9SeenFrom = new Set();
const r9SeenTo = new Set();

for (const row of r9.rows) {
  const { from_key: fromKey, to_key: toKey } = row;

  if (!fromKey || !toKey) fail(`r9 row is missing from_key/to_key: ${JSON.stringify(row)}`);
  if (r9SeenFrom.has(fromKey)) fail(`r9 renames "${fromKey}" more than once`);
  if (r9SeenTo.has(toKey)) fail(`r9 targets "${toKey}" more than once`);
  r9SeenFrom.add(fromKey);
  r9SeenTo.add(toKey);

  // The rename must be a pure namespace move of a governed record field: the
  // record_id and field are declared explicitly and both key names must be
  // exactly reconstructible from them, so a row can never smuggle in a
  // renamed/normalized field name alongside the namespace change.
  if (!r9Records.has(row.record_id)) {
    fail(`r9 row "${fromKey}" targets record "${row.record_id}", which is not in the package's declared record list`);
  }
  if (fromKey !== `home.training.record.${row.record_id}.${row.field}`) {
    fail(`r9 from_key "${fromKey}" is not the legacy form of record "${row.record_id}" field "${row.field}"`);
  }
  if (toKey !== `training.record.${row.record_id}.${row.field}`) {
    fail(`r9 to_key "${toKey}" is not the canonical form of record "${row.record_id}" field "${row.field}"`);
  }

  const current = keys[fromKey];
  if (!current) fail(`r9 cannot rename "${fromKey}": key does not exist in the merged overlay`);
  if (keys[toKey]) fail(`r9 cannot rename "${fromKey}" to "${toKey}": target key already exists`);
  if (r9Plan.has(toKey)) fail(`r9 cannot rename "${fromKey}" to "${toKey}": another row is already being renamed away from that key`);

  // Byte-for-byte equivalence assertion across the rename. This is what makes
  // the migration provably text-preserving rather than merely intended to be.
  if (current.en !== row.expected_en) {
    fail(`r9 EN drift on "${fromKey}": overlay has ${JSON.stringify(current.en)}, package declares ${JSON.stringify(row.expected_en)}`);
  }
  if (current.pt !== row.expected_pt) {
    fail(`r9 PT drift on "${fromKey}": overlay has ${JSON.stringify(current.pt)}, package declares ${JSON.stringify(row.expected_pt)}`);
  }
  if (current.scope_status !== row.expected_scope_status) {
    fail(`r9 scope_status drift on "${fromKey}": overlay has "${current.scope_status}", package declares "${row.expected_scope_status}"`);
  }
  if (current.record_id !== row.record_id) {
    fail(`r9 record_id drift on "${fromKey}": overlay has "${current.record_id}", package declares "${row.record_id}"`);
  }
  if (row.translation_status !== "APPROVED") {
    fail(`r9 row "${fromKey}" is not APPROVED (status: ${row.translation_status})`);
  }

  r9Plan.set(fromKey, toKey);
  r9Renamed.push(toKey);
}

// Apply the whole plan in a single ordered rebuild. Renaming in place would
// move every renamed key to the end of the emitted object and turn a 76-key
// rename into a whole-file diff; rebuilding in the original insertion order
// keeps each row where it already was, so the generated table's diff shows
// exactly the key names that changed and nothing else.
const r9Ordered = Object.entries(keys).map(([key, row]) => {
  const toKey = r9Plan.get(key);
  return toKey ? [toKey, { ...row, key: toKey }] : [key, row];
});
for (const key of Object.keys(keys)) delete keys[key];
for (const [key, row] of r9Ordered) keys[key] = row;
for (const [fromKey, toKey] of r9Plan) {
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
  const orphanRecord = [...r9Records].find((id) => rest === id || rest.startsWith(`${id}.`));
  if (orphanRecord) {
    fail(`r9 left "${key}" behind under the legacy namespace — record "${orphanRecord}" is migrated, so every one of its keys must be in the rename manifest (no dual canonical namespace)`);
  }
}

if (r9Renamed.length !== EXPECTED_R9.row_count) {
  fail(`r9 renamed ${r9Renamed.length} keys, expected ${EXPECTED_R9.row_count}`);
}

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
      ...eventDeltaPackages.map((item) => item.file),
      "data/locales/pt-overlay-r9-migration.source.json",
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
    event_delta_packages: eventDeltaPackages,
    r9_revision: r9.source_revision,
    r9_package_id: r9.package_id,
    r9_revision_class: r9.revision_class,
    r9_renamed_keys: r9Renamed.length,
    r9_canonical_namespace: "training.record.<record_id>.<field>",
    r9_retired_namespace: "home.training.record.<record_id>.<field>",
  },
  counts: {
    total_rows: rows.length + delta.rows.length + delta4.rows.length + delta5.rows.length + delta7.rows.length + delta8.rows.length + eventDeltaRequired + eventDeltaUnchanged,
    required_for_pt_launch: qa_summary.required_for_pt_launch + deltaRequired + delta4Required + delta5Required + delta7Required + delta8Required + eventDeltaRequired,
    intentionally_unchanged: qa_summary.intentionally_unchanged + deltaUnchanged + delta4Unchanged + delta5Unchanged + delta7Unchanged + delta8Unchanged + eventDeltaUnchanged,
    approved_rows_total: qa_summary.approved_rows_total + delta.rows.length + delta4.rows.length + delta5.rows.length + delta7.rows.length + delta8.rows.length + eventDeltaRequired + eventDeltaUnchanged,
    r3_delta_rows: delta.rows.length,
    r4_delta_rows: delta4.rows.length,
    r5_delta_rows: delta5.rows.length,
    r6_override_rows: delta6.rows.length,
    r7_delta_rows: delta7.rows.length,
    r8_delta_rows: delta8.rows.length,
    event_delta_rows: eventDeltaRequired + eventDeltaUnchanged,
    r9_renamed_rows: r9Renamed.length,
  },
  keys,
};

writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
console.log(`[build-locale-data] wrote ${Object.keys(keys).length} keys to ${path.relative(ROOT, OUT_PATH)} (r6 overrode ${delta6Overridden} PT values; event deltas added ${eventDeltaRequired + eventDeltaUnchanged} keys; r9 renamed ${r9Renamed.length} keys onto training.record.*)`);
