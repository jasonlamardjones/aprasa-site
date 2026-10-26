// Stage 2A: read-only comparison adapter between governed Things-to-Do dates
// and the pure universal currentness contract. NOT a publication resolver.
// No existing generator, selection rule, or expiry controller imports this.
import { evaluateCurrentness } from './currentness-contract.mjs';
import {
  currentnessState, isValidIsoMonth, CURRENT, REVIEW_DUE, EXPIRED,
} from './things-to-do-currentness.mjs';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function requireDay(value, field) {
  if (typeof value !== 'string' || !ISO_DAY.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`TTD_ADAPTER_INVALID_DAY: ${field}`);
  }
}

/**
 * Compare supported legacy Things-to-Do date semantics with PR #135.
 * `asOfDay` is an incumbent Cape Verde calendar date, not wall-clock now.
 * Noon UTC is safely inside that CV day, making day-based comparisons stable;
 * it is NOT an exact-time expiry clock or authorization to publish anything.
 *
 * Only independently carried start_date, end_date and end_month are mapped.
 * start_datetime/end_datetime have offset strings but no approved source-region
 * IANA zone mapping: they must not silently acquire exact-time semantics.
 * The returned reviewReasons explicitly record any skipped timestamp fields.
 * Neither publication_state nor kind grants ongoing activity or Home selection.
 */
export function compareThingsToDoCurrentness(record, asOfDay) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('TTD_ADAPTER_INVALID_RECORD');
  }
  requireDay(asOfDay, 'asOfDay');
  const reviewReasons = [];
  const precision = record.end_precision ?? 'day';
  if (precision !== 'day' && precision !== 'month') {
    throw new Error('TTD_ADAPTER_UNSUPPORTED_END_PRECISION');
  }

  let activityEnd = null;
  if (precision === 'month') {
    if (record.end_date != null && record.end_date !== '' ||
        record.end_datetime != null && record.end_datetime !== '') {
      throw new Error('TTD_ADAPTER_CONFLICTING_END_PRECISION');
    }
    if (!isValidIsoMonth(record.end_month)) {
      throw new Error('TTD_ADAPTER_INVALID_END_MONTH');
    }
    activityEnd = Object.freeze({ precision: 'month', month: record.end_month });
  } else {
    if (record.end_month != null && record.end_month !== '') {
      throw new Error('TTD_ADAPTER_CONFLICTING_END_PRECISION');
    }
    if (record.end_date != null && record.end_date !== '') {
      requireDay(record.end_date, 'end_date');
      activityEnd = Object.freeze({ precision: 'day', date: record.end_date });
    }
    if (record.end_datetime != null && record.end_datetime !== '') {
      if (typeof record.end_datetime !== 'string') {
        throw new Error('TTD_ADAPTER_INVALID_END_DATETIME');
      }
      reviewReasons.push('END_DATETIME_SOURCE_ZONE_UNVERIFIED');
      if (!activityEnd) reviewReasons.push('END_DATETIME_WITHOUT_DAY_FALLBACK');
    }
  }

  let activityStart = null;
  if (record.start_date != null && record.start_date !== '') {
    requireDay(record.start_date, 'start_date');
    activityStart = Object.freeze({ precision: 'day', date: record.start_date });
  }
  if (record.start_datetime != null && record.start_datetime !== '') {
    if (typeof record.start_datetime !== 'string') {
      throw new Error('TTD_ADAPTER_INVALID_START_DATETIME');
    }
    reviewReasons.push('START_DATETIME_SOURCE_ZONE_UNVERIFIED');
  }

  const normalizedInput = Object.freeze({
    applicationDeadline: null, // Events provide no verified application deadline.
    activityStart,
    activityEnd,
  });
  const evaluation = evaluateCurrentness(normalizedInput, `${asOfDay}T12:00:00Z`);
  const temporalState = evaluation.activityStatus === 'ended' ? EXPIRED
    : activityEnd?.precision === 'month' && evaluation.reviewDue ? REVIEW_DUE
    : CURRENT;
  const incumbentState = currentnessState(record, asOfDay);
  // Explicit editorial expiry is an independent governing decision; the
  // date-only universal evaluator neither replaces nor validates that decision.
  const comparison = record.publication_state === 'expired' ? 'editorial-override'
    : temporalState === incumbentState ? 'match' : 'mismatch';
  if (comparison === 'editorial-override') {
    reviewReasons.push('EDITORIAL_EXPIRY_INDEPENDENT');
  }
  return Object.freeze({
    normalizedInput,
    evaluation,
    temporalState,
    incumbentState,
    comparison,
    reviewReasons: Object.freeze(reviewReasons),
  });
}
