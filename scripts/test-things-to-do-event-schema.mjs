#!/usr/bin/env node
// Schema regression tests for the Things-to-Do canonical record shapes.
//
// Part 1 covers the dated-event shape, focused on the month-precision end
// fields. Part 2 covers the evergreen "recurring-venue" shape introduced for
// recurring-venue discovery cards, whose whole point is the fields it must NOT
// have -- so negative coverage is the only coverage that can prove it.
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

const taverna = baseData.records.find((r) => r.id === 'taverna-live-music');
if (!taverna) throw new Error('taverna-live-music not found in canonical records');
const nautilus = baseData.records.find((r) => r.id === 'nautilus-live-music');
if (!nautilus) throw new Error('nautilus-live-music not found in canonical records');

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

// Same two helpers against the evergreen recurring-venue fixture. Spreading a
// patch onto it ADDS the field under test, which is exactly what the negative
// rules below need: the rule is that the field must not be there at all.
const withTaverna = (patch) => ({ ...taverna, ...patch });

function expectRejectVenue(name, patch, pattern) {
  const { status, out } = validate(withTaverna(patch));
  const rejected = status !== 0;
  record(name, rejected && (!pattern || pattern.test(out)),
    rejected ? `message did not match ${pattern} — got: ${out.trim().split('\n').slice(-2).join(' / ')}` : 'ACCEPTED');
}

function expectAcceptVenue(name, patch) {
  const { status, out } = validate(withTaverna(patch));
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


// === PART 2: the evergreen recurring-venue shape ============================
//
// A recurring-venue record is a discovery gateway to a venue's current
// approved schedule source. It promises no occurrence, so the validator must
// refuse to let one acquire occurrence semantics by any route.

// --- controls --------------------------------------------------------------
expectAcceptVenue('control: canonical Taverna recurring-venue record validates', {});
record('control: canonical Nautilus recurring-venue record validates',
  validate(nautilus).status === 0);

// --- the kind vocabulary is closed ----------------------------------------
expectRejectVenue('an unknown kind is rejected', { kind: 'venue' }, /invalid kind/);

// --- occurrence fields must be ABSENT, not merely null ---------------------
const OCCURRENCE_ERR = /must not carry the occurrence field/;
const occurrenceValues = {
  start_date: '2026-09-18',
  start_datetime: '2026-09-18T20:30:00-01:00',
  end_date: '2026-09-18',
  end_datetime: '2026-09-18T23:00:00-01:00',
  end_precision: 'day',
  end_month: '2026-09',
};
for (const [field, value] of Object.entries(occurrenceValues)) {
  expectRejectVenue(`recurring-venue rejects a populated ${field}`, { [field]: value }, OCCURRENCE_ERR);
}
// The dated-event shape carries these fields set to null. Inheriting that shape
// is itself the failure: a null slot is an invitation to fill it in later.
expectRejectVenue('recurring-venue rejects a null start_datetime (shape, not just value)',
  { start_datetime: null }, OCCURRENCE_ERR);
expectRejectVenue('recurring-venue rejects a null end_date (shape, not just value)',
  { end_date: null }, OCCURRENCE_ERR);

// --- no admission claim ----------------------------------------------------
const ADMISSION_ERR = /free_admission to null/;
expectRejectVenue('recurring-venue rejects a free-admission claim', { free_admission: true }, ADMISSION_ERR);
expectRejectVenue('recurring-venue rejects a paid-admission claim', { free_admission: false }, ADMISSION_ERR);
expectRejectVenue('recurring-venue rejects an absent free_admission', { free_admission: undefined }, ADMISSION_ERR);

// --- the outbound action must be the approved source ----------------------
expectRejectVenue('recurring-venue rejects a card_action pointing away from the approved source',
  { card_action: { label: 'View current schedule', url: 'https://example.invalid/schedule' } },
  /card_action.url must be the approved source_url/);
expectRejectVenue('recurring-venue rejects a missing card_action',
  { card_action: undefined }, /require a card_action.url/);

// --- structured data can never be Event-family -----------------------------
// The kind exists to be an evergreen gateway, not an occurrence. These records
// are the obvious thing to create by copying an existing one, and every dated
// event in the corpus carries an Event-family seo.schema_type -- so the copy
// path is exactly how "Event" would arrive here.
const SCHEMA_ERR = /must set seo\.schema_type to "WebPage"/;
for (const bad of ['Event', 'ExhibitionEvent', 'SportsEvent', 'MusicEvent']) {
  expectRejectVenue(`recurring-venue rejects seo.schema_type "${bad}"`,
    { seo: { ...taverna.seo, schema_type: bad } }, SCHEMA_ERR);
}
expectRejectVenue('recurring-venue rejects an absent seo.schema_type',
  { seo: { ...taverna.seo, schema_type: undefined } }, SCHEMA_ERR);
expectAcceptVenue('recurring-venue accepts seo.schema_type "WebPage"',
  { seo: { ...taverna.seo, schema_type: 'WebPage' } });

// The rule is scoped to this kind: a dated event's Event-family schema_type is
// untouched by it, in both the incumbent and the month-precision shapes.
expectAccept('dated-event keeps its ExhibitionEvent schema_type',
  { seo: { ...sinergia.seo, schema_type: 'ExhibitionEvent' } });
expectAccept('dated-event keeps a plain Event schema_type',
  { seo: { ...sinergia.seo, schema_type: 'Event' } });

// --- provenance stays mandatory -------------------------------------------
// The checked date is the governed verification of the source relationship. It
// is required for this kind exactly as it is for a dated event.
expectRejectVenue('recurring-venue still requires a valid checked_at',
  { checked_at: undefined }, /invalid checked_at/);
expectRejectVenue('recurring-venue rejects a malformed checked_at',
  { checked_at: '16 September 2026' }, /invalid checked_at/);

console.log(`\nThings-to-Do event schema tests: ${passed}/${passed + failures.length} passed.`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
