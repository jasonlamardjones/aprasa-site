// Derives the QA target surface (routes, assets, per-record live invariants)
// from authoritative repository data only.
//
// Deliberately NOT a second event list. Every dated-event route comes from
// data/things-to-do-events.json (the same canonical file scripts/build-sitemap.mjs
// reads) and every published route is cross-checked against the committed
// sitemap.xml, so a newly published event is picked up automatically with no
// edit to the QA layer. Evergreen Things-to-Do routes and the static pages come
// from sitemap.xml, which build-sitemap.mjs owns.

import fs from 'node:fs';
import path from 'node:path';
import { isExpired as recordIsExpired } from '../../lib/things-to-do-currentness.mjs';
import { hasDetailRoute } from '../../lib/things-to-do-kinds.mjs';
import { HUB_ROUTE, THINGS_TO_DO_HUB_PUBLIC, homePreviewIds } from '../../lib/things-to-do-collection.mjs';

/** Public route of the collection hub in each locale. */
export const EN_HUB_ROUTE = `/${HUB_ROUTE}`;
export const PT_HUB_ROUTE = `/pt/${HUB_ROUTE}`;

export const CAPE_VERDE_TZ = 'Atlantic/Cape_Verde';

/**
 * Today in the site's own timezone, matching the incumbent workflow convention
 * (scripts/validate-training-opportunities-currentness.mjs is driven the same way).
 *
 * APRASA_QA_TODAY pins the date for deterministic tests. It is honoured only
 * alongside APRASA_QA_ALLOW_TEST_TARGET=1, the same flag that unlocks the
 * loopback-only test base URL, so a production run always uses the real clock.
 */
export function todayInCapeVerde(now = new Date()) {
  const pinned = process.env.APRASA_QA_TODAY;
  if (pinned && process.env.APRASA_QA_ALLOW_TEST_TARGET === '1') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pinned)) throw new Error(`invalid APRASA_QA_TODAY: ${pinned}`);
    return pinned;
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CAPE_VERDE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Routes listed in the committed sitemap, as origin-relative paths. */
export function sitemapRoutes(root) {
  const xml = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
  const routes = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = new URL(match[1]);
    routes.push(url.pathname);
  }
  return routes;
}

function localeOf(route) {
  return route === '/pt/' || route.startsWith('/pt/') ? 'pt' : 'en';
}

function ptCounterpart(route) {
  return route === '/' ? '/pt/' : `/pt${route}`;
}

function repoFileForRoute(root, route) {
  const relative = route === '/' ? 'index.html' : `${route.replace(/^\//, '')}index.html`;
  return path.join(root, relative);
}

/**
 * A record is expired under the shared resolver used by
 * scripts/validate-things-to-do-currentness.mjs. Re-exported here so QA keeps
 * one definition of expiry rather than a second copy of the rule.
 *
 * REVIEW_DUE is deliberately NOT expired. That matters beyond rendering: the
 * QA pass turns `expiredAtAsOf`/`expiredToday` into TTD_EXPIRED_SURFACED and
 * TTD_CURRENTNESS_DRIFT findings, which are Phase 2B's auto-remediation
 * candidates. Reporting a review-due record as expired would hand Phase 2B a
 * deterministic removal repair for a record whose closing day is unknown --
 * exactly the outcome month precision exists to prevent.
 */
export function isExpired(record, asOf) {
  return recordIsExpired(record, asOf);
}

export function loadTargets(root, { affectedRoutes = [] } = {}) {
  const events = readJson(path.join(root, 'data', 'things-to-do-events.json'));
  const currentness = readJson(path.join(root, 'data', 'things-to-do-currentness.json'));
  const asOf = currentness.as_of;
  const today = todayInCapeVerde();
  // Both canonical kinds publish a real, crawlable detail page, so both are
  // live-QA targets. Restricting this to dated events would leave every
  // evergreen recurring-venue route unchecked in production.
  const records = (events.records ?? []).filter((record) => hasDetailRoute(record));

  const sitemap = sitemapRoutes(root);
  const sitemapSet = new Set(sitemap);

  // Page routes: everything the committed sitemap publishes, plus the PT
  // counterpart of any EN route whose PT page exists on disk but which the
  // sitemap somehow omitted (that omission is itself reported as an issue).
  const pageRoutes = [];
  const seen = new Set();
  const addRoute = (route, { required }) => {
    if (seen.has(route)) return;
    seen.add(route);
    pageRoutes.push({
      route,
      locale: localeOf(route),
      required,
      inSitemap: sitemapSet.has(route),
      repoFile: repoFileForRoute(root, route),
      existsInRepo: fs.existsSync(repoFileForRoute(root, route)),
    });
  };

  for (const route of sitemap) addRoute(route, { required: true });
  for (const route of sitemap.filter((r) => localeOf(r) === 'en')) {
    const pt = ptCounterpart(route);
    if (fs.existsSync(repoFileForRoute(root, pt))) addRoute(pt, { required: true });
  }

  // Per-record live invariants, evaluated against the committed currentness
  // contract (asOf) rather than wall-clock time. The committed surfaces were
  // generated for asOf, so judging them by today's date would manufacture a
  // false positive every time the site outlives its last publication run.
  // Home is the approved limited preview of the collection since the Project 03
  // collection approval; the full eligible collection lives on the hub. A live
  // check therefore needs to know which surface a record is expected on, not
  // just whether it is eligible.
  const previewIds = homePreviewIds(records, asOf);
  const recordTargets = records.map((record) => {
    const enRoute = `/${record.detail_page}`;
    const ptRoute = ptCounterpart(enRoute);
    return {
      id: record.id,
      title: record.title,
      provider: record.provider,
      enRoute,
      ptRoute,
      ptExistsInRepo: fs.existsSync(repoFileForRoute(root, ptRoute)),
      enExistsInRepo: fs.existsSync(repoFileForRoute(root, enRoute)),
      inSitemap: sitemapSet.has(enRoute),
      mediaAsset: record.media?.asset ?? null,
      mediaAlt: record.media?.alt ?? null,
      mediaPolicy: record.media_policy ?? 'optional',
      expiredAtAsOf: isExpired(record, asOf),
      expiredToday: isExpired(record, today),
      inHomePreview: previewIds.has(record.id),
      endDate: record.end_date ?? null,
      publicationState: record.publication_state ?? null,
    };
  });

  // Required same-origin assets: the shared shell plus every canonical media
  // asset that a non-expired record depends on.
  const assets = new Set(['/prasa-launch.css', '/prasa-launch.js']);
  for (const target of recordTargets) {
    if (target.mediaAsset && !target.expiredAtAsOf) assets.add(`/${target.mediaAsset}`);
  }

  const documents = ['/sitemap.xml', '/robots.txt'];

  // Routes this repository has deliberately WITHDRAWN from publication.
  //
  // Everything else in this module derives targets from what the site
  // publishes, so a withdrawn route disappears from the target set at exactly
  // the moment it stops being published -- which would leave nothing asserting
  // that production actually stopped serving it. A stale edge, or a deploy that
  // still carried the file, could keep returning the old collection page and no
  // live pass would say so.
  //
  // These are therefore NEGATIVE targets: routes required to be absent, checked
  // precisely because the sitemap no longer names them. Publication state comes
  // from the same governed flag the generator, the sitemap builder and the
  // workflow read -- never a second definition -- so republication empties this
  // list and the routes return to ordinary positive page QA.
  const withdrawnRoutes = THINGS_TO_DO_HUB_PUBLIC
    ? []
    : [
      { route: EN_HUB_ROUTE, locale: 'en', reason: 'THINGS_TO_DO_HUB_UNPUBLISHED' },
      { route: PT_HUB_ROUTE, locale: 'pt', reason: 'THINGS_TO_DO_HUB_UNPUBLISHED' },
    ];

  const normalizedAffected = affectedRoutes
    .map((route) => (route.startsWith('/') ? route : `/${route}`))
    .filter((route) => seen.has(route));

  return {
    asOf,
    today,
    pageRoutes,
    recordTargets,
    assets: [...assets],
    documents,
    sitemapRoutes: sitemap,
    affectedRoutes: normalizedAffected,
    withdrawnRoutes,
  };
}

/**
 * The route subset a given mode should exercise over HTTP.
 * Immediate runs prioritise the routes the merge actually touched plus the two
 * Home surfaces; every other mode checks the full derived surface.
 */
export function selectHttpRoutes(targets, mode) {
  if (mode !== 'IMMEDIATE_POST_DEPLOY') return targets.pageRoutes;
  // While PUBLISHED, the collection hubs are core public surfaces alongside the
  // two Home surfaces: an eligible record beyond the Home preview is reachable
  // only there, so a pass that skipped them could not tell "correctly
  // previewed" from "lost".
  //
  // They are TEMPORARILY UNPUBLISHED (THINGS_TO_DO_HUB_PUBLIC), so they are not
  // in the sitemap, not in pageRoutes, and naming them here would be inert:
  // the filter below keeps only routes pageRoutes already carries. They are
  // therefore named only while published, so this reads as what it does.
  //
  // KNOWN GAP while dormant, deliberately NOT closed in this tranche: no live
  // pass asserts that production STOPPED serving the two withdrawn routes, so
  // a stale CDN could keep returning them unnoticed. Closing it needs a
  // negative live target (a route required to be absent), which is a new
  // finding code in the governed QA contract rather than a publication change.
  // See the note on THINGS_TO_DO_HUB_PUBLIC.
  const core = new Set([
    '/',
    '/pt/',
    ...(THINGS_TO_DO_HUB_PUBLIC ? [EN_HUB_ROUTE, PT_HUB_ROUTE] : []),
    ...targets.affectedRoutes,
  ]);
  for (const target of targets.recordTargets) {
    // A published event that is current at the committed as_of is always worth
    // re-checking immediately, even when the merge diff did not name its file.
    if (!target.expiredAtAsOf) {
      core.add(target.enRoute);
      if (target.ptExistsInRepo) core.add(target.ptRoute);
    }
  }
  return targets.pageRoutes.filter((page) => core.has(page.route));
}

/**
 * The withdrawn routes a given mode must prove are no longer served.
 *
 * Every mode, deliberately. The positive surface is mode-scoped because it is
 * large and a stale page is caught by the next run anyway; this set is two
 * requests, and the thing it guards against -- a withdrawn page still public --
 * is not something any mode should be willing to miss. It is empty whenever the
 * hub is published, so this costs nothing once the hubs come back.
 */
export function selectWithdrawnRoutes(targets) {
  return targets.withdrawnRoutes;
}

/**
 * Browser route selection. Deliberately small: EN Home, PT Home, and a
 * representative current Things-to-Do detail route chosen dynamically (the
 * affected one when the merge names it, otherwise the first current record).
 */
export function selectBrowserRoutes(targets, mode) {
  const chosen = [];
  const push = (route) => {
    const page = targets.pageRoutes.find((candidate) => candidate.route === route);
    if (page && !chosen.some((existing) => existing.route === route)) chosen.push(page);
  };

  push('/');
  push('/pt/');

  const currentRecords = targets.recordTargets.filter((target) => !target.expiredAtAsOf);
  const affectedRecord = currentRecords.find(
    (target) => targets.affectedRoutes.includes(target.enRoute) || targets.affectedRoutes.includes(target.ptRoute)
  );
  const representative = affectedRecord ?? currentRecords[0] ?? null;
  if (representative) {
    push(representative.enRoute);
    if (mode === 'WEEKLY_DEEP' && representative.ptExistsInRepo) push(representative.ptRoute);
  }

  if (mode === 'WEEKLY_DEEP') {
    push('/about/');
    push('/pt/about/');
    push('/mindelo-essentials/');
    push('/pt/mindelo-essentials/');
  }

  return chosen;
}
