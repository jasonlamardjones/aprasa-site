#!/usr/bin/env node
// Phase 2A post-publication QA runner — DETECT, CLASSIFY, RECORD, REPORT.
//
// This process is read-only with respect to everything it observes. It makes
// GET requests to the production site, reads GitHub deployment metadata, runs
// the incumbent source validators as child processes, and writes a JSON report
// plus screenshots into a local artifact directory. It has no code path that
// commits, pushes, opens a PR, merges, deploys, files an issue, or notifies an
// external service, and none may be added in Phase 2A.
//
// Usage:
//   node scripts/qa/run-post-publication-qa.mjs --mode=DAILY_LIGHTWEIGHT
//   node scripts/qa/run-post-publication-qa.mjs --mode=MANUAL --out=qa-artifacts

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  annotateEdgeGraceExhausted,
  DOMAINS,
  isPropagationEligible,
  makeCheck,
  makeIssue,
  makeReport,
  MODES,
} from './lib/qa-contract.mjs';
import { loadSchema, validateAgainstSchema } from './lib/qa-schema.mjs';
import { EN_HUB_ROUTE, loadTargets, selectBrowserRoutes, selectHttpRoutes, todayInCapeVerde } from './lib/qa-targets.mjs';
import { fetchFollowing, isNormalizingRedirect } from './lib/qa-http.mjs';
import { corroborateByContent, resolveDeploymentProvenance } from './lib/qa-deployment.mjs';
import { runBrowserChecks, VIEWPORTS } from './lib/qa-browser.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_PATH = path.join(ROOT, 'scripts', 'qa', 'qa-report.schema.json');

// Security: the production target is pinned. This is not a general-purpose URL
// scanner — an alternative base URL is accepted only for local fixture tests,
// only over plain HTTP, and only against loopback.
const PRODUCTION_BASE_URL = 'https://aprasa.org';
const TEST_TARGET_ENV = 'APRASA_QA_ALLOW_TEST_TARGET';

// Post-deployment edge readiness.
//
// A VERIFIED github-pages deployment means GitHub finished publishing the
// commit. It does not mean every CDN edge already serves it, and treating the
// first stale 200 as a defect is a false failure during ordinary propagation.
// So immediately after a verified deployment the live HTTP pass is repeated,
// for a strictly bounded window, while the only findings a stale edge could
// explain are still present.
//
// Bounded on purpose: three minutes at thirty-second cadence is six live
// passes. Once the window closes, whatever is still wrong classifies normally.
// The window applies to IMMEDIATE_POST_DEPLOY alone — every other mode runs
// long after any deployment, where staleness is not a credible explanation.
const DEFAULT_EDGE_GRACE_MS = 3 * 60 * 1000;
const DEFAULT_EDGE_RETRY_MS = 30 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveBaseUrl(requested) {
  if (!requested || requested === PRODUCTION_BASE_URL) {
    return { baseUrl: PRODUCTION_BASE_URL, environment: 'production' };
  }
  if (process.env[TEST_TARGET_ENV] !== '1') {
    throw new Error(`refusing non-production base URL "${requested}" (set ${TEST_TARGET_ENV}=1 for local fixture tests only)`);
  }
  let url;
  try {
    url = new URL(requested);
  } catch {
    throw new Error(`invalid --base-url "${requested}"`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'http:' || !loopback) {
    throw new Error(`test base URL must be http:// on loopback, got "${requested}"`);
  }
  return { baseUrl: url.origin, environment: 'test-fixture' };
}

function parseArgs(argv) {
  const args = { mode: 'MANUAL', out: 'qa-artifacts', failOn: 'error' };
  const affected = [];
  for (const arg of argv) {
    const [key, ...rest] = arg.split('=');
    const value = rest.join('=');
    switch (key) {
      case '--mode': args.mode = value; break;
      case '--base-url': args.baseUrl = value; break;
      case '--expected-sha': args.expectedSha = value || null; break;
      case '--commit-timestamp': args.commitTimestamp = value || null; break;
      case '--repo': args.repo = value || null; break;
      case '--out': args.out = value; break;
      case '--affected-from': args.affectedFrom = value; break;
      case '--affected-route': affected.push(value); break;
      case '--fail-on': args.failOn = value; break;
      case '--skip-browser': args.skipBrowser = true; break;
      case '--skip-source': args.skipSource = true; break;
      case '--force-browser': args.forceBrowser = true; break;
      case '--deployment-fixture': args.deploymentFixture = value; break;
      case '--deployment-wait-ms': args.deploymentWaitMs = Number(value); break;
      case '--deployment-poll-ms': args.deploymentPollMs = Number(value); break;
      case '--edge-grace-ms': args.edgeGraceMs = Number(value); break;
      case '--edge-retry-ms': args.edgeRetryMs = Number(value); break;
      default:
        if (key.startsWith('--')) throw new Error(`unknown argument ${key}`);
    }
  }
  if (!MODES.includes(args.mode)) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
  args.affectedRoutes = affected;
  return args;
}

function readAffectedRoutes(args) {
  const routes = [...args.affectedRoutes];
  if (args.affectedFrom && fs.existsSync(args.affectedFrom)) {
    const lines = fs.readFileSync(args.affectedFrom, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
    for (const file of lines) {
      // index.html -> /, pt/index.html -> /pt/, things-to-do/x/index.html -> /things-to-do/x/
      if (!file.endsWith('index.html')) continue;
      const dir = file.slice(0, -'index.html'.length);
      routes.push(`/${dir}`);
    }
  }
  return [...new Set(routes)];
}

/** Collector shared by every phase; `domain` is bound per phase. */
function makeEmitter(state) {
  return (domain) => ({
    check: (spec) => state.checks.push(makeCheck({ domain, ...spec })),
    issue: (spec) => state.issues.push(makeIssue({ domain, ...spec })),
  });
}

const escapeHtml = (value) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

/** Titles are compared in both raw and escaped form, matching the tolerance of the incumbent surface validators. */
function htmlContains(html, fragmentBuilder, value) {
  return html.includes(fragmentBuilder(value)) || html.includes(fragmentBuilder(escapeHtml(value)));
}

// --------------------------------------------------------------------------
// SOURCE_VALIDATION — re-uses the incumbent deterministic validators as-is.
// --------------------------------------------------------------------------

/**
 * The incumbent source validators, keyed by their stable machine-readable
 * identity. The identity is primary and the script path is derived from it —
 * not the other way round — so moving or renaming a script changes exactly one
 * line here and leaves every emitted `validator_id` untouched.
 *
 * This exists because two structurally different validators legitimately emit
 * the same issue code. `validate-things-to-do-currentness.mjs` reports drift a
 * generator can repair by rerunning against authoritative data;
 * `validate-training-opportunities-currentness.mjs` reports drift in
 * hand-authored Home cards that no generator owns. Both surface as
 * SOURCE_CURRENTNESS_DRIFT, and before this field the only thing telling them
 * apart in the report was `evidence.command` — a shell string. Any consumer
 * deciding what it may repair has to key on identity, never on that string.
 */
export const SOURCE_VALIDATORS = Object.freeze({
  things_to_do_events: 'scripts/validate-things-to-do-events.mjs',
  things_to_do_currentness: 'scripts/validate-things-to-do-currentness.mjs',
  things_to_do_surface_equivalence: 'scripts/validate-things-to-do-surface-equivalence.mjs',
  things_to_do_sitemap: 'scripts/validate-things-to-do-sitemap.mjs',
  locale_contract: 'scripts/validate-locale-contract.mjs',
  pt_home_events: 'scripts/validate-pt-home-events.mjs',
  card_media: 'scripts/validate-card-media.mjs',
  training_opportunities_currentness: 'scripts/validate-training-opportunities-currentness.mjs',
});

/**
 * One entry per *invocation*. `id` names the step (it is the check id suffix);
 * `validator_id` names the semantic validator behind it. The two are
 * deliberately not the same thing: the Things-to-Do currentness validator is
 * run twice per pass — once against the committed `as_of` and once against
 * today — so two steps share one identity. Code plus identity is what
 * distinguishes them, and that pair is stable.
 */
export function sourceValidatorPlan(asOf, today) {
  return [
    // Structural: the committed repository must be internally consistent.
    { id: 'events', validator_id: 'things_to_do_events', name: 'canonical event records', args: [SOURCE_VALIDATORS.things_to_do_events], severity: 'ERROR', resolver_class: 'CONTENT_GOVERNANCE' },
    { id: 'currentness-committed', validator_id: 'things_to_do_currentness', name: `committed currentness as of ${asOf}`, args: [SOURCE_VALIDATORS.things_to_do_currentness, `--as-of=${asOf}`], severity: 'ERROR', resolver_class: 'CONTENT_GOVERNANCE' },
    { id: 'surface-equivalence', validator_id: 'things_to_do_surface_equivalence', name: `EN/PT surface equivalence as of ${asOf}`, args: [SOURCE_VALIDATORS.things_to_do_surface_equivalence, `--as-of=${asOf}`], severity: 'ERROR', resolver_class: 'LOCALIZATION' },
    { id: 'sitemap', validator_id: 'things_to_do_sitemap', name: 'sitemap covers canonical routes', args: [SOURCE_VALIDATORS.things_to_do_sitemap], severity: 'ERROR', resolver_class: 'TECHNICAL' },
    { id: 'locale-contract', validator_id: 'locale_contract', name: 'EN/PT locale contract', args: [SOURCE_VALIDATORS.locale_contract], severity: 'ERROR', resolver_class: 'LOCALIZATION' },
    { id: 'pt-home-events', validator_id: 'pt_home_events', name: 'PT Home generated event regions', args: [SOURCE_VALIDATORS.pt_home_events], severity: 'ERROR', resolver_class: 'LOCALIZATION' },
    // Media validator uses exit code 2 for warnings-only.
    { id: 'card-media', validator_id: 'card_media', name: 'card media manifest', args: [SOURCE_VALIDATORS.card_media], severity: 'ERROR', resolver_class: 'MEDIA', warnExitCode: 2 },
    // Live-date drift: content that has aged past its publication date since the
    // last publication run. Real and deterministic, but a publication-cadence
    // matter rather than a site defect, so it warns instead of failing.
    { id: 'currentness-today', validator_id: 'things_to_do_currentness', name: `currentness drift as of ${today}`, args: [SOURCE_VALIDATORS.things_to_do_currentness, `--as-of=${today}`], severity: 'WARNING', resolver_class: 'CONTENT_GOVERNANCE', drift: true },
    { id: 'training-currentness-today', validator_id: 'training_opportunities_currentness', name: `training opportunity currentness as of ${today}`, args: [SOURCE_VALIDATORS.training_opportunities_currentness, `--as-of=${today}`, '--home=index.html', '--home=pt/index.html'], severity: 'WARNING', resolver_class: 'CONTENT_GOVERNANCE', drift: true },
  ];
}

/** Run one validator as a child process. Extracted so the identity contract can
 *  be tested against chosen outcomes without depending on what the real
 *  validators happen to report on the day the suite runs. */
async function runValidatorStep(validator) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, validator.args, { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}` || String(error.message),
    };
  }
}

export async function runSourceValidation(emit, { asOf, today, runStep = runValidatorStep }) {
  for (const validator of sourceValidatorPlan(asOf, today)) {
    const startedAt = Date.now();
    const { code, output } = await runStep(validator);
    const warnOnly = validator.warnExitCode !== undefined && code === validator.warnExitCode;
    const passed = code === 0;
    emit.check({
      id: `source:${validator.id}`,
      name: validator.name,
      validator_id: validator.validator_id,
      status: passed ? 'PASS' : warnOnly ? 'WARN' : validator.severity === 'WARNING' ? 'WARN' : 'FAIL',
      observed: { exit_code: code },
      expected: { exit_code: 0 },
      duration_ms: Date.now() - startedAt,
      evidence: { command: `node ${validator.args.join(' ')}` },
    });
    if (passed) continue;
    emit.issue({
      code: validator.drift ? 'SOURCE_CURRENTNESS_DRIFT' : warnOnly ? 'SOURCE_VALIDATOR_WARNING' : 'SOURCE_VALIDATOR_FAILED',
      severity: warnOnly ? 'WARNING' : validator.severity,
      category: 'SOURCE',
      check: validator.name,
      // The semantic identity of the validator that produced this finding.
      // `evidence.command` stays as evidence and must never be parsed for it.
      validator_id: validator.validator_id,
      observed: output.trim().split('\n').slice(0, 25).join('\n'),
      expected: 'validator exits 0',
      evidence: { command: `node ${validator.args.join(' ')}`, exit_code: code, step_id: validator.id },
      resolver_class: validator.resolver_class,
      auto_remediation_candidate: Boolean(validator.drift),
    });
  }
}

// --------------------------------------------------------------------------
// LIVE_HTTP_VALIDATION
// --------------------------------------------------------------------------

const HTML_SHELL_MARKERS = ['<html', '</html>', '<main id="main"', '<header class="site-header"'];

function expectedContentType(route) {
  if (route.endsWith('.xml')) return { pattern: /xml/i, label: 'xml' };
  if (route.endsWith('.txt')) return { pattern: /text\/plain/i, label: 'text/plain' };
  if (route.endsWith('.css')) return { pattern: /text\/css/i, label: 'text/css' };
  if (route.endsWith('.js')) return { pattern: /javascript/i, label: 'javascript' };
  if (/\.(png|jpe?g|webp|avif|gif|svg)$/i.test(route)) return { pattern: /^image\//i, label: 'image/*' };
  return { pattern: /text\/html/i, label: 'text/html' };
}

async function fetchAndCheckRoute(emit, { baseUrl, route, locale = null, kind = 'page', required = true }) {
  const url = new URL(route, baseUrl).toString();
  // The allowed origin is the pinned target, not merely the origin of this
  // route, so no derived route can widen where the QA layer is permitted to go.
  const response = await fetchFollowing(url, { allowedOrigin: new URL(baseUrl).origin });
  const finalUrl = response.url;
  const evidence = { url, final_url: finalUrl, status: response.status, attempts: response.attempts, redirect_chain: response.chain };

  // An off-origin redirect is reported from the hop that was refused, never
  // from a comparison of endpoints — the refused request was never sent.
  if (response.redirectBlocked) {
    const blocked = response.redirectBlocked;
    emit.check({
      id: `http:redirect-origin:${route}`,
      name: `${kind} redirect stays on the pinned origin`,
      status: 'FAIL',
      route,
      locale,
      observed: blocked,
      expected: `every redirect hop resolves to ${blocked.allowed_origin}`,
    });
    emit.issue({
      code: 'ROUTE_REDIRECT_OFF_ORIGIN_BLOCKED',
      severity: required ? 'ERROR' : 'WARNING',
      category: kind === 'asset' ? 'ASSET' : 'ROUTE',
      check: `${kind} redirect stays on the pinned origin`,
      route,
      locale,
      observed: `hop ${blocked.hop}: ${blocked.from} -> ${blocked.status ?? 'n/a'} ${blocked.location ?? blocked.to}`,
      expected: `every redirect hop resolves to ${blocked.allowed_origin}`,
      evidence: {
        ...evidence,
        source_url: blocked.from,
        redirect_status: blocked.status,
        location: blocked.location,
        resolved_target: blocked.to,
        blocked_origin: blocked.blocked_origin,
        allowed_origin: blocked.allowed_origin,
        redirect_hop: blocked.hop,
        reason: blocked.reason,
        transmitted: false,
      },
      resolver_class: 'TECHNICAL',
    });
    return null;
  }

  if (!response.ok) {
    emit.check({ id: `http:${route}`, name: `${kind} reachable`, status: 'FAIL', route, locale, observed: response.networkError, expected: 'HTTP 200' });
    emit.issue({
      code: 'ROUTE_UNREACHABLE',
      severity: required ? 'ERROR' : 'WARNING',
      category: kind === 'asset' ? 'ASSET' : 'ROUTE',
      check: `${kind} reachable`,
      route,
      locale,
      observed: response.networkError,
      expected: 'HTTP 200',
      evidence,
      resolver_class: 'TECHNICAL',
      retryable: true,
    });
    return null;
  }

  // Redirects: benign normalisation is informational, anything else is a defect.
  if (response.chain.length > 0) {
    emit.check({
      id: `http:redirect-origin:${route}`,
      name: `${kind} redirect stays on the pinned origin`,
      status: 'PASS',
      route,
      locale,
      observed: { hops: response.chain.length, chain: response.chain },
      expected: `every redirect hop resolves to ${response.allowedOrigin}`,
    });
    const benign = isNormalizingRedirect(url, finalUrl, response.chain);
    emit.check({
      id: `http:redirect:${route}`,
      name: `${kind} redirect correctness`,
      status: benign ? 'PASS' : 'FAIL',
      route,
      locale,
      observed: response.chain,
      expected: 'no redirect, or same-origin https/trailing-slash normalisation only',
    });
    if (!benign) {
      emit.issue({
        code: 'ROUTE_REDIRECT_UNEXPECTED',
        severity: 'ERROR',
        category: 'ROUTE',
        check: `${kind} redirect correctness`,
        route,
        locale,
        observed: finalUrl,
        expected: url,
        evidence,
        resolver_class: 'TECHNICAL',
      });
    } else {
      emit.issue({
        code: 'ROUTE_REDIRECT_NORMALIZED',
        severity: 'INFO',
        category: 'ROUTE',
        check: `${kind} redirect correctness`,
        route,
        locale,
        observed: finalUrl,
        expected: url,
        evidence,
        resolver_class: 'TECHNICAL',
      });
    }
  }

  const statusOk = response.status === 200;
  emit.check({
    id: `http:status:${route}`,
    name: `${kind} returns 200`,
    status: statusOk ? 'PASS' : 'FAIL',
    route,
    locale,
    observed: response.status,
    expected: 200,
    duration_ms: response.duration_ms,
    evidence,
  });
  if (!statusOk) {
    const serverError = response.status >= 500;
    emit.issue({
      code: response.status === 404 ? 'ROUTE_NOT_FOUND' : serverError ? 'ROUTE_SERVER_ERROR' : 'ROUTE_UNEXPECTED_STATUS',
      severity: required ? 'ERROR' : 'WARNING',
      category: kind === 'asset' ? 'ASSET' : 'ROUTE',
      check: `${kind} returns 200`,
      route,
      locale,
      observed: response.status,
      expected: 200,
      evidence,
      resolver_class: 'TECHNICAL',
      retryable: serverError,
      auto_remediation_candidate: false,
    });
    return null;
  }

  const contentType = expectedContentType(route);
  const contentTypeOk = contentType.pattern.test(response.contentType ?? '');
  emit.check({
    id: `http:content-type:${route}`,
    name: `${kind} content type`,
    status: contentTypeOk ? 'PASS' : 'FAIL',
    route,
    locale,
    observed: response.contentType,
    expected: contentType.label,
  });
  if (!contentTypeOk) {
    emit.issue({
      code: 'CONTENT_TYPE_UNEXPECTED',
      severity: 'ERROR',
      category: kind === 'asset' ? 'ASSET' : 'ROUTE',
      check: `${kind} content type`,
      route,
      locale,
      observed: response.contentType,
      expected: contentType.label,
      evidence,
      resolver_class: 'TECHNICAL',
    });
  }

  if (kind === 'asset' || kind === 'document') {
    const empty = response.bytes === 0;
    emit.check({ id: `http:body:${route}`, name: `${kind} body non-empty`, status: empty ? 'FAIL' : 'PASS', route, locale, observed: response.bytes, expected: '> 0 bytes' });
    if (empty) {
      emit.issue({
        code: 'RESPONSE_BODY_EMPTY',
        severity: 'ERROR',
        category: kind === 'asset' ? 'ASSET' : 'ROUTE',
        check: `${kind} body non-empty`,
        route,
        locale,
        observed: 0,
        expected: '> 0 bytes',
        evidence,
        resolver_class: 'TECHNICAL',
      });
    }
    return response;
  }

  const missingMarkers = HTML_SHELL_MARKERS.filter((marker) => !response.body.includes(marker));
  emit.check({
    id: `http:shell:${route}`,
    name: 'page body is a valid A PRASA page',
    status: missingMarkers.length ? 'FAIL' : 'PASS',
    route,
    locale,
    observed: { bytes: response.bytes, missing_markers: missingMarkers },
    expected: HTML_SHELL_MARKERS,
  });
  if (missingMarkers.length) {
    emit.issue({
      code: 'ROUTE_BODY_INVALID',
      severity: 'ERROR',
      category: 'CONTENT',
      check: 'page body is a valid A PRASA page',
      route,
      locale,
      observed: { bytes: response.bytes, missing_markers: missingMarkers },
      expected: 'a complete A PRASA page shell',
      evidence,
      resolver_class: 'TECHNICAL',
    });
    return response;
  }

  if (locale) {
    const langMatch = response.body.match(/<html[^>]*\slang="([^"]+)"/i);
    const observedLang = langMatch ? langMatch[1] : null;
    const langOk = observedLang === locale;
    emit.check({ id: `http:lang:${route}`, name: 'html lang contract', status: langOk ? 'PASS' : 'FAIL', route, locale, observed: observedLang, expected: locale });
    if (!langOk) {
      emit.issue({
        code: 'LOCALE_LANG_MISMATCH',
        severity: 'ERROR',
        category: 'LOCALIZATION',
        check: 'html lang contract',
        route,
        locale,
        observed: observedLang,
        expected: locale,
        evidence,
        resolver_class: 'LOCALIZATION',
        auto_remediation_candidate: true,
      });
    }
  }

  // Protected brand identity. "A PRAÇA"/"A PRACA" is the known corruption of
  // the A PRASA wordmark that build-locale-data.mjs already guards at source;
  // this is the live-surface counterpart of that same rule.
  const corrupted = /A PRA[ÇC]A/.test(response.body);
  emit.check({ id: `http:brand:${route}`, name: 'protected A PRASA spelling', status: corrupted ? 'FAIL' : 'PASS', route, locale, observed: corrupted ? 'A PRAÇA/A PRACA present' : 'clean', expected: 'A PRASA' });
  if (corrupted) {
    emit.issue({
      code: 'LOCALE_BRAND_CORRUPTION',
      severity: 'ERROR',
      category: 'LOCALIZATION',
      check: 'protected A PRASA spelling',
      route,
      locale,
      observed: 'live page contains "A PRAÇA"/"A PRACA"',
      expected: 'the protected A PRASA spelling',
      evidence,
      resolver_class: 'LOCALIZATION',
    });
  }

  return response;
}

// --------------------------------------------------------------------------
// Live Things-to-Do + localization contracts
// --------------------------------------------------------------------------

function checkThingsToDoLiveContract(emit, { targets, bodies, baseUrl }) {
  const enHome = bodies.get('/');
  // The EN collection hub carries the full eligible collection; Home carries
  // the approved preview of it. Live record-presence is judged across both.
  const enHub = bodies.get(EN_HUB_ROUTE);
  const sitemapBody = bodies.get('/sitemap.xml');

  for (const record of targets.recordTargets) {
    const label = `${record.id}`;

    // Route/sitemap correspondence, from canonical data (never a second list).
    emit.check({
      id: `ttd:sitemap:${label}`,
      name: 'canonical detail route present in live sitemap',
      status: sitemapBody === undefined ? 'SKIP' : sitemapBody.includes(`${baseUrl}${record.enRoute}`) ? 'PASS' : 'FAIL',
      route: record.enRoute,
      locale: 'en',
      observed: sitemapBody === undefined ? 'sitemap not fetched' : sitemapBody.includes(`${baseUrl}${record.enRoute}`),
      expected: `<loc>${baseUrl}${record.enRoute}</loc>`,
    });
    if (sitemapBody !== undefined && !sitemapBody.includes(`${baseUrl}${record.enRoute}`)) {
      emit.issue({
        code: 'SITEMAP_ROUTE_MISSING',
        severity: 'ERROR',
        category: 'CONTENT',
        check: 'canonical detail route present in live sitemap',
        route: record.enRoute,
        locale: 'en',
        observed: 'absent from live sitemap.xml',
        expected: `<loc>${baseUrl}${record.enRoute}</loc>`,
        evidence: { record_id: record.id },
        resolver_class: 'CONTENT_GOVERNANCE',
        auto_remediation_candidate: true,
      });
    }

    const enBody = bodies.get(record.enRoute);
    if (enBody !== undefined) {
      const hasTitle = htmlContains(enBody, (value) => `<h1>${value}</h1>`, record.title);
      const hasProvider = enBody.includes(record.provider) || enBody.includes(escapeHtml(record.provider));
      emit.check({
        id: `ttd:identity:${label}`,
        name: 'event identity represented on detail page',
        status: hasTitle && hasProvider ? 'PASS' : 'FAIL',
        route: record.enRoute,
        locale: 'en',
        observed: { title: hasTitle, provider: hasProvider },
        expected: { title: true, provider: true },
      });
      if (!hasTitle || !hasProvider) {
        emit.issue({
          code: 'TTD_IDENTITY_MISSING',
          severity: 'ERROR',
          category: 'CONTENT',
          check: 'event identity represented on detail page',
          route: record.enRoute,
          locale: 'en',
          observed: { title_present: hasTitle, provider_present: hasProvider },
          expected: { title: record.title, provider: record.provider },
          evidence: { record_id: record.id },
          resolver_class: 'CONTENT_GOVERNANCE',
        });
      }
    }

    // EN/PT surface equivalence on the live site: whenever the repository
    // publishes a PT counterpart, the live PT route must exist too.
    if (record.ptExistsInRepo) {
      const ptFetched = bodies.has(record.ptRoute);
      const enFetched = bodies.has(record.enRoute);
      if (enFetched && !ptFetched) {
        emit.issue({
          code: 'LOCALE_PT_ROUTE_MISSING',
          severity: 'ERROR',
          category: 'LOCALIZATION',
          check: 'PT counterpart route is live',
          route: record.ptRoute,
          locale: 'pt',
          observed: 'PT route did not return a usable page while the EN route did',
          expected: 'both EN and PT detail routes live',
          evidence: { record_id: record.id, en_route: record.enRoute },
          resolver_class: 'LOCALIZATION',
          auto_remediation_candidate: true,
        });
      }
      emit.check({
        id: `ttd:pt-parity:${label}`,
        name: 'PT counterpart route is live',
        status: !enFetched ? 'SKIP' : ptFetched ? 'PASS' : 'FAIL',
        route: record.ptRoute,
        locale: 'pt',
        observed: { en_live: enFetched, pt_live: ptFetched },
        expected: 'EN live implies PT live',
      });
    }

    // Public currentness, judged against the committed currentness contract.
    //
    // Since the Project 03 collection approval this spans TWO surfaces: Home
    // shows the approved limited preview and the hub shows the full eligible
    // collection. An eligible record beyond the preview is correctly absent
    // from Home and present on the hub, so "surfaced" means present on either
    // one — and an expired record must be on neither.
    if (enHome !== undefined) {
      const onHome = htmlContains(enHome, (value) => `<h3>${value}</h3>`, record.title);
      const onHub = enHub === undefined ? false : htmlContains(enHub, (value) => `<h3>${value}</h3>`, record.title);
      const onSurface = onHome || onHub;
      // The hub is only decisive when it was actually fetched. If it was not,
      // a preview member is still fully checkable on Home; a record beyond the
      // preview is not, and is skipped rather than reported on no evidence.
      const checkable = onHome || enHub !== undefined || record.inHomePreview;
      if (record.expiredAtAsOf && onSurface) {
        emit.issue({
          code: 'TTD_EXPIRED_SURFACED',
          severity: 'ERROR',
          category: 'CONTENT',
          check: 'expired record is not surfaced on Home',
          route: '/',
          locale: 'en',
          observed: `${record.id} is on the live ${onHome ? 'Home' : 'collection hub'} surface`,
          expected: `${record.id} absent (expired as of ${targets.asOf})`,
          evidence: { record_id: record.id, end_date: record.endDate, publication_state: record.publicationState, on_home: onHome, on_hub: onHub },
          resolver_class: 'CONTENT_GOVERNANCE',
          auto_remediation_candidate: true,
        });
      } else if (!record.expiredAtAsOf && !onSurface && checkable) {
        emit.issue({
          code: 'TTD_CURRENT_RECORD_MISSING_FROM_HOME',
          severity: 'ERROR',
          category: 'CONTENT',
          check: 'current record is surfaced on Home',
          route: '/',
          locale: 'en',
          observed: `${record.id} absent from the live Home preview and collection hub`,
          expected: `${record.id} present on Home or the collection hub (current as of ${targets.asOf})`,
          evidence: { record_id: record.id, end_date: record.endDate, in_home_preview: record.inHomePreview, hub_fetched: enHub !== undefined },
          resolver_class: 'CONTENT_GOVERNANCE',
          auto_remediation_candidate: true,
        });
      } else if (!record.expiredAtAsOf && record.expiredToday && onSurface) {
        // Not a defect: the committed surfaces are correct for the currentness
        // date they were generated for, and the record has simply aged since.
        emit.issue({
          code: 'TTD_CURRENTNESS_DRIFT',
          severity: 'WARNING',
          category: 'CONTENT',
          check: 'live Home currentness against today',
          route: '/',
          locale: 'en',
          observed: `${record.id} ended ${record.endDate} but is still on a public collection surface (surfaces generated for ${targets.asOf})`,
          expected: `a publication run with as_of >= ${targets.today}`,
          evidence: { record_id: record.id, end_date: record.endDate, committed_as_of: targets.asOf, today: targets.today },
          resolver_class: 'CONTENT_GOVERNANCE',
          auto_remediation_candidate: true,
        });
      }
      emit.check({
        id: `ttd:home:${label}`,
        name: 'public collection currentness matches canonical record',
        status: !checkable ? 'SKIP' : record.expiredAtAsOf === onSurface ? 'FAIL' : 'PASS',
        route: '/',
        locale: 'en',
        observed: {
          on_home: onHome,
          on_hub: onHub,
          in_home_preview: record.inHomePreview,
          expired_at_as_of: record.expiredAtAsOf,
          expired_today: record.expiredToday,
        },
        expected: { on_public_surface: !record.expiredAtAsOf },
      });
    }
  }

  // Live sitemap must agree with the live public route set in both directions.
  if (sitemapBody !== undefined) {
    const liveSitemapRoutes = [...sitemapBody.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => new URL(match[1]).pathname);
    const repoSitemapRoutes = new Set(targets.sitemapRoutes);
    const extra = liveSitemapRoutes.filter((route) => !repoSitemapRoutes.has(route));
    const missing = targets.sitemapRoutes.filter((route) => !liveSitemapRoutes.includes(route));
    emit.check({
      id: 'ttd:sitemap-agreement',
      name: 'live sitemap agrees with canonical public routes',
      status: extra.length || missing.length ? 'FAIL' : 'PASS',
      route: '/sitemap.xml',
      observed: { extra, missing },
      expected: 'live sitemap equals the canonical route set',
    });
    if (extra.length || missing.length) {
      emit.issue({
        code: 'SITEMAP_PUBLIC_ROUTE_MISMATCH',
        severity: 'ERROR',
        category: 'CONTENT',
        check: 'live sitemap agrees with canonical public routes',
        route: '/sitemap.xml',
        observed: { unexpected_in_live_sitemap: extra, missing_from_live_sitemap: missing },
        expected: 'live sitemap equals the canonical route set derived from repository data',
        evidence: { canonical_route_count: targets.sitemapRoutes.length, live_route_count: liveSitemapRoutes.length },
        resolver_class: 'CONTENT_GOVERNANCE',
        auto_remediation_candidate: true,
      });
    }
  }
}

/**
 * Localization health beyond the per-route lang/brand checks: a small set of
 * governed PT values that must appear on the live PT Home. The expected values
 * are read from the generated locale data, not hardcoded here, so Project 09
 * remains the single source of truth.
 */
function checkLocalizationHealth(emit, { bodies, localeData }) {
  const ptHome = bodies.get('/pt/');
  const requiredKeys = ['nav.home', 'nav.about', 'nav.mindelo_essentials'];
  if (ptHome === undefined) {
    emit.check({ id: 'locale:pt-home-values', name: 'governed PT values present on PT Home', status: 'SKIP', route: '/pt/', locale: 'pt', observed: 'PT Home not fetched', expected: requiredKeys });
    return;
  }
  const missing = [];
  for (const key of requiredKeys) {
    const entry = localeData.keys[key];
    if (!entry || !entry.pt) continue;
    if (!ptHome.includes(entry.pt) && !ptHome.includes(escapeHtml(entry.pt))) missing.push({ key, expected_pt: entry.pt });
  }
  emit.check({
    id: 'locale:pt-home-values',
    name: 'governed PT values present on PT Home',
    status: missing.length ? 'FAIL' : 'PASS',
    route: '/pt/',
    locale: 'pt',
    observed: { missing },
    expected: requiredKeys,
  });
  if (missing.length) {
    emit.issue({
      code: 'LOCALE_REQUIRED_VALUE_MISSING',
      severity: 'ERROR',
      category: 'LOCALIZATION',
      check: 'governed PT values present on PT Home',
      route: '/pt/',
      locale: 'pt',
      observed: missing,
      expected: 'each governed PT navigation value rendered on the live PT Home',
      evidence: { source: 'data/locales/locale-data.generated.json' },
      resolver_class: 'LOCALIZATION',
      auto_remediation_candidate: true,
    });
  }
}

/**
 * Bounded readiness poll for the immediate mode.
 *
 * GitHub Pages publishes asynchronously after a merge, so checking the live
 * site the instant the push event fires reports propagation as a defect. This
 * waits for the expected SHA to leave the pending state, for a strictly bounded
 * budget, and then proceeds regardless — a runner is never parked indefinitely,
 * and a still-pending result is reported honestly as PENDING rather than
 * waited out.
 */
async function waitForDeployment({ repo, expectedSha, token, commitTimestamp, waitMs, pollMs, notes }) {
  const deadline = Date.now() + Math.max(0, waitMs);
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const provenance = await resolveDeploymentProvenance({ repo, expectedSha, token, commitTimestamp });
    const settled = provenance.state === 'DEPLOYMENT_VERIFIED' || provenance.state === 'DEPLOYMENT_FAILED';
    if (settled || Date.now() >= deadline) {
      if (attempts > 1) notes.push(`deployment readiness poll: ${attempts} attempt(s), final state ${provenance.state}`);
      return provenance;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

// --------------------------------------------------------------------------
// Step summary
// --------------------------------------------------------------------------

function renderStepSummary(report) {
  const lines = [];
  lines.push(`## Post-publication QA — ${report.mode}`);
  lines.push('');
  lines.push(`**Overall:** \`${report.overall_status}\` · **Target:** ${report.target.base_url} · **Deployment:** \`${report.target.deployment_state}\``);
  lines.push('');
  lines.push('| Domain | Status |');
  lines.push('| --- | --- |');
  for (const domain of DOMAINS) lines.push(`| ${domain} | \`${report.domains[domain]}\` |`);
  lines.push('');
  lines.push(`Checks: ${report.counts.checks} (${report.counts.checks_failed} failed) · Issues: ${report.counts.issues} ` +
    `(CRITICAL ${report.counts.issues_by_severity.CRITICAL}, ERROR ${report.counts.issues_by_severity.ERROR}, ` +
    `WARNING ${report.counts.issues_by_severity.WARNING}, INFO ${report.counts.issues_by_severity.INFO})`);
  lines.push('');
  lines.push(`Expected main SHA: \`${report.target.expected_main_sha ?? 'unknown'}\` · Observed deployment SHA: \`${report.target.observed_deployment_sha ?? 'unknown'}\``);

  const notable = report.issues.filter((issue) => issue.severity !== 'INFO').slice(0, 40);
  if (notable.length) {
    lines.push('');
    lines.push('### Issues');
    lines.push('');
    lines.push('| Severity | Code | Route | Resolver | Observed |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const issue of notable) {
      const observed = typeof issue.observed === 'string' ? issue.observed : JSON.stringify(issue.observed);
      lines.push(`| ${issue.severity} | \`${issue.code}\` | ${issue.route ?? '—'} | ${issue.resolver_class} | ${String(observed ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160)} |`);
    }
    if (report.issues.filter((issue) => issue.severity !== 'INFO').length > notable.length) {
      lines.push('');
      lines.push(`_… and ${report.issues.filter((issue) => issue.severity !== 'INFO').length - notable.length} more; see the JSON artifact._`);
    }
  }
  lines.push('');
  lines.push('_Phase 2A is detection-only: this run made no change to the repository, the deployment, or any external system._');
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

export async function run(argv) {
  const args = parseArgs(argv);
  const { baseUrl, environment } = resolveBaseUrl(args.baseUrl);
  const startedAt = new Date().toISOString();
  const state = { checks: [], issues: [] };
  const emitter = makeEmitter(state);
  const notes = [];

  const affectedRoutes = readAffectedRoutes(args);
  const targets = loadTargets(ROOT, { affectedRoutes });
  const localeData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'locales', 'locale-data.generated.json'), 'utf8'));

  const outDir = path.resolve(ROOT, args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const wantsBrowser = args.forceBrowser
    || (!args.skipBrowser && ['IMMEDIATE_POST_DEPLOY', 'WEEKLY_DEEP', 'MANUAL'].includes(args.mode));
  const wantsSource = !args.skipSource;

  const domainsRun = ['LIVE_HTTP_VALIDATION', 'DEPLOYMENT_PROVENANCE'];
  if (wantsSource) domainsRun.push('SOURCE_VALIDATION');
  if (wantsBrowser) domainsRun.push('LIVE_BROWSER_VALIDATION');

  // --- DEPLOYMENT_PROVENANCE ---------------------------------------------
  const deploymentEmit = emitter('DEPLOYMENT_PROVENANCE');
  let provenance;
  if (args.deploymentFixture) {
    // Test-only injection point, gated by the same loopback-only env flag that
    // guards the base URL. Never reachable in a production run.
    if (process.env[TEST_TARGET_ENV] !== '1') throw new Error('--deployment-fixture requires the test-target env flag');
    provenance = JSON.parse(fs.readFileSync(args.deploymentFixture, 'utf8'));
  } else {
    provenance = await waitForDeployment({
      repo: args.repo ?? process.env.GITHUB_REPOSITORY ?? null,
      expectedSha: args.expectedSha ?? null,
      token: process.env.GITHUB_TOKEN ?? null,
      commitTimestamp: args.commitTimestamp ?? null,
      waitMs: Number.isFinite(args.deploymentWaitMs) ? args.deploymentWaitMs : 0,
      pollMs: Number.isFinite(args.deploymentPollMs) ? args.deploymentPollMs : 30000,
      notes,
    });
  }
  deploymentEmit.check({
    id: 'deployment:provenance',
    name: 'deployed commit identified',
    status: provenance.state === 'DEPLOYMENT_VERIFIED' ? 'PASS'
      : provenance.state === 'DEPLOYMENT_FAILED' ? 'FAIL'
        : provenance.state === 'DEPLOYMENT_PENDING' ? 'WARN' : 'UNKNOWN',
    observed: { state: provenance.state, observed_sha: provenance.observedSha, reason: provenance.reason },
    expected: { state: 'DEPLOYMENT_VERIFIED', expected_sha: args.expectedSha ?? null },
    evidence: provenance.evidence,
  });
  if (provenance.state === 'DEPLOYMENT_FAILED') {
    deploymentEmit.issue({
      code: 'DEPLOYMENT_FAILED',
      severity: 'CRITICAL',
      category: 'DEPLOYMENT',
      check: 'deployed commit identified',
      observed: provenance.reason,
      expected: 'a successful github-pages deployment of the expected SHA',
      evidence: provenance.evidence,
      resolver_class: 'DEPLOYMENT',
    });
  } else if (provenance.state === 'DEPLOYMENT_PENDING') {
    deploymentEmit.issue({
      code: 'DEPLOYMENT_PENDING',
      severity: 'INFO',
      category: 'DEPLOYMENT',
      check: 'deployed commit identified',
      observed: provenance.reason,
      expected: 'a successful github-pages deployment of the expected SHA',
      evidence: provenance.evidence,
      resolver_class: 'DEPLOYMENT',
      retryable: true,
    });
  } else if (provenance.state === 'DEPLOYMENT_UNKNOWN') {
    deploymentEmit.issue({
      code: 'DEPLOYMENT_SHA_UNKNOWN',
      severity: 'INFO',
      category: 'DEPLOYMENT',
      check: 'deployed commit identified',
      observed: provenance.reason,
      expected: 'deployment metadata identifying the live commit',
      evidence: provenance.evidence,
      resolver_class: 'DEPLOYMENT',
      retryable: true,
    });
  }

  // --- SOURCE_VALIDATION --------------------------------------------------
  if (wantsSource) {
    await runSourceValidation(emitter('SOURCE_VALIDATION'), { asOf: targets.asOf, today: targets.today });
  }

  // --- LIVE_HTTP_VALIDATION ----------------------------------------------
  // The pass is repeatable and collects into its own arrays, so an edge-grace
  // retry *replaces* the previous attempt rather than accumulating a second
  // copy of every finding.
  const runLiveHttpPass = async () => {
    const checks = [];
    const issues = [];
    const httpEmit = {
      check: (spec) => checks.push(makeCheck({ domain: 'LIVE_HTTP_VALIDATION', ...spec })),
      issue: (spec) => issues.push(makeIssue({ domain: 'LIVE_HTTP_VALIDATION', ...spec })),
    };
    const bodies = new Map();

    for (const document of targets.documents) {
      const response = await fetchAndCheckRoute(httpEmit, { baseUrl, route: document, kind: 'document' });
      if (response) bodies.set(document, response.body);
    }
    for (const page of selectHttpRoutes(targets, args.mode)) {
      const response = await fetchAndCheckRoute(httpEmit, { baseUrl, route: page.route, locale: page.locale, kind: 'page' });
      if (response) bodies.set(page.route, response.body);
    }
    // EN Home is required for the Home currentness contract even when the mode's
    // route selection would not otherwise have fetched it.
    if (!bodies.has('/')) {
      const response = await fetchAndCheckRoute(httpEmit, { baseUrl, route: '/', locale: 'en', kind: 'page' });
      if (response) bodies.set('/', response.body);
    }
    for (const asset of targets.assets) {
      await fetchAndCheckRoute(httpEmit, { baseUrl, route: asset, kind: 'asset' });
    }

    checkThingsToDoLiveContract(httpEmit, { targets, bodies, baseUrl });
    checkLocalizationHealth(httpEmit, { bodies, localeData });
    return { checks, issues, bodies };
  };

  const homeRepoBody = fs.existsSync(path.join(ROOT, 'index.html')) ? fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8') : null;
  const edgeGraceMs = Number.isFinite(args.edgeGraceMs) ? args.edgeGraceMs : DEFAULT_EDGE_GRACE_MS;
  const edgeRetryMs = Number.isFinite(args.edgeRetryMs) ? args.edgeRetryMs : DEFAULT_EDGE_RETRY_MS;
  // Grace is scoped to the one situation it exists for: the run that fires
  // immediately after GitHub confirmed the expected commit was published.
  const edgeGraceApplies = args.mode === 'IMMEDIATE_POST_DEPLOY'
    && provenance.state === 'DEPLOYMENT_VERIFIED'
    && edgeGraceMs > 0;

  let pass = await runLiveHttpPass();
  let edgeAttempts = 1;
  // Home-byte corroboration is INFORMATIONAL ONLY. It says one cache key is
  // current; it says nothing about whether /pt/ or an event detail route has
  // converged, because those are different cache keys on different edges. It
  // used to end the whole grace window, which produced exactly the false
  // failure this mechanism exists to prevent: Home current, /pt/ transiently
  // 404, one request made, run marked FAILED. It is now recorded and never
  // consulted by the retry loop.
  let corroborated = corroborateByContent(pass.bodies.get('/') ?? null, homeRepoBody);
  const edgeGraceTrace = [];

  /**
   * Per-finding identity. Grace is owned by the individual finding, not by the
   * run: each unresolved finding is re-evaluated every attempt and stops being
   * retried only when it personally clears or the global deadline expires.
   */
  const findingKey = (issue) => `${issue.code}|${issue.route ?? '-'}|${issue.locale ?? '-'}`;
  const tracked = new Map();

  const observeAttempt = (issues, attempt) => {
    const eligible = issues.filter(isPropagationEligible);
    const present = new Set(eligible.map(findingKey));
    for (const issue of eligible) {
      const key = findingKey(issue);
      if (!tracked.has(key)) {
        tracked.set(key, {
          key,
          code: issue.code,
          route: issue.route ?? null,
          locale: issue.locale ?? null,
          first_seen_attempt: attempt,
          resolved_at_attempt: null,
        });
      } else {
        // Seen again: if it had cleared and came back, it is unresolved again.
        tracked.get(key).resolved_at_attempt = null;
      }
    }
    const resolvedNow = [];
    for (const entry of tracked.values()) {
      if (!present.has(entry.key) && entry.resolved_at_attempt === null) {
        entry.resolved_at_attempt = attempt;
        resolvedNow.push(entry.key);
      }
    }
    return { unresolved: eligible, resolvedNow };
  };

  if (edgeGraceApplies) {
    const deadline = Date.now() + edgeGraceMs;
    let observation = observeAttempt(pass.issues, edgeAttempts);

    // Keep going while ANY tracked finding is still unresolved. There is no
    // global early exit: the only two ways a finding stops being retried are
    // recovering, or the deadline running out for everyone.
    while (observation.unresolved.length > 0) {
      if (Date.now() + edgeRetryMs > deadline) break;

      edgeGraceTrace.push({
        attempt: edgeAttempts,
        codes: [...new Set(observation.unresolved.map((issue) => issue.code))],
        routes: [...new Set(observation.unresolved.map((issue) => issue.route).filter(Boolean))].slice(0, 20),
        unresolved_keys: observation.unresolved.map(findingKey).slice(0, 20),
        resolved_since_previous_attempt: observation.resolvedNow.slice(0, 20),
      });

      await sleep(edgeRetryMs);
      edgeAttempts += 1;
      pass = await runLiveHttpPass();
      corroborated = corroborateByContent(pass.bodies.get('/') ?? null, homeRepoBody);
      observation = observeAttempt(pass.issues, edgeAttempts);
    }
  }

  const edgeFindingTrace = [...tracked.values()];

  const bodies = pass.bodies;
  state.checks.push(...pass.checks);
  // Findings that outlived the window keep their severity and gain the record
  // that propagation was considered and ruled out.
  state.issues.push(...(edgeGraceApplies && edgeAttempts > 1
    ? annotateEdgeGraceExhausted(pass.issues, { attempts: edgeAttempts, windowMs: edgeGraceMs, corroborated })
    : pass.issues));

  // Each retried attempt is recorded as its own INFO finding, tagged as
  // propagation-related, so a run that recovered still shows what it saw first.
  const edgeEmit = emitter('LIVE_HTTP_VALIDATION');
  for (const entry of edgeGraceTrace) {
    edgeEmit.issue({
      code: 'EDGE_PROPAGATION_RETRY',
      severity: 'INFO',
      category: 'ROUTE',
      check: 'post-deployment edge serves the verified commit',
      observed: `attempt ${entry.attempt} of the live pass found ${entry.codes.join(', ')} on ${entry.routes.length} route(s)`,
      expected: 'every edge serves the commit GitHub reported as published',
      evidence: {
        propagation_related: true,
        attempt: entry.attempt,
        codes: entry.codes,
        routes: entry.routes,
        // Which individual findings were still unresolved at this attempt, and
        // which had cleared since the previous one. Retry is per finding.
        unresolved_keys: entry.unresolved_keys,
        resolved_since_previous_attempt: entry.resolved_since_previous_attempt,
        edge_grace_window_ms: edgeGraceMs,
        edge_retry_ms: edgeRetryMs,
        deployment_state: provenance.state,
      },
      resolver_class: 'DEPLOYMENT',
      deterministic: false,
      retryable: true,
    });
  }
  if (edgeGraceApplies && edgeAttempts > 1) {
    notes.push(`edge readiness: ${edgeAttempts} live pass(es) within a ${edgeGraceMs}ms grace window at ${edgeRetryMs}ms cadence`);
  }
  emitter('DEPLOYMENT_PROVENANCE').check({
    id: 'deployment:edge-readiness',
    name: 'post-deployment edge serves the verified commit',
    status: !edgeGraceApplies ? 'SKIP'
      : pass.issues.some(isPropagationEligible) ? 'FAIL' : 'PASS',
    observed: {
      grace_applies: edgeGraceApplies,
      attempts: edgeAttempts,
      findings_tracked: edgeFindingTrace.length,
      findings_recovered: edgeFindingTrace.filter((entry) => entry.resolved_at_attempt !== null).length,
      findings_unresolved: edgeFindingTrace.filter((entry) => entry.resolved_at_attempt === null).length,
    },
    expected: 'no propagation-eligible mismatch remains once the grace window closes',
    evidence: {
      window_ms: edgeGraceMs,
      retry_ms: edgeRetryMs,
      mode: args.mode,
      deployment_state: provenance.state,
      // Per finding: when it first appeared and when it cleared. This is the
      // record that each one was retried on its own terms.
      findings: edgeFindingTrace,
      // Informational only. Never used to stop retrying anything.
      live_home_matches_checked_out_bytes: corroborated,
      home_corroboration_is_advisory: true,
    },
  });

  // Content corroboration for deployment identity — supporting evidence only.
  if (corroborated !== null) {
    provenance.evidence = { ...provenance.evidence, live_home_matches_checked_out_bytes: corroborated };
  }

  // --- LIVE_BROWSER_VALIDATION -------------------------------------------
  let screenshots = [];
  if (wantsBrowser) {
    const browserEmit = emitter('LIVE_BROWSER_VALIDATION');
    const browserRoutes = selectBrowserRoutes(targets, args.mode);
    screenshots = await runBrowserChecks({
      baseUrl,
      routes: browserRoutes,
      viewports: VIEWPORTS,
      requiredMedia: targets.assets,
      screenshotDir: path.join(outDir, 'screenshots'),
      emit: browserEmit,
      notes,
    });
  }

  const completedAt = new Date().toISOString();
  const report = makeReport({
    mode: args.mode,
    target: {
      environment,
      base_url: baseUrl,
      expected_main_sha: args.expectedSha ?? null,
      observed_deployment_sha: provenance.observedSha ?? null,
      deployment_state: provenance.state,
      deployment_evidence: provenance.evidence ?? {},
      currentness_as_of: targets.asOf,
      affected_routes: targets.affectedRoutes,
    },
    started_at: startedAt,
    completed_at: completedAt,
    checks: state.checks,
    issues: state.issues,
    domainsRun,
    run: {
      workflow: process.env.GITHUB_WORKFLOW ?? null,
      run_id: process.env.GITHUB_RUN_ID ?? null,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      trigger_event: process.env.GITHUB_EVENT_NAME ?? null,
    },
    evidence_artifacts: screenshots.map((file) => path.relative(outDir, file)),
    notes,
  });

  const schemaErrors = validateAgainstSchema(report, loadSchema(SCHEMA_PATH));
  if (schemaErrors.length) {
    // A report that does not match its own published contract is itself a
    // defect, and must not be passed off as a valid result.
    report.notes.push(...schemaErrors.map((error) => `schema violation: ${error}`));
  }

  const reportPath = path.join(outDir, 'post-publication-qa.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const summary = renderStepSummary(report);
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

  return { report, reportPath, schemaErrors, summary, failOn: args.failOn };
}

function exitCodeFor(report, failOn, schemaErrors) {
  if (schemaErrors.length) return 1;
  if (failOn === 'never') return 0;
  return report.overall_status === 'FAILED' ? 1 : 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  run(process.argv.slice(2))
    .then(({ report, reportPath, schemaErrors, summary, failOn }) => {
      console.log(summary);
      console.log(`\nReport written to ${reportPath}`);
      for (const error of schemaErrors) console.error(`schema violation: ${error}`);
      process.exit(exitCodeFor(report, failOn, schemaErrors));
    })
    .catch((error) => {
      console.error(`post-publication QA runner failed: ${error.message}`);
      process.exit(2);
    });
}

export { exitCodeFor, resolveBaseUrl, todayInCapeVerde };
