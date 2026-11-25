#!/usr/bin/env node
// CV-030: approved copy, both Home surfaces, and the Cabo Verde deadline.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = 'aai-portuguese-a1-2026';
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/training-opportunities.json'), 'utf8'));
const record = data.records.find((item) => item.id === id);
assert.equal(data.records.length, 22);
assert.equal(data.records.filter((item) => item.id === id).length, 1);
assert.equal(record.lifecycle_class, 'fixed-window-opportunity');
assert.equal(record.publication_state, 'EXPIRED');
assert.equal(record.end_date, '2026-11-26');
assert.equal(record.card.attributes['data-application-expires-at'], '2026-11-27T01:00:00Z');
assert.equal(new Intl.DateTimeFormat('en-CA', {timeZone:'Atlantic/Cape_Verde', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23'}).format(new Date('2026-11-27T01:00:00Z')), '2026-11-27, 00');
const overlay = JSON.parse(fs.readFileSync(path.join(root, 'data/locales/pt-overlay-aai-portuguese-a1-2026.source.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(root, 'data/locales/locale-data.generated.json'), 'utf8')).keys;
assert.equal(overlay.rows.length, 9);
for (const row of overlay.rows) {
  assert.equal(keys[row.key].en, row.source_en);
  assert.equal(keys[row.key].pt, row.pt);
}
// After the authorized static transition the exact canonical marker pairs remain,
// but neither Home may present the AAI card, dialog content or application URL.
for (const [locale, file] of [['en', 'index.html'], ['pt', 'pt/index.html']]) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const parts = html.split(`<!-- BEGIN GENERATED TRAINING: ${id} -->`);
  assert.equal(parts.length, 2, `${locale}: exactly one AAI begin marker`);
  const end = parts[1].split(`<!-- END GENERATED TRAINING: ${id} -->`);
  assert.equal(end.length, 2, `${locale}: exactly one AAI end marker`);
  assert.equal(end[0].trim(), '', `${locale}: AAI region is non-actionable`);
  assert.ok(!html.includes(`data-event-id="${id}"`), `${locale}: no active AAI card`);
  assert.ok(!html.includes('form.jotform.com/263012358621551'), `${locale}: no AAI application action`);
}

// Drive the actual browser guard function with a controlled clock. At the
// boundary, the entire card goes away, including both application links and
// its details template; a dialog already open for that card is closed.
const runtime = fs.readFileSync(path.join(root, 'prasa-launch.js'), 'utf8');
const start = runtime.indexOf('  function guardTimedApplicationCards() {');
const end = runtime.indexOf('  guardTimedApplicationCards();', start);
assert.ok(start > 0 && end > start);
const guard = runtime.slice(start, end) + '\nguardTimedApplicationCards();';
function runtimeProbe(now, open=false) {
  let removed = false, closed = false, cleared = false, timer = null;
  const card = {getAttribute: () => '2026-11-27T01:00:00Z', remove: () => {removed = true;}};
  const context = {
    document: {querySelectorAll: () => [card]},
    Date: class extends Date {static now() {return now;}},
    window: {setTimeout: (_fn, delay) => {timer = delay;}},
    dialogTrigger: open ? {closest: () => card} : null,
    dialog: {open, close: () => {closed = true;}},
    dialogContent: {replaceChildren: () => {cleared = true;}},
  };
  vm.runInNewContext(guard, context);
  return {removed, closed, cleared, timer};
}
assert.deepEqual(runtimeProbe(Date.parse('2026-11-27T00:59:59Z')), {removed:false,closed:false,cleared:false,timer:1000});
assert.deepEqual(runtimeProbe(Date.parse('2026-11-27T01:00:00Z'), true), {removed:true,closed:true,cleared:true,timer:null});

function run(cwd, script, args=[]) {
  return spawnSync(process.execPath, [script, ...args], {cwd, encoding:'utf8'});
}
// The after-deadline currentness validator now accepts the canonical EXPIRED state.
const current = run(root, 'scripts/validate-training-opportunities-currentness.mjs', ['--as-of=2026-11-27','--home=index.html','--home=pt/index.html']);
assert.equal(current.status, 0, current.stderr);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-aai-expiry-'));
try {
  fs.cpSync(root, tmp, {recursive:true, filter: (src) => !['.git', 'node_modules'].includes(path.basename(src))});
  const p = path.join(tmp, 'data/training-opportunities.json');
  const historical = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(historical.records.length, 22, 'historical canonical record preserved');
  const aai = historical.records.find((item) => item.id === id);
  assert.equal(aai.publication_state, 'EXPIRED');
  // Recreate the PRE-expiry fixture only inside this disposable copy. This
  // proves the still-approved presentation is intact without republishing it.
  aai.publication_state = 'CURRENT';
  fs.writeFileSync(p, JSON.stringify(historical, null, 2) + '\n');
  for (const [locale, home] of [['en', 'index.html'], ['pt', 'pt/index.html']]) {
    let result = run(tmp, 'scripts/generate-training-opportunities.mjs', [`--locale=${locale}`, '--as-of=2026-11-26', `--home=${home}`, '--write']);
    assert.equal(result.status, 0, result.stderr);
    let html = fs.readFileSync(path.join(tmp, home), 'utf8');
    let region = html.split(`<!-- BEGIN GENERATED TRAINING: ${id} -->`)[1]?.split(`<!-- END GENERATED TRAINING: ${id} -->`)[0];
    assert.ok(region, `${locale}: historical AAI region exists`);
    for (const field of ['title','status','meta','body','requirements','good','action','checked','detail_checked']) {
      assert.ok(region.includes(keys[`training.record.${id}.${field}`][locale]), `${locale}: ${field} approved wording preserved`);
    }
    assert.equal((region.match(/href="https:\/\/form.jotform.com\/263012358621551"/g) || []).length, 2);
    aai.publication_state = 'EXPIRED';
    fs.writeFileSync(p, JSON.stringify(historical, null, 2) + '\n');
    result = run(tmp, 'scripts/generate-training-opportunities.mjs', [`--locale=${locale}`, '--as-of=2026-11-27', `--home=${home}`, '--write']);
    assert.equal(result.status, 0, result.stderr);
    html = fs.readFileSync(path.join(tmp, home), 'utf8');
    region = html.split(`<!-- BEGIN GENERATED TRAINING: ${id} -->`)[1]?.split(`<!-- END GENERATED TRAINING: ${id} -->`)[0];
    assert.equal(region.trim(), '', `${locale}: expired AAI has no actionable application presentation`);
    aai.publication_state = 'CURRENT';
    fs.writeFileSync(p, JSON.stringify(historical, null, 2) + '\n');
  }
  aai.publication_state = 'EXPIRED';
  fs.writeFileSync(p, JSON.stringify(historical, null, 2) + '\n');
  const valid = run(tmp, 'scripts/validate-training-opportunities-currentness.mjs', ['--as-of=2026-11-27','--home=index.html','--home=pt/index.html']);
  assert.equal(valid.status, 0, valid.stderr);
} finally {
  fs.rmSync(tmp, {recursive:true, force:true});
}
console.log('AAI A1: nine exact EN/PT pairs, runtime boundary, preserved pre-expiry wording and post-expiry static retirement passed.');
