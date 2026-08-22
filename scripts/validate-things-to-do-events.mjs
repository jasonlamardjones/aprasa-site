import fs from 'node:fs';

const file = new URL('../data/things-to-do-events.json', import.meta.url);
const manifestFile = new URL('../internal/provider-media-manifest.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

const errors = [];
const ids = new Set();
const routes = new Set();
const mediaTitles = new Set();
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const isoDateTime = /^\d{4}-\d{2}-\d{2}T/;
const allowedPublicationStates = new Set(['draft', 'published', 'expired', 'withdrawn']);

for (const record of data.records ?? []) {
  const label = record.title ?? record.id ?? 'unknown';

  if (!record.id) errors.push(`${label}: missing id`);
  if (ids.has(record.id)) errors.push(`${label}: duplicate id`);
  ids.add(record.id);

  if (record.kind !== 'dated-event') errors.push(`${label}: invalid kind`);
  if (!record.title) errors.push(`${label}: missing title`);
  if (!record.provider) errors.push(`${label}: missing provider`);
  if (!record.source_url) errors.push(`${label}: missing source_url`);
  if (!record.source_type) errors.push(`${label}: missing source_type`);
  if (!record.detail_page) errors.push(`${label}: missing detail_page`);
  if (!allowedPublicationStates.has(record.publication_state)) errors.push(`${label}: invalid publication_state`);

  if (routes.has(record.detail_page)) errors.push(`${label}: duplicate detail route`);
  routes.add(record.detail_page);

  if (!isoDate.test(record.checked_at)) errors.push(`${label}: invalid checked_at`);
  if (record.start_date && !isoDate.test(record.start_date)) errors.push(`${label}: invalid start_date`);
  if (record.end_date && !isoDate.test(record.end_date)) errors.push(`${label}: invalid end_date`);
  if (record.start_datetime && !isoDateTime.test(record.start_datetime)) errors.push(`${label}: invalid start_datetime`);
  if (record.end_datetime && !isoDateTime.test(record.end_datetime)) errors.push(`${label}: invalid end_datetime`);

  if (record.end_date && record.start_date && record.end_date < record.start_date) {
    errors.push(`${label}: end_date before start_date`);
  }

  if (record.media_manifest_title) {
    if (mediaTitles.has(record.media_manifest_title)) {
      errors.push(`${label}: duplicate media manifest title`);
    }
    mediaTitles.add(record.media_manifest_title);

    const matches = manifest.records.filter((item) => item.section === 'things-to-do' && item.title === record.media_manifest_title);
    if (matches.length !== 1) {
      errors.push(`${label}: expected exactly one matching things-to-do media manifest record, found ${matches.length}`);
    } else {
      const mediaRecord = matches[0];
      if (mediaRecord.provider !== record.provider) errors.push(`${label}: provider differs from media manifest`);
      if (record.media?.asset && mediaRecord.media_asset !== record.media.asset) errors.push(`${label}: media asset differs from media manifest`);
    }
  } else {
    errors.push(`${label}: missing media_manifest_title`);
  }

  if (record.media && !record.media.asset) {
    errors.push(`${label}: media record missing asset reference`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Validated ${data.records.length} dated Things to Do records and media-manifest relationships.`);
