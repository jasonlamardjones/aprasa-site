import fs from 'node:fs';
import path from 'node:path';

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

if (errors.length) {
  console.error('Things to Do sitemap errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Sitemap validation passed for ${data.records.length} canonical dated-event routes.`);
