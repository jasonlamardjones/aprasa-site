// Single source of truth for Things-to-Do currentness.
//
// This resolver replaces the boolean predicate that was previously copied,
// verbatim, into seven separate scripts. That duplication was safe only while
// currentness had exactly two outcomes; it stops being safe the moment a third
// one exists, because seven copies drift independently. Every consumer now
// imports from here.
//
// --- End precision -------------------------------------------------------
//
// A record's end information carries a precision:
//
//   "day"    end_date is an exact ISO day (the incumbent shape). ABSENT
//            end_precision means "day", so every record written before this
//            field existed keeps byte-identical semantics with no edit.
//   "month"  the source establishes only the month a record ends in, not the
//            day. end_date is null and end_month is YYYY-MM.
//
// Month precision exists because a source can be authoritative about "on view
// until November 2026" while establishing no closing day at all. The previous
// schema could not express that: every available value either kept such a
// record current forever, or expired it on a day nobody had verified.
//
// --- The three states ----------------------------------------------------
//
//   EXPIRED     publication_state is explicitly "expired", OR a day-precision
//               end_date falls strictly before asOf. Existing removal and
//               past-event behavior applies.
//   REVIEW_DUE  month precision, and asOf has reached the first day of
//               end_month. The record stays public and is NEVER treated as
//               expired; it means a human must reverify against the source.
//   CURRENT     otherwise. Render normally.
//
// --- On `${end_month}-01` ------------------------------------------------
//
// reviewDueFrom() returns the first day of end_month. This is a MONTH-BOUNDARY
// TEST -- it answers "has that month begun?" and nothing else. It is not an
// inferred, derived, or fabricated closing date, it is never stored on the
// record, and it is never rendered or serialized to any public surface. A
// record whose closing day is unknown must not acquire one here by arithmetic.

export const CURRENT = 'current';
export const REVIEW_DUE = 'review-due';
export const EXPIRED = 'expired';

export const DAY_PRECISION = 'day';
export const MONTH_PRECISION = 'month';
export const END_PRECISIONS = Object.freeze([DAY_PRECISION, MONTH_PRECISION]);

export const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_MONTH_PATTERN = /^\d{4}-\d{2}$/;

/**
 * True only for a real calendar month in YYYY-MM form.
 *
 * ISO_MONTH_PATTERN alone is a SHAPE test: it happily accepts 2026-00,
 * 2026-13, 2026-99 and 9999-99, none of which are months. Shape was never
 * sufficient here -- an impossible month feeds the month-boundary comparison
 * and the schema check alike, so it is rejected at the one place both of them
 * read from.
 */
export function isValidIsoMonth(value) {
  if (typeof value !== 'string' || !ISO_MONTH_PATTERN.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

/**
 * The calendar month containing a record's canonical start, or null when the
 * record supplies no valid start.
 *
 * A record may express its start as start_date or start_datetime; this reads
 * whichever it validly supplies, preferring start_date, exactly as
 * scripts/lib/event-publication-contract.mjs already resolves a start day.
 * The month is taken from the local calendar date AS WRITTEN -- no timezone
 * conversion, no arithmetic -- because the governed value is the local
 * calendar month the source states, and shifting it by an offset would change
 * a governed date rather than read it.
 */
export function startMonthOf(record) {
  const startDay = record?.start_date ?? record?.start_datetime?.slice(0, 10);
  if (typeof startDay !== 'string' || !ISO_DAY_PATTERN.test(startDay)) return null;
  return startDay.slice(0, 7);
}

/** Declared end precision, defaulting to "day" when the field is absent. */
export function endPrecisionOf(record) {
  return record?.end_precision ?? DAY_PRECISION;
}

export function isMonthPrecision(record) {
  return endPrecisionOf(record) === MONTH_PRECISION;
}

/**
 * First day of end_month, for the month-boundary comparison only.
 * Returns null for day-precision records and for a malformed end_month --
 * including an impossible calendar month such as 2026-13 -- so a bad value can
 * never silently read as "not yet due". Behavior for a valid month is
 * unchanged.
 */
export function reviewDueFrom(record) {
  if (!isMonthPrecision(record)) return null;
  const month = record?.end_month;
  if (!isValidIsoMonth(month)) return null;
  return `${month}-01`;
}

/** Resolve a record to exactly one of CURRENT / REVIEW_DUE / EXPIRED. */
export function currentnessState(record, asOf) {
  if (!ISO_DAY_PATTERN.test(asOf ?? '')) {
    throw new Error(`things-to-do currentness: invalid asOf ${JSON.stringify(asOf)}`);
  }

  // An explicit editorial expiry always wins, at either precision.
  if (record?.publication_state === 'expired') return EXPIRED;

  if (isMonthPrecision(record)) {
    const boundary = reviewDueFrom(record);
    // Month precision NEVER resolves to EXPIRED on date alone: an unknown
    // closing day cannot be allowed to become an automatic removal.
    return boundary && asOf >= boundary ? REVIEW_DUE : CURRENT;
  }

  if (record?.end_date && record.end_date < asOf) return EXPIRED;
  return CURRENT;
}

/** True only for EXPIRED. REVIEW_DUE is deliberately not expired. */
export function isExpired(record, asOf) {
  return currentnessState(record, asOf) === EXPIRED;
}

/** True when a human must reverify the record against its source. */
export function isReviewDue(record, asOf) {
  return currentnessState(record, asOf) === REVIEW_DUE;
}

/**
 * True when the record still belongs on public surfaces (Home card, detail
 * route rendered without a past-event label). CURRENT and REVIEW_DUE both
 * qualify; only EXPIRED does not.
 */
export function isPubliclyCurrent(record, asOf) {
  return currentnessState(record, asOf) !== EXPIRED;
}
