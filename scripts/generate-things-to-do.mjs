import fs from 'node:fs';

const input = new URL('../data/things-to-do-events.json', import.meta.url);
const records = JSON.parse(fs.readFileSync(input, 'utf8')).records;

const asOfArg = process.argv.find((arg) => arg.startsWith('--as-of='));
const asOf = asOfArg ? asOfArg.split('=')[1] : new Date().toISOString().slice(0, 10);

const current = records.filter((record) => {
  if (!record.end_date) return true;
  return record.end_date >= asOf;
});

console.log(`As of ${asOf}: ${current.length}/${records.length} dated Things to Do records are current.`);
for (const record of current) {
  console.log(`- ${record.id}: ${record.title}`);
}

// Phase 1 scaffold: rendering adapters will replace hand-authored duplicated surfaces
// after validation of generated output against the incumbent static markup.
