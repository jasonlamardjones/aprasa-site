// Single source of truth for Things-to-Do COLLECTION MEMBERSHIP: which
// canonical records belong on the dedicated collection hub, and which subset
// of those the Home preview shows.
//
// This exists for the same anti-drift reason as scripts/lib/things-to-do-keys.mjs
// and scripts/lib/things-to-do-currentness.mjs: the generator that renders the
// surfaces and the validators that police them must resolve membership from
// one definition, never from two copies that can diverge.
//
// It adds NO currentness rule of its own. Eligibility is exactly
// isPubliclyCurrent() from the incumbent currentness resolver — CURRENT and
// REVIEW_DUE are both eligible, only EXPIRED is not — so the hub and Home
// consume the same canonical currentness state the incumbent Things-to-Do
// presentation already consumes.
//
// --- Ordering -------------------------------------------------------------
//
// Hub order is the canonical record order of data/things-to-do-events.json,
// filtered to the eligible records. That is the incumbent deterministic
// ordering: Home's generated marker slots already sit in canonical record
// order, so the hub keeps it.
//
// It is deliberately NOT ordered by popularity, SEO demand, provider status,
// commercial relationship, payment or sponsorship, and nothing here may make
// it so.
//
// --- Home preview membership ----------------------------------------------
//
// Home membership is a GOVERNED CURATED SUBSET (HOME_PREVIEW_IDS below), not a
// count. It used to be "the first three eligible records in canonical order",
// which is a rule that decides for itself which records appear the moment the
// corpus changes. Project 03's EXPAND_HOME_PREVIEW ruling of 17 September 2026
// is not expressible that way: it approved five specific records, and the
// eligible record sitting fourth in canonical order is deliberately NOT one of
// them. Raising a limit from 3 to 5 would have surfaced it.
//
// So the selection is stated, not derived. This is the only editorial ranking
// input in the module, it is an explicit approved list and nothing more, and
// it must never grow into a scoring or popularity rule.

import { isPubliclyCurrent } from './things-to-do-currentness.mjs';

// --- Hub publication state -------------------------------------------------
//
// TEMPORARILY UNPUBLISHED, on founder approval of 13 September 2026.
//
// The standalone collection hubs (/things-to-do/ and /pt/things-to-do/) are
// dormant, not removed. Home stays the public Things-to-Do surface — its
// preview, its cards, its links — and every individual detail page stays
// public at its unchanged canonical URL. What is withdrawn is the standalone
// collection page at each locale root.
//
// The reason is product sequencing, not a fault in the collection machinery:
// a dedicated collection page should become public when that area is
// sufficiently developed and the operating/automation/QA system is stable,
// and this one went public ahead of that.
//
// Everything the hub needs is deliberately left intact and exercised against
// this flag flipped inside a sandbox: membership selection, canonical
// ordering, the renderer, the locale keys, the canonical/hreflang helpers
// below. See enableHub() in scripts/test-things-to-do-hub.mjs.
//
// REACTIVATION IS NOT FLAG-ONLY. Flipping this to `true` and running
// scripts/build-all.mjs restores three of the five things that were withdrawn:
//
//   * both hub surfaces;
//   * their sitemap entries;
//   * the breadcrumb on GENERATED detail pages.
//
// Two more are hand-authored and no generator owns them, so they must be
// restored by hand:
//
//   * the Home call to action in index.html (PT follows via
//     scripts/build-static-pages.mjs);
//   * the breadcrumb on things-to-do/water-adventure-activities-mindelo/ and
//     things-to-do/street-art-mindelo/, each of which carries a note saying so.
//
// enableHub() performs all of them, so if republication ever grows another step
// the negative-coverage cases stop getting a valid published baseline and fail
// — which is the alarm we want, rather than discovering it at reactivation.
//
// KNOWN GAP while dormant, deliberately left open here: the post-publication
// live QA no longer exercises the two withdrawn routes (they leave the sitemap,
// so they leave scripts/qa/lib/qa-targets.mjs's derived target set), which
// means no live pass would notice a stale CDN still serving them. Closing it
// needs a NEGATIVE live target — a route required to be absent — and that is a
// new finding code in the governed QA contract (scripts/qa/lib/qa-contract.mjs),
// not a publication change, so it belongs to the QA tranche rather than to this
// one. Absence itself is proven in the repository: the files are deleted, the
// routes are out of the sitemap, and no shipped page links to them.
//
// Reactivation is its own founder-approved tranche, not a side effect of some
// later change.
export const THINGS_TO_DO_HUB_PUBLIC = false;

/**
 * The approved Home preview, in approved order.
 *
 * Project 03, EXPAND_HOME_PREVIEW, 17 September 2026: Home shows exactly these
 * five records -- the three already visible, in their existing positions, plus
 * the two evergreen recurring-venue gateways appended after them.
 *
 * Membership here is NECESSARY, NOT SUFFICIENT. A listed record still has to be
 * publicly current to appear: homePreviewRecords() resolves this list against
 * collectionRecords(), so a selected record that expires or is withdrawn drops
 * off Home exactly as it does today. Selecting an id can add a record to the
 * preview; it can never keep a stale one alive.
 *
 * The order is the approved order and is what the hub validator compares the
 * rendered Home against. It currently coincides with canonical record order,
 * but this list is the authority, not that coincidence.
 */
export const HOME_PREVIEW_IDS = Object.freeze([
  'cartinha-dholanda-mindelo-2026',
  'sinergia-da-materia',
  'voyage-obi-margo-kafe-djan-djan-2026',
  'taverna-live-music',
  'nautilus-live-music',
]);

/**
 * Number of records the approved Home preview shows.
 *
 * Derived from the governed list so the two can never disagree. It remains the
 * upper bound consumers assert against; it is no longer the thing that DECIDES
 * membership.
 */
export const HOME_PREVIEW_LIMIT = HOME_PREVIEW_IDS.length;

/** Route of the collection hub, relative to a locale root. */
export const HUB_ROUTE = 'things-to-do/';

/** Canonical dated-event records eligible for the collection, in canonical order. */
export function collectionRecords(records, asOf) {
  return (records ?? []).filter((record) => isPubliclyCurrent(record, asOf));
}

/**
 * The approved Home preview: the governed HOME_PREVIEW_IDS selection, in
 * approved order, restricted to the records that are actually eligible.
 *
 * The currentness gate is collectionRecords() itself -- the same eligibility
 * every other Things-to-Do surface consumes -- so this adds no currentness rule
 * of its own and cannot bypass one.
 */
export function homePreviewRecords(records, asOf) {
  const eligible = new Map(collectionRecords(records, asOf).map((record) => [record.id, record]));
  return HOME_PREVIEW_IDS.map((id) => eligible.get(id)).filter((record) => record !== undefined);
}

/**
 * Selected ids that no canonical record carries at all.
 *
 * A governed list of ids has one failure mode the old count-based rule did not:
 * a typo, or an id left behind when a record is renamed or removed, silently
 * selects nothing and Home quietly shrinks. That is invisible in the output --
 * a missing card looks exactly like an expired one -- so it is reported instead
 * of inferred. Deliberately distinct from "selected but not currently
 * eligible", which is normal, expected and must stay silent.
 */
export function unknownHomePreviewIds(records) {
  const known = new Set((records ?? []).map((record) => record.id));
  return HOME_PREVIEW_IDS.filter((id) => !known.has(id));
}

/** Ids of the approved Home preview records. */
export function homePreviewIds(records, asOf) {
  return new Set(homePreviewRecords(records, asOf).map((record) => record.id));
}

/** Repository-relative output path of the hub for a locale. */
export function hubOutputPath(locale) {
  return locale === 'pt' ? `pt/${HUB_ROUTE}index.html` : `${HUB_ROUTE}index.html`;
}

/** Absolute public URL of the hub for a locale. */
export function hubCanonical(locale) {
  return locale === 'pt' ? `https://aprasa.org/pt/${HUB_ROUTE}` : `https://aprasa.org/${HUB_ROUTE}`;
}
