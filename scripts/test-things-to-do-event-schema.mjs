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
import {
  SOURCE_REFERENCE_EVENT_IDS,
  SOURCE_REFERENCE_EVIDENCE_HANDLES,
  assertPublicInputBoundary,
  validatePacket,
  validatePublicInputShapes,
  validateSourceUnion,
} from './lib/event-publication-contract.mjs';

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

// --- the outbound action must be the approved schedule destination --------
// Taverna and Nautilus have two record-specific durable provider destinations
// approved by Project 03. Other recurring venues continue to default to the
// evidence source_url unless separately governed.
expectAcceptVenue('Taverna accepts its approved durable provider destination', {
  card_action: { ...taverna.card_action, url: 'https://www.facebook.com/TavernaMindelo' },
});
record('Nautilus accepts its approved durable provider destination',
  validate({
    ...nautilus,
    card_action: { ...nautilus.card_action, url: 'https://www.facebook.com/Nautilus.Mindelo' },
  }).status === 0);
expectRejectVenue('recurring-venue rejects an unapproved action destination',
  { card_action: { label: 'View current schedule', url: 'https://example.invalid/schedule' } },
  /card_action.url must match the approved schedule destination/);
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

// ===========================================================================
// Part 3 — record-scoped source union (Project 03 / Project 04 handoff)
//
// The Project 25 handle for each approved event is the event's own id, held in
// an explicit immutable allowlist; no restricted record id appears here.
// ===========================================================================
const KUTUMBAIA_ID = 'kutumbaia-edicao-03-2026';
const MANXI_ID = 'manxi-liliane-reis-exhibition-2026';
const synthRef = (id = KUTUMBAIA_ID) => ({ version: 1, kind: 'restricted-evidence', evidence_ref: id });
const synthB = (id = KUTUMBAIA_ID, patch = {}) => ({
  ...structuredClone(baseData.records.find((r) => r.id === 'cartinha-dholanda-mindelo-2026')),
  id, title: 'SYNTH Title', media_manifest_title: 'SYNTH Title', detail_page: `things-to-do/${id}/`,
  source_url: null, source_reference: synthRef(id), card_action: null,
  ...patch,
});
const withNoAction = (rec) => ({ ...rec, detail: { ...rec.detail, action_label: null } });
const unionProblems = (rec) => validateSourceUnion(rec);
const unionRejects = (name, rec, pattern) => {
  const problems = unionProblems(rec);
  record(name, problems.length > 0 && (!pattern || problems.some((p) => pattern.test(p))), problems.join(' | ') || 'ACCEPTED');
};

record('source union: both approved ids are the only scoped ids', JSON.stringify(SOURCE_REFERENCE_EVENT_IDS) === JSON.stringify([KUTUMBAIA_ID, MANXI_ID]));
record('source union: the evidence allowlist maps each approved id to itself, exactly',
  JSON.stringify(SOURCE_REFERENCE_EVIDENCE_HANDLES) === JSON.stringify({ [KUTUMBAIA_ID]: KUTUMBAIA_ID, [MANXI_ID]: MANXI_ID }));
record('source union: the allowlist is immutable',
  Object.isFrozen(SOURCE_REFERENCE_EVIDENCE_HANDLES) && Object.isFrozen(SOURCE_REFERENCE_EVENT_IDS)
    && (() => { try { SOURCE_REFERENCE_EVIDENCE_HANDLES['sinergia-da-materia'] = 'sinergia-da-materia'; } catch { /* strict mode throws */ } return !('sinergia-da-materia' in SOURCE_REFERENCE_EVIDENCE_HANDLES); })());
record('source union: every incumbent record is valid mode A', baseData.records.every((r) => validateSourceUnion(r).length === 0));
for (const id of [KUTUMBAIA_ID, MANXI_ID]) {
  record(`source union: ${id} accepts its own approved evidence handle (mode B)`, unionProblems(withNoAction(synthB(id))).length === 0, unionProblems(withNoAction(synthB(id))).join(' | '));
}
unionRejects('source union: a wrong-event handle is rejected (Kutumbaia record, MANXI handle)', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: synthRef(MANXI_ID) })), /must equal the approved evidence handle/);
unionRejects('source union: a wrong-event handle is rejected (MANXI record, Kutumbaia handle)', withNoAction(synthB(MANXI_ID, { source_reference: synthRef(KUTUMBAIA_ID) })), /must equal the approved evidence handle/);
unionRejects('source union: an unlisted handle is rejected', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: { ...synthRef(), evidence_ref: 'kutumbaia-edicao-04-2026' } })), /must equal the approved evidence handle/);
unionRejects('source union: a handle differing only by case is rejected', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: { ...synthRef(), evidence_ref: 'Kutumbaia-Edicao-03-2026' } })), /must equal the approved evidence handle/);
unionRejects('source union: a missing evidence_ref is rejected', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: { version: 1, kind: 'restricted-evidence' } })), /evidence_ref must be a non-empty/);
unionRejects('source union: an empty evidence_ref is rejected', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: { ...synthRef(), evidence_ref: '' } })), /evidence_ref must be a non-empty/);
unionRejects('source union: a non-string evidence_ref is rejected', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: { ...synthRef(), evidence_ref: 42 } })), /evidence_ref must be a non-empty/);
unionRejects('source union: mixed mode (url AND reference) is rejected', withNoAction(synthB(KUTUMBAIA_ID, { source_url: 'https://example.org/x' })), /mutually exclusive/);
unionRejects('source union: absent mode (neither) is rejected', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: undefined })), /missing source_url/);
unionRejects('source union: an explicit null source_reference is rejected, not treated as absent', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: null })), /source_reference must be an object/);
unionRejects('source union: an explicit null source_reference is rejected on an ordinary mode A record', { ...structuredClone(sinergia), source_reference: null }, /source_reference must be an object/);
unionRejects('source union: mode A is not allowed for a scoped id', { ...structuredClone(sinergia), id: KUTUMBAIA_ID }, /requires a governed source_reference/);
unionRejects('source union: mode B is not allowed for any other id', withNoAction(synthB('sinergia-da-materia')), /only permitted for the two/);
unionRejects('source union: an unsupported id cannot borrow an approved handle', withNoAction(synthB('sinergia-da-materia', { source_reference: synthRef(KUTUMBAIA_ID) })), /only permitted for the two|no approved handle/);
unionRejects('source union: Object.prototype names are not scoped ids', withNoAction(synthB('constructor', { source_reference: { ...synthRef(), evidence_ref: 'constructor' } })), /only permitted for the two/);
unionRejects('source union: empty-string source_url does not stand in for null', withNoAction(synthB(KUTUMBAIA_ID, { source_url: '' })), /missing source_url|requires source_url to be null/);
unionRejects('source union: a non-object reference is rejected', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: KUTUMBAIA_ID })), /must be an object/);
for (const [label, patch, pattern] of [
  ['unknown version', { version: 2 }, /version must equal 1/],
  ['unknown kind', { kind: 'public-url' }, /kind must be/],
  ['extra field', { note: 'x' }, /unsupported field/],
  ['retired flyer_ref field', { flyer_ref: 'x' }, /unsupported field/],
  ['retired attestation_ref field', { attestation_ref: 'x' }, /unsupported field/],
  ['retired attestation_date field', { attestation_date: '2026-10-21' }, /unsupported field/],
]) {
  unionRejects(`source union: ${label} is rejected`, withNoAction(synthB(KUTUMBAIA_ID, { source_reference: { ...synthRef(), ...patch } })), pattern);
}
// NO_CTA is enforced in mode B, on both public-action fields.
unionRejects('source union: mode B rejects a card_action', withNoAction(synthB(KUTUMBAIA_ID, { card_action: { label: 'Open', url: 'https://example.org/' } })), /NO_CTA/);
unionRejects('source union: mode B rejects a detail action_label', synthB(), /action_label to null \(NO_CTA\)/);

// Public-leak guard: nothing that locates restricted evidence may be a handle.
for (const [label, value] of [
  ['URL', 'https://example.org/evidence'],
  ['Drive locator', 'drive.google.com'],
  ['attachment id', `file_${'0123456789abcdef'.repeat(2)}`],
  ['SHA-256 value', 'a'.repeat(64)],
  ['email address', 'person@example.org'],
  ['path', 'restricted/flyer'],
  ['whitespace', 'flyer 1'],
]) {
  unionRejects(`source union leak guard: evidence_ref rejects ${label}`,
    withNoAction(synthB(KUTUMBAIA_ID, { source_reference: { ...synthRef(), evidence_ref: value } })), /must not contain/);
}
// A restricted Project 25 record id is not an approved handle, whatever its shape.
unionRejects('source union: a restricted-register record id is not an approved handle',
  withNoAction(synthB(KUTUMBAIA_ID, { source_reference: { ...synthRef(), evidence_ref: ['P25', 'EV', '2026', '0001'].join('-') } })), /must equal the approved evidence handle/);

// The packet contract runs the same union: dry-run packets cannot sidestep it.
{
  const packet = JSON.parse(fs.readFileSync(path.join(ROOT, 'automation', 'things-to-do', 'fixtures', 'ready.json'), 'utf8'));
  const issues = (event) => validatePacket({ ...packet, event }, { checkRepository: false }).issues ?? [];
  const asText = (list) => list.map((i) => i.reason).join(' | ');
  const modeB = (id, ref) => withNoAction({ ...packet.event, id, detail_page: `things-to-do/${id}/`, source_url: null, source_reference: ref, card_action: null });
  const mixed = issues({ ...packet.event, source_reference: synthRef() });
  record('packet: a url + reference event is rejected by the contract', /mutually exclusive/.test(asText(mixed)), asText(mixed));
  const absent = issues({ ...packet.event, source_url: null });
  record('packet: an event with neither source is rejected', /missing source_url/.test(asText(absent)), asText(absent));
  for (const id of [KUTUMBAIA_ID, MANXI_ID]) {
    const ok = issues(modeB(id, synthRef(id))).filter((i) => /source_(url|reference)/.test(`${i.reason} ${i.required_input}`));
    record(`packet: ${id} mode B raises no source issue with its own handle`, ok.length === 0, asText(ok));
  }
  const wrong = issues(modeB(KUTUMBAIA_ID, synthRef(MANXI_ID)));
  record('packet: a wrong-event handle is rejected by the contract', /must equal the approved evidence handle/.test(asText(wrong)), asText(wrong));
  const extra = issues(modeB(KUTUMBAIA_ID, { ...synthRef(), flyer_ref: 'x' }));
  record('packet: an extra reference field is rejected by the contract', /unsupported field/.test(asText(extra)), asText(extra));
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'automation', 'things-to-do', 'event-publication-packet.schema.json'), 'utf8'));
  const refSchema = schema.properties.event.properties.source_reference;
  record('packet schema: source_url admits null and source_reference is a closed evidence_ref object',
    schema.properties.event.properties.source_url.type.includes('null')
      && refSchema.additionalProperties === false
      && JSON.stringify(refSchema.required) === JSON.stringify(['version', 'kind', 'evidence_ref'])
      && !('flyer_ref' in refSchema.properties) && !('attestation_ref' in refSchema.properties) && !('attestation_date' in refSchema.properties));
  const branches = schema.properties.event.oneOf.slice(1);
  record('packet schema: each mode B branch binds one id to its own evidence handle',
    branches.length === 2 && branches.every((b) => b.properties.id.const === b.properties.source_reference.properties.evidence_ref.const)
      && JSON.stringify(branches.map((b) => b.properties.id.const)) === JSON.stringify([KUTUMBAIA_ID, MANXI_ID]));
}

// Real validators against a throwaway copy of the repository.
function sandboxWith(mutate) {
  const dir = sandbox();
  const eventsFile = path.join(dir, EVENTS);
  const manifestFile = path.join(dir, 'internal', 'provider-media-manifest.json');
  const state = { data: JSON.parse(fs.readFileSync(eventsFile, 'utf8')), manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')), dir };
  mutate(state);
  fs.writeFileSync(eventsFile, JSON.stringify(state.data, null, 2) + '\n');
  fs.writeFileSync(manifestFile, JSON.stringify(state.manifest, null, 2) + '\n');
  return state;
}
const runIn = (dir, script, args = []) => {
  const r = spawnSync('node', [path.join(dir, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const cartinhaManifestRow = (manifest) => manifest.records.find((r) => r.section === 'things-to-do'
  && r.title === baseData.records.find((x) => x.id === 'cartinha-dholanda-mindelo-2026').media_manifest_title);
const addSynthB = ({ data, manifest }) => {
  data.records.push(withNoAction(synthB()));
  manifest.records.push({ ...structuredClone(cartinhaManifestRow(manifest)), title: 'SYNTH Title', source_url: null });
};

{
  const state = sandboxWith(addSynthB);
  const r = runIn(state.dir, 'validate-things-to-do-events.mjs');
  record('canonical validator: mode B with its own handle raises no source issue', !/source_(url|reference)/.test(r.out), r.out.trim().split('\n').slice(-3).join(' / '));
  fs.rmSync(state.dir, { recursive: true, force: true });
}
{
  const state = sandboxWith(({ data, manifest }) => {
    data.records.push(withNoAction(synthB(KUTUMBAIA_ID, { source_reference: synthRef(MANXI_ID) })));
    manifest.records.push({ ...structuredClone(cartinhaManifestRow(manifest)), title: 'SYNTH Title', source_url: null });
  });
  const r = runIn(state.dir, 'validate-things-to-do-events.mjs');
  record('canonical validator: a wrong-event handle is rejected', r.status !== 0 && /must equal the approved evidence handle/.test(r.out), r.out.trim().split('\n').slice(-2).join(' / '));
  fs.rmSync(state.dir, { recursive: true, force: true });
}
{
  const state = sandboxWith(({ data }) => { data.records = data.records.map((x) => (x.id === 'sinergia-da-materia' ? { ...x, source_url: 'https://example.org/x', source_reference: synthRef() } : x)); });
  const r = runIn(state.dir, 'validate-things-to-do-events.mjs');
  record('canonical validator: a mixed incumbent record is rejected', r.status !== 0 && /mutually exclusive/.test(r.out), r.out.trim().split('\n').slice(-2).join(' / '));
  fs.rmSync(state.dir, { recursive: true, force: true });
}
{
  const state = sandboxWith(({ manifest }) => { manifest.records.find((x) => x.title === 'Sinergia da Matéria' || x.title === baseData.records.find((y) => y.id === 'sinergia-da-materia').media_manifest_title).source_url = null; });
  const r = runIn(state.dir, 'validate-card-media.mjs');
  record('media validator: a null manifest source_url is rejected beside a mode A record', r.status === 1 && /source_url null is only valid/.test(r.out), r.out.trim().split('\n').slice(-2).join(' / '));
  fs.rmSync(state.dir, { recursive: true, force: true });
}
{
  const state = sandboxWith(({ manifest }) => { cartinhaManifestRow(manifest).source_reference = synthRef(); });
  const r = runIn(state.dir, 'validate-card-media.mjs');
  record('media validator: a manifest row carrying source_reference is rejected', r.status === 1 && /must not carry source_reference/.test(r.out), r.out.trim().split('\n').slice(-2).join(' / '));
  fs.rmSync(state.dir, { recursive: true, force: true });
}
{
  // Rendering: a mode B record produces a detail page with no evidence link, no
  // handle anywhere in generated output, and no public action. The generator
  // does not run the validators, so this exercises it on its own.
  const state = sandboxWith(addSynthB);
  for (const file of ['index.html', 'pt/index.html']) {
    const homeFile = path.join(state.dir, file);
    let html = fs.readFileSync(homeFile, 'utf8');
    const last = [...html.matchAll(/<!-- END GENERATED EVENT: [a-z0-9]+(?:-[a-z0-9]+)* -->/g)].pop();
    const at = last.index + last[0].length;
    html = `${html.slice(0, at)}\n        <!-- BEGIN GENERATED EVENT: ${KUTUMBAIA_ID} -->\n        <!-- END GENERATED EVENT: ${KUTUMBAIA_ID} -->${html.slice(at)}`;
    fs.writeFileSync(homeFile, html);
  }
  const gen = runIn(state.dir, 'generate-things-to-do.mjs', ['--write', '--as-of=2026-10-12']);
  const detailFile = path.join(state.dir, 'things-to-do', KUTUMBAIA_ID, 'index.html');
  const detail = fs.existsSync(detailFile) ? fs.readFileSync(detailFile, 'utf8') : '';
  record('render: the mode B detail page is generated', gen.status === 0 && detail.length > 0, gen.out.trim().split('\n').slice(-2).join(' / '));
  const generatedFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|xml|txt)$/.test(entry.name)) generatedFiles.push(full);
    }
  })(state.dir);
  const markerLeaks = generatedFiles.filter((f) => /evidence_ref|source_reference|restricted-evidence/.test(fs.readFileSync(f, 'utf8')));
  record('render: no source_reference marker appears in any generated HTML/XML/TXT', markerLeaks.length === 0, markerLeaks.join(', '));
  record('render: no public action link on a mode B detail page', !/class="dialog-link"/.test(detail));
  const jsonLd = detail.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '';
  const ld = jsonLd ? JSON.parse(jsonLd) : {};
  record('render: JSON-LD carries no source URL, reference, sameAs or action',
    jsonLd.length > 0 && !('sameAs' in ld) && !('potentialAction' in ld) && !/evidence_ref|source_reference|restricted-evidence|"source/.test(jsonLd) && ld.url === `https://aprasa.org/things-to-do/${KUTUMBAIA_ID}/`);
  fs.rmSync(state.dir, { recursive: true, force: true });
}

{
  // Generator guard: the generator does not run the validators, so it refuses a
  // mode B record that carries any public action on its own.
  for (const [label, patch] of [
    ['a detail action_label', { detail: { ...synthB().detail, action_label: 'View source' } }],
    ['a card_action', { card_action: { label: 'Open', url: 'https://example.org/' } }],
  ]) {
    const state = sandboxWith(({ data, manifest }) => {
      data.records.push({ ...withNoAction(synthB()), ...patch });
      manifest.records.push({ ...structuredClone(cartinhaManifestRow(manifest)), title: 'SYNTH Title', source_url: null });
    });
    for (const file of ['index.html', 'pt/index.html']) {
      const homeFile = path.join(state.dir, file);
      let html = fs.readFileSync(homeFile, 'utf8');
      const last = [...html.matchAll(/<!-- END GENERATED EVENT: [a-z0-9]+(?:-[a-z0-9]+)* -->/g)].pop();
      const at = last.index + last[0].length;
      html = `${html.slice(0, at)}\n        <!-- BEGIN GENERATED EVENT: ${KUTUMBAIA_ID} -->\n        <!-- END GENERATED EVENT: ${KUTUMBAIA_ID} -->${html.slice(at)}`;
      fs.writeFileSync(homeFile, html);
    }
    const gen = runIn(state.dir, 'generate-things-to-do.mjs', ['--write', '--as-of=2026-10-12']);
    record(`generator guard: refuses a mode B record carrying ${label}`, gen.status !== 0 && /NO_CTA/.test(gen.out), gen.out.trim().split('\n').slice(-2).join(' / '));
    fs.rmSync(state.dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// Part 4 — Codex review remediation: public-input boundary, schema/runtime
// agreement and standalone fail-closed enforcement.
//
// The repository carries no JSON Schema library and gains none here. The
// evaluator below is test-local, implements exactly the keywords the packet
// schema uses and THROWS on any other keyword, so the schema cannot quietly grow
// past it. The acceptance matrix runs the real schema file and the real runtime
// validators on the same packets and requires the same verdict from both.
// ===========================================================================
const SCHEMA_KEYWORDS = new Set(['$schema', '$id', 'title', 'type', 'const', 'enum', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'minLength', 'maxLength', 'pattern', 'oneOf', 'not', 'default']);
const jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function schemaTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return Number.isInteger(v) ? 'integer' : typeof v;
}
const schemaTypeOk = (v, t) => (t === 'number' ? ['number', 'integer'].includes(schemaTypeOf(v)) : schemaTypeOf(v) === t);
function schemaErrors(value, schema, pointer = '#', errors = []) {
  for (const keyword of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(keyword)) throw new Error(`test schema evaluator: unsupported keyword "${keyword}" at ${pointer}`);
  }
  if ('type' in schema && ![].concat(schema.type).some((t) => schemaTypeOk(value, t))) errors.push(`${pointer}: wrong type`);
  if ('const' in schema && !jsonEq(value, schema.const)) errors.push(`${pointer}: const`);
  if ('enum' in schema && !schema.enum.some((e) => jsonEq(e, value))) errors.push(`${pointer}: enum`);
  if (typeof value === 'string') {
    if ('minLength' in schema && value.length < schema.minLength) errors.push(`${pointer}: minLength`);
    if ('maxLength' in schema && value.length > schema.maxLength) errors.push(`${pointer}: maxLength`);
    if ('pattern' in schema && !new RegExp(schema.pattern).test(value)) errors.push(`${pointer}: pattern`);
  }
  if (Array.isArray(value)) {
    if ('minItems' in schema && value.length < schema.minItems) errors.push(`${pointer}: minItems`);
    if ('items' in schema) value.forEach((item, i) => schemaErrors(item, schema.items, `${pointer}[${i}]`, errors));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${pointer}: missing ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) schemaErrors(child, schema.properties[key], `${pointer}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${pointer}: unexpected field ${key}`);
    }
  }
  if ('oneOf' in schema) {
    const matches = schema.oneOf.filter((sub) => schemaErrors(value, sub, pointer, []).length === 0).length;
    if (matches !== 1) errors.push(`${pointer}: oneOf matched ${matches}`);
  }
  if ('not' in schema && schemaErrors(value, schema.not, pointer, []).length === 0) errors.push(`${pointer}: not`);
  return errors;
}

const packetSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'automation', 'things-to-do', 'event-publication-packet.schema.json'), 'utf8'));
const writeFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'automation', 'things-to-do', 'fixtures', 'ready-write.json'), 'utf8'));
const readyFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'automation', 'things-to-do', 'fixtures', 'ready.json'), 'utf8'));
const runtimeAccepts = (packet) => validatePublicInputShapes(packet).length === 0 && validateSourceUnion(packet.event).length === 0;
const schemaAccepts = (packet) => schemaErrors(packet, packetSchema).length === 0;
const cloneJson = (v) => JSON.parse(JSON.stringify(v));

// Restricted shapes are assembled from parts so this file never contains one whole.
const HEX32 = '0123456789abcdef'.repeat(2);
const RESTRICTED = [
  ['attachment id', `file_${HEX32}`],
  ['SHA-256 value', 'ab'.repeat(32)],
  ['internal evidence id', ['P25', 'EV', '2026', '0001'].join('-')],
  ['Drive locator', `https://drive.${'google'}.com/file/d/restricted/view`],
  ['Docs locator', `https://docs.${'google'}.com/document/d/restricted/edit`],
];

const asModeB = (packet, id = KUTUMBAIA_ID, ref = synthRef(id)) => {
  const p = cloneJson(packet);
  Object.assign(p.event, { id, detail_page: `things-to-do/${id}/`, source_url: null, source_reference: ref, card_action: null });
  p.event.detail.action_label = null;
  return p;
};
const withEvent = (patch) => (p) => { Object.assign(p.event, patch); return p; };

const MATRIX = [
  // [name, packet, expected verdict from BOTH schema and runtime]
  ['control: incumbent-shaped mode A packet (ready fixture)', readyFixture, true],
  ['control: incumbent-shaped mode A packet with manifest + package (write fixture)', writeFixture, true],
  ['mode B Kutumbaia with its own handle', asModeB(writeFixture, KUTUMBAIA_ID), true],
  ['mode B MANXI with its own handle', asModeB(writeFixture, MANXI_ID), true],
  ['mode A: scoped id with a plain URL is rejected', withEvent({ id: KUTUMBAIA_ID, detail_page: `things-to-do/${KUTUMBAIA_ID}/` })(cloneJson(writeFixture)), false],
  ['mode A: scoped id with URL AND reference is rejected (mixed)', withEvent({ id: MANXI_ID, detail_page: `things-to-do/${MANXI_ID}/`, source_reference: synthRef(MANXI_ID) })(cloneJson(writeFixture)), false],
  ['mode A: explicit source_reference null is rejected (unscoped id)', withEvent({ source_reference: null })(cloneJson(writeFixture)), false],
  ['mode B: explicit source_reference null is rejected', withEvent({ source_reference: null })(asModeB(writeFixture)), false],
  ['mode B: source_url omitted is rejected', ((p) => { delete p.event.source_url; return p; })(asModeB(writeFixture)), false],
  ['mode B: wrong-event handle is rejected', asModeB(writeFixture, KUTUMBAIA_ID, synthRef(MANXI_ID)), false],
  ['mode B: unlisted handle is rejected', asModeB(writeFixture, KUTUMBAIA_ID, { ...synthRef(), evidence_ref: 'kutumbaia-edicao-04-2026' }), false],
  ['mode B: unsupported id is rejected', asModeB(writeFixture, 'automation-fixture-guarded-write', synthRef()), false],
  ['mode B: extra reference field is rejected', asModeB(writeFixture, KUTUMBAIA_ID, { ...synthRef(), attestation_date: '2026-10-21' }), false],
  ['mode B: missing evidence_ref is rejected', asModeB(writeFixture, KUTUMBAIA_ID, { version: 1, kind: 'restricted-evidence' }), false],
  ['mode B: wrong version is rejected', asModeB(writeFixture, KUTUMBAIA_ID, { ...synthRef(), version: 2 }), false],
  ['mode B: wrong kind is rejected', asModeB(writeFixture, KUTUMBAIA_ID, { ...synthRef(), kind: 'public-url' }), false],
  ['mode B: card_action present is rejected (NO_CTA)', withEvent({ card_action: { label: 'Open', url: 'https://example.org/' } })(asModeB(writeFixture)), false],
  ['mode B: action_label present is rejected (NO_CTA)', ((p) => { p.event.detail.action_label = 'Open'; return p; })(asModeB(writeFixture)), false],
  ['mode A: non-HTTP source_url is rejected', withEvent({ source_url: 'ftp://example.org/x' })(cloneJson(writeFixture)), false],
  ['mode A: empty source_url is rejected', withEvent({ source_url: '' })(cloneJson(writeFixture)), false],
  ['mode A: both source fields absent is rejected', ((p) => { delete p.event.source_url; return p; })(cloneJson(writeFixture)), false],
  ['fact with both value and value_html is rejected', ((p) => { p.event.detail.facts[0].value_html = '<b>x</b>'; return p; })(cloneJson(writeFixture)), false],
  ['fact with neither value nor value_html is rejected', ((p) => { delete p.event.detail.facts[0].value; return p; })(cloneJson(writeFixture)), false],
  ['legitimate optional fields are accepted (street, end_month, end_precision, currentness_note, value_html)', ((p) => {
    Object.assign(p.event, { end_month: '2026-11', end_precision: 'month', currentness_note: 'Checked.', start_date: '2026-09-20' });
    p.event.location.street = 'Rua de Lisboa';
    p.event.detail.facts.push({ label: 'Link', value_html: '<a href="https://example.org/x">example.org</a>' });
    return p;
  })(cloneJson(writeFixture)), true],
  ['event.media null is accepted (fallback media)', withEvent({ media: null, media_policy: 'fallback_allowed' })(cloneJson(writeFixture)), true],
];
// Extra fields at every depth, with every restricted shape, as value AND as key.
const INJECTION_SITES = [
  ['event top level', (p, k, v) => { p.event[k] = v; }],
  ['event.location', (p, k, v) => { p.event.location[k] = v; }],
  ['event.display', (p, k, v) => { p.event.display[k] = v; }],
  ['event.media', (p, k, v) => { p.event.media[k] = v; }],
  ['event.card_action', (p, k, v) => { p.event.card_action[k] = v; }],
  ['event.detail', (p, k, v) => { p.event.detail[k] = v; }],
  ['event.detail.facts[0]', (p, k, v) => { p.event.detail.facts[0][k] = v; }],
  ['event.seo', (p, k, v) => { p.event.seo[k] = v; }],
  ['event.source_reference', (p, k, v) => {
    // A fully valid mode B record apart from the injected reference field.
    Object.assign(p.event, { id: KUTUMBAIA_ID, detail_page: `things-to-do/${KUTUMBAIA_ID}/`, source_url: null, source_reference: { ...synthRef(), [k]: v }, card_action: null });
    p.event.detail.action_label = null;
  }],
  ['media.approved_manifest', (p, k, v) => { p.media.approved_manifest[k] = v; }],
  ['localization.approved_package', (p, k, v) => { p.localization.approved_package[k] = v; }],
  ['localization.approved_package.rows[0]', (p, k, v) => { p.localization.approved_package.rows[0][k] = v; }],
];
for (const [label, value] of RESTRICTED) {
  for (const [site, inject] of INJECTION_SITES) {
    const asValue = cloneJson(writeFixture); inject(asValue, 'restricted_note', value);
    const asKey = cloneJson(writeFixture); inject(asKey, value, 'x');
    MATRIX.push([`injection: ${label} as an extra field VALUE at ${site}`, asValue, false]);
    MATRIX.push([`injection: ${label} as an extra field KEY at ${site}`, asKey, false]);
  }
}
for (const [name, packet, expected] of MATRIX) {
  const schemaVerdict = schemaAccepts(packet);
  const runtimeVerdict = runtimeAccepts(packet);
  record(`matrix: ${name}`, schemaVerdict === expected && runtimeVerdict === expected, `schema=${schemaVerdict} runtime=${runtimeVerdict} expected=${expected}`);
}

// Every dated-event incumbent record is admissible to both validators unchanged.
{
  const datedIncumbents = baseData.records.filter((r) => r.kind === 'dated-event');
  const eventSchema = packetSchema.properties.event;
  const bad = datedIncumbents.filter((r) => schemaErrors(r, eventSchema).length > 0 || validatePublicInputShapes({ event: r }).length > 0 || validateSourceUnion(r).length > 0).map((r) => r.id);
  record(`incumbent: all ${datedIncumbents.length} dated-event records pass the event schema and runtime boundary unchanged`, bad.length === 0, bad.join(', '));
  const manifestRows = JSON.parse(fs.readFileSync(path.join(ROOT, 'internal', 'provider-media-manifest.json'), 'utf8')).records
    .filter((r) => r.section === 'things-to-do' && !('retained_detail_page' in r));
  const manifestSchema = packetSchema.properties.media.properties.approved_manifest;
  // A hash-bearing incumbent provenance passes when that hash is the packet's approved asset hash.
  const provenanceHash = (r) => (r.media_provenance ?? '').match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i)?.[0]?.toLowerCase();
  const asPacketMedia = (r) => ({ media: { local_asset: 'assets/events/incumbent-public-asset.jpg', asset_sha256: provenanceHash(r) ?? null, approved_manifest: r } });
  const badRows = manifestRows.filter((r) => schemaErrors(r, manifestSchema).length > 0 || validatePublicInputShapes(asPacketMedia(r)).length > 0).map((r) => r.title);
  record(`incumbent: all ${manifestRows.length} manifest rows (incl. hash-bearing provenance) pass the manifest schema and runtime boundary`, badRows.length === 0, badRows.join(', '));
  const hashBearing = manifestRows.filter((r) => provenanceHash(r));
  record(`incumbent: ${hashBearing.length} hash-bearing provenance rows are rejected if the hash is NOT the approved asset hash`,
    hashBearing.length > 0 && hashBearing.every((r) => validatePublicInputShapes({ media: { local_asset: 'assets/events/incumbent-public-asset.jpg', asset_sha256: 'cd'.repeat(32), approved_manifest: r } }).length > 0
      && validatePublicInputShapes({ media: { approved_manifest: r } }).length > 0));
  record('incumbent: the retained Spotlight binding is NOT admissible through a packet manifest',
    schemaErrors({ ...manifestRows[0], retained_detail_page: 'things-to-do/x/index.html' }, manifestSchema).length > 0
      && validatePublicInputShapes({ media: { approved_manifest: { ...manifestRows[0], retained_detail_page: 'x' } } }).length > 0);
}

// Value leaks inside allowed fields are runtime-screened (a JSON schema cannot express
// "no string anywhere contains X" without an open-ended pattern on every field).
for (const [label, value] of RESTRICTED) {
  for (const [site, mutate] of [
    ['event.detail.body', (p, v) => { p.event.detail.body = `Ordinary text ${v} more text`; }],
    ['event.title', (p, v) => { p.event.title = `Title ${v}`; }],
    ['event.card_action.url', (p, v) => { p.event.card_action.url = v; }],
    ['approved_manifest.media_alt', (p, v) => { p.media.approved_manifest.media_alt = `Alt ${v}`; }],
    ['approved_package row pt', (p, v) => { p.localization.approved_package.rows[0].pt = `PT ${v}`; }],
  ]) {
    const p = cloneJson(writeFixture); mutate(p, value);
    const problems = validatePublicInputShapes(p);
    const echoed = problems.some((m) => m.includes(value));
    // media_provenance alone may carry a public asset hash; every other field screens it.
    record(`value leak: ${label} inside ${site} is rejected without being echoed`, problems.length > 0 && !echoed, problems.join(' | ') || 'ACCEPTED');
  }
}
{
  const assetHash = writeFixture.media.asset_sha256;
  const provenanceProblems = (text, mutate = () => {}) => {
    const p = cloneJson(writeFixture);
    p.media.approved_manifest.media_provenance = text;
    mutate(p);
    return validatePublicInputShapes(p);
  };
  const PROV_ERR = /may cite only the SHA-256 of the approved public asset/;
  record('provenance hash: the approved public asset hash is accepted', provenanceProblems(`Public asset, SHA-256 ${assetHash}.`).length === 0);
  record('provenance hash: the approved hash is accepted in upper case too', provenanceProblems(`Public asset ${assetHash.toUpperCase()}`).length === 0);
  record('provenance hash: text without any hash is accepted', provenanceProblems('Approved non-public Phase 1B fixture media.').length === 0);
  record('provenance hash: an arbitrary hash is rejected', provenanceProblems(`Provenance ${'ab'.repeat(32)}`).some((m) => PROV_ERR.test(m)));
  record('provenance hash: the approved hash plus a second hash is rejected', provenanceProblems(`${assetHash} and ${'ab'.repeat(32)}`).some((m) => PROV_ERR.test(m)));
  record('provenance hash: a hash is rejected when the packet has no approved asset hash', provenanceProblems(`Provenance ${assetHash}`, (p) => { delete p.media.asset_sha256; }).some((m) => PROV_ERR.test(m)));
  record('provenance hash: a hash is rejected when asset_sha256 is malformed', provenanceProblems(`Provenance ${assetHash}`, (p) => { p.media.asset_sha256 = assetHash.slice(1); }).some((m) => PROV_ERR.test(m)));
  // A fallback_allowed packet has no public asset, so there is nothing a hash could belong to.
  const PROV_ERR_ANY = /may cite only the SHA-256 of the approved public asset/;
  const fallbackPacket = (provenance, mutate = () => {}) => {
    const p = cloneJson(writeFixture);
    p.event.media_policy = 'fallback_allowed';
    p.event.media = null;
    p.media.local_asset = null;
    p.media.asset_sha256 = 'ab'.repeat(32);
    p.media.approved_manifest.media_asset = null;
    p.media.approved_manifest.media_provenance = provenance;
    mutate(p);
    return p;
  };
  const preflightReasons = (p) => validatePacket(p, { checkRepository: false }).issues.map((i) => i.reason);
  const boundaryThrows = (p) => { try { assertPublicInputBoundary(p); return null; } catch (e) { return e.message; } };
  for (const [label, mutate] of [
    ['local_asset null', () => {}],
    ['local_asset empty string', (p) => { p.media.local_asset = ''; }],
    ['local_asset absent', (p) => { delete p.media.local_asset; }],
    ['asset_sha256 also null', (p) => { p.media.asset_sha256 = null; }],
  ]) {
    const p = fallbackPacket(`Fallback record. ${'ab'.repeat(32)}`, mutate);
    const reasons = preflightReasons(p);
    const thrown = boundaryThrows(p);
    record(`provenance hash: fallback/no-asset (${label}) is rejected at preflight`, reasons.some((r) => PROV_ERR_ANY.test(r)));
    record(`provenance hash: fallback/no-asset (${label}) is rejected at the writer boundary`, thrown !== null && PROV_ERR_ANY.test(thrown));
    record(`provenance hash: fallback/no-asset (${label}) never echoes the hash`, !reasons.join(' ').includes('ab'.repeat(32)) && !String(thrown).includes('ab'.repeat(32)));
  }
  {
    const clean = fallbackPacket('Approved A PRASA neutral category fallback; no media asset.');
    record('provenance hash: a fallback record with hash-free provenance is still accepted at both gates',
      !preflightReasons(clean).some((r) => PROV_ERR_ANY.test(r)) && boundaryThrows(clean) === null);
    const real = cloneJson(writeFixture);
    real.media.approved_manifest.media_provenance = `Public asset ${writeFixture.media.asset_sha256}`;
    record('provenance hash: a real public asset citing its own hash passes both gates',
      !preflightReasons(real).some((r) => PROV_ERR_ANY.test(r)) && boundaryThrows(real) === null);
    const wrongAsset = cloneJson(real);
    wrongAsset.media.approved_manifest.media_provenance = `Public asset ${'cd'.repeat(32)}`;
    record('provenance hash: a real public asset citing a different hash is rejected at both gates',
      preflightReasons(wrongAsset).some((r) => PROV_ERR_ANY.test(r)) && PROV_ERR_ANY.test(String(boundaryThrows(wrongAsset))));
    // Bytes are compared with asset_sha256 by the real-write preflight and the writer, not here.
    const contractSource = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'event-publication-contract.mjs'), 'utf8');
    record('provenance hash: real-write preflight still compares asset_sha256 with the asset bytes',
      /actualHash !== media\.asset_sha256/.test(contractSource));
  }
  record('provenance hash: a rejected hash is never echoed', !provenanceProblems(`Provenance ${'ab'.repeat(32)}`).join(' ').includes('ab'.repeat(32)));
  record('provenance hash: a restricted attachment id or locator in provenance is still rejected',
    provenanceProblems(`Provenance ${RESTRICTED[0][1]}`).length > 0 && provenanceProblems(`Provenance ${RESTRICTED[3][1]}`).length > 0);
  const viaContract = cloneJson(writeFixture);
  viaContract.media.approved_manifest.media_provenance = `Provenance ${'ab'.repeat(32)}`;
  record('provenance hash: the packet preflight and the writer boundary both reject an arbitrary hash',
    validatePacket(viaContract, { checkRepository: false }).state === 'INVALID_INPUT'
      && (() => { try { assertPublicInputBoundary(viaContract); return false; } catch (e) { return /PUBLIC_INPUT_BOUNDARY/.test(e.message); } })());
  const q = cloneJson(writeFixture);
  q.event.detail.body = 'Join us at the Google Arts festival; tickets at https://example.org/tickets/12345678 or call +238 988 60 80.';
  q.event.source_url = 'https://www.agendacultural.cv/eventos/example';
  record('no false positive: ordinary copy and ordinary public URLs are accepted', validatePublicInputShapes(q).length === 0 && validateSourceUnion(q.event).length === 0);
}

// Semantic URL validity. The schema gates only the scheme; the runtime asks the URL
// parser (plus explicit rejection of forms it silently repairs) at every entrypoint.
{
  const MALFORMED = ['http://', 'https://exa mple.org', 'http://[', 'https:///x', 'http://:80', 'https://%',
    'https://user:pw@example.org/x', 'https:\\\\example.org', 'http:example.org', 'https://exa\tmple.org', ' https://example.org/'];
  const SCHEME_REJECTED = ['javascript:alert(1)', 'ftp://example.org/x', '//example.org/x', '/relative/path', 'example.org', ''];
  const urlPacket = (field, url) => {
    const p = cloneJson(writeFixture);
    if (field === 'source_url') p.event.source_url = url;
    if (field === 'card_action.url') p.event.card_action.url = url;
    if (field === 'manifest.source_url') p.media.approved_manifest.source_url = url;
    if (field === 'manifest.media_asset_source_url') p.media.approved_manifest.media_asset_source_url = url;
    return p;
  };
  const runtimeUrlOk = (p) => validatePublicInputShapes(p).length === 0 && validateSourceUnion(p.event).length === 0;
  for (const field of ['source_url', 'card_action.url', 'manifest.source_url', 'manifest.media_asset_source_url']) {
    for (const url of MALFORMED) {
      const p = urlPacket(field, url);
      record(`url semantics: ${field} ${JSON.stringify(url)} is rejected by the runtime`, !runtimeUrlOk(p));
    }
    for (const url of SCHEME_REJECTED) {
      const p = urlPacket(field, url);
      record(`url semantics: ${field} ${JSON.stringify(url)} is rejected by BOTH schema and runtime`, !runtimeUrlOk(p) && !schemaAccepts(p));
    }
    const ok = urlPacket(field, 'https://www.example.org:8443/a/b?c=d#e');
    record(`url semantics: ${field} accepts an ordinary HTTPS URL in both`, runtimeUrlOk(ok) && schemaAccepts(ok));
  }
  // The documented layering: a parseable-looking prefix passes the schema gate; the runtime decides.
  for (const url of ['http://[', 'https:///x', 'https://%']) {
    const p = urlPacket('source_url', url);
    record(`url semantics: ${JSON.stringify(url)} passes only the schema scheme gate and is rejected by the runtime`, schemaAccepts(p) && !runtimeUrlOk(p));
  }
  // card_action as an object must name a destination: present, non-empty, valid HTTP(S).
  {
    const withAction = (ca) => { const p = cloneJson(writeFixture); p.event.card_action = ca; return p; };
    const UR = /card_action\.url/;
    const reasons = (p) => validatePacket(p, { checkRepository: false }).issues.map((i) => i.reason);
    const throwsBoundary = (p) => { try { assertPublicInputBoundary(p); return null; } catch (e) { return e.message; } };
    for (const [label, ca, both] of [
      ['url omitted', { label: 'Event listing' }, true],
      ['url empty', { label: 'Event listing', url: '' }, true],
      ['url null', { label: 'Event listing', url: null }, true],
      ['url numeric', { label: 'Event listing', url: 5 }, true],
      ['url non-HTTP(S) scheme', { label: 'Event listing', url: 'javascript:alert(1)' }, true],
      ['url ftp scheme', { label: 'Event listing', url: 'ftp://example.org/e' }, true],
      ['url scheme-valid but malformed', { label: 'Event listing', url: 'https:///x' }, false],
    ]) {
      const p = withAction(ca);
      record(`card_action: ${label} is rejected at preflight`, reasons(p).some((r) => UR.test(r)));
      record(`card_action: ${label} is rejected at the writer boundary`, UR.test(String(throwsBoundary(p))));
      record(`card_action: ${label} is rejected by the runtime union validator`, validateSourceUnion(p.event).some((m) => UR.test(m)));
      record(`card_action: ${label} ${both ? 'is rejected by BOTH schema and runtime' : 'passes only the schema scheme gate; the runtime rejects it'}`,
        both ? !schemaAccepts(p) && !runtimeAccepts(p) : schemaAccepts(p) && !runtimeAccepts(p));
    }
    const good = withAction({ label: 'Event listing', url: 'https://example.org/e' });
    record('card_action: a valid HTTPS url is accepted by schema, runtime, preflight and the writer boundary',
      schemaAccepts(good) && runtimeAccepts(good) && !reasons(good).some((r) => UR.test(r)) && throwsBoundary(good) === null);
    const none = withAction(null);
    record('card_action: null is still accepted (schema, runtime and writer boundary)', schemaAccepts(none) && runtimeAccepts(none) && throwsBoundary(none) === null);
    for (const id of [KUTUMBAIA_ID, MANXI_ID]) {
      const noCta = asModeB(writeFixture, id);
      record(`card_action: the approved NO_CTA event ${id} remains valid with card_action null`,
        noCta.event.card_action === null && schemaAccepts(noCta) && runtimeAccepts(noCta) && throwsBoundary(noCta) === null);
    }
  }
  record('url semantics: the preflight and the writer boundary both reject a malformed card_action.url',
    validatePacket(urlPacket('card_action.url', 'javascript:alert(1)'), { checkRepository: false }).state === 'INVALID_INPUT'
      && (() => { try { assertPublicInputBoundary(urlPacket('card_action.url', 'javascript:alert(1)')); return false; } catch (e) { return /PUBLIC_INPUT_BOUNDARY/.test(e.message); } })());
  const incumbentUrls = baseData.records.flatMap((r) => [r.source_url, r.card_action?.url]).filter(Boolean);
  record(`url semantics: all ${incumbentUrls.length} incumbent source and card-action URLs remain accepted`, incumbentUrls.every((u) => validateSourceUnion({ id: 'x', source_url: u }).length === 0));
}

// The shared contract and the writer's copy boundary reject the same packets.
{
  const injected = cloneJson(writeFixture); injected.event.restricted_note = RESTRICTED[0][1];
  const verdict = validatePacket(injected, { checkRepository: false });
  record('contract: validatePacket reports INVALID_INPUT for an unknown public field', verdict.state === 'INVALID_INPUT' && verdict.issues.some((i) => /not an allowed public field/.test(i.reason)));
  record('contract: the issue text never echoes the restricted value', !JSON.stringify(verdict.issues).includes(RESTRICTED[0][1]));
  const keyed = cloneJson(writeFixture); keyed.event[RESTRICTED[0][1]] = 'x';
  record('contract: a restricted-shaped KEY is redacted in the issue text', !JSON.stringify(validatePacket(keyed, { checkRepository: false }).issues).includes(RESTRICTED[0][1]));
  let threw = null;
  try { assertPublicInputBoundary(injected); } catch (error) { threw = error; }
  record('writer boundary: assertPublicInputBoundary throws on an unchecked extra field', Boolean(threw) && /PUBLIC_INPUT_BOUNDARY/.test(threw.message) && !threw.message.includes(RESTRICTED[0][1]));
  let clean = null;
  try { assertPublicInputBoundary(writeFixture); } catch (error) { clean = error; }
  record('writer boundary: the incumbent write fixture passes the boundary', clean === null, clean?.message);
  const writerSource = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'event-publication-write.mjs'), 'utf8');
  const copySite = writerSource.slice(writerSource.indexOf('function applyApprovedInputs'));
  record('writer boundary: applyApprovedInputs asserts the boundary before its first copy',
    copySite.indexOf('assertPublicInputBoundary(packet)') > 0 && copySite.indexOf('assertPublicInputBoundary(packet)') < copySite.indexOf('events.records.push(packet.event)'));
}

// Standalone entry points: neither the generator nor the media validator may rely
// on a preceding validation run.
const standaloneGeneratorRejects = (name, patchRecord, pattern, manifestRow = true) => {
  const state = sandboxWith(({ data, manifest }) => {
    data.records.push(patchRecord);
    if (manifestRow) manifest.records.push({ ...structuredClone(cartinhaManifestRow(manifest)), title: 'SYNTH Title', source_url: null });
  });
  for (const file of ['index.html', 'pt/index.html']) {
    const homeFile = path.join(state.dir, file);
    let html = fs.readFileSync(homeFile, 'utf8');
    const last = [...html.matchAll(/<!-- END GENERATED EVENT: [a-z0-9]+(?:-[a-z0-9]+)* -->/g)].pop();
    const at = last.index + last[0].length;
    html = `${html.slice(0, at)}\n        <!-- BEGIN GENERATED EVENT: ${patchRecord.id} -->\n        <!-- END GENERATED EVENT: ${patchRecord.id} -->${html.slice(at)}`;
    fs.writeFileSync(homeFile, html);
  }
  const detailDir = path.join(state.dir, 'things-to-do', patchRecord.id);
  const gen = runIn(state.dir, 'generate-things-to-do.mjs', ['--write', '--as-of=2026-10-12']);
  record(`standalone generator: ${name}`, gen.status !== 0 && pattern.test(gen.out) && !fs.existsSync(detailDir), gen.out.trim().split('\n').slice(-2).join(' / '));
  fs.rmSync(state.dir, { recursive: true, force: true });
};
standaloneGeneratorRejects('a wrong-event handle fails even with null actions', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: synthRef(MANXI_ID) })), /must equal the approved evidence handle/);
standaloneGeneratorRejects('an unsupported id with a reference fails', withNoAction(synthB('automation-fixture-guarded-write')), /only permitted for the two/);
standaloneGeneratorRejects('an invalid reference shape fails', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: { ...synthRef(), note: 'x' } })), /unsupported field/);
standaloneGeneratorRejects('a prohibited action fails', withNoAction(synthB(KUTUMBAIA_ID, { card_action: { label: 'Open', url: 'https://example.org/' } })), /NO_CTA/);
standaloneGeneratorRejects('a scoped id with only a plain URL fails', { ...withNoAction(synthB(KUTUMBAIA_ID)), source_url: 'https://example.org/x', source_reference: undefined }, /requires a governed source_reference/);
for (const [label, patch, pattern] of [
  ['a malformed source_url', (r) => { r.source_url = 'https:///x'; }, /source_url must be an HTTP\(S\) URL/],
  ['a script-scheme card_action.url', (r) => { r.card_action = { ...r.card_action, url: 'javascript:alert(1)' }; }, /card_action\.url must be a valid HTTP\(S\) URL/],
  ['a card_action without a url', (r) => { delete r.card_action.url; }, /card_action\.url must be a valid HTTP\(S\) URL/],
]) {
  const state = sandboxWith(({ data }) => { patch(data.records.find((r) => r.id === 'cartinha-dholanda-mindelo-2026')); });
  const gen = runIn(state.dir, 'generate-things-to-do.mjs', ['--write', '--as-of=2026-10-12']);
  record(`standalone generator: ${label} on an existing record fails before writing`, gen.status !== 0 && pattern.test(gen.out), gen.out.trim().split('\n').slice(-2).join(' / '));
  const media = runIn(state.dir, 'validate-card-media.mjs');
  record(`standalone media validator: ${label} on an existing record is rejected`, media.status !== 0 && pattern.test(media.out), media.out.trim().split('\n').slice(-2).join(' / '));
  const canonical = runIn(state.dir, 'validate-things-to-do-events.mjs');
  record(`standalone canonical validator: ${label} on an existing record is rejected`, canonical.status !== 0 && pattern.test(canonical.out), canonical.out.trim().split('\n').slice(-2).join(' / '));
  fs.rmSync(state.dir, { recursive: true, force: true });
}
standaloneGeneratorRejects('an explicit null source_reference fails', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: null })), /source_reference must be an object/);

const standaloneMediaRejects = (name, canonical, manifestPatch, pattern) => {
  const state = sandboxWith(({ data, manifest }) => {
    data.records.push(canonical);
    manifest.records.push({ ...structuredClone(cartinhaManifestRow(manifest)), title: 'SYNTH Title', source_url: null, ...manifestPatch });
  });
  const r = runIn(state.dir, 'validate-card-media.mjs');
  record(`standalone media validator: ${name}`, r.status !== 0 && pattern.test(r.out), r.out.trim().split('\n').slice(-3).join(' / '));
  fs.rmSync(state.dir, { recursive: true, force: true });
};
standaloneMediaRejects('a wrong-event handle is not accepted as a canonical reference', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: synthRef(MANXI_ID) })), {}, /must equal the approved evidence handle/);
standaloneMediaRejects('...and the null manifest row then has no valid reference to mirror', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: synthRef(MANXI_ID) })), {}, /source_url null is only valid/);
standaloneMediaRejects('an unsupported id with a reference is rejected', withNoAction(synthB('automation-fixture-guarded-write')), {}, /only permitted for the two/);
standaloneMediaRejects('an invalid reference shape is rejected', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: { ...synthRef(), note: 'x' } })), {}, /unsupported field/);
standaloneMediaRejects('a prohibited action is rejected', withNoAction(synthB(KUTUMBAIA_ID, { card_action: { label: 'Open', url: 'https://example.org/' } })), {}, /NO_CTA/);
standaloneMediaRejects('a scoped id with only a plain URL is rejected', { ...withNoAction(synthB(KUTUMBAIA_ID)), source_url: 'https://example.org/x', source_reference: undefined }, { source_url: 'https://example.org/x' }, /requires a governed source_reference/);
standaloneMediaRejects('a manifest row with a URL beside a valid reference is rejected', withNoAction(synthB(KUTUMBAIA_ID)), { source_url: 'https://example.org/x' }, /source_url must be null for a record backed by a source_reference/);
{
  const state = sandboxWith(addSynthB);
  const r = runIn(state.dir, 'validate-card-media.mjs');
  record('standalone media validator: a valid mode B record raises no source-union error', !/source_url|source_reference|evidence handle/.test(r.out), r.out.trim().split('\n').slice(-3).join(' / '));
  fs.rmSync(state.dir, { recursive: true, force: true });
}

// Public-repo rule: no evidence-locator shape anywhere in the canonical data or
// the internal manifest, whatever the validators say.
for (const rel of [EVENTS, path.join('internal', 'provider-media-manifest.json')]) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  record(`repo scan: ${rel.replace(/\\/g, '/')} holds no attachment id or Drive locator`, !/file_[0-9a-f]{32}/i.test(text) && !/(?:drive|docs)\.google\./i.test(text));
}

console.log(`\nThings-to-Do event schema tests: ${passed}/${passed + failures.length} passed.`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
