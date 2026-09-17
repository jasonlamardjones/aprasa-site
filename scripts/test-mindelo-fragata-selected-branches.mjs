#!/usr/bin/env node
// Regression coverage for "Mindelo Essentials — Fragata Selected Branches"
// (Project 04 task order, 17 September 2026): exactly two Fragata branch
// records (Central, Monte Sossego) are published, with the Project 26-cleared
// coordinates carried exactly, and the three excluded branches (Dom Luís, Chã
// de Alecrim, Praça Nova) stay unpublished with no provider-level Fragata pin
// on the map. Runs with no dependencies.
//
// Usage: node scripts/test-mindelo-fragata-selected-branches.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
}

const directory = readJson('mindelo-essentials/data/mindelo-essentials.json');
const geojson = readJson('mindelo-essentials/data/mindelo-essentials.geojson');
const enHtml = read('mindelo-essentials/index.html');
const ptHtml = read('pt/mindelo-essentials/index.html');
const locale = readJson('data/locales/locale-data.generated.json');

const EXPECTED = {
  'SV-MIN-MKT-003': {
    name: 'Fragata — Central',
    location: 'Avenida 5 de Julho, Mindelo',
    lat: 16.8876964,
    lon: -24.9884169,
  },
  'SV-MIN-MKT-004': {
    name: 'Fragata — Monte Sossego',
    location: 'Rua Academia de Música Jotamont, Monte Sossego, Mindelo',
    lat: 16.87799,
    lon: -24.98805,
  },
};
const APPROVED_DESCRIPTION_EN = 'Fragata is a local supermarket network. The provider advertises customer support and scheduled delivery; check directly with Fragata for current availability and coverage.';
const APPROVED_DESCRIPTION_PT = 'A Fragata é uma rede local de supermercados. O prestador anuncia apoio ao cliente e entregas programadas; confirme diretamente com a Fragata a disponibilidade atual e a área de cobertura.';

console.log('[1] exactly two selected Fragata branch records are published, independently represented');
const publishedFragata = directory.records.filter((r) => r.provider === 'Fragata' && r.publication_status === 'published');
check('exactly two published Fragata records', publishedFragata.length === 2, `got ${publishedFragata.length}`);
const publishedFragataIds = new Set(publishedFragata.map((r) => r.id));
for (const id of Object.keys(EXPECTED)) {
  check(`${id} is published`, publishedFragataIds.has(id));
}
check('the two published Fragata records are distinct (no duplication)', publishedFragataIds.size === 2);

for (const [id, expected] of Object.entries(EXPECTED)) {
  const record = directory.records.find((r) => r.id === id);
  console.log(`[2] ${id} canonical directory fields`);
  check(`${id} exists`, !!record);
  if (!record) continue;
  check(`${id} name`, record.name === expected.name, `got ${JSON.stringify(record.name)}`);
  check(`${id} category`, record.category === 'Groceries & Everyday Shopping');
  check(`${id} provider is the bare provider identity "Fragata"`, record.provider === 'Fragata');
  check(`${id} context (EN type) is "Supermarket"`, record.context === 'Supermarket');
  check(`${id} location is exact`, record.location === expected.location, `got ${JSON.stringify(record.location)}`);
  check(`${id} lat is exact`, record.lat === expected.lat, `got ${record.lat}`);
  check(`${id} lon is exact`, record.lon === expected.lon, `got ${record.lon}`);
  check(`${id} map_status is map-ready (cleared, building/site precision)`, record.map_status === 'map-ready');
  check(`${id} checked matches checked_at 2026-09-17`, record.checked === '17 September 2026');
  check(`${id} description is the approved EN text, unaltered`, record.description === APPROVED_DESCRIPTION_EN);
  check(`${id} publication_status is published`, record.publication_status === 'published');
  check(`${id} directions link encodes the exact cleared coordinates`, record.directions === `https://www.google.com/maps/search/?api=1&query=${expected.lat},${expected.lon}`);
}

console.log('[3] excluded Fragata branches remain unpublished, evidence untouched');
const removedPracaNova = directory.records.find((r) => r.id === 'SV-MIN-MKT-002');
check('Fragata — Praça Nova (SV-MIN-MKT-002) still exists as governed history', !!removedPracaNova);
check('Fragata — Praça Nova is not published', removedPracaNova?.publication_status === 'removed');
check('Fragata — Praça Nova was not marked expired/withdrawn/unavailable', removedPracaNova?.publication_status === 'removed');
const excludedNames = ['Fragata — Dom Luís', 'Fragata — Chã de Alecrim', 'Fragata — Praça Nova'];
const publishedNames = new Set(directory.records.filter((r) => r.publication_status === 'published').map((r) => r.name));
for (const name of excludedNames) {
  check(`"${name}" is not published`, !publishedNames.has(name));
}
check('no Fragata — Dom Luís record exists at all', !directory.records.some((r) => r.name === 'Fragata — Dom Luís'));
check('no Fragata — Chã de Alecrim record exists at all', !directory.records.some((r) => r.name === 'Fragata — Chã de Alecrim'));

console.log('[4] map derives exactly the two selected pins, no provider-level pin');
for (const [id, expected] of Object.entries(EXPECTED)) {
  const feature = geojson.features.find((f) => f.id === id);
  check(`${id} has a geojson feature`, !!feature);
  if (!feature) continue;
  check(`${id} geojson coordinates are [lon, lat] exact`, feature.geometry.coordinates[0] === expected.lon && feature.geometry.coordinates[1] === expected.lat);
  check(`${id} geojson name matches`, feature.properties.name === expected.name);
}
const fragataFeatures = geojson.features.filter((f) => (f.properties.name || '').startsWith('Fragata'));
check('geojson carries exactly the two selected Fragata pins, no generic/provider-level pin', fragataFeatures.length === 2, `got ${fragataFeatures.map((f) => f.id).join(', ')}`);
check('no Fragata — Praça Nova pin on the map', !geojson.features.some((f) => f.properties.name === 'Fragata — Praça Nova'));
check('no bare "Fragata" provider-level pin on the map', !geojson.features.some((f) => f.properties.name === 'Fragata'));

console.log('[5] EN directory page exposes both records with the approved copy');
for (const id of Object.keys(EXPECTED)) {
  check(`${id} EN record block present`, enHtml.includes(`data-record-id="${id}"`));
}
check('EN page carries the approved description text verbatim', enHtml.includes(APPROVED_DESCRIPTION_EN));
check('Groceries & Everyday Shopping EN category count reflects the two additions (2 -> 4)', /Groceries &amp; Everyday Shopping<\/span><span class="category-count">4<\/span>/.test(enHtml));

console.log('[6] PT directory page exposes both records with the governed translation, unretranslated');
for (const id of Object.keys(EXPECTED)) {
  check(`${id} PT record block present`, ptHtml.includes(`data-record-id="${id}"`));
}
check('PT page carries the approved description translation verbatim', ptHtml.includes(APPROVED_DESCRIPTION_PT));
check('PT page never fell back to untranslated English description text', !ptHtml.includes(APPROVED_DESCRIPTION_EN));

console.log('[7] governed locale keys carry the exact approved EN/PT pairs, required for PT launch');
for (const id of Object.keys(EXPECTED)) {
  const typeLabel = locale.keys[`record.${id}.type_label`];
  check(`record.${id}.type_label exists and is approved`, typeLabel?.translation_status === 'APPROVED');
  check(`record.${id}.type_label EN is "Supermarket"`, typeLabel?.en === 'Supermarket');
  check(`record.${id}.type_label PT is "Supermercado"`, typeLabel?.pt === 'Supermercado');
  const description = locale.keys[`record.${id}.description`];
  check(`record.${id}.description EN matches the approved text`, description?.en === APPROVED_DESCRIPTION_EN);
  check(`record.${id}.description PT matches the approved text`, description?.pt === APPROVED_DESCRIPTION_PT);
  check(`record.${id}.description is REQUIRED_FOR_PT_LAUNCH`, description?.scope_status === 'REQUIRED_FOR_PT_LAUNCH');
}

console.log(`\n[test-mindelo-fragata-selected-branches] ${checks - failures}/${checks} checks passed.`);
if (failures) {
  console.error(`[test-mindelo-fragata-selected-branches] FAILED with ${failures} failing check(s).`);
  process.exit(1);
}
