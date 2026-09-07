#!/usr/bin/env node
// Behavioural tests for scripts/generate-training-opportunities.mjs.
//
// The defect these exist to prevent: the generator used to filter canonical
// records down to the visible publication states BEFORE touching the surface.
// A populated record moved to EXPIRED/WITHDRAWN/SUPERSEDED therefore stopped
// being generator-owned, its stale card stayed visibly on Home, and the run
// still reported success — with a quietly smaller record count. These tests
// drive real state transitions against a populated surface and assert that
// ownership is total: every canonical record, in every state, on every run.
//
// Each case runs in its own throwaway copy of the repository, so nothing here
// can touch the working tree.
//
// Usage: node scripts/test-training-opportunities-generator.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AS_OF = '2026-09-01';
const DATA_PATH = path.join(ROOT, 'data', 'training-opportunities.json');
// Derived, not hardcoded: the assertion is that the generator owns EVERY
// canonical record on every run, so it must track the canonical record list
// rather than a number that a legitimate rotation would falsify.
const RECORD_COUNT = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')).records.length;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-gen-test-'));
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  return dir;
}

function run(dir, locale, extra = []) {
  const args = [
    path.join(dir, 'scripts', 'generate-training-opportunities.mjs'),
    `--locale=${locale}`,
    `--as-of=${AS_OF}`,
    ...(locale === 'pt' ? [`--home=${path.join('pt', 'index.html')}`] : []),
    ...extra,
  ];
  const result = spawnSync('node', args, { cwd: dir, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function homePath(dir, locale) {
  return locale === 'pt' ? path.join(dir, 'pt', 'index.html') : path.join(dir, 'index.html');
}

function region(dir, locale, id) {
  const html = fs.readFileSync(homePath(dir, locale), 'utf8');
  const begin = `<!-- BEGIN GENERATED TRAINING: ${id} -->`;
  const end = `<!-- END GENERATED TRAINING: ${id} -->`;
  const a = html.indexOf(begin);
  const b = html.indexOf(end);
  if (a === -1 || b === -1) return null;
  return html.slice(html.lastIndexOf('\n', a) + 1, b + end.length);
}

function setState(dir, id, state) {
  const p = path.join(dir, 'data', 'training-opportunities.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data.records.find((r) => r.id === id).publication_state = state;
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

const MARKER_ONLY = (id) =>
  `        <!-- BEGIN GENERATED TRAINING: ${id} -->\n        <!-- END GENERATED TRAINING: ${id} -->`;

// --- populated-region transition tests ------------------------------------
// CURRENT -> removed state -> CURRENT, against a genuinely populated region.
for (const removedState of ['EXPIRED', 'WITHDRAWN', 'SUPERSEDED']) {
  for (const locale of ['en', 'pt']) {
    const dir = sandbox();
    const id = 'myrtle';
    const label = `${locale.toUpperCase()} CURRENT -> ${removedState} -> CURRENT`;

    const populated = region(dir, locale, id);
    check(`${label}: starts populated`, populated !== null && populated.includes('<article class="resource-card"'));

    // Forward transition.
    setState(dir, id, removedState);
    const fwd = run(dir, locale, ['--write']);
    const cleared = region(dir, locale, id);
    check(`${label}: generator succeeds on the transition`, fwd.status === 0, fwd.stderr.trim());
    check(`${label}: stale card content is gone`, cleared !== null && !cleared.includes('<article'));
    check(`${label}: region is exactly the marker pair`, cleared === MARKER_ONLY(id), JSON.stringify(cleared));
    check(`${label}: marker pair preserved`,
      cleared !== null && cleared.includes(`BEGIN GENERATED TRAINING: ${id}`) && cleared.includes(`END GENERATED TRAINING: ${id}`));
    check(`${label}: all ${RECORD_COUNT} regions still owned`, new RegExp(`${RECORD_COUNT} region\\(s\\) owned`).test(fwd.stdout), fwd.stdout.trim());
    check(`${label}: reports one cleared region`, new RegExp(`${RECORD_COUNT - 1} rendered, 1 cleared`).test(fwd.stdout), fwd.stdout.trim());

    // Deterministic + idempotent in the removed state.
    const again = run(dir, locale, ['--write']);
    check(`${label}: removed state is idempotent`, again.status === 0 && region(dir, locale, id) === cleared);
    const dryRun = run(dir, locale);
    check(`${label}: read-only check agrees while cleared`, dryRun.status === 0, dryRun.stderr.trim());

    // Reverse transition restores canonical content byte-for-byte.
    setState(dir, id, 'CURRENT');
    const back = run(dir, locale, ['--write']);
    check(`${label}: reverse transition succeeds`, back.status === 0, back.stderr.trim());
    check(`${label}: canonical content restored byte-for-byte`, region(dir, locale, id) === populated);

    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- stale content inside a removed-state region is drift, never "matches" --
{
  const dir = sandbox();
  const id = 'myrtle';
  setState(dir, id, 'WITHDRAWN');
  const dry = run(dir, 'en');
  check('stale content in a removed-state region is reported as drift',
    dry.status === 1 && /DRIFT/.test(dry.stderr) && dry.stderr.includes(id), dry.stderr.trim());
  check('drift run never claims "matches"', !/matches generated output/.test(dry.stdout), dry.stdout.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- canonical publication-state token -------------------------------------
{
  const dir = sandbox();
  setState(dir, 'myrtle', 'TEMPORARILY_UNAVAILABLE');
  const r = run(dir, 'en');
  check('TEMPORARILY_UNAVAILABLE fails closed',
    r.status === 1 && /TEMPORARILY_UNAVAILABLE has no approved status treatment/.test(r.stderr), r.stderr.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const dir = sandbox();
  setState(dir, 'myrtle', 'TEMPORARILY UNAVAILABLE');
  const r = run(dir, 'en');
  check('space-form token is rejected (not an alias)',
    r.status === 1 && /unsupported publication_state "TEMPORARILY UNAVAILABLE"/.test(r.stderr), r.stderr.trim());
  const v = spawnSync('node', [path.join(dir, 'scripts', 'validate-training-opportunities-data.mjs')], { cwd: dir, encoding: 'utf8' });
  check('validator rejects the space-form token and names the canonical one',
    v.status === 1 && /retired spelling; the canonical token is "TEMPORARILY_UNAVAILABLE"/.test(v.stderr), (v.stderr || '').trim());
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- unknown state and orphan marker ---------------------------------------
{
  const dir = sandbox();
  setState(dir, 'myrtle', 'ARCHIVED');
  const r = run(dir, 'en');
  check('unknown publication_state fails closed',
    r.status === 1 && /unsupported publication_state "ARCHIVED"/.test(r.stderr), r.stderr.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const dir = sandbox();
  const p = path.join(dir, 'data', 'training-opportunities.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data.records = data.records.filter((r) => r.id !== 'microsoft-learn');
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  const r = run(dir, 'en');
  check('a marker region with no canonical record fails closed',
    r.status === 1 && /marker region "microsoft-learn" has no canonical record/.test(r.stderr), r.stderr.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Learning Spotlight uniqueness invariant -------------------------------
// Rotation must never leave two records marked as the Learning Spotlight, and
// must never leave one half-rotated (marker without labels, or labels without
// the marker). The invariant lives in the structured-data validator; these
// probes prove it actually rejects those states rather than passing vacuously.
function validate(dir) {
  const r = spawnSync('node', [path.join(dir, 'scripts', 'validate-training-opportunities-data.mjs')], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function editData(dir, mutate) {
  const p = path.join(dir, 'data', 'training-opportunities.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  mutate(data);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

{
  const dir = sandbox();
  const clean = validate(dir);
  check('committed data holds exactly one Learning Spotlight',
    clean.status === 0 && /Learning Spotlight held by exactly one record \(start-cv\)/.test(clean.stdout), clean.stdout.trim() || clean.stderr.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // The failure the rotation exists to prevent: the incoming spotlight added
  // while the outgoing one keeps its treatment.
  const dir = sandbox();
  editData(dir, (data) => {
    const outgoing = data.records.find((r) => r.id === 'myrtle');
    const incoming = data.records.find((r) => r.id === 'start-cv');
    outgoing.card.attributes = { 'data-learning-spotlight': 'myrtle' };
    outgoing.card.spotlight_label = incoming.card.spotlight_label;
    outgoing.detail.spotlight_label = incoming.detail.spotlight_label;
    outgoing.card.spotlight_disclosure = incoming.card.spotlight_disclosure;
    outgoing.detail.spotlight_disclosure = incoming.detail.spotlight_disclosure;
  });
  const r = validate(dir);
  check('two simultaneous Learning Spotlights are rejected',
    r.status === 1 && /exactly one record must hold the Learning Spotlight; found 2/.test(r.stderr), r.stderr.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // A rotation that removes the marker but leaves the labels behind.
  const dir = sandbox();
  editData(dir, (data) => {
    data.records.find((r) => r.id === 'start-cv').card.attributes = null;
  });
  const r = validate(dir);
  check('a partial Learning Spotlight treatment is rejected',
    r.status === 1 && /partial Learning Spotlight treatment/.test(r.stderr), r.stderr.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // No spotlight at all is equally a rotation defect, not a quiet success.
  const dir = sandbox();
  editData(dir, (data) => {
    const r = data.records.find((rec) => rec.id === 'start-cv');
    r.card.attributes = null;
    r.card.spotlight_label = null;
    r.detail.spotlight_label = null;
    r.card.spotlight_disclosure = null;
    r.detail.spotlight_disclosure = null;
  });
  const r = validate(dir);
  check('a surface with no Learning Spotlight is rejected',
    r.status === 1 && /exactly one record must hold the Learning Spotlight; found 0/.test(r.stderr), r.stderr.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // Spotlight status is presentation only, so it may never be held by a record
  // the generator does not render onto the surface.
  const dir = sandbox();
  editData(dir, (data) => {
    data.records.find((r) => r.id === 'start-cv').publication_state = 'WITHDRAWN';
  });
  const r = validate(dir);
  check('a Learning Spotlight on a removed-state record is rejected',
    r.status === 1 && /holds the Learning Spotlight in publication_state "WITHDRAWN"/.test(r.stderr), r.stderr.trim());
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // Exactly one spotlight article reaches each rendered Home surface.
  const dir = sandbox();
  for (const locale of ['en', 'pt']) {
    const r = run(dir, locale);
    const html = fs.readFileSync(homePath(dir, locale), 'utf8');
    const marked = html.match(/<article class="resource-card" data-learning-spotlight="[^"]+">/g) || [];
    check(`${locale.toUpperCase()} Home carries exactly one Learning Spotlight article`,
      r.status === 0 && marked.length === 1 && marked[0].includes('"start-cv"'), JSON.stringify(marked));
    check(`${locale.toUpperCase()} Home no longer marks Myrtle as the Learning Spotlight`,
      !html.includes('data-learning-spotlight="myrtle"'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nGenerator ownership/state tests: ${passed}/${passed + failures.length} passed.`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
