import fs from 'node:fs';
import path from 'node:path';
import { hubCanonical, hubOutputPath } from './lib/things-to-do-collection.mjs';

const root = process.cwd();
const data = JSON.parse(fs.readFileSync(path.join(root, 'data', 'things-to-do-events.json'), 'utf8'));
const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
const errors = [];

for (const record of data.records ?? []) {
  const expected = `https://aprasa.org/${record.detail_page}`;
  if (!sitemap.includes(`<loc>${expected}</loc>`)) {
    errors.push(`${record.id}: sitemap missing ${expected}`);
  }
}

// The collection hub is a canonical crawlable surface in its own right, one
// per locale. A locale's hub is required in the sitemap exactly when that
// locale's hub file exists, matching how scripts/build-sitemap.mjs emits PT
// routes only for pages that have actually been generated.
let hubRoutes = 0;
for (const locale of ['en', 'pt']) {
  if (!fs.existsSync(path.join(root, hubOutputPath(locale)))) continue;
  hubRoutes += 1;
  const expected = hubCanonical(locale);
  if (!sitemap.includes(`<loc>${expected}</loc>`)) {
    errors.push(`things-to-do hub (${locale}): sitemap missing ${expected}`);
  }
}

if (errors.length) {
  console.error('Things to Do sitemap errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Sitemap validation passed for ${data.records.length} canonical dated-event routes and ${hubRoutes} collection-hub route(s).`);
