#!/usr/bin/env node
// Focused regression tests for the open-call-unknown-deadline lifecycle class
// (Project 03 ruling EDTECH_LIFECYCLE_RESOLVED, 18 September 2026).
//
// The class exists for a bounded call whose authoritative evidence
// affirmatively shows applications are OPEN, but where no closing date and no
// rolling-intake rule has been established, and where no deadline may be
// inferred.
//
// What these tests are actually defending. The class was added by extending
// two lifecycle registries and NOTHING else: no date rule of its own was
// written for it. It inherits "no end_date, ever" from the incumbent invariant
//
//     fixed-window-opportunity  -> a valid ISO end_date is REQUIRED
//     every other class         -> end_date is NOT SUPPORTED
//
// That is a deliberately cheap design, and its whole risk is that a later
// well-meaning edit "tidies" the date branch — makes end_date optional for
// fixed-window so the new class fits more symmetrically, or carves the new
// class out of the non-fixed-window side. Either would silently weaken the
// invariant that guards all eight fixed-window records, which is exactly the
// expiry machinery #10 had to correct by hand. So the fixed-window assertions
// below are not redundant coverage of someone else's rule: they are the load-
// bearing half of this class's own contract, and they are asserted in BOTH
// directions on purpose.
//
// Each case mutates its own throwaway copy of the repository, so nothing here
// can touch the working tree.
//
// Usage: node scripts/test-training-lifecycle-open-call.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const OPEN_CALL = 'open-call-unknown-deadline';
const FIXED_WINDOW = 'fixed-window-opportunity';
const EDTECH_ID = 'timbuktoo-edtech-pan-african-incubation';
// A fixed-window record that is genuinely inside its window at this date, so
// "accepted" below is about the class rule and not about expiry.
const FIXED_WINDOW_ID = 'regea-oral-communications-call-2026';
const AS_OF = '2026-09-15';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.log(`FAIL — ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-lifecycle-test-'));
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  return dir;
}

function dataPath(dir) {
  return path.join(dir, 'data', 'training-opportunities.json');
}

function readData(dir) {
  return JSON.parse(fs.readFileSync(dataPath(dir), 'utf8'));
}

function writeData(dir, data) {
  fs.writeFileSync(dataPath(dir), `${JSON.stringify(data, null, 2)}\n`);
}

function mutate(dir, id, fn) {
  const data = readData(dir);
  fn(data.records.find((r) => r.id === id), data);
  writeData(dir, data);
}

function validateData(dir) {
  const result = spawnSync('node', [path.join(dir, 'scripts', 'validate-training-opportunities-data.mjs')], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

function generate(dir, locale) {
  const result = spawnSync('node', [
    path.join(dir, 'scripts', 'generate-training-opportunities.mjs'),
    `--locale=${locale}`,
    `--as-of=${AS_OF}`,
    ...(locale === 'pt' ? [`--home=${path.join('pt', 'index.html')}`] : []),
    '--write',
  ], { cwd: dir, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

function region(dir, locale, id) {
  const home = locale === 'pt' ? path.join(dir, 'pt', 'index.html') : path.join(dir, 'index.html');
  const html = fs.readFileSync(home, 'utf8');
  const begin = `<!-- BEGIN GENERATED TRAINING: ${id} -->`;
  const end = `<!-- END GENERATED TRAINING: ${id} -->`;
  const a = html.indexOf(begin);
  const b = html.indexOf(end);
  if (a === -1 || b === -1) return null;
  return html.slice(a + begin.length, b);
}

// --- CASE 1 — the committed EdTech record is valid as governed --------------
// open-call-unknown-deadline + CURRENT + no end_date at all.
{
  const dir = sandbox();
  const record = readData(dir).records.find((r) => r.id === EDTECH_ID);
  check('CASE 1: EdTech record exists in the canonical corpus', Boolean(record));
  check('CASE 1: lifecycle_class is open-call-unknown-deadline', record?.lifecycle_class === OPEN_CALL, record?.lifecycle_class);
  check('CASE 1: publication_state is CURRENT', record?.publication_state === 'CURRENT', record?.publication_state);
  check('CASE 1: ordinary_publication_eligibility is ELIGIBLE', record?.ordinary_publication_eligibility === 'ELIGIBLE');
  // Absent, not null: the invariant tests `end_date != null`, so an absent key
  // is the honest encoding and no explicit null is required.
  check('CASE 1: end_date key is absent entirely', record && !('end_date' in record));
  const result = validateData(dir);
  check('CASE 1: structured-data validator ACCEPTS it', result.status === 0, result.out.trim().slice(0, 400));
  check('CASE 1: validator reports the new class in its class tally',
    result.out.includes(`${OPEN_CALL}=1`), result.out.trim().slice(0, 200));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- CASE 2 — the class does not REQUIRE an end_date -----------------------
// Distinct from CASE 1: this proves the absence is genuinely permitted for the
// class rather than tolerated only for this one record's shape. A second
// open-call record is synthesised from the committed one.
{
  const dir = sandbox();
  mutate(dir, EDTECH_ID, (_record, data) => {
    const clone = JSON.parse(JSON.stringify(data.records.find((r) => r.id === EDTECH_ID)));
    clone.id = 'probe-open-call-second-record';
    clone.card = JSON.parse(JSON.stringify(clone.card));
    clone.detail = JSON.parse(JSON.stringify(clone.detail));
    // Point every locale slot at the probe's own namespace so the failure we
    // read is about the date rule, never about borrowed keys.
    const renamespace = (slot) => {
      if (!slot || typeof slot !== 'object') return slot;
      if (typeof slot.locale_key === 'string') {
        slot.locale_key = slot.locale_key.replace(EDTECH_ID, clone.id);
      }
      for (const value of Object.values(slot)) renamespace(value);
      return slot;
    };
    renamespace(clone.card);
    renamespace(clone.detail);
    data.records.push(clone);
  });
  const result = validateData(dir);
  // The probe has no governed locale keys, so the validator must complain
  // about THAT and never about a missing end_date.
  check('CASE 2: a second open-call record is never rejected for a missing end_date',
    !result.out.includes(`${OPEN_CALL} requires`) && !/probe-open-call-second-record.*end_date/.test(result.out),
    result.out.trim().slice(0, 300));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- CASE 3 — the class may NOT carry an end_date -------------------------
// The incumbent non-fixed-window date invariant is retained, so an end_date on
// this class is rejected. This is what stops a deadline being smuggled in.
{
  const dir = sandbox();
  mutate(dir, EDTECH_ID, (record) => { record.end_date = '2026-12-31'; });
  const result = validateData(dir);
  check('CASE 3: open-call-unknown-deadline carrying an end_date is REJECTED', result.status !== 0);
  check('CASE 3: rejection cites the non-fixed-window date invariant',
    result.out.includes('end_date is only supported for fixed-window-opportunity'),
    result.out.trim().slice(0, 300));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- CASE 4 — fixed-window without end_date is STILL rejected -------------
// The load-bearing half. If this ever passes, the new class was implemented by
// weakening the invariant that guards every fixed-window record.
{
  const dir = sandbox();
  mutate(dir, FIXED_WINDOW_ID, (record) => { delete record.end_date; });
  const result = validateData(dir);
  check('CASE 4: fixed-window-opportunity with the end_date key deleted is REJECTED', result.status !== 0);
  check('CASE 4: rejection still cites the fixed-window end_date requirement',
    result.out.includes('fixed-window-opportunity requires a valid end_date'),
    result.out.trim().slice(0, 300));

  const nulled = sandbox();
  mutate(nulled, FIXED_WINDOW_ID, (record) => { record.end_date = null; });
  const nullResult = validateData(nulled);
  check('CASE 4: fixed-window-opportunity with end_date null is REJECTED', nullResult.status !== 0);
  check('CASE 4: an explicit null is not an accepted stand-in for a governed window',
    nullResult.out.includes('fixed-window-opportunity requires a valid end_date'),
    nullResult.out.trim().slice(0, 300));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(nulled, { recursive: true, force: true });
}

// --- CASE 5 — fixed-window WITH a valid end_date is still accepted --------
// The other direction: adding the class did not make fixed-window stricter or
// otherwise disturb the eight records that depend on it.
{
  const dir = sandbox();
  const data = readData(dir);
  const fixedWindow = data.records.filter((r) => r.lifecycle_class === FIXED_WINDOW);
  check('CASE 5: the incumbent fixed-window records are still present', fixedWindow.length === 8, String(fixedWindow.length));
  check('CASE 5: every one still carries a valid ISO end_date',
    fixedWindow.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.end_date || '')),
    JSON.stringify(fixedWindow.map((r) => [r.id, r.end_date])));
  const result = validateData(dir);
  check('CASE 5: the unmodified corpus (8 fixed-window + 1 open-call) is ACCEPTED', result.status === 0, result.out.trim().slice(0, 300));
  check('CASE 5: validator still tallies 8 fixed-window records',
    result.out.includes(`${FIXED_WINDOW}=8`), result.out.trim().slice(0, 200));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- CASE 6 — no date-driven automatic expiry for the new class ----------
// Generation is driven by publication_state, never by a date, so an as-of far
// in the future must still render the open call. A class that auto-expired
// would clear its region here.
{
  const dir = sandbox();
  const future = spawnSync('node', [
    path.join(dir, 'scripts', 'generate-training-opportunities.mjs'),
    '--locale=en',
    '--as-of=2027-12-31',
    '--write',
  ], { cwd: dir, encoding: 'utf8' });
  check('CASE 6: generation succeeds at a far-future as-of date', future.status === 0, (future.stderr || '').trim().slice(0, 300));
  const body = region(dir, 'en', EDTECH_ID);
  check('CASE 6: the open call still renders at as-of 2027-12-31 — no date-driven expiry',
    Boolean(body && body.trim() !== '' && body.includes('EdTech')),
    body === null ? 'region missing' : `region length ${body.trim().length}`);
  // And the record's own canonical state is untouched by the late date.
  const after = readData(dir).records.find((r) => r.id === EDTECH_ID);
  check('CASE 6: publication_state is still CURRENT after a far-future run', after?.publication_state === 'CURRENT', after?.publication_state);
  check('CASE 6: no end_date was materialised by the run', after && !('end_date' in after));

  // Control: the state dimension still works for this class. EXPIRED clears
  // the region with end_date still absent, which is the governed path for
  // "evidence shows closure but no reliable closing date".
  mutate(dir, EDTECH_ID, (record) => { record.publication_state = 'EXPIRED'; });
  const expired = generate(dir, 'en');
  const expiredBody = region(dir, 'en', EDTECH_ID);
  check('CASE 6 (control): EXPIRED clears the region while end_date stays absent',
    expired.status === 0 && expiredBody !== null && expiredBody.trim() === '',
    expiredBody === null ? 'region missing' : expiredBody.trim().slice(0, 120));
  const expiredRecord = readData(dir).records.find((r) => r.id === EDTECH_ID);
  check('CASE 6 (control): the EXPIRED open call still carries no end_date', expiredRecord && !('end_date' in expiredRecord));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- CASE 7 — a CURRENT open call renders on both EN and PT Home ---------
{
  const dir = sandbox();
  for (const locale of ['en', 'pt']) {
    const result = generate(dir, locale);
    check(`CASE 7: ${locale.toUpperCase()} generation succeeds`, result.status === 0, result.out.trim().slice(0, 300));
    const body = region(dir, locale, EDTECH_ID);
    check(`CASE 7: ${locale.toUpperCase()} Home renders the open call`, Boolean(body && body.trim() !== ''));
    check(`CASE 7: ${locale.toUpperCase()} region carries the governed programme identity`,
      Boolean(body && body.includes('timbuktoo')));
    check(`CASE 7: ${locale.toUpperCase()} region carries the governed action URL`,
      Boolean(body && body.includes('https://airtable.com/appYbpSCCV1VosC1M/pagMQfKHj9mIYPFyN/form')));
  }
  // Locale separation: each surface shows its own approved status wording and
  // not the other locale's, so this is a real PT render and not an EN fallback.
  const en = region(dir, 'en', EDTECH_ID) || '';
  const pt = region(dir, 'pt', EDTECH_ID) || '';
  check('CASE 7: EN carries the approved EN status line', en.includes('Currently shown as open'));
  check('CASE 7: PT carries the approved PT status line', pt.includes('Atualmente apresentada como aberta'));
  check('CASE 7: PT does not fall back to the EN status line', !pt.includes('Currently shown as open'));
  check('CASE 7: PT carries the approved PT good-to-know copy',
    pt.includes('Não foi estabelecida qualquer data-limite oficial'));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- CASE 8 — the internal lifecycle token never becomes public copy ------
// The token is governance architecture. It must appear in no rendered surface,
// in either locale, and in no governed locale string.
{
  const dir = sandbox();
  generate(dir, 'en');
  generate(dir, 'pt');
  for (const [label, rel] of [['EN Home', 'index.html'], ['PT Home', path.join('pt', 'index.html')]]) {
    const html = fs.readFileSync(path.join(dir, rel), 'utf8');
    check(`CASE 8: ${label} never exposes the raw lifecycle token`, !html.includes(OPEN_CALL));
    // Nor any other raw lifecycle token, which would mean the architecture had
    // started leaking internal classes generally.
    for (const token of [FIXED_WINDOW, 'rolling-opportunity', 'evergreen-learning-resource', 'institutional-training-catalog', 'recurring-opportunity']) {
      check(`CASE 8: ${label} never exposes the raw lifecycle token "${token}"`, !html.includes(token));
    }
  }
  const locale = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'locales', 'locale-data.generated.json'), 'utf8'));
  const leaked = Object.values(locale.keys).filter(
    (row) => (typeof row.en === 'string' && row.en.includes(OPEN_CALL))
      || (typeof row.pt === 'string' && row.pt.includes(OPEN_CALL)),
  );
  check('CASE 8: no governed locale string contains the lifecycle token', leaked.length === 0,
    JSON.stringify(leaked.map((row) => row.key)));
  // The approved public status wording stands on its own, unchanged by the
  // internal token it sits alongside.
  const status = locale.keys[`training.record.${EDTECH_ID}.status`];
  check('CASE 8: approved EN status wording is exactly as governed', status?.en === 'Currently shown as open', status?.en);
  check('CASE 8: approved PT status wording is exactly as governed', status?.pt === 'Atualmente apresentada como aberta', status?.pt);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failures.length) {
  console.log(`Open-call lifecycle tests: ${passed} passed, ${failures.length} FAILED`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log(`Open-call lifecycle tests: ${passed}/${passed} passed.`);
