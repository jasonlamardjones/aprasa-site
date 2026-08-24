import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const input = path.join(root, 'data', 'things-to-do-events.json');
const indexPath = path.join(root, 'index.html');
const records = JSON.parse(fs.readFileSync(input, 'utf8')).records;
const indexHtml = fs.readFileSync(indexPath, 'utf8');

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

const errors = [];

for (const record of records) {
  if (record.kind !== 'dated-event') continue;

  const expiredByState = record.publication_state === 'expired';
  const expiredByDate = Boolean(record.end_date && record.end_date < asOf);
  if (!expiredByState && !expiredByDate) continue;

  const appearsOnHome = indexHtml.includes(`<h3>${record.title}</h3>`);

  if (appearsOnHome) {
    const reason = expiredByDate ? `expired ${record.end_date}` : 'publication_state "expired"';
    errors.push(`${record.id}: ${reason} but still appears in Home current Things to Do markup as of ${asOf}`);
  }
}

if (errors.length) {
  console.error('Things to Do currentness errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Currentness validation passed as of ${asOf}.`);
