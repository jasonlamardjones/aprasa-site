#!/usr/bin/env node
// Normalizes the governed Project 09 PT overlay export into
// data/locales/locale-data.generated.json, preserving provenance.
//
// Source of truth: data/locales/pt-overlay-r2.source.json (raw governed r2
// export, 732 rows) PLUS data/locales/pt-overlay-r3-delta.source.json (the
// r3 additive delta, 21 rows) merged on top. r3 is strictly additive: every
// r3 key must be new, never an existing r2 key — r3 is not authorized to
// reopen or replace r1/r2 approved values. This script performs no
// translation and no wording changes — it only reshapes and merges the row
// lists into a keyed lookup table for scripts/lib/locale.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SOURCE_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r2.source.json");
const DELTA_PATH = path.join(ROOT, "data", "locales", "pt-overlay-r3-delta.source.json");
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

const output = {
  provenance: {
    source_revision: delta.source_revision,
    source_package_id: pkg.source_package_id,
    semantic_authority: pkg.semantic_authority,
    project_09_verdict: pkg.project_09_verdict,
    implementation_reference: pkg.implementation_reference,
    generated_by: "scripts/build-locale-data.mjs",
    generated_from: ["data/locales/pt-overlay-r2.source.json", "data/locales/pt-overlay-r3-delta.source.json"],
    base_revision: pkg.source_revision,
    delta_revision: delta.source_revision,
  },
  counts: {
    total_rows: rows.length + delta.rows.length,
    required_for_pt_launch: qa_summary.required_for_pt_launch + deltaRequired,
    intentionally_unchanged: qa_summary.intentionally_unchanged + deltaUnchanged,
    approved_rows_total: qa_summary.approved_rows_total + delta.rows.length,
    r3_delta_rows: delta.rows.length,
  },
  keys,
};

writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
console.log(`[build-locale-data] wrote ${Object.keys(keys).length} keys to ${path.relative(ROOT, OUT_PATH)}`);
