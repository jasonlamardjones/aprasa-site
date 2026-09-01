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
  const records = (events.records ?? []).filter((record) => record.kind === 'dated-event');

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
  };
}

/**
 * The route subset a given mode should exercise over HTTP.
 * Immediate runs prioritise the routes the merge actually touched plus the two
 * Home surfaces; every other mode checks the full derived surface.
 */
export function selectHttpRoutes(targets, mode) {
  if (mode !== 'IMMEDIATE_POST_DEPLOY') return targets.pageRoutes;
  const core = new Set(['/', '/pt/', ...targets.affectedRoutes]);
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
