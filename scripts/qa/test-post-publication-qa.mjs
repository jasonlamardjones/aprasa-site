#!/usr/bin/env node
// Deterministic test matrix for the Phase 2A post-publication QA layer.
//
// Every case runs against a local loopback fixture server or an in-process
// stub. Production is never contacted and never modified. Run with:
//   node scripts/qa/test-post-publication-qa.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.APRASA_QA_ALLOW_TEST_TARGET = '1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { makeIssue, makeReport, rollupOverallStatus, applyPropagationGrace } = await import('./lib/qa-contract.mjs');
const { loadSchema, validateAgainstSchema } = await import('./lib/qa-schema.mjs');
const { loadTargets } = await import('./lib/qa-targets.mjs');
const { classifyConsoleMessage, classifyNetworkFailure } = await import('./lib/qa-classify.mjs');
const { isNormalizingRedirect } = await import('./lib/qa-http.mjs');
const { resolveDeploymentProvenance } = await import('./lib/qa-deployment.mjs');
const { readRouteBytes, startFixtureServer } = await import('./lib/qa-fixture-server.mjs');
const { runBrowserChecks } = await import('./lib/qa-browser.mjs');
const { findChrome } = await import('./lib/cdp.mjs');
const { run, exitCodeFor, resolveBaseUrl } = await import('./run-post-publication-qa.mjs');

const SCHEMA = loadSchema(path.join(ROOT, 'scripts', 'qa', 'qa-report.schema.json'));
// Pin the QA clock to the committed currentness date so date-boundary drift
// does not leak into cases that are not about drift.
const COMMITTED_AS_OF = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'things-to-do-currentness.json'), 'utf8')).as_of;

const results = [];
let failures = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

async function testCase(name, fn) {
  try {
    await fn((ok, detail) => record(name, ok, detail));
  } catch (error) {
    record(name, false, `threw: ${error.stack ?? error.message}`);
  }
}

function tempOut(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aprasa-qa-${label}-`));
}

function writeDeploymentFixture(dir, state, extra = {}) {
  const file = path.join(dir, 'deployment.json');
  fs.writeFileSync(file, JSON.stringify({
    state,
    observedSha: extra.observedSha ?? null,
    reason: extra.reason ?? 'TEST_FIXTURE',
    evidence: { source: 'test-fixture' },
  }));
  return file;
}

const targets = loadTargets(ROOT);

/**
 * Run the full HTTP-domain runner against a fixture site.
 * `mutate` receives the healthy site map and injects a single defect.
 */
async function runAgainstFixture({ mutate = () => {}, mode = 'DAILY_LIGHTWEIGHT', deploymentState = 'DEPLOYMENT_VERIFIED', skipSource = true, today = COMMITTED_AS_OF }) {
  const overrides = new Map();
  mutate(overrides);
  const server = await startFixtureServer(overrides, { root: ROOT });
  const out = tempOut('run');
  const previousToday = process.env.APRASA_QA_TODAY;
  process.env.APRASA_QA_TODAY = today;
  try {
    const argv = [
      `--mode=${mode}`,
      `--base-url=${server.origin}`,
      `--out=${out}`,
      '--skip-browser',
      `--deployment-fixture=${writeDeploymentFixture(out, deploymentState, { observedSha: 'a'.repeat(40) })}`,
    ];
    if (skipSource) argv.push('--skip-source');
    return await run(argv);
  } finally {
    if (previousToday === undefined) delete process.env.APRASA_QA_TODAY;
    else process.env.APRASA_QA_TODAY = previousToday;
    await server.close();
  }
}

const codesIn = (report) => new Set(report.issues.map((issue) => issue.code));
const errorsIn = (report) => report.issues.filter((issue) => issue.severity === 'ERROR' || issue.severity === 'CRITICAL');

// ---------------------------------------------------------------------------
// 1. Healthy site fixture
// ---------------------------------------------------------------------------
await testCase('01 healthy site fixture reports HEALTHY with no errors', async (assert) => {
  const { report, schemaErrors } = await runAgainstFixture({ skipSource: false });
  const ok = report.overall_status === 'HEALTHY' && errorsIn(report).length === 0 && schemaErrors.length === 0;
  assert(ok, `overall=${report.overall_status} errors=${JSON.stringify(errorsIn(report).map((i) => [i.code, i.route, i.observed]))} schema=${schemaErrors.join('; ')}`);
});

// ---------------------------------------------------------------------------
// 2. Required-route 404
// ---------------------------------------------------------------------------
await testCase('02 required route 404 becomes ERROR / FAILED', async (assert) => {
  const { report } = await runAgainstFixture({
    mutate: (overrides) => overrides.set('/about/', null),
  });
  const issue = report.issues.find((candidate) => candidate.code === 'ROUTE_NOT_FOUND' && candidate.route === '/about/');
  assert(
    Boolean(issue) && issue.severity === 'ERROR' && report.overall_status === 'FAILED' && issue.resolver_class === 'TECHNICAL',
    `overall=${report.overall_status} issue=${JSON.stringify(issue)}`
  );
});

// ---------------------------------------------------------------------------
// 3. Redirect mismatch
// ---------------------------------------------------------------------------
await testCase('03 unexpected redirect becomes ERROR, normalisation stays INFO', async (assert) => {
  const { report } = await runAgainstFixture({
    mutate: (overrides) => {
      overrides.set('/about/', { status: 301, body: Buffer.from(''), contentType: 'text/html', location: '/mindelo-essentials/' });
    },
  });
  const unexpected = report.issues.find((issue) => issue.code === 'ROUTE_REDIRECT_UNEXPECTED');
  const normalisationIsBenign = isNormalizingRedirect('https://aprasa.org/about', 'https://aprasa.org/about/', [{}]);
  assert(
    Boolean(unexpected) && unexpected.severity === 'ERROR' && report.overall_status === 'FAILED' && normalisationIsBenign,
    `issue=${JSON.stringify(unexpected)} normalisationBenign=${normalisationIsBenign}`
  );
});

// ---------------------------------------------------------------------------
// 4. Missing same-origin asset
// ---------------------------------------------------------------------------
await testCase('04 missing required same-origin asset becomes ERROR', async (assert) => {
  const { report } = await runAgainstFixture({
    mutate: (overrides) => overrides.set('/prasa-launch.css', null),
  });
  const issue = report.issues.find((candidate) => candidate.route === '/prasa-launch.css' && candidate.code === 'ROUTE_NOT_FOUND');
  assert(
    Boolean(issue) && issue.severity === 'ERROR' && issue.category === 'ASSET' && report.overall_status === 'FAILED',
    `issue=${JSON.stringify(issue)} overall=${report.overall_status}`
  );
});

// ---------------------------------------------------------------------------
// 11. EN route exists / PT route missing
// ---------------------------------------------------------------------------
await testCase('11 EN route live but PT counterpart missing becomes ERROR', async (assert) => {
  const record = targets.recordTargets.find((candidate) => candidate.ptExistsInRepo && !candidate.expiredAtAsOf);
  const { report } = await runAgainstFixture({
    mutate: (overrides) => overrides.set(record.ptRoute, null),
  });
  const issue = report.issues.find((candidate) => candidate.code === 'LOCALE_PT_ROUTE_MISSING' && candidate.route === record.ptRoute);
  assert(
    Boolean(issue) && issue.severity === 'ERROR' && issue.resolver_class === 'LOCALIZATION' && report.overall_status === 'FAILED',
    `record=${record.id} issue=${JSON.stringify(issue)}`
  );
});

// ---------------------------------------------------------------------------
// 12. Sitemap / public-route mismatch
// ---------------------------------------------------------------------------
await testCase('12 sitemap disagreeing with canonical routes becomes ERROR', async (assert) => {
  const { report } = await runAgainstFixture({
    mutate: (overrides) => {
      const sitemap = String(readRouteBytes(ROOT, '/sitemap.xml'));
      const broken = sitemap.replace(
        '</urlset>',
        '  <url>\n    <loc>https://aprasa.org/things-to-do/not-a-canonical-route/</loc>\n  </url>\n</urlset>'
      );
      overrides.set('/sitemap.xml', { status: 200, body: Buffer.from(broken), contentType: 'application/xml' });
    },
  });
  const issue = report.issues.find((candidate) => candidate.code === 'SITEMAP_PUBLIC_ROUTE_MISMATCH');
  assert(
    Boolean(issue) && issue.severity === 'ERROR' && issue.observed.unexpected_in_live_sitemap.includes('/things-to-do/not-a-canonical-route/'),
    `issue=${JSON.stringify(issue)}`
  );
});

// ---------------------------------------------------------------------------
// 13. Deployment pending
// ---------------------------------------------------------------------------
await testCase('13 deployment pending does not turn propagation into a false failure', async (assert) => {
  const { report, schemaErrors } = await runAgainstFixture({
    mutate: (overrides) => overrides.set('/about/', null),
    deploymentState: 'DEPLOYMENT_PENDING',
  });
  const downgraded = report.issues.find((issue) => issue.code === 'ROUTE_NOT_FOUND' && issue.route === '/about/');
  assert(
    Boolean(downgraded)
      && downgraded.severity === 'WARNING'
      && downgraded.evidence.downgrade_reason === 'DEPLOYMENT_PENDING_PROPAGATION_WINDOW'
      && report.overall_status === 'DEGRADED'
      && exitCodeFor(report, 'error', schemaErrors) === 0,
    `overall=${report.overall_status} issue=${JSON.stringify(downgraded)}`
  );
});

// ---------------------------------------------------------------------------
// 14. Deployment SHA unknown
// ---------------------------------------------------------------------------
await testCase('14 unknown deployment SHA yields UNKNOWN, not a false HEALTHY', async (assert) => {
  const { report } = await runAgainstFixture({ deploymentState: 'DEPLOYMENT_UNKNOWN' });
  const unknownIssue = report.issues.find((issue) => issue.code === 'DEPLOYMENT_SHA_UNKNOWN');
  assert(
    report.overall_status === 'UNKNOWN' && Boolean(unknownIssue) && unknownIssue.severity === 'INFO',
    `overall=${report.overall_status} issue=${JSON.stringify(unknownIssue)}`
  );
});

await testCase('14b unknown deployment SHA still reports FAILED when an independent defect exists', async (assert) => {
  const { report } = await runAgainstFixture({
    mutate: (overrides) => overrides.set('/about/', null),
    deploymentState: 'DEPLOYMENT_UNKNOWN',
  });
  assert(report.overall_status === 'FAILED', `overall=${report.overall_status}`);
});

// ---------------------------------------------------------------------------
// 15. Report schema validation
// ---------------------------------------------------------------------------
await testCase('15 report validates against the published schema, and violations are caught', async (assert) => {
  const { report, schemaErrors } = await runAgainstFixture({});
  const malformed = JSON.parse(JSON.stringify(report));
  malformed.overall_status = 'MOSTLY_FINE';
  malformed.issues.push({ ...report.issues[0], severity: 'CATASTROPHIC' });
  const malformedErrors = validateAgainstSchema(malformed, SCHEMA);
  assert(
    schemaErrors.length === 0 && malformedErrors.length >= 1,
    `valid=${schemaErrors.join('; ')} malformedErrors=${malformedErrors.length}`
  );
});

// ---------------------------------------------------------------------------
// 16 / 17. Severity ladder does not blur
// ---------------------------------------------------------------------------
await testCase('16 warnings degrade but never fail the workflow', async (assert) => {
  const warning = makeIssue({
    code: 'EXTERNAL_DEPENDENCY_WARNING',
    severity: 'WARNING',
    category: 'NETWORK',
    domain: 'LIVE_BROWSER_VALIDATION',
    check: 'analytics request',
    resolver_class: 'EXTERNAL_DEPENDENCY',
  });
  const report = makeReport({
    mode: 'MANUAL',
    target: { environment: 'production', base_url: 'https://aprasa.org', expected_main_sha: null, observed_deployment_sha: null, deployment_state: 'DEPLOYMENT_VERIFIED' },
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    checks: [],
    issues: [warning],
    domainsRun: ['LIVE_BROWSER_VALIDATION'],
  });
  assert(
    report.overall_status === 'DEGRADED' && exitCodeFor(report, 'error', []) === 0,
    `overall=${report.overall_status} exit=${exitCodeFor(report, 'error', [])}`
  );
});

await testCase('17 a deterministic error fails the workflow', async (assert) => {
  const error = makeIssue({
    code: 'ROUTE_NOT_FOUND',
    severity: 'ERROR',
    category: 'ROUTE',
    domain: 'LIVE_HTTP_VALIDATION',
    check: 'page returns 200',
    resolver_class: 'TECHNICAL',
  });
  const status = rollupOverallStatus([error], 'DEPLOYMENT_VERIFIED');
  const report = makeReport({
    mode: 'MANUAL',
    target: { environment: 'production', base_url: 'https://aprasa.org', expected_main_sha: null, observed_deployment_sha: null, deployment_state: 'DEPLOYMENT_VERIFIED' },
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    checks: [],
    issues: [error],
    domainsRun: ['LIVE_HTTP_VALIDATION'],
  });
  assert(status === 'FAILED' && exitCodeFor(report, 'error', []) === 1, `status=${status}`);
});

// ---------------------------------------------------------------------------
// Classification policy (cases 9 and 10 at policy level)
// ---------------------------------------------------------------------------
await testCase('09a analytics failure classifies as EXTERNAL_DEPENDENCY_WARNING', async (assert) => {
  const classification = classifyNetworkFailure({ url: 'https://plausible.io/js/pa.js', baseUrl: 'https://aprasa.org' });
  assert(
    classification.severity === 'WARNING' && classification.code === 'EXTERNAL_DEPENDENCY_WARNING' && classification.resolver_class === 'EXTERNAL_DEPENDENCY',
    JSON.stringify(classification)
  );
});

await testCase('09b unrecognised third party is surfaced as a warning, not silently ignored', async (assert) => {
  const classification = classifyNetworkFailure({ url: 'https://unknown-cdn.example/x.js', baseUrl: 'https://aprasa.org' });
  assert(
    classification.severity === 'WARNING' && classification.code === 'EXTERNAL_UNCLASSIFIED_FAILURE',
    JSON.stringify(classification)
  );
});

await testCase('10a first-party network failure classifies as ERROR', async (assert) => {
  const classification = classifyNetworkFailure({ url: 'https://aprasa.org/prasa-launch.css', baseUrl: 'https://aprasa.org', required: true });
  assert(
    classification.severity === 'ERROR' && classification.code === 'FIRST_PARTY_REQUEST_FAILED' && classification.resolver_class === 'TECHNICAL',
    JSON.stringify(classification)
  );
});

await testCase('10b third-party console error never escalates to ERROR', async (assert) => {
  const external = classifyConsoleMessage({ text: 'boom', sourceUrl: 'https://plausible.io/js/pa.js', baseUrl: 'https://aprasa.org' });
  const first = classifyConsoleMessage({ text: 'boom', sourceUrl: 'https://aprasa.org/prasa-launch.js', baseUrl: 'https://aprasa.org', kind: 'pageerror' });
  assert(
    external.severity === 'WARNING' && first.severity === 'ERROR' && first.code === 'FIRST_PARTY_PAGE_ERROR',
    `${JSON.stringify(external)} / ${JSON.stringify(first)}`
  );
});

// ---------------------------------------------------------------------------
// Deployment provenance conservatism
// ---------------------------------------------------------------------------
await testCase('provenance reports UNKNOWN without metadata access rather than guessing', async (assert) => {
  const noSha = await resolveDeploymentProvenance({});
  const noToken = await resolveDeploymentProvenance({ expectedSha: 'a'.repeat(40), repo: 'o/r' });
  assert(
    noSha.state === 'DEPLOYMENT_UNKNOWN' && noSha.reason === 'NO_EXPECTED_SHA'
      && noToken.state === 'DEPLOYMENT_UNKNOWN' && noToken.reason === 'NO_DEPLOYMENT_METADATA_ACCESS',
    `${noSha.reason} / ${noToken.reason}`
  );
});

await testCase('provenance maps Pages deployment states to the four provenance states', async (assert) => {
  const sha = 'b'.repeat(40);
  const stub = (state) => async (url) => {
    if (url.includes('/deployments?')) return { ok: true, json: async () => [{ id: 7, sha, created_at: new Date().toISOString() }] };
    return { ok: true, json: async () => [{ state }] };
  };
  const cases = [
    ['success', 'DEPLOYMENT_VERIFIED'],
    ['in_progress', 'DEPLOYMENT_PENDING'],
    ['failure', 'DEPLOYMENT_FAILED'],
    ['weird_state', 'DEPLOYMENT_UNKNOWN'],
  ];
  const observed = [];
  for (const [apiState, expected] of cases) {
    const result = await resolveDeploymentProvenance({ repo: 'o/r', expectedSha: sha, token: 't', fetchImpl: stub(apiState) });
    observed.push([apiState, result.state, expected]);
  }
  const missing = await resolveDeploymentProvenance({
    repo: 'o/r',
    expectedSha: 'c'.repeat(40),
    token: 't',
    commitTimestamp: new Date().toISOString(),
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });
  assert(
    observed.every(([, actual, expected]) => actual === expected) && missing.state === 'DEPLOYMENT_PENDING',
    `${JSON.stringify(observed)} missing=${missing.state}`
  );
});

// ---------------------------------------------------------------------------
// False-positive controls
// ---------------------------------------------------------------------------
await testCase('currentness date boundary drift warns, never errors', async (assert) => {
  const drifted = targets.recordTargets.filter((record) => !record.expiredAtAsOf && record.endDate);
  if (drifted.length === 0) {
    assert(true, 'no dated records to drift');
    return;
  }
  const dayAfter = new Date(`${drifted[0].endDate}T00:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  const { report, schemaErrors } = await runAgainstFixture({ today: dayAfter.toISOString().slice(0, 10) });
  const drift = report.issues.filter((issue) => issue.code === 'TTD_CURRENTNESS_DRIFT');
  assert(
    drift.length > 0
      && drift.every((issue) => issue.severity === 'WARNING' && issue.auto_remediation_candidate === true)
      && errorsIn(report).length === 0
      && exitCodeFor(report, 'error', schemaErrors) === 0,
    `drift=${drift.length} errors=${JSON.stringify(errorsIn(report).map((i) => i.code))}`
  );
});

await testCase('base URL is pinned to production unless a loopback test target is explicitly unlocked', async (assert) => {
  const production = resolveBaseUrl(undefined);
  let rejectedRemote = false;
  let rejectedHttps = false;
  const previous = process.env.APRASA_QA_ALLOW_TEST_TARGET;
  delete process.env.APRASA_QA_ALLOW_TEST_TARGET;
  try {
    resolveBaseUrl('https://example.com');
  } catch {
    rejectedRemote = true;
  }
  process.env.APRASA_QA_ALLOW_TEST_TARGET = '1';
  try {
    resolveBaseUrl('https://example.com');
  } catch {
    rejectedHttps = true;
  }
  process.env.APRASA_QA_ALLOW_TEST_TARGET = previous ?? '1';
  assert(
    production.baseUrl === 'https://aprasa.org' && production.environment === 'production' && rejectedRemote && rejectedHttps,
    `production=${JSON.stringify(production)} rejectedRemote=${rejectedRemote} rejectedHttps=${rejectedHttps}`
  );
});

await testCase('propagation grace never downgrades source or deployment findings', async (assert) => {
  const sourceIssue = makeIssue({ code: 'SOURCE_VALIDATOR_FAILED', severity: 'ERROR', category: 'SOURCE', domain: 'SOURCE_VALIDATION', check: 'x', resolver_class: 'CONTENT_GOVERNANCE' });
  const liveIssue = makeIssue({ code: 'ROUTE_NOT_FOUND', severity: 'ERROR', category: 'ROUTE', domain: 'LIVE_HTTP_VALIDATION', check: 'y', resolver_class: 'TECHNICAL' });
  const graced = applyPropagationGrace([sourceIssue, liveIssue], 'DEPLOYMENT_PENDING');
  assert(
    graced[0].severity === 'ERROR' && graced[1].severity === 'WARNING',
    JSON.stringify(graced.map((issue) => [issue.code, issue.severity]))
  );
});

// ---------------------------------------------------------------------------
// Delayed-recheck reconciliation (no sleeping runner)
// ---------------------------------------------------------------------------
const { decideDelayedRecheck, ARTIFACT_PREFIX } = await import('./reconcile-delayed-recheck.mjs');

function reconcileStub({ successAgeMinutes, artifactCount }) {
  const createdAt = new Date(Date.now() - successAgeMinutes * 60 * 1000).toISOString();
  return async (url) => {
    if (url.includes('/deployments?')) return { ok: true, json: async () => [{ id: 1, sha: 'd'.repeat(40), created_at: createdAt }] };
    if (url.includes('/statuses')) return { ok: true, json: async () => [{ state: 'success', created_at: createdAt }] };
    if (url.includes('/actions/artifacts')) return { ok: true, json: async () => ({ total_count: artifactCount }) };
    throw new Error(`unexpected url ${url}`);
  };
}

await testCase('delayed recheck fires once inside the 30-90 minute window and never repeats', async (assert) => {
  const tooSoon = await decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: reconcileStub({ successAgeMinutes: 5, artifactCount: 0 }) });
  const due = await decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: reconcileStub({ successAgeMinutes: 45, artifactCount: 0 }) });
  const alreadyDone = await decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: reconcileStub({ successAgeMinutes: 45, artifactCount: 1 }) });
  const tooLate = await decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: reconcileStub({ successAgeMinutes: 600, artifactCount: 0 }) });
  assert(
    tooSoon.run === false && tooSoon.reason === 'TOO_SOON'
      && due.run === true && due.artifact === `${ARTIFACT_PREFIX}${'d'.repeat(40)}`
      && alreadyDone.run === false && alreadyDone.reason === 'ALREADY_RECHECKED'
      && tooLate.run === false && tooLate.reason === 'WINDOW_PASSED',
    JSON.stringify([tooSoon.reason, due.reason, alreadyDone.reason, tooLate.reason])
  );
});

await testCase('delayed reconciler stays silent without metadata access', async (assert) => {
  const decision = await decideDelayedRecheck({ repo: null, token: null });
  assert(decision.run === false && decision.reason === 'NO_METADATA_ACCESS', JSON.stringify(decision));
});

// ---------------------------------------------------------------------------
// Browser cases 5 - 10, against synthetic loopback fixtures
// ---------------------------------------------------------------------------
function browserEmitter() {
  const checks = [];
  const issues = [];
  return {
    checks,
    issues,
    emit: {
      check: (spec) => checks.push(spec),
      issue: (spec) => issues.push(spec),
    },
  };
}

// Browser cases are served from an empty directory so that only the synthetic
// markup under test can respond; nothing from the working tree leaks in.
const BROWSER_FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-qa-empty-'));

const SHELL = (body, extraHead = '') => Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>fixture</title>${extraHead}</head>
<body>
<header class="site-header" aria-label="A PRASA"><nav class="site-nav" aria-label="Site navigation"><a href="/">Home</a></nav></header>
<main id="main"><h1>Fixture page</h1><p>${'Deterministic fixture body text. '.repeat(12)}</p>${body}</main>
<footer class="site-footer">A PRASA</footer>
</body></html>`);

async function runBrowserFixture(html, { viewportFilter = null } = {}) {
  const overrides = new Map([['/', { status: 200, body: html, contentType: 'text/html; charset=utf-8' }]]);
  const server = await startFixtureServer(overrides, { root: BROWSER_FIXTURE_ROOT });
  const collector = browserEmitter();
  const out = tempOut('browser');
  try {
    const { VIEWPORTS } = await import('./lib/qa-browser.mjs');
    await runBrowserChecks({
      baseUrl: server.origin,
      routes: [{ route: '/', locale: 'en' }],
      viewports: viewportFilter ? VIEWPORTS.filter((viewport) => viewport.name === viewportFilter) : VIEWPORTS,
      requiredMedia: ['/required-image.png'],
      screenshotDir: path.join(out, 'screenshots'),
      emit: collector.emit,
      notes: [],
      settleMs: 250,
    });
  } finally {
    await server.close();
  }
  return { ...collector, out };
}

const chromeAvailable = Boolean(findChrome());
if (!chromeAvailable) {
  record('05-10 browser cases', false, 'no Chrome/Chromium binary available; browser matrix could not run');
} else {
  await testCase('05 broken rendered image (zero naturalWidth) becomes ERROR', async (assert) => {
    const { issues } = await runBrowserFixture(
      SHELL('<img src="/definitely-missing.png" alt="broken fixture image" width="100" height="100">'),
      { viewportFilter: 'desktop' }
    );
    const issue = issues.find((candidate) => candidate.code === 'IMAGE_RENDER_BROKEN');
    assert(Boolean(issue) && issue.severity === 'ERROR' && issue.resolver_class === 'MEDIA', JSON.stringify(issues.map((i) => i.code)));
  });

  await testCase('06 mobile horizontal overflow becomes a reproducible ERROR', async (assert) => {
    const { issues } = await runBrowserFixture(
      SHELL('<div style="width:900px;height:40px;background:#ccc">wide</div>'),
      { viewportFilter: 'mobile' }
    );
    const issue = issues.find((candidate) => candidate.code === 'HORIZONTAL_OVERFLOW');
    assert(
      Boolean(issue) && issue.severity === 'ERROR' && issue.evidence.viewport === 'mobile' && Array.isArray(issue.evidence.offenders) && issue.evidence.offenders.length > 0,
      JSON.stringify(issue ?? issues.map((i) => i.code))
    );
  });

  await testCase('07 desktop horizontal overflow becomes a reproducible ERROR', async (assert) => {
    const { issues } = await runBrowserFixture(
      SHELL('<div style="width:2400px;height:40px;background:#ccc">wide</div>'),
      { viewportFilter: 'desktop' }
    );
    const issue = issues.find((candidate) => candidate.code === 'HORIZONTAL_OVERFLOW');
    assert(Boolean(issue) && issue.severity === 'ERROR' && issue.evidence.viewport === 'desktop', JSON.stringify(issue ?? issues.map((i) => i.code)));
  });

  await testCase('07b healthy page produces no overflow or render errors', async (assert) => {
    const { issues } = await runBrowserFixture(SHELL('<p>Nothing wide here.</p>'));
    const errors = issues.filter((issue) => issue.severity === 'ERROR' || issue.severity === 'CRITICAL');
    assert(errors.length === 0, JSON.stringify(errors.map((issue) => [issue.code, issue.observed])));
  });

  await testCase('08 fatal first-party JS error becomes ERROR', async (assert) => {
    const { issues } = await runBrowserFixture(
      SHELL('', '<script>window.addEventListener("DOMContentLoaded", () => { throw new Error("fixture fatal error"); });</script>'),
      { viewportFilter: 'desktop' }
    );
    const issue = issues.find((candidate) => candidate.code === 'FIRST_PARTY_PAGE_ERROR' || candidate.code === 'FIRST_PARTY_CONSOLE_ERROR');
    assert(Boolean(issue) && issue.severity === 'ERROR', JSON.stringify(issues.map((i) => [i.code, i.severity])));
  });

  await testCase('09 analytics failure in the browser stays a WARNING', async (assert) => {
    const { issues } = await runBrowserFixture(
      SHELL('', '<script async src="https://plausible.io/js/definitely-not-a-real-script-xyz.js"></script>'),
      { viewportFilter: 'desktop' }
    );
    const analytics = issues.filter((issue) => issue.evidence?.party === 'known-third-party' || issue.code === 'EXTERNAL_DEPENDENCY_WARNING');
    const errors = issues.filter((issue) => issue.severity === 'ERROR');
    assert(
      analytics.every((issue) => issue.severity === 'WARNING') && errors.length === 0,
      `analytics=${JSON.stringify(analytics.map((i) => [i.code, i.severity]))} errors=${JSON.stringify(errors.map((i) => i.code))}`
    );
  });

  await testCase('10 unexpected first-party network failure becomes ERROR', async (assert) => {
    const { issues } = await runBrowserFixture(
      SHELL('', '<link rel="stylesheet" href="/missing-stylesheet.css">'),
      { viewportFilter: 'desktop' }
    );
    const issue = issues.find((candidate) => candidate.code === 'FIRST_PARTY_REQUEST_FAILED');
    assert(
      Boolean(issue) && issue.severity === 'ERROR' && issue.evidence.party === 'first-party',
      JSON.stringify(issues.map((i) => [i.code, i.severity, i.observed]))
    );
  });

  await testCase('screenshots are captured as reproducible evidence', async (assert) => {
    const { out } = await runBrowserFixture(SHELL('<p>evidence</p>'), { viewportFilter: 'mobile' });
    const dir = path.join(out, 'screenshots');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert(files.length > 0 && files.every((file) => file.endsWith('.png')), JSON.stringify(files));
  });
}

// ---------------------------------------------------------------------------
console.log('');
console.log(`${results.length - failures}/${results.length} checks passed.`);
if (failures) {
  console.error(`${failures} QA self-test(s) failed.`);
  process.exit(1);
}
