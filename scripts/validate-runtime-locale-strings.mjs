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

// Floating navigation controls. ui.back_to_top is long-standing governed copy;
// routing it through the block is what lets the Up control exist on surfaces
// with no in-page "Back to top" anchor to borrow a label from.
const GOVERNED_NAV = {
  navBackToTop: 'ui.back_to_top',
  navScrollDown: 'ui.scroll_down',
};

// Quick-action starter messages (Project 09 r19). Delivered to every launcher
// surface: the panel exists on all of them, so the prefill for each action must
// resolve in that surface's own locale.
const GOVERNED_PREFILL = {
  prefillShare: 'runtime.whatsapp_launcher.prefill.share',
  prefillCorrection: 'runtime.whatsapp_launcher.prefill.correction',
  prefillQuestion: 'runtime.whatsapp_launcher.prefill.question',
  prefillSubmissions: 'runtime.whatsapp_launcher.prefill.submissions',
};

const GOVERNED = { ...GOVERNED_MEDIA, ...GOVERNED_LAUNCHER, ...GOVERNED_NAV, ...GOVERNED_PREFILL };

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

// Recognizing a WhatsApp anchor the way the BROWSER does, not the way the
// source happens to be spelled. Used only to challenge an exemption below;
// it is never what decides that a page may be skipped.
//   - attribute quoting: double, single, or unquoted (to the first
//     whitespace, quote or ">");
//   - character references: href="https://wa&#46;me/..." decodes to the
//     governed URL, so the launcher initializes on it.
const HREF_ATTR = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const NAMED_REFS = {amp: '&', period: '.', sol: '/', colon: ':', lpar: '(', rpar: ')'};

function decodeCharRefs(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (whole, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (whole, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);?/gi, (whole, name) => NAMED_REFS[name.toLowerCase()] ?? whole);
}

function hasGovernedWhatsAppAnchor(html) {
  for (const match of html.matchAll(HREF_ATTR)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (decodeCharRefs(value).includes('wa.me/')) return true;
  }
  return false;
}

// Which pages must carry the governed runtime-strings block.
//
// This check is deliberately INVERTED relative to how it started. It used to
// discover launcher surfaces by scanning markup for a WhatsApp anchor, which
// made it fail-OPEN: any page whose anchor the scan failed to recognize was
// silently skipped, and on a PT surface that means the panel renders English
// fallbacks while validation reports success. Review found three separate
// ways to slip past that scan in a row (single-quoted values, unquoted
// values, character references), which is the signal that approximating an
// HTML parser with patterns was the wrong shape for a safety check.
//
// So: EVERY HTML page in the repository must carry the block, except the
// pages listed below. A new page is covered by default and a new bypass is
// not expressible — the failure mode is now "a page you must think about",
// not "a page nobody notices".
const PAGES_WITHOUT_LAUNCHER = new Set([
  // Bare analytics opt-out receipt: no site chrome, no footer contact anchor,
  // and so no floating launcher to localize.
  'internal/analytics-exclude.html',
]);

function walkHtml(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(abs, out);
    else if (entry.name.endsWith('.html')) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out;
}

const allPages = walkHtml(root).sort();
const surfaces = allPages.filter((rel) => !PAGES_WITHOUT_LAUNCHER.has(rel));

if (!surfaces.length) errors.push('no launcher surfaces found — every HTML page is on the exemption list');

// The exemption list is itself checked, from both directions: an entry that
// no longer exists is stale, and an exempt page that actually carries a
// WhatsApp anchor would initialize the launcher and therefore does need the
// block. Anchor parsing is only ever used HERE, to challenge an exemption —
// never to decide that a page can be skipped.
for (const rel of PAGES_WITHOUT_LAUNCHER) {
  if (!allPages.includes(rel)) {
    errors.push(`${rel}: listed as carrying no floating launcher, but no such page exists — stale exemption`);
    continue;
  }
  if (hasGovernedWhatsAppAnchor(fs.readFileSync(path.join(root, rel), 'utf8'))) {
    errors.push(`${rel}: exempted from the governed runtime-strings block, but it carries a WhatsApp anchor — the launcher initializes there and its copy would fall back to English`);
  }
}

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
  const expected = { ...GOVERNED_LAUNCHER, ...GOVERNED_NAV, ...GOVERNED_PREFILL, ...(isHome ? GOVERNED_MEDIA : {}) };

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
