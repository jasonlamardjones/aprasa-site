import fs from 'node:fs';

const input = new URL('../data/things-to-do-events.json', import.meta.url);
const records = JSON.parse(fs.readFileSync(input, 'utf8')).records;

const asOfArg = process.argv.find((arg) => arg.startsWith('--as-of='));
const asOf = asOfArg ? asOfArg.split('=')[1] : new Date().toISOString().slice(0, 10);

const current = records.filter((record) => !record.end_date || record.end_date >= asOf);
const expired = records.filter((record) => record.end_date && record.end_date < asOf);

console.log(JSON.stringify({
  asOf,
  total: records.length,
  current: current.map(({ id, title, detail_page }) => ({ id, title, detail_page })),
  expired: expired.map(({ id, title, detail_page, end_date }) => ({ id, title, detail_page, end_date }))
}, null, 2));
