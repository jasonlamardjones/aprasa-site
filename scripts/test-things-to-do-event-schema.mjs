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
  validatePacket,
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
unionRejects('source union: a null source_reference is treated as absent', withNoAction(synthB(KUTUMBAIA_ID, { source_reference: null })), /missing source_url/);
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
