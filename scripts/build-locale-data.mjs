#!/usr/bin/env node
// Normalizes the governed Project 09 PT overlay export into
// data/locales/locale-data.generated.json, preserving provenance.
//
// Source of truth: data/locales/pt-overlay-r2.source.json (raw governed r2
// export, 732 rows) PLUS data/locales/pt-overlay-r3-delta.source.json (the
// r3 additive delta, 21 rows) PLUS data/locales/pt-overlay-r4-delta.source.json
// (the r4 additive delta, 26 rows, adding the two EMAR / Kre+ opportunity
// records) merged on top, in order. Each delta is strictly additive: every
// delta key must be new, never an existing key from an earlier revision —
// no delta is authorized to reopen or replace an earlier approved value.
// This script performs no translation and no wording changes — it only
// reshapes and merges the row lists into a keyed lookup table for
// scripts/lib/locale.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SOURCE_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r2.source.json");
const DELTA_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r3-delta.source.json");
const DELTA4_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r4-delta.source.json");
const DELTA5_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r5-delta.source.json");
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

const output = {
  provenance: {
    source_revision: delta5.source_revision,
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
    ],
    base_revision: pkg.source_revision,
    delta_revision: delta.source_revision,
    delta4_revision: delta4.source_revision,
    delta5_revision: delta5.source_revision,
  },
  counts: {
    total_rows: rows.length + delta.rows.length + delta4.rows.length + delta5.rows.length,
    required_for_pt_launch: qa_summary.required_for_pt_launch + deltaRequired + delta4Required + delta5Required,
    intentionally_unchanged: qa_summary.intentionally_unchanged + deltaUnchanged + delta4Unchanged + delta5Unchanged,
    approved_rows_total: qa_summary.approved_rows_total + delta.rows.length + delta4.rows.length + delta5.rows.length,
    r3_delta_rows: delta.rows.length,
    r4_delta_rows: delta4.rows.length,
    r5_delta_rows: delta5.rows.length,
  },
  keys,
};

writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
console.log(`[build-locale-data] wrote ${Object.keys(keys).length} keys to ${path.relative(ROOT, OUT_PATH)}`);
