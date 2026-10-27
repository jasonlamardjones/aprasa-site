// Stage 2B-L: parity-gated production bridge from the universal currentness
// contract (PR #135) to Things-to-Do generation and collection selection.
//
// The temporal state comes from the Stage 2A comparison adapter's universal
// `temporalState`. The adapter also resolves the incumbent state, and any
// disagreement between the two is a hard failure naming the record and date:
// there is deliberately NO fallback to the incumbent, so a silent divergence
// can never decide what is published.
//
// This module is separate from scripts/lib/things-to-do-currentness.mjs on
// purpose: the adapter imports that incumbent resolver, so the incumbent cannot
// import the adapter without a cycle.
//
// What this resolves is TEMPORAL currentness only. It grants no publication
// authority, Home inclusion, ongoing status or editorial approval; those stay
// with isPubliclyPublishable() and HOME_PREVIEW_IDS in
// scripts/lib/things-to-do-collection.mjs. An explicit editorial expiry
// (publication_state "expired") remains an independent override.
//
// Malformed or unsupported date input -- including an impossible asOf day such
// as 2026-02-30 -- is rejected rather than read as current. Offset-bearing
// start_datetime/end_datetime values never acquire exact-time expiry here: the
// adapter maps only day and month precision (see its header).
import { compareThingsToDoCurrentness } from './things-to-do-currentness-adapter.mjs';
import { EXPIRED } from './things-to-do-currentness.mjs';

function label(record) {
  return typeof record?.id === 'string' ? record.id : JSON.stringify(record?.id ?? null);
}

/** Resolve a record to exactly one of CURRENT / REVIEW_DUE / EXPIRED. */
export function currentnessState(record, asOf) {
  let parity;
  try {
    parity = compareThingsToDoCurrentness(record, asOf);
  } catch (error) {
    throw new Error(`TTD_UNIVERSAL_RESOLVER_INVALID_INPUT: ${label(record)} as of ${asOf}: ${error.message}`, { cause: error });
  }
  if (parity.comparison === 'mismatch') {
    throw new Error(`TTD_UNIVERSAL_PARITY_MISMATCH: ${label(record)} as of ${asOf}: universal=${parity.temporalState} incumbent=${parity.incumbentState}`);
  }
  // An explicit editorial expiry always wins, independent of the dates.
  if (record.publication_state === 'expired') return EXPIRED;
  return parity.temporalState;
}

/** True only for EXPIRED. REVIEW_DUE is deliberately not expired. */
export function isExpired(record, asOf) {
  return currentnessState(record, asOf) === EXPIRED;
}

/** CURRENT and REVIEW_DUE are both publicly current; only EXPIRED is not. */
export function isPubliclyCurrent(record, asOf) {
  return currentnessState(record, asOf) !== EXPIRED;
}
