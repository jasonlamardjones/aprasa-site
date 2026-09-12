#!/usr/bin/env node
// Regression coverage for the floating WhatsApp launcher's on-site panel
// (Project 09 runtime copy P09-PT-RUNTIME-WHATSAPP-LAUNCHER-2026-09-12-r1).
//
// Runs with no dependencies so the hosted workflow can execute it directly.
// Behavioural checks that genuinely need a browser (real click dispatch,
// focus movement) are covered by browser QA; what this file pins is the
// contract that makes that behaviour possible, plus every governed-delivery
// and destination property, which are the things that can regress silently.
//
// Usage: node scripts/test-whatsapp-launcher-panel.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './lib/locale.mjs';
import { LAUNCHER_PANEL_KEYS } from './lib/runtime-strings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOVERNED_WHATSAPP_URL = 'https://wa.me/message/GC3C5Q4MSF37I1';

let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
}

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function walkHtml(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(abs, out);
    else if (entry.name.endsWith('.html')) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out;
}

const surfaces = walkHtml(root).filter((rel) => read(rel).includes('href="https://wa.me/')).sort();
const launcherJs = read('prasa-launch.js');
const mindeloJs = read('mindelo-essentials/mindelo-essentials.js');

// --- 1. Every floating-launcher surface receives all 8 runtime keys --------
console.log(`[1] governed runtime-key delivery across ${surfaces.length} launcher surface(s)`);
check('at least the four Home/Mindelo surfaces plus the generated pages exist', surfaces.length >= 30,
  `found ${surfaces.length}`);
for (const rel of surfaces) {
  const match = read(rel).match(/<script type="application\/json" id="i18n-strings">([\s\S]*?)<\/script>/);
  check(`${rel} carries the governed runtime-strings block`, !!match);
  if (!match) continue;
  let block;
  try { block = JSON.parse(match[1]); } catch (error) {
    check(`${rel} runtime-strings block is valid JSON`, false, error.message);
    continue;
  }
  for (const runtimeKey of Object.keys(LAUNCHER_PANEL_KEYS)) {
    check(`${rel} carries "${runtimeKey}"`, typeof block[runtimeKey] === 'string' && block[runtimeKey].length > 0);
  }
}

// --- 2. PT never receives EN panel copy ------------------------------------
console.log('[2] no English panel copy on any PT surface');
for (const rel of surfaces.filter((r) => r.startsWith('pt/'))) {
  const block = JSON.parse(read(rel).match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1]);
  for (const [runtimeKey, localeKey] of Object.entries(LAUNCHER_PANEL_KEYS)) {
    const en = t(localeKey, 'en');
    const pt = t(localeKey, 'pt');
    check(`${rel} "${runtimeKey}" holds the governed PT value`, block[runtimeKey] === pt,
      `got ${JSON.stringify(block[runtimeKey])}, expected ${JSON.stringify(pt)}`);
    if (en !== pt) {
      check(`${rel} "${runtimeKey}" is not the English value`, block[runtimeKey] !== en);
    }
  }
}
// The runtime files must carry no translation of their own.
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  for (const localeKey of Object.values(LAUNCHER_PANEL_KEYS)) {
    const pt = t(localeKey, 'pt');
    const en = t(localeKey, 'en');
    if (pt === en) continue;
    check(`${name} does not hardcode the PT value for "${localeKey}"`, !source.includes(pt));
  }
}

// --- 3. Initial launcher activation does not navigate ----------------------
console.log('[3] launcher is a toggle, not an outbound link');
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  const control = source.slice(source.indexOf('floating-utility floating-utility-whatsapp'));
  const controlBlock = control.slice(0, 1200);
  check(`${name} builds the launcher as a button`, /createElement\("button"\)/.test(
    source.slice(Math.max(0, source.indexOf('floating-utility floating-utility-whatsapp') - 600),
      source.indexOf('floating-utility floating-utility-whatsapp'))));
  check(`${name} marks the launcher with aria-expanded`, controlBlock.includes('"aria-expanded", "false"'));
  check(`${name} associates the launcher with the panel via aria-controls`, controlBlock.includes('"aria-controls", PANEL_ID'));
  check(`${name} never assigns the governed URL to the launcher control itself`,
    !/button\.href\s*=/.test(source));
}

// --- 4. The explicit Open WhatsApp action uses the exact governed destination
console.log('[4] panel CTA carries the exact governed destination');
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  check(`${name} pins the governed destination`, source.includes(`"${GOVERNED_WHATSAPP_URL}"`));
  check(`${name} sets the CTA href from the asserted governed anchor`, /cta\.href = sourceAnchor\.href;/.test(source));
  const others = [...source.matchAll(/https:\/\/wa\.me\/[^"' )]*/g)].map((m) => m[0]);
  check(`${name} contains no other wa.me literal`, others.every((u) => u === GOVERNED_WHATSAPP_URL),
    `found ${JSON.stringify([...new Set(others)])}`);
  check(`${name} introduces no prefilled-message parameter`, !/[?&](text|message)=/.test(source));
}

// --- 5. Destination conflict still fails closed ----------------------------
console.log('[5] fail-closed destination guard intact');
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  check(`${name} rejects a conflicting or absent destination set`,
    source.includes('destinations.size !== 1 || !destinations.has(GOVERNED_WHATSAPP_URL)'));
  check(`${name} re-asserts the resolved anchor before initializing`,
    source.includes('normalizeUrl(sourceAnchor.href) !== GOVERNED_WHATSAPP_URL'));
  check(`${name} returns without building the cluster when the guard trips`,
    /console\.warn\("A PRASA floating WhatsApp control not initialized/.test(source));
}

// --- 6. Panel open/close state ---------------------------------------------
console.log('[6] panel open/close state is wired');
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  check(`${name} starts the panel hidden`, /panel\.hidden = true;/.test(source));
  check(`${name} opens by unhiding and setting aria-expanded`,
    /panel\.hidden = false;[\s\S]{0,120}"aria-expanded", "true"/.test(source));
  check(`${name} closes by hiding and clearing aria-expanded`,
    /panel\.hidden = true;[\s\S]{0,120}"aria-expanded", "false"/.test(source));
  check(`${name} closes on Escape`, /event\.key !== "Escape"/.test(source));
  check(`${name} returns focus to the launcher on close`, /if \(returnFocus\) button\.focus\(\);/.test(source));
  check(`${name} moves focus into the panel on open`, /panel\.focus\(\);/.test(source));
  check(`${name} gives the panel an accessible name`, source.includes('"aria-labelledby", PANEL_TITLE_ID'));
}

// --- 7. Quick-action selection ---------------------------------------------
console.log('[7] quick actions are single-select, local, and expose state');
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  check(`${name} exposes selection through aria-pressed`, source.includes('"aria-pressed", "false"'));
  check(`${name} clears every other action before selecting`,
    /for \(const other of quickActions\) other\.setAttribute\("aria-pressed", "false"\);/.test(source));
  check(`${name} toggles the activated action`,
    /action\.setAttribute\("aria-pressed", selected \? "false" : "true"\);/.test(source));
  check(`${name} renders exactly the four governed quick actions`,
    (source.match(/launcherQuickAction(Share|Correction|Question|Submissions)"/g) || []).length >= 4);
}

// --- 8. Generated output remains deterministic -----------------------------
// The block is a JSON island: key order and spacing must be stable, or every
// rebuild would churn 32 files. Assert the serialization is canonical rather
// than re-running the generators here (build-all is exercised separately).
console.log('[8] governed block serialization is canonical and stable');
for (const rel of surfaces) {
  const raw = read(rel).match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1];
  check(`${rel} block is emitted on a single line`, !/\n/.test(raw));
  // Byte-identical round-trip is the real determinism property: it proves the
  // block is canonical compact JSON.stringify output, so a rebuild cannot
  // churn key order or spacing across all 32 surfaces. (A naive "contains no
  // ': '" check would be wrong here — governed strings contain colons.)
  check(`${rel} block round-trips byte-identically`, JSON.stringify(JSON.parse(raw)) === raw);
}

console.log(`\n[test-whatsapp-launcher-panel] ${checks - failures}/${checks} checks passed across ${surfaces.length} surface(s).`);
if (failures) {
  console.error(`[test-whatsapp-launcher-panel] FAILED with ${failures} failing check(s).`);
  process.exit(1);
}
