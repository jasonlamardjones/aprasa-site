#!/usr/bin/env node
// Adversarial tests for the governed override authorization fence in
// scripts/build-locale-data.mjs.
//
// Override packages are the only mechanism that may restate an already-approved
// EN/PT value. An earlier fence validated each package against fields the
// package itself declared, so a probe that swapped in unrelated authority
// strings and an unrelated Myrtle semantic rewrite was accepted. The fence now
// lives in code (GOVERNED_OVERRIDE_CONTRACTS) and the package is checked
// against it.
//
// Every probe below tampers with a package in a throwaway copy of the
// repository and asserts the build FAILS. A probe that passes means the
// override lane has become an ungoverned semantic-rewrite lane.
//
// Usage: node scripts/test-governed-override-authorization.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const R11 = 'pt-overlay-r11-review-due-copy.source.json';
const R12 = 'pt-overlay-r12-academia-cv-statement.source.json';

let passed = 0;
const failures = [];

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-override-test-'));
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  return dir;
}

function build(dir) {
  const r = spawnSync('node', [path.join(dir, 'scripts', 'build-locale-data.mjs')], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function pkgPath(dir, file) {
  return path.join(dir, 'data', 'locales', file);
}

/** Applies a tamper to a package and asserts the build fails closed. */
function probe(name, file, mutate, expectPattern) {
  const dir = sandbox();
  const p = pkgPath(dir, file);
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  mutate(pkg);
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  const { status, out } = build(dir);
  const rejected = status !== 0;
  const matched = expectPattern ? expectPattern.test(out) : true;
  if (rejected && matched) {
    passed += 1;
    console.log(`PASS — rejected: ${name}`);
  } else {
    failures.push(`${name} — status ${status}${rejected ? ` but message did not match ${expectPattern}` : ' (ACCEPTED)'}: ${out.trim().split('\n').pop()}`);
    console.log(`FAIL — ${name} was NOT properly rejected`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// Control: the untampered repository must build.
{
  const dir = sandbox();
  const { status, out } = build(dir);
  if (status === 0) { passed += 1; console.log('PASS — control: untampered packages build'); }
  else { failures.push(`control build failed: ${out.trim()}`); console.log('FAIL — control build'); }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- the exact probe that defeated the previous fence ----------------------
probe('unrelated Myrtle semantic rewrite smuggled into r11', R11, (pkg) => {
  pkg.rows.push({
    key: 'training.record.myrtle.body',
    source_revision: 'P03-PT-SOURCE-2026-09-01-r11',
    old_en: 'Explore language, computer, workplace-English and other learning programs from Myrtle Atividades Educativas in Mindelo.',
    new_en: 'Myrtle is closed until further notice.',
    old_pt: 'Explore programas de línguas, informática, inglês para o trabalho e outras áreas de aprendizagem da Myrtle Atividades Educativas, em Mindelo.',
    new_pt: 'A Myrtle está encerrada até nova indicação.',
    record_id: 'myrtle',
    translation_status: 'APPROVED',
  });
  pkg.affected_records.push('myrtle');
  pkg.supplied_rows_approved = pkg.rows.length;
  pkg.declared_overridden_row_count_in_handoff = pkg.rows.length;
  pkg.change_control_status.existing_keys_overridden = pkg.rows.length;
}, /affected_records is not the authorized set|row count is not authorized/);

probe('unrelated record swapped in place of an authorized row', R11, (pkg) => {
  pkg.rows[0].key = 'training.record.myrtle.status';
  pkg.rows[0].record_id = 'myrtle';
}, /not an authorized target key/);

// --- authority references --------------------------------------------------
probe('modified semantic authority', R11, (pkg) => {
  pkg.semantic_authority = 'Project 99 — self-granted authority';
}, /semantic_authority is not the authorized value/);

probe('modified linguistic authority', R11, (pkg) => {
  pkg.linguistic_authority = 'Project 99 — self-granted linguistic authority';
}, /linguistic_authority is not the authorized value/);

// --- package / revision identity -------------------------------------------
probe('changed package identifier', R11, (pkg) => {
  pkg.package_id = 'aprasa-training-review-due-copy-r11-v2';
}, /package_id is not the authorized value/);

probe('changed revision identifier', R11, (pkg) => {
  pkg.source_revision = 'P03-PT-SOURCE-2026-09-02-r11b';
}, /source_revision is not the authorized value/);

// --- row set ---------------------------------------------------------------
probe('extra sixth row', R11, (pkg) => {
  pkg.rows.push({ ...pkg.rows[0], key: 'training.record.kafe-djan-djan.checked' });
  pkg.supplied_rows_approved = pkg.rows.length;
}, /row count is not authorized/);

probe('missing authorized row', R11, (pkg) => {
  pkg.rows.splice(0, 1);
  pkg.supplied_rows_approved = pkg.rows.length;
}, /row count is not authorized/);

probe('row count declaration inflated', R11, (pkg) => {
  pkg.supplied_rows_approved = 99;
}, /supplied_rows_approved mismatch/);

// --- tuple contents --------------------------------------------------------
probe('modified replacement string (new_en)', R11, (pkg) => {
  pkg.rows[0].new_en = 'Possibly hiring · Mindelo';
}, /new_en is not the authorized value/);

probe('modified replacement string (new_pt)', R11, (pkg) => {
  pkg.rows[3].new_pt = 'Ainda a recrutar para 2026/2027';
}, /new_pt is not the authorized value/);

probe('modified baseline value (old_en)', R11, (pkg) => {
  pkg.rows[0].old_en = 'Something else entirely';
}, /old_en is not the authorized value/);

probe('modified baseline value (old_pt)', R11, (pkg) => {
  pkg.rows[1].old_pt = 'Something else entirely';
}, /old_pt is not the authorized value/);

// --- governance flags ------------------------------------------------------
probe('unapproved Project 09 status', R11, (pkg) => {
  pkg.project_09_status = 'draft';
}, /Project 09 status is not approved/);

probe('lifecycle/state modification claimed', R11, (pkg) => {
  pkg.change_control_status.lifecycle_or_publication_state_modified = 1;
}, /must not modify lifecycle or publication state/);

// --- the same fence applies to r12 -----------------------------------------
probe('r12: unrelated record smuggled in', R12, (pkg) => {
  pkg.rows[0].key = 'training.record.myrtle.good';
  pkg.rows[0].record_id = 'myrtle';
}, /not an authorized target key/);

probe('r12: replacement string reworded', R12, (pkg) => {
  pkg.rows[0].new_en = 'CVs may still be accepted at the secretariats.';
}, /new_en is not the authorized value/);

probe('r12: authority reference changed', R12, (pkg) => {
  pkg.semantic_authority = 'Project 04 — implementation self-authorization';
}, /semantic_authority is not the authorized value/);

console.log(`\nGoverned override authorization probes: ${passed}/${passed + failures.length} passed.`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
