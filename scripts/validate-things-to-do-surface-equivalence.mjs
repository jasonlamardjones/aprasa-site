import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dataPath = path.join(root, 'data', 'things-to-do-events.json');
const indexPath = path.join(root, 'index.html');

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const errors = [];

for (const record of data.records ?? []) {
  const label = `${record.id} :: ${record.title}`;
  const detailFile = path.join(root, record.detail_page, 'index.html');

  if (!indexHtml.includes(`<h3>${record.title}</h3>`)) {
    errors.push(`${label}: title missing from Home Things to Do markup`);
  }

  if (!indexHtml.includes(`href="${record.detail_page}"`)) {
    errors.push(`${label}: detail route missing from Home markup`);
  }

  if (record.card_action?.url && !indexHtml.includes(record.card_action.url)) {
    errors.push(`${label}: Home action URL missing from Home markup`);
  }

  if (record.media?.asset && !indexHtml.includes(record.media.asset)) {
    errors.push(`${label}: media asset missing from Home markup`);
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
}

if (errors.length) {
  console.error('Things to Do surface equivalence errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Surface equivalence passed for ${data.records.length} canonical dated-event records.`);
