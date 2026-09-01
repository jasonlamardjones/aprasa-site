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
const eventDeltaFiles = readdirSync(path.join(ROOT, "data", "locales"))
  .filter((name) => /^pt-overlay-event-[a-z0-9]+(?:-[a-z0-9]+)*\.source\.json$/.test(name))
  .sort();
let eventDeltaRequired = 0;
let eventDeltaUnchanged = 0;

for (const fileName of eventDeltaFiles) {
  const source = JSON.parse(readFileSync(path.join(ROOT, "data", "locales", fileName), "utf8"));
  if (source.project_09_status !== "approved" || source.review_required !== 0 || source.blocking_issue != null) {
    fail(`${fileName}: unresolved Project 09 governance state`);
  }
  if (!Array.isArray(source.rows) || source.supplied_rows_approved !== source.rows.length) {
    fail(`${fileName}: approved row count does not match supplied rows`);
    continue;
  }
  for (const row of source.rows) {
    if (row.scope_status === "REQUIRED_FOR_PT_LAUNCH") eventDeltaRequired += 1;
    else if (row.scope_status === "INTENTIONALLY_UNCHANGED") eventDeltaUnchanged += 1;
    else fail(`${fileName}: ${row.key} has invalid scope_status`);
    if (row.translation_status !== "APPROVED" || !row.pt) fail(`${fileName}: ${row.key} is not fully approved`);
    const generated = data.keys[row.key];
    if (!generated) fail(`${fileName}: ${row.key} missing from generated locale data`);
    else if (generated.en !== row.source_en || generated.pt !== row.pt || generated.source_revision !== row.source_revision) {
      fail(`${fileName}: ${row.key} generated value/provenance differs from approved source`);
    }
  }
}

// --- Overlay contract (counts) — combined r2 base (732) + r3 delta (21) + r4 delta (26)
// + r5 delta (2) + r7 delta (19) + r8 delta (21). The r6 brand-voice delta overrides
// 42 existing PT values and adds no keys, so every count below is unchanged by it. ---
if (keys.length !== 821 + eventDeltaRequired + eventDeltaUnchanged) fail(`expected ${821 + eventDeltaRequired + eventDeltaUnchanged} total keys including approved event deltas, got ${keys.length}`);
const required = keys.filter((k) => k.scope_status === "REQUIRED_FOR_PT_LAUNCH");
const unchanged = keys.filter((k) => k.scope_status === "INTENTIONALLY_UNCHANGED");
if (required.length !== 793 + eventDeltaRequired) fail(`expected ${793 + eventDeltaRequired} REQUIRED_FOR_PT_LAUNCH keys, got ${required.length}`);
if (unchanged.length !== 28 + eventDeltaUnchanged) fail(`expected ${28 + eventDeltaUnchanged} INTENTIONALLY_UNCHANGED keys, got ${unchanged.length}`);
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
if (data.provenance.delta7_revision !== "P03-PT-SOURCE-2026-08-28-r7") {
  fail(`unexpected delta7_revision: ${data.provenance.delta7_revision}`);
}
if (data.provenance.delta7_package_id !== "aprasa-pt-simabo-ways-to-help-r7-delta") {
  fail(`unexpected delta7_package_id: ${data.provenance.delta7_package_id}`);
}
if (data.provenance.delta8_revision !== "P03-PT-SOURCE-2026-08-29-r8") {
  fail(`unexpected delta8_revision: ${data.provenance.delta8_revision}`);
}
if (data.provenance.delta8_package_id !== "aprasa-pt-part-ilhas-artemisa-ferreira-r8-delta") {
  fail(`unexpected delta8_package_id: ${data.provenance.delta8_package_id}`);
}

if (data.provenance.delta9_revision !== "P03-PT-SOURCE-2026-09-01-r9") {
  fail(`unexpected delta9_revision: ${data.provenance.delta9_revision}`);
}
if (data.provenance.delta9_package_id !== "aprasa-pt-sinergia-da-materia-source-correction-r9-delta") {
  fail(`unexpected delta9_package_id: ${data.provenance.delta9_package_id}`);
}
if (data.provenance.delta9_revision_class !== "OVERRIDE_EXISTING_KEYS_WITH_SOURCE_CORRECTION") {
  fail(`unexpected delta9_revision_class: ${data.provenance.delta9_revision_class}`);
}
if (data.provenance.delta9_superseding_ruling !== "P03-SINERGIA-CURRENTNESS-2026-09-01") {
  fail(`unexpected delta9_superseding_ruling: ${data.provenance.delta9_superseding_ruling}`);
}
if (data.provenance.delta9_owning_project !== "Project 03") {
  fail(`unexpected delta9_owning_project: ${data.provenance.delta9_owning_project}`);
}

// --- r9 source correction (Sinergia da Matéria, Project 03, 01 September 2026) ---
// Pins the governed month-level public meaning in both locales, proves the
// superseded July-August meaning is gone from every corrected key, and proves
// no exact November closing day was introduced anywhere in the overlay.
const r9Id = "event.sinergia-da-materia";
const r9Expected = {
  [`${r9Id}.display.status`]: {
    en: "On view until November 2026",
    pt: "Em exibição até novembro de 2026",
  },
  [`${r9Id}.detail.fact.dates.value_display`]: {
    en: "On view until November 2026",
    pt: "Em exibição até novembro de 2026",
  },
  [`${r9Id}.seo.description`]: {
    en: "Sinergia da Matéria: Entre o Bruto e o Traço is an exhibition by Davitson Almeida at CNAD’s Galeria Zero in Mindelo, on view until November 2026.",
    pt: "Sinergia da Matéria: Entre o Bruto e o Traço é uma exposição de Davitson Almeida na Galeria Zero do CNAD, em Mindelo, em exibição até novembro de 2026.",
  },
};
for (const [key, expected] of Object.entries(r9Expected)) {
  const row = data.keys[key];
  if (!row) {
    fail(`r9 corrected key missing from locale data: ${key}`);
    continue;
  }
  if (row.en !== expected.en) fail(`${key} EN is not the approved correction: got ${JSON.stringify(row.en)}`);
  if (row.pt !== expected.pt) fail(`${key} PT is not the approved correction: got ${JSON.stringify(row.pt)}`);
  if (row.source_revision !== "P03-PT-SOURCE-2026-09-01-r9") {
    fail(`${key} does not carry the r9 source revision: got ${row.source_revision}`);
  }
  // Superseded provenance must survive the swap so the prior approved meaning
  // stays auditable.
  const correction = row.source_correction;
  if (!correction) {
    fail(`${key} lost its source-correction provenance`);
    continue;
  }
  if (correction.superseded_source_status !== "SUPERSEDED") fail(`${key} superseded_source_status is not SUPERSEDED`);
  if (correction.owning_project !== "Project 03") fail(`${key} correction owning_project mismatch`);
  if (correction.superseding_ruling !== "P03-SINERGIA-CURRENTNESS-2026-09-01") fail(`${key} correction ruling reference mismatch`);
  if (correction.semantic_change !== true) fail(`${key} correction does not declare semantic_change`);
  if (!correction.superseded_en || !correction.superseded_pt) fail(`${key} correction did not preserve the superseded EN/PT values`);
  for (const [side, text] of [["EN", row.en], ["PT", row.pt]]) {
    if (/31 August 2026|31 de agosto de 2026/.test(text)) {
      fail(`${key} ${side} still carries the superseded 31 August 2026 meaning`);
    }
  }
}

// No governed string anywhere may name an exact day in November 2026 for this
// record: the closing day is not established and must never be inferred.
for (const [key, row] of Object.entries(data.keys)) {
  if (!key.startsWith(`${r9Id}.`)) continue;
  for (const [side, text] of [["EN", row.en ?? ""], ["PT", row.pt ?? ""]]) {
    if (/\b\d{1,2}\s+(de\s+)?(November|novembro)\b/i.test(text) || /\b(November|novembro)\s+\d{1,2}\b/i.test(text)) {
      fail(`${key} ${side} infers an exact November day: ${JSON.stringify(text)}`);
    }
  }
}

// --- Sinergia free admission (additive lane, Project 03 confirmation) ---
const r9Admission = {
  [`${r9Id}.detail.fact.admission.label`]: { en: "Admission", pt: "Admissão" },
  [`${r9Id}.detail.fact.admission.value_display`]: { en: "Free admission", pt: "Entrada livre" },
};
for (const [key, expected] of Object.entries(r9Admission)) {
  const row = data.keys[key];
  if (!row) {
    fail(`Sinergia admission key missing from locale data: ${key}`);
    continue;
  }
  if (row.en !== expected.en) fail(`${key} EN mismatch: got ${JSON.stringify(row.en)}`);
  if (row.pt !== expected.pt) fail(`${key} PT mismatch: got ${JSON.stringify(row.pt)}`);
  // Additive, never routed through the source-correction class.
  if (row.source_correction) fail(`${key} must not carry a source correction — free admission is an additive addition`);
}

// --- r8 delta spot checks (same-day PART_ILHAS / Artemisa Ferreira event) ---
// Pins the governed date/time, the free-admission fact established by the
// Project 03 ruling of 29 August 2026, the official-title identity policy, and
// the event-image alt approved by Project 09 after inspecting the flyer.
const r8Id = "event.part-ilhas-artemisa-ferreira";
const r8Keys = [
  "title", "summary", "display.status", "display.meta", "display.checked",
  "media.alt", "card_action.label", "detail.good_to_know", "detail.body",
  "detail.checked", "detail.action_label", "seo.description", "seo.title",
  "detail.fact.date.label", "detail.fact.date.value_display",
  "detail.fact.guest.label", "detail.fact.guest.value_display",
  "detail.fact.where.label", "detail.fact.where.value_display",
  "detail.fact.admission.label", "detail.fact.admission.value_display",
].map((k) => `${r8Id}.${k}`);
for (const k of r8Keys) {
  if (!data.keys[k]) fail(`r8 key missing from locale data: ${k}`);
}
const r8Spot = {
  [`${r8Id}.display.status`]: "Sábado, 29 de agosto de 2026 · 18:30",
  [`${r8Id}.detail.fact.date.value_display`]: "Sábado, 29 de agosto de 2026 · 18:30",
  [`${r8Id}.detail.fact.guest.label`]: "Convidada",
  [`${r8Id}.detail.fact.guest.value_display`]: "Artemisa Ferreira · Cineasta e poeta",
  [`${r8Id}.detail.fact.admission.label`]: "Admissão",
  [`${r8Id}.detail.fact.admission.value_display`]: "Entrada livre",
  [`${r8Id}.card_action.label`]: "Ver evento",
  [`${r8Id}.detail.action_label`]: "Ver página oficial do evento",
};
for (const [k, expected] of Object.entries(r8Spot)) {
  if (data.keys[k] && data.keys[k].pt !== expected) {
    fail(`${k} PT does not match the approved Project 09 r8 string: got ${JSON.stringify(data.keys[k].pt)}`);
  }
}
// The official event title is identity-preserved verbatim in both locales.
const r8Title = data.keys[`${r8Id}.title`];
if (r8Title) {
  if (r8Title.identity_policy !== "PRESERVE_OFFICIAL_EVENT_TITLE") {
    fail(`${r8Id}.title must carry identity_policy PRESERVE_OFFICIAL_EVENT_TITLE`);
  }
  if (r8Title.en !== r8Title.pt) {
    fail(`${r8Id}.title must be preserved verbatim across locales`);
  }
}
// The 18:30 start time is factual and must survive verbatim in both locales.
for (const k of [`${r8Id}.display.status`, `${r8Id}.detail.fact.date.value_display`]) {
  const row = data.keys[k];
  if (row && !(row.en.includes("18:30") && row.pt.includes("18:30"))) {
    fail(`${k} does not carry the approved 18:30 start time in both locales`);
  }
}
// Project 03 ruled admission free on 29 August 2026; the PT alt is authorized
// to carry "Entrada Livre". No r8 string may introduce a ticket price, a
// registration requirement, or an eligibility restriction.
for (const k of r8Keys) {
  const row = data.keys[k];
  if (!row) continue;
  for (const text of [row.en, row.pt]) {
    if (text && /\b(ticket|bilhete|inscri[cç][aã]o obrigat|registration required|reserva obrigat|\d+\s?(CVE|EUR|€))\b/i.test(text)) {
      fail(`r8 key "${k}" introduces ticketing, registration or eligibility language that is not in the approved packet`);
    }
  }
}

// --- r7 delta spot checks (single Simabo Organizations & Ways to Help record) ---
// Pins the record's governed strings, both hours values in both locales, and two
// structural guards: clinical support stays a single contextual list item, and
// donation support stays informational (contact only, never a payment flow).
const r7Keys = [
  "ui.ways_to_help",
  "ui.current_volunteer_hours",
  "ui.contact",
  "home.help.simabo.contact_action",
  "home.help.simabo.checked",
  "home.help.simabo.detail_checked",
  "home.help.simabo.leaflet_alt",
  "home.help.simabo.hours.dog_walking_label",
  "home.help.simabo.hours.dog_walking_value",
  "home.help.simabo.hours.cats_label",
  "home.help.simabo.hours.cats_value",
  "home.help.record.simabo.intro",
  "home.help.record.simabo.ways_intro",
  "home.help.record.simabo.way_dogs",
  "home.help.record.simabo.way_cats",
  "home.help.record.simabo.way_skills",
  "home.help.record.simabo.way_clinical",
  "home.help.record.simabo.way_donation",
  "home.help.record.simabo.closing",
];
for (const k of r7Keys) {
  if (!data.keys[k]) fail(`r7 key missing from locale data: ${k}`);
}
const r7Spot = {
  "ui.ways_to_help": "Formas de ajudar",
  "ui.current_volunteer_hours": "Horário atual de voluntariado",
  "ui.contact": "Contacto",
  "home.help.simabo.contact_action": "Contactar a Simabo",
  "home.help.simabo.hours.dog_walking_label": "Passear cães",
  "home.help.simabo.hours.dog_walking_value": "07:00–13:00 ou 13:00–18:30",
  "home.help.simabo.hours.cats_label": "Ajudar com os gatos",
  "home.help.simabo.hours.cats_value": "09:00–18:00",
};
for (const [k, expected] of Object.entries(r7Spot)) {
  if (data.keys[k] && data.keys[k].pt !== expected) {
    fail(`${k} PT does not match the approved Project 09 r7 string: got ${JSON.stringify(data.keys[k].pt)}`);
  }
}
// Approved Simabo hours are factual and must survive verbatim in BOTH locales.
const r7HoursEn = {
  "home.help.simabo.hours.dog_walking_value": "07:00–13:00 or 13:00–18:30",
  "home.help.simabo.hours.cats_value": "09:00–18:00",
};
for (const [k, expected] of Object.entries(r7HoursEn)) {
  if (data.keys[k] && data.keys[k].en !== expected) {
    fail(`${k} EN does not match the approved Simabo hours: got ${JSON.stringify(data.keys[k].en)}`);
  }
}
// Clinical/veterinary support is one contextual item inside the single Simabo
// record. No other r7 key may carry it — that is what keeps a standalone
// veterinary/clinic record from reappearing through the overlay.
for (const k of r7Keys) {
  const row = data.keys[k];
  if (!row || k === "home.help.record.simabo.way_clinical") continue;
  for (const text of [row.en, row.pt]) {
    if (text && /veterinar|veterinár|nurse|enfermeir|clinical work|trabalho clínico/i.test(text)) {
      fail(`r7 key "${k}" carries clinical/veterinary language outside the single approved list item`);
    }
  }
}
// Donation support is informational only: it routes to the public contact
// address. No r7 string may introduce payment/donation-flow language.
for (const k of r7Keys) {
  const row = data.keys[k];
  if (!row) continue;
  for (const text of [row.en, row.pt]) {
    if (text && /\b(donate now|give now|pay|payment|iban|paypal|mbway|nib|bank transfer|transferência bancária|pagamento)\b/i.test(text)) {
      fail(`r7 key "${k}" introduces donation-payment language; donation support must stay informational`);
    }
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
  // Migrated to the canonical training.record.* namespace by the r9
  // RENAME_KEYS package (Project 09 atomic namespace migration). The r3 delta
  // still owns these two rows; only the key name moved, the approved EN/PT
  // values are unchanged and are asserted byte-for-byte by build-locale-data.mjs.
  "training.record.openlearn.card_action",
  "training.record.iefp-pepe.card_action",
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
