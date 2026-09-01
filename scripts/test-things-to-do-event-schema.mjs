#!/usr/bin/env node
// Schema regression tests for the Things-to-Do dated-event record shape,
// focused on the month-precision end fields.
//
// Independent review of the month-precision work found that end_month was
// validated by SHAPE only (/^\d{4}-\d{2}$/), which accepts impossible calendar
// months such as 2026-00, 2026-13, 2026-99 and 9999-99; and that the
// "end_month must not precede the start month" rule read start_date alone, so
// a record whose start is expressed only as start_datetime slipped past it.
// Neither gap had negative coverage. These tests are that coverage.
//
// Each case writes a candidate records file into a throwaway copy of the
// repository and runs the real validator against it, so what is under test is
// the shipped script, not a reimplementation of its rules.
//
// Usage: node scripts/test-things-to-do-event-schema.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EVENTS = path.join('data', 'things-to-do-events.json');

let passed = 0;
const failures = [];

function record(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS — ${name}`); }
  else { failures.push(`${name}${detail ? `: ${detail}` : ''}`); console.log(`FAIL — ${name}${detail ? `: ${detail}` : ''}`); }
}

const baseData = JSON.parse(fs.readFileSync(path.join(ROOT, EVENTS), 'utf8'));
const sinergia = baseData.records.find((r) => r.id === 'sinergia-da-materia');
if (!sinergia) throw new Error('sinergia-da-materia not found in canonical records');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-schema-test-'));
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  return dir;
}

/** Run the real validator against a records file containing exactly `rec`. */
function validate(rec) {
  const dir = sandbox();
  const data = JSON.parse(fs.readFileSync(path.join(dir, EVENTS), 'utf8'));
  data.records = data.records.map((r) => (r.id === rec.id ? rec : r));
  fs.writeFileSync(path.join(dir, EVENTS), JSON.stringify(data, null, 2) + '\n');
  const r = spawnSync('node', [path.join(dir, 'scripts', 'validate-things-to-do-events.mjs')], { cwd: dir, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const withSinergia = (patch) => ({ ...sinergia, ...patch });

function expectReject(name, patch, pattern) {
  const { status, out } = validate(withSinergia(patch));
  const rejected = status !== 0;
  record(name, rejected && (!pattern || pattern.test(out)),
    rejected ? `message did not match ${pattern} — got: ${out.trim().split('\n').slice(-2).join(' / ')}` : 'ACCEPTED');
}

function expectAccept(name, patch) {
  const { status, out } = validate(withSinergia(patch));
  record(name, status === 0, out.trim().split('\n').slice(-2).join(' / '));
}

// --- control ---------------------------------------------------------------
expectAccept('control: canonical Sinergia record validates', {});

// --- PATCH 1: impossible calendar months -----------------------------------
const MONTH_ERR = /valid calendar month/;
for (const bad of ['2026-00', '2026-13', '2026-99', '9999-99']) {
  expectReject(`impossible calendar month ${bad} is rejected`, { end_month: bad }, MONTH_ERR);
}
// Shape failures must still be caught by the same rule.
for (const bad of ['2026', '2026-1', 'not-a-month', '2026-11-01', '']) {
  expectReject(`malformed end_month ${JSON.stringify(bad)} is rejected`, { end_month: bad }, MONTH_ERR);
}
// Boundary months are real and must be accepted. Each is paired with a start
// inside that month, so this asserts calendar validity alone and is not
// silently satisfied (or failed) by the ordering rule tested below.
expectAccept('boundary month 2026-01 is accepted',
  { start_date: '2026-01-05', start_datetime: null, end_month: '2026-01' });
expectAccept('boundary month 2026-12 is accepted',
  { start_date: '2026-12-05', start_datetime: null, end_month: '2026-12' });

// --- PATCH 2: end_month must not precede the start month -------------------
const ORDER_ERR = /before start month/;

expectReject('end_month before start_date month is rejected',
  { start_date: '2026-07-31', start_datetime: null, end_month: '2026-06' }, ORDER_ERR);

expectReject('end_month before start_datetime month is rejected',
  { start_date: null, start_datetime: '2026-07-31T20:00:00-01:00', end_month: '2026-06' }, ORDER_ERR);

expectAccept('end_month equal to the start month is accepted (start_date)',
  { start_date: '2026-07-31', start_datetime: null, end_month: '2026-07' });

expectAccept('end_month equal to the start month is accepted (start_datetime)',
  { start_date: null, start_datetime: '2026-07-31T20:00:00-01:00', end_month: '2026-07' });

expectAccept('valid control: July start, end_month 2026-11 (start_date)',
  { start_date: '2026-07-31', start_datetime: null, end_month: '2026-11' });

expectAccept('valid control: July start, end_month 2026-11 (start_datetime)',
  { start_date: null, start_datetime: '2026-07-31T20:00:00-01:00', end_month: '2026-11' });

// A start_datetime whose local calendar date is read AS WRITTEN: the offset
// must not be applied to shift the governed month.
expectReject('start_datetime local calendar month is read as written, not offset-shifted',
  { start_date: null, start_datetime: '2026-08-01T00:30:00-01:00', end_month: '2026-07' }, ORDER_ERR);

// --- preserved existing month-precision rules ------------------------------
expectReject('month precision requires end_month',
  { end_month: undefined }, /requires end_month/);

expectReject('month precision forbids an exact end_date',
  { end_date: '2026-11-30' }, /requires end_date null/);

expectReject('month precision forbids an exact end_datetime',
  { end_datetime: '2026-11-30T20:00:00-01:00' }, /requires end_datetime null/);

expectReject('end_month is rejected outside month precision',
  { end_precision: 'day', end_date: '2026-11-30', end_month: '2026-11' },
  /end_month is only valid with end_precision "month"/);

expectReject('invalid end_precision is rejected',
  { end_precision: 'week' }, /invalid end_precision/);

// Absent end_precision keeps legacy day semantics: a plain day-precision
// record with no end_month and an exact end_date must still validate.
expectAccept('absent end_precision retains legacy day semantics',
  { end_precision: undefined, end_month: undefined, end_date: '2026-11-30' });

console.log(`\nThings-to-Do event schema tests: ${passed}/${passed + failures.length} passed.`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
