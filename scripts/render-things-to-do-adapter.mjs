import fs from 'node:fs';
import { isPubliclyCurrent } from './lib/things-to-do-currentness.mjs';

const input = new URL('../data/things-to-do-events.json', import.meta.url);
const records = JSON.parse(fs.readFileSync(input, 'utf8')).records;

const asOfArg = process.argv.find((arg) => arg.startsWith('--as-of='));
if (!asOfArg) {
  console.error('Missing required --as-of=YYYY-MM-DD');
  process.exit(1);
}
const asOf = asOfArg.split('=')[1];
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error(`Invalid --as-of date: ${asOf}`);
  process.exit(1);
}

// CURRENT and REVIEW_DUE are both publicly current; only EXPIRED is not.
function isCurrent(record) {
  return isPubliclyCurrent(record, asOf);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const currentRecords = records.filter(isCurrent);

const fragments = currentRecords.map((record) => ({
  id: record.id,
  route: record.detail_page,
  title: record.title,
  html: `<article data-event-id="${escapeHtml(record.id)}"><h3>${escapeHtml(record.title)}</h3><p>${escapeHtml(record.display?.status ?? '')}</p></article>`
}));

console.log(JSON.stringify({
  asOf,
  generated: fragments.length,
  records: fragments
}, null, 2));

// Diagnostic adapter only: reports deterministic current fragments without mutating files.
