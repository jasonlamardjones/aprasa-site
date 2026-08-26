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

// --- Overlay contract (counts) — combined r2 base (732) + r3 delta (21) + r4 delta (26) + r5 delta (2).
// The r6 brand-voice delta overrides 42 existing PT values and adds no keys,
// so every count below is unchanged by it. ---
if (keys.length !== 781) fail(`expected 781 total keys (732 r2 + 21 r3 + 26 r4 + 2 r5, +0 from r6), got ${keys.length}`);
const required = keys.filter((k) => k.scope_status === "REQUIRED_FOR_PT_LAUNCH");
const unchanged = keys.filter((k) => k.scope_status === "INTENTIONALLY_UNCHANGED");
if (required.length !== 753) fail(`expected 753 REQUIRED_FOR_PT_LAUNCH keys (705 + 20 + 26 + 2), got ${required.length}`);
if (unchanged.length !== 28) fail(`expected 28 INTENTIONALLY_UNCHANGED keys (27 + 1 + 0 + 0), got ${unchanged.length}`);
if (data.provenance.delta_revision !== "P03-PT-SOURCE-2026-08-25-r3") {
  fail(`unexpected delta_revision: ${data.provenance.delta_revision}`);
}
if (data.provenance.base_revision !== "P03-PT-SOURCE-2026-08-25-r2") {
  fail(`unexpected base_revision: ${data.provenance.base_revision}`);
}
if (data.provenance.delta4_revision !== "P03-PT-SOURCE-2026-08-25-r4") {
  fail(`unexpected delta4_revision: ${data.provenance.delta4_revision}`);
}
if (data.provenance.delta5_revision !== "P03-PT-SOURCE-2026-08-25-r5") {
  fail(`unexpected delta5_revision: ${data.provenance.delta5_revision}`);
}
if (data.provenance.delta6_revision !== "P03-PT-SOURCE-2026-08-26-r6") {
  fail(`unexpected delta6_revision: ${data.provenance.delta6_revision}`);
}
if (data.provenance.delta6_package_id !== "P09-PT-BRAND-VOICE-2026-08-26-v1") {
  fail(`unexpected delta6_package_id: ${data.provenance.delta6_package_id}`);
}
if (data.provenance.delta6_revision_class !== "OVERRIDE_EXISTING_KEYS") {
  fail(`unexpected delta6_revision_class: ${data.provenance.delta6_revision_class}`);
}

// --- r6 delta spot checks (Project 09 PT brand-voice refinement) ---
// Representative approved strings across the three affected surfaces. These
// pin the tu-register wording so a later revision cannot silently revert it.
const r6Spot = {
  "home.hero.tagline": "Um lugar para encontrares o que te move.",
  "home.meta.og_description": "Um lugar para encontrares o que te move.",
  "home.hero.closing": "Encontra o que te move.",
  "home.things.submit_action": "Envia à A PRASA para consideração",
  "home.mindelo.title": "Orienta-te em Mindelo.",
  "about.meta.og_description":
    "Um lugar para encontrares o que te move. Uma praça pública digital independente e orientada por fontes, enraizada em Cabo Verde.",
  "about.find.title": "O que podes encontrar",
  "about.take_part.title": "Participa",
  "about.take_part.intro_list": "Podes:",
  "about.take_part.body_4": "Se encontrares um erro, agradecemos que nos avises.",
  "mindelo.directory.title": "Encontra um lugar e vê-o no mapa.",
  "mindelo.sources.body_3": "Tens uma sugestão, correção ou recomendação local?",
};
for (const [k, expected] of Object.entries(r6Spot)) {
  if (!data.keys[k]) {
    fail(`r6 key missing from locale data: ${k}`);
  } else if (data.keys[k].pt !== expected) {
    fail(`${k} PT does not match the approved Project 09 r6 brand-voice string`);
  }
}

// --- r6 scope guard: category D copy must NOT have been converted to tu ---
// These are factual / eligibility / source / trust rows adjacent to the r6
// surfaces. They are deliberately outside the 42-key delta and must keep the
// restrained third-person register.
const r6MustNotChange = {
  "home.training.emar.urgent_badge": "Oportunidade urgente",
  "home.training.emar.deadline_prominent": "Candidate-se até 30 de agosto de 2026",
  "mindelo.sources.body_2":
    "A PRASA está disponível em inglês e português. O conteúdo em português é publicado após revisão humana.",
  "ui.current": "Atual",
};
for (const [k, expected] of Object.entries(r6MustNotChange)) {
  if (data.keys[k] && data.keys[k].pt !== expected) {
    fail(`category-D key "${k}" was altered outside the approved r6 scope: got ${JSON.stringify(data.keys[k].pt)}`);
  }
}

// --- r5 delta spot checks (EMAR / Kre+ urgent-opportunity treatment) ---
const r5Keys = ["home.training.emar.urgent_badge", "home.training.emar.deadline_prominent"];
for (const k of r5Keys) {
  if (!data.keys[k]) fail(`r5 key missing from locale data: ${k}`);
}
if (data.keys["home.training.emar.urgent_badge"]?.pt !== "Oportunidade urgente") {
  fail(`home.training.emar.urgent_badge PT does not match the approved Project 09 string`);
}
if (data.keys["home.training.emar.deadline_prominent"]?.pt !== "Candidate-se até 30 de agosto de 2026") {
  fail(`home.training.emar.deadline_prominent PT does not match the approved Project 09 string`);
}

// --- r4 delta spot checks (EMAR / Kre+ opportunity records) ---
const r4Keys = [
  "home.training.emar.status",
  "home.training.emar.provider",
  "home.training.emar.fact_label.applications",
  "home.training.emar.fact_label.education",
  "home.training.emar.fact_label.places",
  "home.training.emar.fact_label.registration_fee",
  "home.training.emar.fact_label.tuition",
  "home.training.emar.fact_label.evaluation",
  "home.training.emar.fact_label.results",
  "home.training.emar.fact_value.applications",
  "home.training.emar.fact_value.registration_fee",
  "home.training.emar.fact_value.tuition",
  "home.training.emar.fact_value.evaluation",
  "home.training.emar.fact_value.results",
  "home.training.emar.documents_heading",
  "home.training.emar.document.education_certificate",
  "home.training.emar.document.cni",
  "home.training.emar.good_to_know",
  "home.training.emar.action",
  "home.training.emar.checked",
  "home.training.record.emar-motorista-n3.title",
  "home.training.record.emar-motorista-n3.body",
  "home.training.record.emar-motorista-n3.fact_value.education",
  "home.training.record.emar-assistente-eletrotecnico-naval-n4.title",
  "home.training.record.emar-assistente-eletrotecnico-naval-n4.body",
  "home.training.record.emar-assistente-eletrotecnico-naval-n4.fact_value.education",
];
for (const k of r4Keys) {
  if (!data.keys[k]) fail(`r4 key missing from locale data: ${k}`);
}
if (data.keys["home.training.emar.fact_value.applications"]?.pt !== "até 30 de agosto de 2026") {
  fail(`home.training.emar.fact_value.applications PT does not match the approved 2026-08-30 deadline`);
}

// --- r3 delta spot checks ---
const r3Keys = [
  "ui.cv_delivery",
  "ui.delivery_hours",
  "home.training.record.openlearn.card_action",
  "home.training.record.iefp-pepe.card_action",
  "home.help.record.cruz-vermelha.card_action",
  "home.help.record.biosfera.card_action",
  "home.help.record.no-bai.card_action",
  "home.help.record.espaco-jovem.card_action",
  "standalone.mindelo_cultural.meta.title",
  "standalone.mindelo_cultural.meta.description",
  "standalone.mindelo_cultural.social.title",
  "standalone.mindelo_cultural.social.description",
  "standalone.green_line.meta.title",
  "standalone.green_line.meta.description",
  "standalone.green_line.social.title",
  "standalone.green_line.social.description",
  "standalone.green_line.image_alt",
  "mindelo.map.marker.orientation_accessible_name",
  "mindelo.map.marker.directory_accessible_name",
  "mindelo.map.marker.orientation_default_name",
  "mindelo.map.marker.directory_default_name",
];
for (const k of r3Keys) {
  if (!data.keys[k]) fail(`r3 key missing from locale data: ${k}`);
}
const orientationName = data.keys["mindelo.map.marker.orientation_default_name"];
if (orientationName && orientationName.pt !== "Ponto de referência para orientação") {
  fail(`mindelo.map.marker.orientation_default_name PT does not match approved r3 refinement`);
}
const mcDesc = data.keys["standalone.mindelo_cultural.meta.description"];
if (
  mcDesc &&
  mcDesc.pt !==
    "Mindelo Cultural é um recurso gerido de forma independente para descobrir experiências culturais locais, atividades e o que fazer em Mindelo e São Vicente."
) {
  fail(`standalone.mindelo_cultural.meta.description PT does not match approved r3 refinement`);
}
for (const templKey of ["mindelo.map.marker.orientation_accessible_name", "mindelo.map.marker.directory_accessible_name"]) {
  const row = data.keys[templKey];
  if (row && !row.pt.includes("{name}")) fail(`${templKey}: PT value does not preserve the {name} placeholder`);
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
