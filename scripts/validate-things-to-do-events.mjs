import fs from 'node:fs';

const file = new URL('../data/things-to-do-events.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const errors = [];
const ids = new Set();
const routes = new Set();
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

for (const record of data.records ?? []) {
  const label = record.title ?? record.id ?? 'unknown';

  if (!record.id) errors.push(`${label}: missing id`);
  if (ids.has(record.id)) errors.push(`${label}: duplicate id`);
  ids.add(record.id);

  if (record.kind !== 'dated-event') errors.push(`${label}: invalid kind`);
  if (!record.title) errors.push(`${label}: missing title`);
  if (!record.provider) errors.push(`${label}: missing provider`);
  if (!record.source_url) errors.push(`${label}: missing source_url`);
  if (!record.detail_page) errors.push(`${label}: missing detail_page`);

  if (routes.has(record.detail_page)) errors.push(`${label}: duplicate detail route`);
  routes.add(record.detail_page);

  if (!isoDate.test(record.checked_at)) errors.push(`${label}: invalid checked_at`);
  if (record.end_date && !isoDate.test(record.end_date)) errors.push(`${label}: invalid end_date`);
  if (record.start_date && !isoDate.test(record.start_date)) errors.push(`${label}: invalid start_date`);

  if (record.end_date && record.start_date && record.end_date < record.start_date) {
    errors.push(`${label}: end_date before start_date`);
  }

  if (record.publication_state === 'published' && !record.source_url) {
    errors.push(`${label}: published record requires source`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Validated ${data.records.length} dated Things to Do records.`);
