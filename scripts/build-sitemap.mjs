#!/usr/bin/env node
// Regenerates sitemap.xml. Static routes remain explicit, while dated
// Things-to-Do detail routes are derived from the canonical event data so a
// newly approved dated event never requires a separate manual sitemap edit.
// PT routes are emitted only when the corresponding PT page exists on disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const SITEMAP_PATH = path.join(root, 'sitemap.xml');
const EVENTS_PATH = path.join(root, 'data', 'things-to-do-events.json');

const STATIC_EN_ROUTES = [
  '/',
  '/mindelo-essentials/',
  '/about/',
  '/things-to-do/water-adventure-activities-mindelo/',
  '/things-to-do/street-art-mindelo/',
];

const events = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
const detailRoutePattern = /^things-to-do\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const datedEventRoutes = [];
const seen = new Set(STATIC_EN_ROUTES);

for (const record of events.records ?? []) {
  if (record.kind !== 'dated-event') continue;
  if (typeof record.detail_page !== 'string' || !detailRoutePattern.test(record.detail_page)) {
    throw new Error(`${record.id ?? record.title ?? 'unknown'}: invalid dated-event detail_page`);
  }
  const route = `/${record.detail_page}`;
  if (seen.has(route)) {
    throw new Error(`${record.id ?? record.title ?? 'unknown'}: duplicate sitemap route ${route}`);
  }
  seen.add(route);
  datedEventRoutes.push(route);
}

const EN_ROUTES = [...STATIC_EN_ROUTES, ...datedEventRoutes];

function ptRouteExists(enRoute) {
  const ptDir = path.join(root, 'pt', enRoute.replace(/^\//, ''));
  return fs.existsSync(path.join(ptDir, 'index.html'));
}

const ptRoutes = EN_ROUTES.filter(ptRouteExists).map((r) => `/pt${r === '/' ? '/' : r}`);
const urls = [...EN_ROUTES, ...ptRoutes]
  .map((r) => `  <url>\n    <loc>https://aprasa.org${r}</loc>\n  </url>`)
  .join('\n');
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

if (write) {
  fs.writeFileSync(SITEMAP_PATH, xml);
  console.log(`[build-sitemap] wrote sitemap.xml — ${EN_ROUTES.length} EN routes (${datedEventRoutes.length} canonical dated-event routes), ${ptRoutes.length} PT routes (${EN_ROUTES.length - ptRoutes.length} PT route(s) not yet generated, excluded).`);
} else {
  console.log(xml);
}
