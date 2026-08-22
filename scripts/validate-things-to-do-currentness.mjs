import fs from 'node:fs';

const input = new URL('../data/things-to-do-events.json', import.meta.url);
const records = JSON.parse(fs.readFileSync(input, 'utf8')).records;

const asOfArg = process.argv.find((arg) => arg.startsWith('--as-of='));
const asOf = asOfArg ? asOfArg.split('=')[1] : new Date().toISOString().slice(0, 10);

const errors = [];

for (const record of records) {
  if (record.kind !== 'dated-event') continue;

  const expired = Boolean(record.end_date && record.end_date < asOf);

  if (expired && record.publication_state === 'published') {
    if (!['expired', 'withdrawn'].includes(record.publication_state)) {
      errors.push(`${record.id}: expired event remains published as of ${asOf}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Currentness validation passed for ${records.length} records as of ${asOf}.`);
