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
    check(`${label}: all nine regions still owned`, /9 region\(s\) owned/.test(fwd.stdout), fwd.stdout.trim());
    check(`${label}: reports one cleared region`, /8 rendered, 1 cleared/.test(fwd.stdout), fwd.stdout.trim());

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

console.log(`\nGenerator ownership/state tests: ${passed}/${passed + failures.length} passed.`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
