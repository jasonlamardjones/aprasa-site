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
// Order is the canonical record order of data/things-to-do-events.json,
// filtered to the eligible records. That is the incumbent deterministic
// ordering: Home's generated marker slots already sit in canonical record
// order, so the hub and the Home preview simply keep it.
//
// It is deliberately NOT ordered by popularity, SEO demand, provider status,
// commercial relationship, payment or sponsorship, and nothing here may make
// it so. "First three" means the first three eligible records in canonical
// order and nothing else.

import { isPubliclyCurrent } from './things-to-do-currentness.mjs';

/** Number of eligible records the approved Home preview shows. */
export const HOME_PREVIEW_LIMIT = 3;

/** Route of the collection hub, relative to a locale root. */
export const HUB_ROUTE = 'things-to-do/';

/** Canonical dated-event records eligible for the collection, in canonical order. */
export function collectionRecords(records, asOf) {
  return (records ?? []).filter((record) => isPubliclyCurrent(record, asOf));
}

/** The approved Home preview: the first HOME_PREVIEW_LIMIT eligible records. */
export function homePreviewRecords(records, asOf) {
  return collectionRecords(records, asOf).slice(0, HOME_PREVIEW_LIMIT);
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
