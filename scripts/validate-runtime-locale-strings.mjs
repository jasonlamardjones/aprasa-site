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
//      rather than carrying invented or English-substituted copy. The
//      "section thumbnail" note is in that state today, pending Project 09.
//
// Usage: node scripts/validate-runtime-locale-strings.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, hasKey } from './lib/locale.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

// runtime key -> governed locale key. Must mirror RUNTIME_STRING_KEYS in
// scripts/build-static-pages.mjs.
const GOVERNED = {
  mediaFallbackLabel: 'system.media_fallback.label',
  mediaFallbackNote: 'system.media_fallback.note',
  trainingsSectionLabel: 'home.training.title',
  organizationsSectionLabel: 'home.organizations.title',
};

// Runtime keys deliberately left unresolved because the governed overlay
// carries no approved Portuguese value for them yet. Each one must stay out of
// both blocks, and must still have an English default in prasa-launch.js.
const BLOCKED_PENDING_APPROVAL = {
  sectionThumbnailNote: 'A PRASA section thumbnail — not provider-specific imagery.',
};

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

for (const [locale, relative] of [['en', 'index.html'], ['pt', 'pt/index.html']]) {
  const block = readBlock(relative);
  if (!block) continue;

  for (const [runtimeKey, localeKey] of Object.entries(GOVERNED)) {
    if (!hasKey(localeKey)) {
      errors.push(`${relative}: governed key "${localeKey}" no longer exists in the overlay`);
      continue;
    }
    const expected = t(localeKey, locale);
    if (block[runtimeKey] !== expected) {
      errors.push(`${relative}: "${runtimeKey}" is ${JSON.stringify(block[runtimeKey])}, expected the governed ${locale.toUpperCase()} value ${JSON.stringify(expected)} from "${localeKey}"`);
    }
    // No English may survive on the PT surface where the governed values differ.
    if (locale === 'pt') {
      const en = t(localeKey, 'en');
      if (en !== expected && block[runtimeKey] === en) {
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

  // Every key the block declares must be one this contract knows about, so a
  // string cannot be smuggled onto a public surface outside the governed set.
  for (const runtimeKey of Object.keys(block)) {
    if (!(runtimeKey in GOVERNED)) {
      errors.push(`${relative}: "${runtimeKey}" is not a governed runtime string key`);
    }
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
  `[validate-runtime-locale-strings] OK — ${Object.keys(GOVERNED).length} governed runtime string(s) resolved per locale on both Home surfaces;`
  + ` ${blocked.length} left unresolved pending Project 09 approval (${blocked.join(', ')}).`
);
