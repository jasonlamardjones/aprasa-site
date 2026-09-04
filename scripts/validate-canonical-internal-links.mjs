#!/usr/bin/env node
// Regression gate for canonical internal-link form.
//
// A live technical SEO audit found internal navigation pointing at explicit
// Home document URLs (/index.html, /pt/index.html) and at the legacy
// /index.html#things-to-do return anchor. Those URLs return 200 and
// canonicalize correctly, so the correction was link hygiene only — no
// canonical policy changed and no redirect was added. This validator stops the
// pattern being reintroduced by a generator, a template or a hand edit.
//
// It asserts three things across every committed HTML page:
//   1. No href points at a Home document URL. Home is linked as "./", "../",
//      "../../" — the clean directory form of its canonical URL.
//   2. No Things-to-Do return control points at a Home fragment. Every one
//      resolves to its own locale's collection route.
//   3. The sitemap publishes no index.html variant.
//
// Usage: node scripts/validate-canonical-internal-links.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNoncanonicalHomeLinks } from './lib/canonical-links.mjs';
import { HUB_ROUTE } from './lib/things-to-do-collection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'assets', 'validation-artifacts']);
const errors = [];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

const files = walk(root);
for (const file of files) {
  const relative = path.relative(root, file);
  const html = fs.readFileSync(file, 'utf8');

  for (const href of findNoncanonicalHomeLinks(html)) {
    errors.push(`${relative}: noncanonical Home link ${href} — link Home by its canonical directory form`);
  }

  // A Things-to-Do return control must lead to the collection, not to a Home
  // fragment. The route it resolves to is checked, not the literal string, so
  // a page at any depth is judged by where the link actually goes.
  for (const match of html.matchAll(/<nav class="breadcrumb"[\s\S]*?<a href="([^"]+)"/g)) {
    const href = match[1];
    if (href.includes('#things-to-do')) {
      errors.push(`${relative}: breadcrumb points at a Home fragment (${href}) instead of the collection route`);
      continue;
    }
    const resolved = `/${path.relative(root, path.resolve(path.dirname(file), href))}`.replace(/\/?$/, '/');
    const expected = relative.startsWith('pt/') ? `/pt/${HUB_ROUTE}` : `/${HUB_ROUTE}`;
    if (resolved !== expected) {
      errors.push(`${relative}: breadcrumb resolves to ${resolved}, expected the same-locale collection route ${expected}`);
    }
  }
}

const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
for (const match of sitemap.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
  if (match[1].includes('index.html')) {
    errors.push(`sitemap.xml: publishes an index.html document URL (${match[1]}) instead of its canonical directory form`);
  }
}

if (errors.length) {
  console.error(`[validate-canonical-internal-links] FAILED with ${errors.length} error(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`[validate-canonical-internal-links] OK — ${files.length} page(s) link Home and the Things-to-Do collection by canonical route.`);
