import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(root, 'internal', 'provider-media-manifest.json');
const htmlPath = path.join(root, 'index.html');
const eventsPath = path.join(root, 'data', 'things-to-do-events.json');
const currentnessPath = path.join(root, 'data', 'things-to-do-currentness.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const html = fs.readFileSync(htmlPath, 'utf8');
const eventRecords = JSON.parse(fs.readFileSync(eventsPath, 'utf8')).records ?? [];
const currentness = JSON.parse(fs.readFileSync(currentnessPath, 'utf8'));
const asOf = currentness.as_of;

const allowedTypes = new Set(['provider-supplied', 'provider-owned', 'editorial-fallback']);
const allowedStates = new Set(['authentic-present', 'authentic-available-needs-ingestion', 'fallback-temporary', 'fallback-final']);

const errors = [];
const warnings = [];
const escapeHtml = (value) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
const isIsoDate = (value) => {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);

  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

if (!isIsoDate(asOf)) {
  errors.push(`things-to-do currentness: invalid as_of date ${asOf}`);
}

const canonicalEventByManifestTitle = new Map(
  eventRecords.map((record) => [record.media_manifest_title, record])
);

for (const record of manifest.records) {
  const label = `${record.section} :: ${record.title}`;
  const appearsOnHome = html.includes(`<h3>${escapeHtml(record.title)}</h3>`);
  const canonicalEvent = record.section === 'things-to-do'
    ? canonicalEventByManifestTitle.get(record.title)
    : null;
  const isExpiredDatedEvent = Boolean(
    canonicalEvent
    && canonicalEvent.kind === 'dated-event'
    && canonicalEvent.end_date
    && canonicalEvent.end_date < asOf
  );

  if (!appearsOnHome && !isExpiredDatedEvent) {
    errors.push(`${label}: card title not found in index.html`);
  }
  if (!record.source_url) errors.push(`${label}: missing source_url`);
  if (!allowedTypes.has(record.media_type)) errors.push(`${label}: invalid media_type ${record.media_type}`);
  if (!allowedStates.has(record.media_state)) errors.push(`${label}: invalid media_state ${record.media_state}`);

  if (record.media_state === 'authentic-present') {
    if (!record.media_asset) errors.push(`${label}: authentic-present requires media_asset`);
    if (record.media_asset && !fs.existsSync(path.join(root, record.media_asset))) {
      errors.push(`${label}: media_asset does not exist: ${record.media_asset}`);
    }
    if (!hasText(record.media_provenance)) errors.push(`${label}: authentic-present requires media_provenance`);
    if (!isIsoDate(record.media_checked_date)) errors.push(`${label}: authentic-present requires a valid calendar date in YYYY-MM-DD format`);
    if (!hasText(record.media_alt)) errors.push(`${label}: authentic-present requires informative media_alt`);
  }

  if (record.media_type === 'provider-owned' || record.media_type === 'provider-supplied') {
    if (!record.media_source) errors.push(`${label}: authentic media requires media_source provenance`);
  }

  if (record.media_type === 'editorial-fallback') {
    if (!record.fallback_category) errors.push(`${label}: fallback requires fallback_category`);
    if (!record.fallback_reason) errors.push(`${label}: fallback requires fallback_reason`);
  }

  if (record.media_state === 'authentic-available-needs-ingestion' || record.media_state === 'fallback-temporary') {
    warnings.push(`${label}: media is not editorially complete (${record.media_state})`);
  }
}

const expectedSections = new Set(manifest.scope);
for (const section of expectedSections) {
  if (!manifest.records.some((record) => record.section === section)) errors.push(`${section}: no manifest records`);
}

console.log(`Media manifest: ${manifest.records.length} records`);
if (warnings.length) {
  console.log('\nOutstanding media work:');
  for (const warning of warnings) console.log(`- ${warning}`);
}

if (errors.length) {
  console.error('\nValidation errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('\nStructural media validation passed.');
if (warnings.length) {
  console.log('Publication gate remains OPEN: unresolved media records are listed above.');
  process.exitCode = 2;
} else {
  console.log('Publication media gate PASSED: no temporary or pending-ingestion records remain.');
}
