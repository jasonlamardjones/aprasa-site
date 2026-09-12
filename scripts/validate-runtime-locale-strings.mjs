#!/usr/bin/env node
// Regression gate for the runtime editorial-fallback strings injected by
// prasa-launch.js.
//
// A live audit found those labels rendering in English on the Portuguese Home
// surface: prasa-launch.js injects them at runtime, so the static-page
// localizer never sees them. They now come from a governed
// <script type="application/json" id="i18n-strings"> block that
// scripts/build-static-pages.mjs writes per locale from the approved overlay,
// with prasa-launch.js falling back to its own English defaults when a key is
// absent.
//
// This validator asserts:
//   1. Both Home surfaces carry the block, and every value in it is the
//      governed value for that page's own locale.
//   2. The EN block matches prasa-launch.js's hardcoded defaults byte for
//      byte, so the English surface cannot drift from the governed source.
//   3. prasa-launch.js itself carries no translation — a governed value
//      reaches it only through the block.
//   4. A key with no approved Portuguese value is ABSENT from both blocks
//      rather than carrying invented or English-substituted copy. That set is
//      empty today: the "section thumbnail" note shipped unresolved with the
//      collection hub and was approved by Project 09 afterwards, so it is now
//      a required, verified value like every other governed runtime string.
//      The mechanism stays in place for the next string that needs it.
//
// Usage: node scripts/validate-runtime-locale-strings.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, hasKey } from './lib/locale.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

// runtime key -> governed locale key. Must mirror the maps in
// scripts/lib/runtime-strings.mjs. This file deliberately keeps its OWN copy
// rather than importing them: it is the check that those maps are correct, so
// importing from them would make the check vacuous.
//
// Two groups, because they have different reach. The media-fallback copy is
// rendered only into Home's card shelves. The launcher-panel copy (Project 09
// r17) is rendered into the on-site panel the floating WhatsApp launcher
// opens, and that launcher initializes on every surface carrying the governed
// WhatsApp anchor — so those keys must reach every such surface, in that
// surface's own locale.
const GOVERNED_MEDIA = {
  mediaFallbackLabel: 'system.media_fallback.label',
  mediaFallbackNote: 'system.media_fallback.note',
  sectionThumbnailNote: 'system.media_fallback.section_note',
  trainingsSectionLabel: 'home.training.title',
  organizationsSectionLabel: 'home.organizations.title',
};

const GOVERNED_LAUNCHER = {
  launcherHeader: 'runtime.whatsapp_launcher.header',
  launcherIntro: 'runtime.whatsapp_launcher.intro',
  launcherQuickActionShare: 'runtime.whatsapp_launcher.quick_action.share',
  launcherQuickActionCorrection: 'runtime.whatsapp_launcher.quick_action.correction',
  launcherQuickActionQuestion: 'runtime.whatsapp_launcher.quick_action.question',
  launcherQuickActionSubmissions: 'runtime.whatsapp_launcher.quick_action.submissions',
  launcherPrimaryAction: 'runtime.whatsapp_launcher.primary_action',
  launcherSecondaryAction: 'runtime.whatsapp_launcher.secondary_action',
};

const GOVERNED = { ...GOVERNED_MEDIA, ...GOVERNED_LAUNCHER };

// Mindelo Essentials' own runtime strings, written into the same block by
// scripts/build-mindelo-pt.mjs under that script's contract. Listed explicitly
// so the two Mindelo surfaces are held to a closed key set like every other
// surface, rather than exempted wholesale. Values are that contract's business;
// what this file asserts is only that no OTHER key appears.
const MINDELO_RUNTIME_KEYS = new Set([
  'searchCountOne',
  'searchCountManyTemplate',
  'mapEnhancedGuidance',
  'mapDefaultMarkerTitle',
  'markerOrientationAccessibleNameTemplate',
  'markerDirectoryAccessibleNameTemplate',
  'markerOrientationDefaultName',
  'markerDirectoryDefaultName',
]);

// Runtime keys deliberately left unresolved because the governed overlay
// carries no approved Portuguese value for them yet. Each one must stay out of
// both blocks, and must still have an English default in prasa-launch.js.
//
// Empty today. It is not dead code: it is the mechanism that keeps an
// unapproved string out of a public surface, and the negative coverage in
// scripts/test-things-to-do-hub.mjs proves an unknown key is still rejected.
const BLOCKED_PENDING_APPROVAL = {};

const runtime = fs.readFileSync(path.join(root, 'prasa-launch.js'), 'utf8');

function readBlock(relative) {
  const html = fs.readFileSync(path.join(root, relative), 'utf8');
  const match = html.match(/<script type="application\/json" id="i18n-strings">([\s\S]*?)<\/script>/);
  if (!match) {
    errors.push(`${relative}: governed runtime-strings block is missing`);
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    errors.push(`${relative}: governed runtime-strings block is not valid JSON: ${error.message}`);
    return null;
  }
}

// Every surface the floating launcher can initialize on. Discovered from the
// repository rather than listed by hand, so a new page cannot silently ship
// without the governed runtime copy: the launcher initializes wherever the
// governed WhatsApp anchor is, so that anchor is the discovery key.
function walkHtml(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(abs, out);
    else if (entry.name.endsWith('.html')) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out;
}

// Mirror the runtime's own selector, a[href*="wa.me/"], rather than a
// narrower literal: the launcher initializes on any anchor whose href merely
// CONTAINS "wa.me/", so single-quoted or protocol-relative markup counts. A
// discovery rule stricter than the runtime's would skip a page the launcher
// still runs on — and on a PT page that is exactly the silent English
// fallback this validator exists to prevent.
// Quoted (double or single) and unquoted attribute values all reach
// a[href*="wa.me/"] in a browser, so all three must be discovered here.
// An unquoted value runs to the first whitespace, quote or ">".
const WA_ANCHOR = /href\s*=\s*(?:"[^"]*wa\.me\/|'[^']*wa\.me\/|[^\s"'>]*wa\.me\/)/i;

const surfaces = walkHtml(root)
  .filter((rel) => WA_ANCHOR.test(fs.readFileSync(path.join(root, rel), 'utf8')))
  .sort();

if (!surfaces.length) errors.push('no floating-launcher surfaces found — the wa.me discovery key matched nothing');

let checkedSurfaces = 0;
for (const relative of surfaces) {
  const html = fs.readFileSync(path.join(root, relative), 'utf8');
  const locale = relative === 'pt/index.html' || relative.startsWith('pt/') ? 'pt' : 'en';
  const isHome = relative === 'index.html' || relative === 'pt/index.html';
  // Mindelo Essentials runs its own runtime (mindelo-essentials.js) and its
  // block carries that runtime's own governed strings alongside the launcher
  // copy, under scripts/build-mindelo-pt.mjs's contract. Those specific keys
  // are expected here — but only those: a blanket "anything goes on Mindelo"
  // exemption would let a new or misspelled key ride onto a public block
  // unchecked, which is precisely what the unknown-key rule below exists to
  // stop.
  const carriesMindeloRuntime = /mindelo-essentials\.js/.test(html);
  const expected = { ...GOVERNED_LAUNCHER, ...(isHome ? GOVERNED_MEDIA : {}) };

  const block = readBlock(relative);
  if (!block) continue;
  checkedSurfaces += 1;

  for (const [runtimeKey, localeKey] of Object.entries(expected)) {
    if (!hasKey(localeKey)) {
      errors.push(`${relative}: governed key "${localeKey}" no longer exists in the overlay`);
      continue;
    }
    const want = t(localeKey, locale);
    if (block[runtimeKey] !== want) {
      errors.push(`${relative}: "${runtimeKey}" is ${JSON.stringify(block[runtimeKey])}, expected the governed ${locale.toUpperCase()} value ${JSON.stringify(want)} from "${localeKey}"`);
    }
    // No English may survive on a PT surface where the governed values differ.
    if (locale === 'pt') {
      const en = t(localeKey, 'en');
      if (en !== want && block[runtimeKey] === en) {
        errors.push(`${relative}: "${runtimeKey}" still holds the English value ${JSON.stringify(en)}`);
      }
    }
  }

  for (const runtimeKey of Object.keys(BLOCKED_PENDING_APPROVAL)) {
    if (runtimeKey in block) {
      errors.push(
        `${relative}: "${runtimeKey}" was written into the governed block, but no approved Project 09 value exists for it`
        + ' — it must stay unresolved rather than carry invented or English-substituted copy'
      );
    }
  }

  // A key this contract does not know about would be copy smuggled onto a
  // public surface outside the governed set.
  for (const runtimeKey of Object.keys(block)) {
    if (runtimeKey in GOVERNED) continue;
    if (carriesMindeloRuntime && MINDELO_RUNTIME_KEYS.has(runtimeKey)) continue;
    errors.push(`${relative}: "${runtimeKey}" is not a governed runtime string key`);
  }
}

// The English defaults compiled into prasa-launch.js are the fallback for every
// page without a block, so they must equal the governed English values.
for (const [runtimeKey, localeKey] of Object.entries(GOVERNED)) {
  if (!hasKey(localeKey)) continue;
  const en = t(localeKey, 'en');
  if (!runtime.includes(`${runtimeKey}: ${JSON.stringify(en)}`)) {
    errors.push(`prasa-launch.js: default for "${runtimeKey}" does not match the governed English value ${JSON.stringify(en)}`);
  }
}
for (const [runtimeKey, expected] of Object.entries(BLOCKED_PENDING_APPROVAL)) {
  if (!runtime.includes(`${runtimeKey}: ${JSON.stringify(expected)}`)) {
    errors.push(`prasa-launch.js: English default for the unapproved "${runtimeKey}" changed; it must stay as audited until Project 09 supplies an approved value`);
  }
}

// Every runtime string prasa-launch.js can render must be accounted for by one
// of the two sets above. A default with no governed key and no recorded
// blocked status would be untracked copy on a public surface.
for (const match of runtime.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*): "/gm)) {
  const runtimeKey = match[1];
  if (!(runtimeKey in GOVERNED) && !(runtimeKey in BLOCKED_PENDING_APPROVAL)) {
    errors.push(`prasa-launch.js: runtime string default "${runtimeKey}" is neither governed nor recorded as pending Project 09 approval`);
  }
}

// prasa-launch.js must not carry translated copy of its own. Any governed PT
// value appearing in the file would mean a translation was hardcoded rather
// than supplied through the governed block.
for (const localeKey of Object.values(GOVERNED)) {
  if (!hasKey(localeKey)) continue;
  const pt = t(localeKey, 'pt');
  const en = t(localeKey, 'en');
  if (pt !== en && runtime.includes(pt)) {
    errors.push(`prasa-launch.js: hardcodes the Portuguese value for "${localeKey}"; governed copy must reach the runtime through the i18n-strings block`);
  }
}

if (errors.length) {
  console.error(`[validate-runtime-locale-strings] FAILED with ${errors.length} error(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

const blocked = Object.keys(BLOCKED_PENDING_APPROVAL);
console.log(
  `[validate-runtime-locale-strings] OK — ${Object.keys(GOVERNED).length} governed runtime string(s); ${checkedSurfaces} floating-launcher surface(s) carry the governed block in their own locale;`
  + ` ${blocked.length} left unresolved pending Project 09 approval${blocked.length ? ` (${blocked.join(', ')})` : ''}.`
);
