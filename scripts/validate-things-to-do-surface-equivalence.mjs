import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dataPath = path.join(root, 'data', 'things-to-do-events.json');
const indexPath = path.join(root, 'index.html');
const asOfArg = process.argv.find((arg) => arg.startsWith('--as-of='));
const asOf = asOfArg ? asOfArg.split('=')[1] : new Date().toISOString().slice(0, 10);

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const errors = [];

for (const record of data.records ?? []) {
  const label = `${record.id} :: ${record.title}`;
  const detailFile = path.join(root, record.detail_page, 'index.html');
  const expired = Boolean(record.end_date && record.end_date < asOf);
  const onHome = indexHtml.includes(`<h3>${record.title}</h3>`);

  if (!expired && !onHome) {
    errors.push(`${label}: current record missing from Home Things to Do markup`);
  }

  if (expired && onHome) {
    errors.push(`${label}: expired record remains on Home as of ${asOf}`);
  }

  if (!expired && !indexHtml.includes(`href="${record.detail_page}"`)) {
    errors.push(`${label}: current detail route missing from Home markup`);
  }

  if (!expired && record.card_action?.url && !indexHtml.includes(record.card_action.url)) {
    errors.push(`${label}: current Home action URL missing from Home markup`);
  }

  if (!expired && record.media?.asset && !indexHtml.includes(record.media.asset)) {
    errors.push(`${label}: current media asset missing from Home markup`);
  }

  if (!fs.existsSync(detailFile)) {
    errors.push(`${label}: detail page does not exist at ${record.detail_page}`);
    continue;
  }

  const detailHtml = fs.readFileSync(detailFile, 'utf8');
  if (!detailHtml.includes(`<h1>${record.title}</h1>`)) {
    errors.push(`${label}: title missing from detail page`);
  }
  if (!detailHtml.includes(record.provider)) {
    errors.push(`${label}: provider missing from detail page`);
  }
  if (record.card_action?.url && !detailHtml.includes(record.card_action.url)) {
    errors.push(`${label}: action URL missing from detail page`);
  }
  if (record.media?.asset) {
    const relativeMedia = `../../${record.media.asset}`;
    if (!detailHtml.includes(relativeMedia)) {
      errors.push(`${label}: media asset missing from detail page`);
    }
  }

  if (expired && detailHtml.includes('EventScheduled') && detailHtml.includes('Generated from data/things-to-do-events.json')) {
    errors.push(`${label}: generated expired detail page still reports EventScheduled`);
  }
}

if (errors.length) {
  console.error(`Things to Do surface equivalence errors as of ${asOf}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Surface equivalence passed for ${data.records.length} canonical dated-event records as of ${asOf}.`);
