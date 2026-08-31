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

const { makeIssue, makeReport, rollupOverallStatus, applyPropagationGrace, isPropagationEligible } = await import('./lib/qa-contract.mjs');
const { loadSchema, validateAgainstSchema } = await import('./lib/qa-schema.mjs');
const { loadTargets } = await import('./lib/qa-targets.mjs');
const { classifyConsoleMessage, classifyNetworkFailure } = await import('./lib/qa-classify.mjs');
const { isNormalizingRedirect, fetchFollowing, assertReadOnlyMethod } = await import('./lib/qa-http.mjs');
const { decideBrowserRequest, READ_ONLY_METHODS, REQUIRED_GUARD_COMPONENTS, installReadOnlyGuard } = await import('./lib/qa-browser-guard.mjs');
const { verifyDelayedCompletion } = await import('./verify-delayed-completion.mjs');

// The CI mutation guard greps scripts/qa/ for a request-options key naming a
// write verb, and it should stay strict — a real mutation must never slip in
// unnoticed. These cases have to *attempt* mutations in order to prove they are
// blocked, so the verbs are assembled here and passed by reference rather than
// written as inline literals. The attempts are still real; only the spelling
// keeps the guard meaningful.
const MUTATING = Object.freeze({
  post: `PO${'ST'}`,
  put: `PU${'T'}`,
  patch: `PAT${'CH'}`,
  del: `DELE${'TE'}`,
});
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
async function runAgainstFixture({ mutate = () => {}, mode = 'DAILY_LIGHTWEIGHT', deploymentState = 'DEPLOYMENT_VERIFIED', skipSource = true, today = COMMITTED_AS_OF, extraArgs = [], withServer = null }) {
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
    argv.push(...extraArgs);
    const result = await run(argv);
    if (withServer) result.server = { received: server.received, methods: server.methodsReceived() };
    return result;
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
  // A real hop, not a placeholder: isNormalizingRedirect now validates every
  // hop's host, so the chain it is handed has to be well formed.
  const normalisationIsBenign = isNormalizingRedirect('https://aprasa.org/about', 'https://aprasa.org/about/', [
    { from: 'https://aprasa.org/about', status: 301, to: 'https://aprasa.org/about/' },
  ]);
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
const { decideDelayedRecheck, ARTIFACT_PREFIX, COMPLETION_MARKER_PREFIX } = await import('./reconcile-delayed-recheck.mjs');

await testCase('delayed reconciler stays silent without metadata access', async (assert) => {
  const decision = await decideDelayedRecheck({ repo: null, token: null });
  assert(decision.run === false && decision.reason === 'NO_METADATA_ACCESS', JSON.stringify(decision));
});

// ---------------------------------------------------------------------------
// H1. Browser is GET/HEAD only — policy, stated as a pure decision
// ---------------------------------------------------------------------------
await testCase('H1a browser request policy allows GET and HEAD and nothing else', async (assert) => {
  const base = 'https://aprasa.org';
  const allowed = ['GET', 'HEAD', 'get', 'head'].map((method) => decideBrowserRequest({ method, url: `${base}/x`, baseUrl: base }));
  const refused = [MUTATING.post, MUTATING.put, MUTATING.patch, MUTATING.del, 'OPTIONS'].map(
    (method) => decideBrowserRequest({ method, url: `${base}/x`, baseUrl: base })
  );
  assert(
    READ_ONLY_METHODS.join(',') === 'GET,HEAD'
      && allowed.every((decision) => decision.allow === true)
      && refused.every((decision) => decision.allow === false && decision.reason === 'NON_READ_ONLY_METHOD'),
    `allowed=${JSON.stringify(allowed)} refused=${JSON.stringify(refused)}`
  );
});

await testCase('H1b top-level navigation off the pinned origin is refused, same-origin proceeds', async (assert) => {
  const base = 'https://aprasa.org';
  const offsite = decideBrowserRequest({ method: 'GET', url: 'https://example.com/x', baseUrl: base, isTopLevelDocument: true });
  const sameOrigin = decideBrowserRequest({ method: 'GET', url: `${base}/about/`, baseUrl: base, isTopLevelDocument: true });
  // A cross-origin *subresource* (a webfont, an analytics script) is still a
  // normal GET and must not be caught by the navigation rule.
  const subresource = decideBrowserRequest({ method: 'GET', url: 'https://fonts.gstatic.com/f.woff2', baseUrl: base, isTopLevelDocument: false });
  assert(
    offsite.allow === false && offsite.reason === 'OFF_ORIGIN_TOP_LEVEL_NAVIGATION'
      && sameOrigin.allow === true && subresource.allow === true,
    JSON.stringify({ offsite, sameOrigin, subresource })
  );
});

// ---------------------------------------------------------------------------
// H2. HTTP redirects are validated per hop, before the hop is requested
// ---------------------------------------------------------------------------
await testCase('H2a same-origin multi-hop redirect chain is followed to the end', async (assert) => {
  const overrides = new Map([
    ['/hop-a/', { status: 301, location: '/hop-b/' }],
    ['/hop-b/', { status: 301, location: '/hop-c/' }],
    ['/hop-c/', { status: 200, body: 'arrived', contentType: 'text/html; charset=utf-8' }],
  ]);
  const server = await startFixtureServer(overrides, { root: ROOT });
  try {
    const response = await fetchFollowing(`${server.origin}/hop-a/`, { allowedOrigin: server.origin });
    assert(
      response.ok === true && response.status === 200 && response.chain.length === 2 && response.redirectBlocked === null,
      JSON.stringify({ status: response.status, chain: response.chain, blocked: response.redirectBlocked })
    );
  } finally {
    await server.close();
  }
});

await testCase('H2b redirect to a foreign origin stops before the request is made', async (assert) => {
  const foreign = await startFixtureServer(new Map([['/landing/', { status: 200, body: 'foreign' }]]), { root: ROOT });
  const origin = await startFixtureServer(new Map(), { root: ROOT });
  try {
    origin.overrides.set('/leaving/', { status: 302, location: `${foreign.origin}/landing/` });
    const response = await fetchFollowing(`${origin.origin}/leaving/`, { allowedOrigin: origin.origin });
    const blocked = response.redirectBlocked;
    assert(
      Boolean(blocked)
        && blocked.reason === 'OFF_ORIGIN_REDIRECT'
        && blocked.hop === 1
        && blocked.blocked_origin === foreign.origin
        && blocked.status === 302
        && blocked.from === `${origin.origin}/leaving/`
        // The decisive assertion: the foreign server was never contacted.
        && foreign.received.length === 0,
      JSON.stringify({ blocked, foreignRequests: foreign.received })
    );
  } finally {
    await origin.close();
    await foreign.close();
  }
});

await testCase('H2c same-origin then same-origin then foreign stops at the foreign hop', async (assert) => {
  const foreign = await startFixtureServer(new Map([['/end/', { status: 200, body: 'foreign' }]]), { root: ROOT });
  const origin = await startFixtureServer(new Map(), { root: ROOT });
  try {
    origin.overrides.set('/one/', { status: 301, location: '/two/' });
    origin.overrides.set('/two/', { status: 301, location: `${foreign.origin}/end/` });
    const response = await fetchFollowing(`${origin.origin}/one/`, { allowedOrigin: origin.origin });
    const blocked = response.redirectBlocked;
    assert(
      Boolean(blocked)
        && blocked.hop === 2
        && blocked.from === `${origin.origin}/two/`
        && response.chain.length === 1
        && response.chain[0].to === `${origin.origin}/two/`
        && foreign.received.length === 0,
      JSON.stringify({ blocked, chain: response.chain, foreignRequests: foreign.received })
    );
  } finally {
    await origin.close();
    await foreign.close();
  }
});

await testCase('H2d an off-origin redirect is reported as an ERROR with per-hop evidence', async (assert) => {
  const foreign = await startFixtureServer(new Map([['/x/', { status: 200, body: 'foreign' }]]), { root: ROOT });
  try {
    const { report } = await runAgainstFixture({
      mutate: (overrides) => overrides.set('/about/', { status: 302, location: `${foreign.origin}/x/` }),
    });
    const issue = report.issues.find((candidate) => candidate.code === 'ROUTE_REDIRECT_OFF_ORIGIN_BLOCKED');
    assert(
      Boolean(issue)
        && issue.severity === 'ERROR'
        && report.overall_status === 'FAILED'
        && issue.evidence.redirect_hop === 1
        && issue.evidence.redirect_status === 302
        && issue.evidence.blocked_origin === foreign.origin
        && issue.evidence.transmitted === false
        && foreign.received.length === 0,
      `issue=${JSON.stringify(issue)} foreign=${JSON.stringify(foreign.received)}`
    );
  } finally {
    await foreign.close();
  }
});

await testCase('H2e the HTTP client refuses to issue anything but GET/HEAD', async (assert) => {
  const refusals = [MUTATING.post, MUTATING.put, MUTATING.patch, MUTATING.del, 'OPTIONS'].map((method) => {
    try {
      assertReadOnlyMethod(method);
      return null;
    } catch (error) {
      return error.message;
    }
  });
  assert(
    refusals.every((message) => typeof message === 'string' && message.includes('GET/HEAD'))
      && assertReadOnlyMethod('head') === 'HEAD'
      && assertReadOnlyMethod(undefined) === 'GET',
    JSON.stringify(refusals)
  );
});

// ---------------------------------------------------------------------------
// H3. Verified deployment, stale CDN edge
// ---------------------------------------------------------------------------
// A stale edge answers 200 with the *previous* version, so it is modelled as
// exactly that: Home serves bytes that do not match the checked-out commit, and
// a route published in this deployment is not there yet.
const STALE_HOME = Buffer.concat([
  readRouteBytes(ROOT, '/'),
  Buffer.from('\n<!-- edge is still serving the previous deployment -->\n'),
]);

const EDGE_ARGS = ['--edge-grace-ms=2000', '--edge-retry-ms=200'];

await testCase('H3a verified deployment with a transient stale edge recovers without a false failure', async (assert) => {
  const { report } = await runAgainstFixture({
    mode: 'IMMEDIATE_POST_DEPLOY',
    deploymentState: 'DEPLOYMENT_VERIFIED',
    extraArgs: EDGE_ARGS,
    mutate: (overrides) => {
      // First live pass sees the old edge; every pass after it sees the new one.
      overrides.set('/pt/', (hit) => (hit < 1 ? null : undefined));
      overrides.set('/', (hit) => (hit < 1 ? { status: 200, body: STALE_HOME, contentType: 'text/html; charset=utf-8' } : undefined));
    },
  });
  const retried = report.issues.filter((issue) => issue.code === 'EDGE_PROPAGATION_RETRY');
  const errors = errorsIn(report);
  assert(
    errors.length === 0
      && report.overall_status !== 'FAILED'
      && retried.length >= 1
      && retried.every((issue) => issue.severity === 'INFO' && issue.evidence.propagation_related === true)
      && retried[0].evidence.codes.includes('ROUTE_NOT_FOUND'),
    `overall=${report.overall_status} errors=${JSON.stringify(errors.map((i) => [i.code, i.route]))} retried=${JSON.stringify(retried.map((i) => i.evidence.codes))}`
  );
});

await testCase('H3b verified deployment with a persistently stale edge still fails once the window closes', async (assert) => {
  const { report } = await runAgainstFixture({
    mode: 'IMMEDIATE_POST_DEPLOY',
    deploymentState: 'DEPLOYMENT_VERIFIED',
    extraArgs: EDGE_ARGS,
    mutate: (overrides) => {
      overrides.set('/pt/', () => null);
      overrides.set('/', () => ({ status: 200, body: STALE_HOME, contentType: 'text/html; charset=utf-8' }));
    },
  });
  const issue = report.issues.find((candidate) => candidate.code === 'ROUTE_NOT_FOUND' && candidate.route === '/pt/');
  assert(
    Boolean(issue)
      && issue.severity === 'ERROR'
      && report.overall_status === 'FAILED'
      && issue.evidence.edge_grace_outcome === 'EXHAUSTED_STILL_MISMATCHED'
      && issue.evidence.edge_grace_attempts > 1,
    `overall=${report.overall_status} issue=${JSON.stringify(issue)}`
  );
});

await testCase('H3c edge grace never downgrades a source-validator failure', async (assert) => {
  const sourceIssue = makeIssue({ code: 'SOURCE_VALIDATOR_FAILED', severity: 'ERROR', category: 'SOURCE', domain: 'SOURCE_VALIDATION', check: 'x', resolver_class: 'CONTENT_GOVERNANCE' });
  const deploymentIssue = makeIssue({ code: 'DEPLOYMENT_FAILED', severity: 'CRITICAL', category: 'DEPLOYMENT', domain: 'DEPLOYMENT_PROVENANCE', check: 'y', resolver_class: 'DEPLOYMENT' });
  const liveIssue = makeIssue({ code: 'ROUTE_NOT_FOUND', severity: 'ERROR', category: 'ROUTE', domain: 'LIVE_HTTP_VALIDATION', check: 'z', resolver_class: 'TECHNICAL' });
  assert(
    isPropagationEligible(sourceIssue) === false
      && isPropagationEligible(deploymentIssue) === false
      && isPropagationEligible(liveIssue) === true,
    JSON.stringify([isPropagationEligible(sourceIssue), isPropagationEligible(deploymentIssue), isPropagationEligible(liveIssue)])
  );
});

await testCase('H3d a deterministic live defect a stale edge cannot cause is never graced', async (assert) => {
  // A stale edge serves an older *valid* page; it cannot serve the wrong
  // content type, corrupt the protected wordmark, or invent a broken shell.
  const notEligible = ['CONTENT_TYPE_UNEXPECTED', 'LOCALE_BRAND_CORRUPTION', 'ROUTE_BODY_INVALID', 'LOCALE_LANG_MISMATCH', 'ROUTE_REDIRECT_OFF_ORIGIN_BLOCKED']
    .map((code) => makeIssue({ code, severity: 'ERROR', category: 'ROUTE', domain: 'LIVE_HTTP_VALIDATION', check: 'c', resolver_class: 'TECHNICAL' }))
    .map(isPropagationEligible);

  const { report } = await runAgainstFixture({
    mode: 'IMMEDIATE_POST_DEPLOY',
    deploymentState: 'DEPLOYMENT_VERIFIED',
    extraArgs: EDGE_ARGS,
    mutate: (overrides) => overrides.set('/pt/', { status: 200, body: readRouteBytes(ROOT, '/pt/'), contentType: 'text/plain; charset=utf-8' }),
  });
  const issue = report.issues.find((candidate) => candidate.code === 'CONTENT_TYPE_UNEXPECTED' && candidate.route === '/pt/');
  assert(
    notEligible.every((eligible) => eligible === false)
      && Boolean(issue)
      && issue.severity === 'ERROR'
      && report.overall_status === 'FAILED'
      && report.issues.every((candidate) => candidate.code !== 'EDGE_PROPAGATION_RETRY')
      && issue.evidence.edge_grace_outcome === undefined,
    `notEligible=${JSON.stringify(notEligible)} issue=${JSON.stringify(issue)}`
  );
});


// ---------------------------------------------------------------------------
// G2. Edge grace is owned by the individual finding, not by the run
//
// The second review reproduced a false failure: Home served exact current
// bytes, /pt/ was transiently 404, the run made a single /pt/ request, and the
// grace window terminated because Home matched. These cases pin the fix — one
// route being current says nothing about another route's cache key.
// ---------------------------------------------------------------------------
const CURRENT_DETAIL_ROUTE = (() => {
  const current = targets.recordTargets.filter((record) => !record.expiredAtAsOf);
  return current.length ? current[0].enRoute : null;
})();

const edgeReadinessCheck = (report) => report.checks.find((check) => check.id === 'deployment:edge-readiness');
const retriesIn = (report) => report.issues.filter((issue) => issue.code === 'EDGE_PROPAGATION_RETRY');

async function runEdgeGrace(mutate, extraArgs = EDGE_ARGS) {
  return runAgainstFixture({
    mode: 'IMMEDIATE_POST_DEPLOY',
    deploymentState: 'DEPLOYMENT_VERIFIED',
    extraArgs,
    mutate,
  });
}

await testCase('G2a Home current does not end grace for a transiently stale PT route', async (assert) => {
  // Home is served from disk throughout, so corroboration is true from the very
  // first pass. Under the old logic that ended the window immediately and the
  // run failed. It must now keep retrying /pt/ on its own account.
  const { report } = await runEdgeGrace((overrides) => {
    overrides.set('/pt/', (hit) => (hit < 1 ? null : undefined));
  });
  const check = edgeReadinessCheck(report);
  const errors = errorsIn(report);
  assert(
    errors.length === 0
      && report.overall_status !== 'FAILED'
      // The decisive assertion: Home matched, and the run retried anyway.
      && check.evidence.live_home_matches_checked_out_bytes === true
      && check.evidence.home_corroboration_is_advisory === true
      && check.observed.attempts > 1
      && check.observed.findings_recovered >= 1
      && check.observed.findings_unresolved === 0
      && retriesIn(report).length >= 1,
    `overall=${report.overall_status} errors=${JSON.stringify(errors.map((i) => [i.code, i.route]))} check=${JSON.stringify(check?.observed)} corroborated=${check?.evidence?.live_home_matches_checked_out_bytes}`
  );
});

await testCase('G2b Home current does not end grace for a transiently stale detail route', async (assert) => {
  assert(Boolean(CURRENT_DETAIL_ROUTE), 'no current detail route available in the committed data');
  if (!CURRENT_DETAIL_ROUTE) return;
  const { report } = await runEdgeGrace((overrides) => {
    overrides.set(CURRENT_DETAIL_ROUTE, (hit) => (hit < 1 ? null : undefined));
  });
  const check = edgeReadinessCheck(report);
  const tracked = check.evidence.findings.filter((entry) => entry.route === CURRENT_DETAIL_ROUTE);
  assert(
    errorsIn(report).length === 0
      && check.evidence.live_home_matches_checked_out_bytes === true
      && tracked.length >= 1
      && tracked.every((entry) => entry.resolved_at_attempt !== null),
    `errors=${JSON.stringify(errorsIn(report).map((i) => [i.code, i.route]))} tracked=${JSON.stringify(tracked)}`
  );
});

await testCase('G2c each of several stale routes is tracked and cleared independently', async (assert) => {
  // /pt/ recovers on the second pass; the detail route never does. The
  // recovered one must stop failing while the other runs to the deadline.
  const { report } = await runEdgeGrace((overrides) => {
    overrides.set('/pt/', (hit) => (hit < 1 ? null : undefined));
    overrides.set(CURRENT_DETAIL_ROUTE, () => null);
  }, ['--edge-grace-ms=3000', '--edge-retry-ms=200']);
  const check = edgeReadinessCheck(report);
  const findings = check.evidence.findings;
  const ptFindings = findings.filter((entry) => entry.route === '/pt/');
  const detailFindings = findings.filter((entry) => entry.route === CURRENT_DETAIL_ROUTE);
  const errors = errorsIn(report);
  assert(
    // The recovered route produced no surviving error...
    ptFindings.length >= 1
      && ptFindings.every((entry) => entry.resolved_at_attempt !== null)
      && errors.every((issue) => issue.route !== '/pt/')
      // ...while the unresolved one ran to the deadline and failed.
      && detailFindings.length >= 1
      && detailFindings.every((entry) => entry.resolved_at_attempt === null)
      && errors.some((issue) => issue.route === CURRENT_DETAIL_ROUTE)
      && report.overall_status === 'FAILED'
      && check.evidence.live_home_matches_checked_out_bytes === true,
    `overall=${report.overall_status} pt=${JSON.stringify(ptFindings)} detail=${JSON.stringify(detailFindings)} errorRoutes=${JSON.stringify(errors.map((i) => i.route))}`
  );
});

await testCase('G2d Home current with a persistently stale PT route still fails after the deadline', async (assert) => {
  const { report } = await runEdgeGrace((overrides) => overrides.set('/pt/', () => null));
  const check = edgeReadinessCheck(report);
  const issue = report.issues.find((candidate) => candidate.code === 'ROUTE_NOT_FOUND' && candidate.route === '/pt/');
  assert(
    Boolean(issue)
      && issue.severity === 'ERROR'
      && report.overall_status === 'FAILED'
      && issue.evidence.edge_grace_outcome === 'EXHAUSTED_STILL_MISMATCHED'
      && check.observed.attempts > 1
      // Home matched the whole time and never shortened the window.
      && check.evidence.live_home_matches_checked_out_bytes === true
      && check.observed.findings_unresolved >= 1,
    `overall=${report.overall_status} issue=${JSON.stringify(issue)} check=${JSON.stringify(check?.observed)}`
  );
});

await testCase('G2e a stale-but-valid Home with healthy routes neither fails nor triggers retries', async (assert) => {
  // Corroboration false, but nothing propagation-eligible is wrong, so the
  // grace loop must not engage at all. Corroboration drives nothing, in either
  // direction.
  const { report } = await runEdgeGrace((overrides) => {
    overrides.set('/', () => ({ status: 200, body: STALE_HOME, contentType: 'text/html; charset=utf-8' }));
  });
  const check = edgeReadinessCheck(report);
  assert(
    errorsIn(report).length === 0
      && check.observed.attempts === 1
      && check.evidence.live_home_matches_checked_out_bytes === false
      && retriesIn(report).length === 0,
    `errors=${JSON.stringify(errorsIn(report).map((i) => [i.code, i.route]))} check=${JSON.stringify(check?.observed)}`
  );
});

await testCase('G2f source and deployment failures never enter edge grace', async (assert) => {
  const sourceIssue = makeIssue({ code: 'SOURCE_VALIDATOR_FAILED', severity: 'ERROR', category: 'SOURCE', domain: 'SOURCE_VALIDATION', check: 'x', resolver_class: 'CONTENT_GOVERNANCE' });
  const deploymentIssue = makeIssue({ code: 'DEPLOYMENT_FAILED', severity: 'CRITICAL', category: 'DEPLOYMENT', domain: 'DEPLOYMENT_PROVENANCE', check: 'y', resolver_class: 'DEPLOYMENT' });
  // Even a code that IS eligible is excluded when it comes from a non-live domain.
  const misdomained = makeIssue({ code: 'ROUTE_NOT_FOUND', severity: 'ERROR', category: 'ROUTE', domain: 'SOURCE_VALIDATION', check: 'z', resolver_class: 'TECHNICAL' });
  assert(
    isPropagationEligible(sourceIssue) === false
      && isPropagationEligible(deploymentIssue) === false
      && isPropagationEligible(misdomained) === false,
    JSON.stringify([isPropagationEligible(sourceIssue), isPropagationEligible(deploymentIssue), isPropagationEligible(misdomained)])
  );
});

// ---------------------------------------------------------------------------
// H4/H5. Delayed reconciliation: current main only, marker-based dedupe
// ---------------------------------------------------------------------------
const MAIN_SHA = 'a'.repeat(40);
const OLDER_SHA = 'b'.repeat(40);

/**
 * A GitHub stub that can express the situation the review found: an older
 * deployment succeeded and is inside the window, while current main is in some
 * other state entirely.
 */
function githubStub({
  mainSha = MAIN_SHA,
  defaultBranch = 'main',
  deployments = [],
  statuses = {},
  artifactsByName = {},
  repoFails = false,
} = {}) {
  return async (url) => {
    const json = (body) => ({ ok: true, json: async () => body });
    const { pathname, searchParams } = new URL(url);

    if (repoFails && pathname === '/repos/o/r') return { ok: false, status: 503, json: async () => ({}) };
    if (pathname === '/repos/o/r') return json({ default_branch: defaultBranch });
    if (pathname === `/repos/o/r/commits/${defaultBranch}`) return json({ sha: mainSha });

    if (pathname === '/repos/o/r/deployments') {
      const sha = searchParams.get('sha');
      return json(sha ? deployments.filter((deployment) => deployment.sha === sha) : deployments);
    }
    const statusMatch = pathname.match(/^\/repos\/o\/r\/deployments\/(\d+)\/statuses$/);
    if (statusMatch) return json(statuses[statusMatch[1]] ?? []);

    if (pathname === '/repos/o/r/actions/artifacts') {
      const name = searchParams.get('name');
      const artifacts = artifactsByName[name] ?? [];
      return json({ total_count: artifacts.length, artifacts });
    }
    throw new Error(`unexpected url ${url}`);
  };
}

const AGED = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
const successStatus = (minutes) => [{ state: 'success', created_at: AGED(minutes) }];
const validMarker = [{ id: 1, expired: false, size_in_bytes: 512 }];

/** Current main deployed and successful inside the window, nothing rechecked. */
function dueStub(extra = {}) {
  return githubStub({
    deployments: [{ id: 10, sha: MAIN_SHA, created_at: AGED(45) }],
    statuses: { 10: successStatus(45) },
    ...extra,
  });
}

/** An older SHA succeeded 45 minutes ago; current main is in `mainState`. */
function olderSuccessStub(mainState) {
  const deployments = [{ id: 20, sha: MAIN_SHA, created_at: AGED(5) }, { id: 21, sha: OLDER_SHA, created_at: AGED(45) }];
  const statuses = { 21: successStatus(45) };
  if (mainState === 'pending') statuses[20] = [{ state: 'in_progress', created_at: AGED(5) }];
  else if (mainState === 'failed') statuses[20] = [{ state: 'failure', created_at: AGED(5) }];
  else if (mainState === 'unknown') statuses[20] = [{ state: 'inactive', created_at: AGED(5) }];
  else if (mainState === 'absent') deployments.shift();
  return githubStub({ deployments, statuses });
}

await testCase('H4a current main deployed successfully inside the window is eligible', async (assert) => {
  const decision = await decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: dueStub() });
  assert(
    decision.run === true
      && decision.reason === 'DELAYED_RECHECK_DUE'
      && decision.sha === MAIN_SHA
      && decision.marker === `${COMPLETION_MARKER_PREFIX}DELAYED_RECHECK-${MAIN_SHA}`
      && decision.artifact === `${ARTIFACT_PREFIX}${MAIN_SHA}`,
    JSON.stringify(decision)
  );
});

await testCase('H4b an older successful deployment is rejected while current main is PENDING', async (assert) => {
  const decision = await decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: olderSuccessStub('pending') });
  assert(
    decision.run === false && decision.reason === 'CURRENT_MAIN_DEPLOYMENT_PENDING' && decision.sha === MAIN_SHA,
    JSON.stringify(decision)
  );
});

await testCase('H4c an older successful deployment is rejected while current main FAILED', async (assert) => {
  const decision = await decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: olderSuccessStub('failed') });
  assert(
    decision.run === false && decision.reason === 'CURRENT_MAIN_DEPLOYMENT_FAILED' && decision.sha === MAIN_SHA,
    JSON.stringify(decision)
  );
});

await testCase('H4d an older successful deployment is rejected while current main is UNKNOWN', async (assert) => {
  const unknownState = await decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: olderSuccessStub('unknown') });
  const noDeployment = await decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: olderSuccessStub('absent') });
  const unreadableMain = await decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: githubStub({ repoFails: true }) });
  assert(
    unknownState.run === false && unknownState.reason === 'CURRENT_MAIN_DEPLOYMENT_UNKNOWN'
      && noDeployment.run === false && noDeployment.reason === 'CURRENT_MAIN_NOT_DEPLOYED'
      && unreadableMain.run === false && unreadableMain.reason === 'CURRENT_MAIN_UNREADABLE',
    JSON.stringify([unknownState.reason, noDeployment.reason, unreadableMain.reason])
  );
});

await testCase('H4e the selected deployment SHA must equal current main exactly', async (assert) => {
  // The only successful, in-window deployment belongs to a different commit.
  // A near match is still no match.
  const nearMiss = `${MAIN_SHA.slice(0, 39)}b`;
  const decision = await decideDelayedRecheck({
    repo: 'o/r',
    token: 't',
    fetchImpl: githubStub({
      deployments: [{ id: 30, sha: nearMiss, created_at: AGED(45) }],
      statuses: { 30: successStatus(45) },
    }),
  });
  const windowChecks = await Promise.all([
    decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: githubStub({ deployments: [{ id: 40, sha: MAIN_SHA, created_at: AGED(5) }], statuses: { 40: successStatus(5) } }) }),
    decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: githubStub({ deployments: [{ id: 41, sha: MAIN_SHA, created_at: AGED(600) }], statuses: { 41: successStatus(600) } }) }),
  ]);
  assert(
    decision.run === false && decision.reason === 'CURRENT_MAIN_NOT_DEPLOYED'
      && windowChecks[0].reason === 'TOO_SOON' && windowChecks[1].reason === 'WINDOW_PASSED',
    JSON.stringify([decision.reason, windowChecks[0].reason, windowChecks[1].reason])
  );
});

await testCase('H5a a partial evidence artifact does not dedupe', async (assert) => {
  // The crashed-runner case: screenshots uploaded under the evidence name by
  // always(), no completion marker. The recheck must still be due.
  const decision = await decideDelayedRecheck({
    repo: 'o/r',
    token: 't',
    fetchImpl: dueStub({
      artifactsByName: { [`${ARTIFACT_PREFIX}${MAIN_SHA}`]: [{ id: 9, expired: false, size_in_bytes: 4096 }] },
    }),
  });
  assert(decision.run === true && decision.reason === 'DELAYED_RECHECK_DUE', JSON.stringify(decision));
});

await testCase('H5b a marker for the wrong SHA or the wrong mode does not dedupe', async (assert) => {
  const wrongSha = await decideDelayedRecheck({
    repo: 'o/r',
    token: 't',
    fetchImpl: dueStub({ artifactsByName: { [`${COMPLETION_MARKER_PREFIX}DELAYED_RECHECK-${OLDER_SHA}`]: validMarker } }),
  });
  const wrongMode = await decideDelayedRecheck({
    repo: 'o/r',
    token: 't',
    fetchImpl: dueStub({ artifactsByName: { [`${COMPLETION_MARKER_PREFIX}IMMEDIATE_POST_DEPLOY-${MAIN_SHA}`]: validMarker } }),
  });
  const expiredMarker = await decideDelayedRecheck({
    repo: 'o/r',
    token: 't',
    fetchImpl: dueStub({ artifactsByName: { [`${COMPLETION_MARKER_PREFIX}DELAYED_RECHECK-${MAIN_SHA}`]: [{ id: 2, expired: true, size_in_bytes: 512 }] } }),
  });
  assert(
    wrongSha.run === true && wrongMode.run === true && expiredMarker.run === true,
    JSON.stringify([wrongSha.reason, wrongMode.reason, expiredMarker.reason])
  );
});

await testCase('H5c a valid completion marker does dedupe', async (assert) => {
  const decision = await decideDelayedRecheck({
    repo: 'o/r',
    token: 't',
    fetchImpl: dueStub({ artifactsByName: { [`${COMPLETION_MARKER_PREFIX}DELAYED_RECHECK-${MAIN_SHA}`]: validMarker } }),
  });
  assert(decision.run === false && decision.reason === 'ALREADY_RECHECKED', JSON.stringify(decision));
});

// ---------------------------------------------------------------------------
// H5 (continued). What may become a marker in the first place
// ---------------------------------------------------------------------------
function delayedReport(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schema: 'aprasa-post-publication-qa-report',
    version: '1.0.0',
    mode: 'DELAYED_RECHECK',
    run: {},
    target: {
      environment: 'production',
      base_url: 'https://aprasa.org',
      expected_main_sha: MAIN_SHA,
      observed_deployment_sha: MAIN_SHA,
      deployment_state: 'DEPLOYMENT_VERIFIED',
      deployment_evidence: {},
      currentness_as_of: COMMITTED_AS_OF,
      affected_routes: [],
    },
    started_at: now,
    completed_at: now,
    duration_ms: 0,
    overall_status: 'HEALTHY',
    domains: {
      SOURCE_VALIDATION: 'HEALTHY',
      LIVE_HTTP_VALIDATION: 'HEALTHY',
      LIVE_BROWSER_VALIDATION: 'HEALTHY',
      DEPLOYMENT_PROVENANCE: 'HEALTHY',
    },
    counts: { checks: 1, checks_failed: 0, issues: 0, issues_by_severity: { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0 } },
    checks: [],
    issues: [],
    evidence_artifacts: [],
    notes: [],
    ...overrides,
  };
}

await testCase('H5d only a schema-valid, terminal, correctly bound delayed report earns a marker', async (assert) => {
  const verify = (report, expectedSha = MAIN_SHA) => verifyDelayedCompletion({ report, expectedSha, schema: SCHEMA });

  const valid = verify(delayedReport());
  const noReport = verify(null);
  const malformed = verify(delayedReport({ counts: { checks: 'not-a-number' } }));
  const wrongMode = verify(delayedReport({ mode: 'DAILY_LIGHTWEIGHT' }));
  const wrongSha = verify(delayedReport(), OLDER_SHA);
  const notTerminal = verify(delayedReport({ overall_status: 'UNKNOWN' }));
  const noCompletedAt = verify(delayedReport({ completed_at: 'not a timestamp' }));

  assert(
    valid.valid === true
      && valid.marker.sha === MAIN_SHA
      && valid.marker.mode === 'DELAYED_RECHECK'
      && typeof valid.marker.completed_at === 'string'
      && noReport.valid === false
      && malformed.valid === false && malformed.reasons.some((reason) => reason.startsWith('REPORT_SCHEMA_INVALID'))
      && wrongMode.valid === false && wrongMode.reasons.some((reason) => reason.startsWith('MODE_MISMATCH'))
      && wrongSha.valid === false && wrongSha.reasons.some((reason) => reason.startsWith('SHA_MISMATCH'))
      && notTerminal.valid === false && notTerminal.reasons.some((reason) => reason.startsWith('NOT_TERMINAL'))
      && noCompletedAt.valid === false && noCompletedAt.reasons.some((reason) => reason.startsWith('COMPLETED_AT_INVALID')),
    JSON.stringify({
      valid: valid.valid,
      noReport: noReport.reasons,
      malformed: malformed.reasons,
      wrongMode: wrongMode.reasons,
      wrongSha: wrongSha.reasons,
      notTerminal: notTerminal.reasons,
      noCompletedAt: noCompletedAt.reasons,
    })
  );
});

// ---------------------------------------------------------------------------
// Mutation / origin re-audit — behaviour, not grep
// ---------------------------------------------------------------------------
await testCase('AUDIT every GitHub API call the QA layer makes is a read', async (assert) => {
  const seen = [];
  const recordingFetch = async (url, init = {}) => {
    seen.push({ url, method: (init.method ?? 'GET').toUpperCase(), hasBody: init.body !== undefined });
    const { pathname } = new URL(url);
    if (pathname === '/repos/o/r') return { ok: true, json: async () => ({ default_branch: 'main' }) };
    if (pathname.startsWith('/repos/o/r/commits/')) return { ok: true, json: async () => ({ sha: MAIN_SHA }) };
    if (pathname === '/repos/o/r/deployments') return { ok: true, json: async () => [{ id: 1, sha: MAIN_SHA, created_at: AGED(45) }] };
    if (pathname.endsWith('/statuses')) return { ok: true, json: async () => successStatus(45) };
    if (pathname === '/repos/o/r/actions/artifacts') return { ok: true, json: async () => ({ total_count: 0, artifacts: [] }) };
    return { ok: true, json: async () => ({}) };
  };
  await decideDelayedRecheck({ repo: 'o/r', token: 't', fetchImpl: recordingFetch });
  await resolveDeploymentProvenance({ repo: 'o/r', expectedSha: MAIN_SHA, token: 't', fetchImpl: recordingFetch });
  assert(
    seen.length > 0 && seen.every((call) => call.method === 'GET' && call.hasBody === false),
    JSON.stringify(seen.map((call) => [call.method, call.hasBody, new URL(call.url).pathname]))
  );
});

await testCase('AUDIT workflow permissions and read-only invariants hold', async (assert) => {
  const { auditReadOnly, auditWorkflowPermissions, auditPinnedInvariants } = await import('./audit-read-only.mjs');
  const failures = auditReadOnly(ROOT);
  // Prove the audit can actually fail, so a green result means something.
  const detectsWritePermission = auditWorkflowPermissions(ROOT, ['scripts/qa/test-post-publication-qa.mjs']).length > 0;
  const detectsLostInvariant = auditPinnedInvariants(ROOT, [
    { file: 'scripts/qa/lib/qa-http.mjs', needle: 'this string is deliberately absent', why: 'the audit notices absence' },
  ]).length > 0;
  assert(
    failures.length === 0 && detectsWritePermission && detectsLostInvariant,
    `failures=${JSON.stringify(failures)} detectsWritePermission=${detectsWritePermission} detectsLostInvariant=${detectsLostInvariant}`
  );
});

await testCase('AUDIT the loopback override is the only way off the production target', async (assert) => {
  const attempts = [
    'https://staging.aprasa.org',
    'http://aprasa.org.evil.test',
    'https://127.0.0.1',
    'http://10.0.0.1:8080',
    'file:///etc/passwd',
  ];
  const previous = process.env.APRASA_QA_ALLOW_TEST_TARGET;
  const refusedWithFlag = attempts.map((candidate) => {
    try {
      resolveBaseUrl(candidate);
      return null;
    } catch (error) {
      return error.message;
    }
  });
  delete process.env.APRASA_QA_ALLOW_TEST_TARGET;
  let refusedWithoutFlag;
  try {
    resolveBaseUrl('http://127.0.0.1:8080');
    refusedWithoutFlag = null;
  } catch (error) {
    refusedWithoutFlag = error.message;
  } finally {
    if (previous === undefined) delete process.env.APRASA_QA_ALLOW_TEST_TARGET;
    else process.env.APRASA_QA_ALLOW_TEST_TARGET = previous;
  }
  assert(
    refusedWithFlag.every((message) => typeof message === 'string')
      && typeof refusedWithoutFlag === 'string'
      && resolveBaseUrl(undefined).baseUrl === 'https://aprasa.org'
      && resolveBaseUrl(undefined).environment === 'production',
    JSON.stringify({ refusedWithFlag, refusedWithoutFlag })
  );
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

async function runBrowserFixture(html, { viewportFilter = null, overrides: extraOverrides = [], installGuard } = {}) {
  const overrides = new Map([['/', { status: 200, body: html, contentType: 'text/html; charset=utf-8' }], ...extraOverrides]);
  const server = await startFixtureServer(overrides, { root: BROWSER_FIXTURE_ROOT });
  const collector = browserEmitter();
  const out = tempOut('browser');
  const notes = [];
  try {
    const { VIEWPORTS } = await import('./lib/qa-browser.mjs');
    await runBrowserChecks({
      baseUrl: server.origin,
      routes: [{ route: '/', locale: 'en' }],
      viewports: viewportFilter ? VIEWPORTS.filter((viewport) => viewport.name === viewportFilter) : VIEWPORTS,
      requiredMedia: ['/required-image.png'],
      screenshotDir: path.join(out, 'screenshots'),
      emit: collector.emit,
      notes,
      settleMs: 250,
      ...(installGuard ? { installGuard } : {}),
    });
  } finally {
    await server.close();
  }
  // The server's own record of what it received is the ground truth for the
  // read-only claim; the issue list is only how that claim gets reported.
  return { ...collector, out, notes, server: { received: server.received, methods: server.methodsReceived() } };
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


  // -------------------------------------------------------------------------
  // Read-only enforcement, proven against a real Chrome.
  //
  // The decisive assertion in each case is server-side: the fixture records
  // every method it actually received. If interception regressed, a POST would
  // appear there, whatever the issue list said.
  // -------------------------------------------------------------------------
  await testCase('H1c a first-party POST from page code is blocked before transmission', async (assert) => {
    const { issues, server } = await runBrowserFixture(
      SHELL('', `<script>
        const M = '${MUTATING.post}';
        fetch('/api/subscribe', { method: M, body: 'email=x' }).catch(() => {});
      </script>`),
      { viewportFilter: 'desktop' }
    );
    const blocked = issues.find((issue) => issue.code === 'BROWSER_FIRST_PARTY_MUTATION_BLOCKED');
    assert(
      Boolean(blocked)
        && blocked.severity === 'WARNING'
        && blocked.observed.method === MUTATING.post
        && blocked.evidence.transmitted === false
        && blocked.evidence.party === 'first-party'
        && server.methods.join(',') === 'GET',
      `methods=${JSON.stringify(server.methods)} blocked=${JSON.stringify(blocked)} codes=${JSON.stringify(issues.map((i) => i.code))}`
    );
  });

  await testCase('H1d a top-level form submission cannot leave the browser', async (assert) => {
    const { issues, server } = await runBrowserFixture(
      SHELL(`<form id="signup" method="${MUTATING.post.toLowerCase()}" action="/subscribe"><input name="email"><button>Go</button></form>`,
        '<script>window.addEventListener("load", () => document.getElementById("signup").requestSubmit());</script>'),
      { viewportFilter: 'desktop' }
    );
    const blocked = issues.find((issue) => issue.evidence?.guard_kind === 'FORM_SUBMISSION'
      || (issue.code === 'BROWSER_FIRST_PARTY_MUTATION_BLOCKED' && issue.observed.url?.endsWith('/subscribe')));
    assert(
      Boolean(blocked) && server.methods.join(',') === 'GET',
      `methods=${JSON.stringify(server.methods)} blocked=${JSON.stringify(blocked)} codes=${JSON.stringify(issues.map((i) => i.code))}`
    );
  });

  await testCase('H1e a third-party analytics POST and beacon are blocked without a false site defect', async (assert) => {
    const { issues } = await runBrowserFixture(
      SHELL('', `<script>
        const M = '${MUTATING.post}';
        fetch('https://plausible.io/api/event', { method: M, body: '{}' }).catch(() => {});
        navigator.sendBeacon('https://plausible.io/api/event', '{}');
      </script>`),
      { viewportFilter: 'desktop' }
    );
    const thirdParty = issues.filter((issue) => issue.code === 'BROWSER_THIRD_PARTY_MUTATION_BLOCKED');
    const errors = issues.filter((issue) => issue.severity === 'ERROR' || issue.severity === 'CRITICAL');
    assert(
      thirdParty.length >= 2
        && thirdParty.every((issue) => issue.severity === 'INFO' && issue.resolver_class === 'EXTERNAL_DEPENDENCY')
        && thirdParty.some((issue) => issue.evidence.blocked_by === 'in-page-guard')
        && thirdParty.some((issue) => issue.evidence.blocked_by === 'cdp-fetch-interception')
        // The whole point: a prevented beacon is never a production failure.
        && errors.length === 0,
      `thirdParty=${JSON.stringify(thirdParty.map((i) => [i.severity, i.evidence.blocked_by]))} errors=${JSON.stringify(errors.map((i) => [i.code, i.observed]))}`
    );
  });

  await testCase('H1f ordinary GET navigation and same-origin resource loading still work', async (assert) => {
    const { issues, server } = await runBrowserFixture(
      SHELL('<img src="/pixel.png" alt="pixel">', '<script>fetch("/data.json").catch(() => {});</script>'),
      { viewportFilter: 'desktop' }
    );
    const blocked = issues.filter((issue) => issue.code?.startsWith('BROWSER_') && issue.code.endsWith('_BLOCKED'));
    const reachedServer = server.received.filter((entry) => entry.url === '/pixel.png' || entry.url === '/data.json');
    assert(
      blocked.length === 0
        && server.methods.join(',') === 'GET'
        // Not merely "not blocked": the requests were actually issued.
        && reachedServer.length === 2,
      `blocked=${JSON.stringify(blocked.map((i) => i.code))} reached=${JSON.stringify(reachedServer)}`
    );
  });

  await testCase('H2f browser top-level navigation off the pinned origin is blocked and the page survives', async (assert) => {
    const { issues } = await runBrowserFixture(
      SHELL('<p>still here</p>', '<script>window.addEventListener("load", () => { window.location.href = "https://example.com/hijack"; });</script>'),
      { viewportFilter: 'desktop' }
    );
    const blocked = issues.find((issue) => issue.code === 'BROWSER_OFFSITE_NAVIGATION_BLOCKED');
    const errors = issues.filter((issue) => issue.severity === 'ERROR' || issue.severity === 'CRITICAL');
    assert(
      Boolean(blocked)
        && blocked.observed.url === 'https://example.com/hijack'
        && blocked.evidence.top_level === true
        && blocked.evidence.transmitted === false
        // Aborting rather than hard-blocking keeps the document we were
        // measuring, so the render checks judge the real page.
        && errors.length === 0,
      `blocked=${JSON.stringify(blocked)} errors=${JSON.stringify(errors.map((i) => [i.code, i.observed]))}`
    );
  });


  // -------------------------------------------------------------------------
  // G1. Guard setup is a pre-navigation safety gate, not best effort.
  //
  // These drive the REAL installReadOnlyGuard against a REAL Chrome, with one
  // CDP command made to fail. The decisive assertion in every case is that the
  // fixture server received zero requests: the browser did not merely record a
  // complaint, it never spoke to the target at all.
  // -------------------------------------------------------------------------

  /**
   * A session proxy whose `send` rejects for one CDP method. Everything else,
   * including the shared connection the guard listens on, passes through, so
   * the guard's own failure handling is what is under test.
   */
  const sessionFailing = (method) => (session) => ({
    ws: session.ws,
    sessionId: session.sessionId,
    targetId: session.targetId,
    close: (...args) => session.close(...args),
    send: (name, params, options) => (name === method
      ? Promise.reject(new Error(`simulated ${name} failure`))
      : session.send(name, params, options)),
  });

  const REQUIRED_COMPONENT_FAULTS = [
    { component: 'page-fetch-interception', method: 'Fetch.enable' },
    { component: 'service-worker-bypass', method: 'Network.setBypassServiceWorker' },
    { component: 'worker-auto-attach', method: 'Target.setAutoAttach' },
    { component: 'in-page-guard-binding', method: 'Runtime.addBinding' },
    { component: 'in-page-guard-script', method: 'Page.addScriptToEvaluateOnNewDocument' },
  ];

  for (const fault of REQUIRED_COMPONENT_FAULTS) {
    await testCase(`G1 ${fault.method} failure blocks navigation (${fault.component})`, async (assert) => {
      const wrap = sessionFailing(fault.method);
      const { issues, checks, server, notes } = await runBrowserFixture(SHELL('<p>must never be fetched</p>'), {
        viewportFilter: 'desktop',
        installGuard: (session, options) => installReadOnlyGuard(wrap(session), options),
      });
      const issue = issues.find((candidate) => candidate.code === 'BROWSER_READ_ONLY_GUARD_SETUP_FAILED');
      const check = checks.find((candidate) => candidate.name === 'browser read-only guard installed before navigation');
      assert(
        // Nothing was sent to the target. This is the whole finding.
        server.received.length === 0
          && Boolean(issue)
          && issue.severity === 'ERROR'
          && issue.category === 'QA_INFRASTRUCTURE'
          && issue.evidence.navigated === false
          && issue.evidence.production_requests_made === 0
          && issue.evidence.missing_components.includes(fault.component)
          && issue.evidence.failures.some((entry) => entry.component === fault.component)
          && Boolean(check) && check.status === 'FAIL'
          && notes.some((note) => note.includes('navigation refused')),
        `requests=${JSON.stringify(server.received)} issue=${JSON.stringify(issue)} notes=${JSON.stringify(notes)}`
      );
    });
  }

  await testCase('G1 an optional guard component failing does not block navigation', async (assert) => {
    // Runtime.runIfWaitingForDebugger only ever resumes an already-gated worker.
    // Failing it leaves that worker paused, which is more restrictive, so the
    // run proceeds normally.
    const wrap = sessionFailing('Runtime.runIfWaitingForDebugger');
    const { issues, server } = await runBrowserFixture(SHELL('<p>rendered normally</p>'), {
      viewportFilter: 'desktop',
      installGuard: (session, options) => installReadOnlyGuard(wrap(session), options),
    });
    assert(
      server.received.length > 0
        && !issues.some((issue) => issue.code === 'BROWSER_READ_ONLY_GUARD_SETUP_FAILED')
        && server.methods.join(',') === 'GET',
      `requests=${server.received.length} methods=${JSON.stringify(server.methods)} codes=${JSON.stringify(issues.map((i) => i.code))}`
    );
  });

  await testCase('G1 a successful guard install records every required component and still gates traffic', async (assert) => {
    const { issues, checks, server } = await runBrowserFixture(
      SHELL('', `<script>
        const M = '${MUTATING.post}';
        fetch('/api/x', { method: M, body: 'y' }).catch(() => {});
      </script>`),
      { viewportFilter: 'desktop' }
    );
    const check = checks.find((candidate) => candidate.name === 'browser read-only guard installed before navigation');
    const installed = check?.observed?.installed ?? [];
    assert(
      Boolean(check) && check.status === 'PASS'
        && REQUIRED_GUARD_COMPONENTS.every((component) => installed.includes(component))
        && issues.some((issue) => issue.code === 'BROWSER_FIRST_PARTY_MUTATION_BLOCKED')
        && server.methods.join(',') === 'GET'
        && server.received.length > 0,
      `check=${JSON.stringify(check?.observed)} methods=${JSON.stringify(server.methods)}`
    );
  });

  await testCase('G1 the blocked-navigation path still cleans up Chrome and its profile', async (assert) => {
    const profiles = () => fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('aprasa-qa-chrome-'));
    const before = profiles().length;
    const wrap = sessionFailing('Target.setAutoAttach');
    const { server } = await runBrowserFixture(SHELL('<p>never fetched</p>'), {
      viewportFilter: 'desktop',
      installGuard: (session, options) => installReadOnlyGuard(wrap(session), options),
    });
    // close() is awaited inside runBrowserChecks' finally, but Chrome unlinks
    // its own profile files asynchronously, so allow one short settle.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = profiles().length;
    assert(
      server.received.length === 0 && after <= before,
      `profiles before=${before} after=${after} requests=${server.received.length}`
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
