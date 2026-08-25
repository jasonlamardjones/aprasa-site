#!/usr/bin/env node
// Regenerates sitemap.xml: keeps every existing EN route, and adds a PT
// route for each PT page that has actually been generated on disk (never
// for a page still blocked by the no-silent-fallback contract — a sitemap
// entry with no real page would be a broken/soft-404 URL).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const SITEMAP_PATH = path.join(root, 'sitemap.xml');

const EN_ROUTES = [
  '/',
  '/mindelo-essentials/',
  '/about/',
  '/things-to-do/mon-pikenin/',
  '/things-to-do/part-ilhas-nuno-miranda/',
  '/things-to-do/arquitectura-da-imperfeicao/',
  '/things-to-do/water-adventure-activities-mindelo/',
  '/things-to-do/sinergia-da-materia/',
  '/things-to-do/eclipse-yuran-henrique/',
  '/things-to-do/oficina-contemporanea-lata/',
  '/things-to-do/street-art-mindelo/',
];

function ptRouteExists(enRoute) {
  const ptDir = path.join(root, 'pt', enRoute.replace(/^\//, ''));
  return fs.existsSync(path.join(ptDir, 'index.html'));
}

const ptRoutes = EN_ROUTES.filter(ptRouteExists).map((r) => `/pt${r === '/' ? '/' : r}`);

const urls = [...EN_ROUTES, ...ptRoutes].map((r) => `  <url>\n    <loc>https://aprasa.org${r}</loc>\n  </url>`).join('\n');
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

if (write) {
  fs.writeFileSync(SITEMAP_PATH, xml);
  console.log(`[build-sitemap] wrote sitemap.xml — ${EN_ROUTES.length} EN routes, ${ptRoutes.length} PT routes (${EN_ROUTES.length - ptRoutes.length} PT route(s) not yet generated, excluded).`);
} else {
  console.log(xml);
}
