#!/usr/bin/env node
// No-silent-fallback contract validator for the EN/PT localization architecture.
// Run standalone (validates data/locales/locale-data.generated.json) and/or
// against generated PT HTML output (pass --html <dir> one or more times).

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocaleData, RETIRED_KEY_REMAP } from "./lib/locale.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let errors = [];
let warnings = [];

function fail(msg) {
  errors.push(msg);
}

const data = loadLocaleData();
const keys = Object.values(data.keys);

// --- Overlay contract (counts) ---
if (keys.length !== 732) fail(`expected 732 total keys, got ${keys.length}`);
const required = keys.filter((k) => k.scope_status === "REQUIRED_FOR_PT_LAUNCH");
const unchanged = keys.filter((k) => k.scope_status === "INTENTIONALLY_UNCHANGED");
if (required.length !== 705) fail(`expected 705 REQUIRED_FOR_PT_LAUNCH keys, got ${required.length}`);
if (unchanged.length !== 27) fail(`expected 27 INTENTIONALLY_UNCHANGED keys, got ${unchanged.length}`);
if (data.provenance.source_revision !== "P03-PT-SOURCE-2026-08-25-r2") {
  fail(`unexpected source_revision: ${data.provenance.source_revision}`);
}

// --- No missing mandatory PT ---
for (const row of required) {
  if (!row.pt) fail(`REQUIRED_FOR_PT_LAUNCH key "${row.key}" has no PT value`);
}

// --- Duplicate keys ---
const seen = new Set();
for (const row of keys) {
  if (seen.has(row.key)) fail(`duplicate key: ${row.key}`);
  seen.add(row.key);
}

// --- Retired keys must not be reintroduced ---
for (const retired of Object.keys(RETIRED_KEY_REMAP)) {
  if (retired in data.keys) fail(`retired key reintroduced: ${retired}`);
}
// --- Remap targets must exist ---
for (const target of Object.values(RETIRED_KEY_REMAP)) {
  if (!(target in data.keys)) fail(`remap target missing from locale data: ${target}`);
}

// --- r2 delta spot checks ---
const body2 = data.keys["mindelo.sources.body_2"];
if (!body2) {
  fail(`mindelo.sources.body_2 missing`);
} else {
  if (body2.en !== "A PRASA is available in English and Portuguese. Portuguese content is published after human review.") {
    fail(`mindelo.sources.body_2 EN text does not match expected r2 delta`);
  }
  if (body2.pt !== "A PRASA está disponível em inglês e português. O conteúdo em português é publicado após revisão humana.") {
    fail(`mindelo.sources.body_2 PT text does not match expected r2 delta`);
  }
}
const uiCurrent = data.keys["ui.current"];
if (!uiCurrent) {
  fail(`ui.current missing`);
} else if (uiCurrent.pt !== "Atual") {
  fail(`ui.current PT value is "${uiCurrent.pt}", expected "Atual"`);
}

// --- A PRASA brand protection (spot scan across all EN/PT values) ---
// Flags only the exact all-caps brand substitution "A PRAÇA"; ordinary
// lowercase "praça" (Portuguese for "square") is legitimate vocabulary.
for (const row of keys) {
  for (const text of [row.en, row.pt]) {
    if (text && text.includes("A PRAÇA")) {
      fail(`brand violation "A PRAÇA" found in key "${row.key}"`);
    }
  }
}

// --- Optional: validate generated HTML directories passed via --html ---
const htmlDirs = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--html" && process.argv[i + 1]) htmlDirs.push(process.argv[i + 1]);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (entry === "index.html") out.push(p);
  }
  return out;
}

for (const dir of htmlDirs) {
  const abs = path.join(ROOT, dir);
  let files;
  try {
    files = walk(abs);
  } catch {
    fail(`--html directory does not exist: ${dir}`);
    continue;
  }
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);
    const isPt = /\/pt\//.test(rel) || rel.startsWith("pt/") || rel.startsWith("pt" + path.sep);
    const langMatch = html.match(/<html[^>]*\blang="([^"]+)"/);
    if (!langMatch) {
      fail(`${rel}: no lang attribute on <html>`);
    } else if (isPt && langMatch[1] !== "pt") {
      fail(`${rel}: expected lang="pt", got lang="${langMatch[1]}"`);
    } else if (!isPt && langMatch[1] !== "en") {
      fail(`${rel}: expected lang="en", got lang="${langMatch[1]}"`);
    }

    const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/);
    if (isPt && canonicalMatch && !/\/pt\//.test(canonicalMatch[1]) && canonicalMatch[1] !== "https://aprasa.org/pt/") {
      fail(`${rel}: PT page canonical does not point at a /pt/ URL: ${canonicalMatch[1]}`);
    }

    const hreflangEn = html.match(/hreflang="en" href="([^"]+)"/);
    const hreflangPt = html.match(/hreflang="pt" href="([^"]+)"/);
    const hreflangDefault = html.match(/hreflang="x-default" href="([^"]+)"/);
    if (!hreflangEn || !hreflangPt || !hreflangDefault) {
      fail(`${rel}: missing reciprocal hreflang (en/pt/x-default) tags`);
    } else if (/\/pt\//.test(hreflangDefault[1])) {
      fail(`${rel}: x-default hreflang points at a PT URL`);
    }

    if (isPt) {
      const bodyMatch = html.match(/<body[\s\S]*<\/body>/);
      // no-op placeholder for future deep-scan hook; presence of PT body already
      // implied by generation path succeeding (locale.mjs throws on missing PT).
    }
  }
}

if (warnings.length) {
  console.warn(`[validate-locale-contract] ${warnings.length} warning(s):`);
  for (const w of warnings) console.warn(`  - ${w}`);
}

if (errors.length) {
  console.error(`[validate-locale-contract] FAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `[validate-locale-contract] OK — ${keys.length} keys (${required.length} required, ${unchanged.length} intentionally unchanged), ${htmlDirs.length} HTML dir(s) checked.`
);
