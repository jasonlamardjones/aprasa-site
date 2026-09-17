// Single source of truth for Things-to-Do RECORD KINDS.
//
// This exists for the same anti-drift reason as scripts/lib/things-to-do-keys.mjs,
// scripts/lib/things-to-do-currentness.mjs and scripts/lib/things-to-do-collection.mjs:
// the kind vocabulary is consumed by the generator, by several validators, by the
// sitemap builder and by the live-QA target derivation, and a literal string
// copied into each of them drifts independently.
//
// --- The two kinds --------------------------------------------------------
//
//   "dated-event"      The incumbent kind. A record for an occurrence that
//                      happens on a date (or across a date range) and whose
//                      currentness is resolved from that date. Unchanged.
//
//   "recurring-venue"  An EVERGREEN DISCOVERY GATEWAY to a venue's recurring
//                      cultural programming (Project 03, 16 September 2026).
//                      It carries a stable title, provider, location, evergreen
//                      description, a governed checked_at and an outbound link
//                      to the venue's approved CURRENT SCHEDULE SOURCE.
//
// A recurring-venue record is NOT a schedule. It deliberately encodes no
// occurrence date, no time, no weekly pattern, no performer or film, and no
// admission claim, because none of those is stable and the card promises no
// such stability -- the linked source is where current detail lives. That is
// why OCCURRENCE_DATE_FIELDS below must be ABSENT from such a record rather
// than merely null: a present-but-null start_datetime is the dated-event
// shape, and a record that carries the shape invites a later edit to fill it
// in, which is exactly the dated-event semantics this kind exists to avoid.
//
// The kind is deliberately named for its SHAPE (a recurring venue's
// programming gateway), not for live music, not for any one venue and not for
// any one art form, so the next approved recurring-venue gateway -- cinema
// showtimes, for instance -- reuses it rather than adding a third kind.
//
// --- What consuming a kind means ------------------------------------------
//
// Consumers must route on PURPOSE, not add the new kind reflexively:
//
//   * Currentness (scripts/lib/things-to-do-currentness.mjs and its validator)
//     is date-driven, so an evergreen record is simply out of its scope. The
//     resolver already returns CURRENT for a record with no end date, and the
//     validator already skips any non-dated-event kind. Neither is changed.
//   * Phase 2B remediation (scripts/remediation/) performs deterministic
//     expiry repairs. An evergreen record can never be deterministically
//     expired, so its existing dated-event-only guard must stay closed.
//   * The publication-packet contract (scripts/lib/event-publication-contract.mjs)
//     governs the automated dated-event intake pipeline. Evergreen records are
//     authored canonically, not through that pipeline, so its guard stays closed.
//   * Surfaces that publish a record's DETAIL ROUTE (the sitemap builder, the
//     sitemap assertions in the hub validator, the live-QA target set) are
//     about having a public page, which both kinds have -- so they read
//     DETAIL_ROUTE_KINDS below.

export const DATED_EVENT = 'dated-event';
export const RECURRING_VENUE = 'recurring-venue';

/** Every kind the canonical Things-to-Do corpus may contain. */
export const RECORD_KINDS = Object.freeze([DATED_EVENT, RECURRING_VENUE]);

/**
 * Kinds that own a public detail route derived from the canonical corpus.
 *
 * Both current kinds do. It is a separate constant from RECORD_KINDS because
 * the two answer different questions, and a future kind could be canonical
 * without being separately routable.
 */
export const DETAIL_ROUTE_KINDS = Object.freeze([DATED_EVENT, RECURRING_VENUE]);

/**
 * Occurrence fields a recurring-venue record must not carry AT ALL.
 *
 * Absence, not null: see the note above.
 */
export const OCCURRENCE_DATE_FIELDS = Object.freeze([
  'start_date',
  'start_datetime',
  'end_date',
  'end_datetime',
  'end_precision',
  'end_month',
]);

/**
 * The ONLY Schema.org @type a recurring-venue record may publish.
 *
 * The kind exists to be an evergreen discovery gateway, not an occurrence, so
 * Event-family structured data is the one thing it must never emit: an Event
 * node on a page with no startDate and no eventStatus asserts to search
 * engines exactly the scheduled occurrence the card refuses to promise.
 *
 * It is pinned here, in the shared module, because BOTH the generator and the
 * canonical validator have to agree on it and neither one runs the other --
 * scripts/build-all.mjs drives the generator directly and never invokes
 * scripts/validate-things-to-do-events.mjs, so a validator-only rule would not
 * stop a bad record from being rendered, and a renderer-only rule would let
 * the bad value sit in the corpus unreported. Both read this constant:
 *
 *   * the generator hard-codes it rather than reading seo.schema_type, so a
 *     record copied from a dated event cannot carry "Event" or
 *     "ExhibitionEvent" through into published JSON-LD;
 *   * the validator requires seo.schema_type to equal it, so such a record is
 *     reported rather than silently overridden at render time.
 */
export const RECURRING_VENUE_SCHEMA_TYPE = 'WebPage';

export function isDatedEvent(record) {
  return record?.kind === DATED_EVENT;
}

export function isRecurringVenue(record) {
  return record?.kind === RECURRING_VENUE;
}

/** True when the record's kind publishes a detail route of its own. */
export function hasDetailRoute(record) {
  return DETAIL_ROUTE_KINDS.includes(record?.kind);
}
