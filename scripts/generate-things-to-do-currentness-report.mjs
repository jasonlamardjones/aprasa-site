import fs from 'node:fs';

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

function isExpiredRecord(record) {
  return record.publication_state === 'expired' || Boolean(record.end_date && record.end_date < asOf);
}

const current = records.filter((record) => !isExpiredRecord(record));
const expired = records.filter(isExpiredRecord);

console.log(JSON.stringify({
  asOf,
  total: records.length,
  current: current.map(({ id, title, detail_page }) => ({ id, title, detail_page })),
  expired: expired.map(({ id, title, detail_page, end_date }) => ({ id, title, detail_page, end_date }))
}, null, 2));
