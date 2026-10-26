#!/usr/bin/env node
// Read-only synthetic parity checks. No generator, record, or Home mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareThingsToDoCurrentness as compare } from './lib/things-to-do-currentness-adapter.mjs';

let assertions = 0;
const eq = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label);
  assertions += 1;
};
const throws = (fn, pattern) => {
  assert.throws(fn, pattern);
  assertions += 1;
};
const record = (overrides = {}) => ({ kind: 'dated-event', publication_state: 'published', ...overrides });

// Inclusive Cape Verde day, using the same calendar-day contract as incumbent.
const dated = record({ start_date: '2026-10-28', end_date: '2026-10-29' });
eq(compare(dated, '2026-10-29').temporalState, 'current', 'inclusive last day');
const expired = compare(dated, '2026-10-30');
eq([expired.temporalState, expired.incumbentState, expired.comparison],
  ['expired', 'expired', 'match'], 'next-day parity');
eq(expired.evaluation.activityExpiryInstant, '2026-10-30T01:00:00.000Z', 'CV midnight expiry');
eq(expired.normalizedInput.applicationDeadline, null, 'application closure not invented');

// Month means source review, never fabricated end-day expiry.
const month = record({ start_date: '2026-10-01', end_date: null, end_precision: 'month', end_month: '2026-11' });
eq(compare(month, '2026-10-31').temporalState, 'current', 'before month boundary');
const needsReview = compare(month, '2026-11-01');
eq([needsReview.temporalState, needsReview.incumbentState, needsReview.comparison],
  ['review-due', 'review-due', 'match'], 'month boundary parity');
eq(needsReview.evaluation.activityExpiryInstant, null, 'no month-only expiry instant');
eq(compare(month, '2027-01-01').temporalState, 'review-due', 'review persists');

// Start-only does not establish active, ongoing, or an invented end.
const startOnly = compare(record({ start_date: '2026-12-10' }), '2026-10-26');
eq(startOnly.evaluation.activityStatus, 'upcoming', 'future start is only temporal information');
eq(startOnly.temporalState, 'current', 'no expiry without end');
eq(compare(record({ kind: 'recurring-venue' }), '2026-10-26').evaluation.activityStatus,
  'unknown', 'recurring label never creates an ongoing claim');

// Source timestamps are NOT source-region evidence, even with UTC offsets.
const offsetOnly = compare(record({
  start_datetime: '2026-10-29T18:00:00-01:00',
  end_datetime: '2026-10-29T23:00:00-01:00',
}), '2026-10-30');
eq(offsetOnly.normalizedInput.activityEnd, null, 'unverified end timestamp is not mapped');
eq(offsetOnly.normalizedInput.activityStart, null, 'unverified start timestamp is not mapped');
eq(offsetOnly.temporalState, 'current', 'unverified timestamp cannot expire record');
eq(offsetOnly.reviewReasons, [
  'END_DATETIME_SOURCE_ZONE_UNVERIFIED', 'END_DATETIME_WITHOUT_DAY_FALLBACK',
  'START_DATETIME_SOURCE_ZONE_UNVERIFIED',
], 'timestamp omissions are explicit');
const withFallback = compare(record({
  end_date: '2026-10-29', end_datetime: '2026-10-29T23:00:00-01:00',
}), '2026-10-30');
eq(withFallback.temporalState, 'expired', 'verified day fallback preserved');
eq(withFallback.reviewReasons, ['END_DATETIME_SOURCE_ZONE_UNVERIFIED'],
  'exact-time policy still outstanding');

// An explicit editorial retirement remains distinct from time arithmetic.
const editorial = compare(record({ publication_state: 'expired', end_date: null }), '2026-10-26');
eq([editorial.incumbentState, editorial.temporalState, editorial.comparison],
  ['expired', 'current', 'editorial-override'], 'editorial expiry is independent');
eq(editorial.reviewReasons, ['EDITORIAL_EXPIRY_INDEPENDENT'], 'explicit editorial override');

// Invalid and contradictory precision must not silently evaluate as current.
throws(() => compare(null, '2026-10-26'), /INVALID_RECORD/);
throws(() => compare(dated, '2026-02-30'), /INVALID_DAY/);
throws(() => compare(record({ end_date: '2026-02-30' }), '2026-10-26'), /INVALID_DAY/);
throws(() => compare(record({ start_date: '2026-13-01' }), '2026-10-26'), /INVALID_DAY/);
throws(() => compare(record({ end_precision: 'month', end_month: '2026-13' }), '2026-10-26'), /INVALID_END_MONTH/);
throws(() => compare(record({ end_precision: 'month', end_month: '2026-11', end_date: '2026-11-15' }), '2026-10-26'), /CONFLICTING_END_PRECISION/);
throws(() => compare(record({ end_precision: 'day', end_month: '2026-11' }), '2026-10-26'), /CONFLICTING_END_PRECISION/);
throws(() => compare(record({ end_precision: 'hour' }), '2026-10-26'), /UNSUPPORTED_END_PRECISION/);
throws(() => compare(record({ start_datetime: 123 }), '2026-10-26'), /INVALID_START_DATETIME/);
throws(() => compare(record({ end_datetime: 123 }), '2026-10-26'), /INVALID_END_DATETIME/);
throws(() => compare(record({ start_date: '2026-12-10', end_date: '2026-11-30' }), '2026-10-26'), /CONTRADICTORY_ACTIVITY_RANGE/);

// Determinism, input immutability, and no inferred identity/publication output.
// Independent review regressions: malformed source strings cannot claim parity.
for (const field of ['start_datetime', 'end_datetime']) {
  for (const value of ['not-a-date', '2026-02-30T18:00:00-01:00',
    '2026-10-29T18:00:00', '2026-10-29T24:00:00Z',
    '2026-10-29T18:60:00Z', '2026-10-29T18:00:60Z',
    '2026-10-29T18:00:00+24:00']) {
    throws(() => compare(record({ start_date: '2026-10-01', [field]: value }),
      '2026-10-26'), new RegExp(`INVALID_${field.toUpperCase()}`));
  }
  for (const value of ['2026-02-28T18:00:00Z', '2028-02-29T18:00:00.123+05:30']) {
    eq(compare(record({ [field]: value }), '2026-10-26').normalizedInput
      [field === 'start_datetime' ? 'activityStart' : 'activityEnd'], null,
    'valid timestamp remains excluded without verified source zone');
  }
}
throws(() => compare(record({ start_datetime: '2026-12-10T18:00:00-01:00',
  end_precision: 'month', end_month: '2026-11' }), '2026-10-26'),
  /CONTRADICTORY_ACTIVITY_RANGE/);
for (const start_datetime of ['2026-11-01T00:00:00+14:00', '2026-11-30T23:59:59-12:00']) {
  const result = compare(record({ start_datetime, end_precision: 'month',
    end_month: '2026-11' }), '2026-11-01');
  eq(result.temporalState, 'review-due', 'source month is read as written');
  eq(result.evaluation.activityExpiryInstant, null, 'no exact expiry inferred');
}

const untouched = Object.freeze({ ...dated, home_selected: true, directory_eligible: false });
const before = JSON.stringify(untouched);
eq(compare(untouched, '2026-10-30'), compare(untouched, '2026-10-30'), 'replay deterministic');
eq(JSON.stringify(untouched), before, 'source immutable');
eq(Object.hasOwn(compare(untouched, '2026-10-30'), 'home_selected'), false,
  'Home selection never returned');

// Existing canonical corpus is an input fixture, NEVER modified. Check legacy
// parity across tracked historical date, current day, and coming month review.
const corpus = JSON.parse(fs.readFileSync(new URL('../data/things-to-do-events.json', import.meta.url), 'utf8'));
for (const item of corpus.records) {
  for (const day of ['2026-10-12', '2026-10-26', '2026-11-01']) {
    const result = compare(item, day);
    eq(result.comparison === 'editorial-override' || result.comparison === 'match', true,
      `legacy corpus parity: ${item.id} ${day}`);
  }
}
console.log(`Things-to-Do Stage 2A adapter tests passed (${assertions} assertions)`);
