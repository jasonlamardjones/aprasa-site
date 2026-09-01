import fs from 'node:fs';
import { END_PRECISIONS, MONTH_PRECISION, endPrecisionOf, isValidIsoMonth, startMonthOf } from './lib/things-to-do-currentness.mjs';

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
const detailRoutePattern = /^things-to-do\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const allowedPublicationStates = new Set(['draft', 'published', 'expired', 'withdrawn']);
const allowedMediaPolicies = new Set(['required', 'fallback_allowed']);

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
  else if (!detailRoutePattern.test(record.detail_page)) errors.push(`${label}: invalid detail_page; expected things-to-do/<slug>/`);
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

  // End precision. Absent end_precision means "day", so every record written
  // before this field existed keeps exactly the semantics it already had.
  if (record.end_precision !== undefined && !END_PRECISIONS.includes(record.end_precision)) {
    errors.push(`${label}: invalid end_precision "${record.end_precision}" (expected "day" or "month")`);
  } else if (endPrecisionOf(record) === MONTH_PRECISION) {
    // Month precision states the month a record ends in and nothing finer.
    // The exact-day fields must be empty, or the record would be asserting a
    // closing day its source never established.
    // A real calendar month, not merely YYYY-MM shaped: 2026-00, 2026-13,
    // 2026-99 and 9999-99 all match the shape and none of them is a month.
    if (!isValidIsoMonth(record.end_month)) {
      errors.push(`${label}: end_precision "month" requires end_month as a valid calendar month YYYY-MM (01-12)`);
    } else {
      // The end month cannot precede the month the record starts in. The start
      // may be given as start_date OR start_datetime, so read whichever the
      // record validly supplies rather than start_date alone -- a record whose
      // start is expressed only as start_datetime was previously unchecked.
      const startMonth = startMonthOf(record);
      if (startMonth && record.end_month < startMonth) {
        errors.push(`${label}: end_month ${record.end_month} before start month ${startMonth}`);
      }
    }
    if (record.end_date != null) errors.push(`${label}: end_precision "month" requires end_date null`);
    if (record.end_datetime != null) errors.push(`${label}: end_precision "month" requires end_datetime null`);
  } else if (record.end_month !== undefined) {
    errors.push(`${label}: end_month is only valid with end_precision "month"`);
  }

  if (!allowedMediaPolicies.has(record.media_policy)) {
    errors.push(`${label}: missing or invalid media_policy (expected "required" or "fallback_allowed")`);
  }
  const mediaRequired = record.media_policy === 'required';

  let mediaRecord = null;
  if (record.media_manifest_title) {
    if (mediaTitles.has(record.media_manifest_title)) {
      errors.push(`${label}: duplicate media manifest title`);
    }
    mediaTitles.add(record.media_manifest_title);

    const matches = manifest.records.filter((item) => item.section === 'things-to-do' && item.title === record.media_manifest_title);
    if (matches.length !== 1) {
      errors.push(`${label}: expected exactly one matching things-to-do media manifest record, found ${matches.length}`);
    } else {
      mediaRecord = matches[0];
      if (mediaRecord.provider !== record.provider) errors.push(`${label}: provider differs from media manifest`);
      if (record.media?.asset && mediaRecord.media_asset !== record.media.asset) errors.push(`${label}: media asset differs from media manifest`);
    }
  } else {
    errors.push(`${label}: missing media_manifest_title`);
  }

  if (record.media && !record.media.asset) {
    errors.push(`${label}: media record missing asset reference`);
  }

  if (mediaRequired) {
    if (!record.media || !record.media.asset) {
      errors.push(`${label}: media_policy is "required" but canonical media is missing`);
    } else if (mediaRecord) {
      if (mediaRecord.media_state !== 'authentic-present') {
        errors.push(`${label}: media_policy is "required" but media manifest state is "${mediaRecord.media_state}", not authentic-present`);
      }
      if (mediaRecord.media_asset !== record.media.asset) {
        errors.push(`${label}: media_policy is "required" but manifest asset does not match canonical media asset`);
      }
      if (!fs.existsSync(new URL(`../${record.media.asset}`, import.meta.url))) {
        errors.push(`${label}: media_policy is "required" but canonical media asset does not exist: ${record.media.asset}`);
      }
      if ((mediaRecord.media_alt ?? '') !== (record.media.alt ?? '')) {
        errors.push(`${label}: media_policy is "required" but media manifest alt text does not match canonical media alt text`);
      }
      if (typeof mediaRecord.media_width === 'number' && mediaRecord.media_width !== record.media.width) {
        errors.push(`${label}: media_policy is "required" but manifest media_width does not match canonical media width`);
      }
      if (typeof mediaRecord.media_height === 'number' && mediaRecord.media_height !== record.media.height) {
        errors.push(`${label}: media_policy is "required" but manifest media_height does not match canonical media height`);
      }
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Validated ${data.records.length} dated Things to Do records and media-manifest relationships.`);
