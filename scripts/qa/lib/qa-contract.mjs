// Phase 2A post-publication QA — shared result contract.
//
// This module owns the *vocabulary* of the QA layer: the report envelope, the
// severity ladder, the four result domains, the resolver classes, and the
// rollup rules that turn individual issues into an overall status. Everything
// else in scripts/qa/ produces checks and issues through these constructors so
// a single place decides what a report is allowed to look like.
//
// Phase 2A is detection-only. Nothing here (and nothing that consumes it) may
// mutate the repository, the deployed site, or any external system. The
// `auto_remediation_candidate` flag is classification metadata reserved for a
// future Phase 2B orchestrator; it grants no authority in this phase.

export const REPORT_SCHEMA = 'aprasa-post-publication-qa-report';
export const REPORT_VERSION = '1.0.0';

export const MODES = Object.freeze([
  'IMMEDIATE_POST_DEPLOY',
  'DELAYED_RECHECK',
  'DAILY_LIGHTWEIGHT',
  'WEEKLY_DEEP',
  'MANUAL',
]);

export const DOMAINS = Object.freeze([
  'SOURCE_VALIDATION',
  'LIVE_HTTP_VALIDATION',
  'LIVE_BROWSER_VALIDATION',
  'DEPLOYMENT_PROVENANCE',
]);

export const SEVERITIES = Object.freeze(['INFO', 'WARNING', 'ERROR', 'CRITICAL']);
const SEVERITY_RANK = Object.freeze({ INFO: 0, WARNING: 1, ERROR: 2, CRITICAL: 3 });

export const OVERALL_STATUSES = Object.freeze(['HEALTHY', 'DEGRADED', 'FAILED', 'UNKNOWN']);
export const CHECK_STATUSES = Object.freeze(['PASS', 'WARN', 'FAIL', 'SKIP', 'UNKNOWN']);

export const DEPLOYMENT_STATES = Object.freeze([
  'DEPLOYMENT_VERIFIED',
  'DEPLOYMENT_PENDING',
  'DEPLOYMENT_FAILED',
  'DEPLOYMENT_UNKNOWN',
]);

export const RESOLVER_CLASSES = Object.freeze([
  'TECHNICAL',
  'LOCALIZATION',
  'CONTENT_GOVERNANCE',
  'MEDIA',
  'EXTERNAL_DEPENDENCY',
  'DEPLOYMENT',
  'UNKNOWN',
]);

export const CATEGORIES = Object.freeze([
  'ROUTE',
  'ASSET',
  'MEDIA',
  'LOCALIZATION',
  'CONTENT',
  'RENDER',
  'CONSOLE',
  'NETWORK',
  'DEPLOYMENT',
  'SOURCE',
  'SCHEMA',
]);

/**
 * Live findings a stale CDN edge can plausibly explain, and only those.
 *
 * The distinction this list encodes is the one the review demanded:
 * "GitHub Pages reports the deployment VERIFIED" is a statement about
 * GitHub finishing a publish, not about every edge already serving the new
 * bytes. An edge still holding the previous version answers 200 with the *old*
 * page, so what it produces is a presence/absence mismatch — a route that does
 * not exist yet, a sitemap entry not yet listed, an event not yet on Home.
 *
 * Everything outside this list is excluded on purpose, because a stale edge
 * cannot produce it:
 *   ROUTE_BODY_INVALID      a stale edge serves a valid *older* page shell
 *   CONTENT_TYPE_UNEXPECTED server configuration, not content version
 *   LOCALE_LANG_MISMATCH    an older page still carries a correct lang
 *   LOCALE_BRAND_CORRUPTION protected-brand rule, never softened
 *   ROUTE_REDIRECT_*        routing configuration, not content version
 * Source-domain and deployment-domain findings are excluded structurally, by
 * domain, further down.
 */
export const PROPAGATION_ELIGIBLE_CODES = Object.freeze([
  'ROUTE_NOT_FOUND',
  'ROUTE_UNEXPECTED_STATUS',
  'ROUTE_SERVER_ERROR',
  'ROUTE_UNREACHABLE',
  'RESPONSE_BODY_EMPTY',
  'SITEMAP_ROUTE_MISSING',
  'SITEMAP_PUBLIC_ROUTE_MISMATCH',
  'TTD_IDENTITY_MISSING',
  'TTD_CURRENT_RECORD_MISSING_FROM_HOME',
  'TTD_EXPIRED_SURFACED',
  'LOCALE_PT_ROUTE_MISSING',
  'LOCALE_REQUIRED_VALUE_MISSING',
]);

/**
 * Edge-readiness grace applies to the live HTTP domain only. The browser
 * domain runs after the HTTP pass has already settled (or exhausted its
 * window), so by the time a page is rendered the edge question is answered.
 */
export function isPropagationEligible(issue) {
  if (issue.domain !== 'LIVE_HTTP_VALIDATION') return false;
  if (issue.severity !== 'ERROR' && issue.severity !== 'CRITICAL') return false;
  return PROPAGATION_ELIGIBLE_CODES.includes(issue.code);
}

/**
 * Record, on the findings that outlived the grace window, that propagation was
 * considered and ruled out. Severity is deliberately untouched: once the window
 * closes, a surviving mismatch is a defect and classifies normally. This only
 * writes down *why* it is now trusted.
 */
export function annotateEdgeGraceExhausted(issues, { attempts, windowMs, corroborated = null }) {
  return issues.map((issue) => (isPropagationEligible(issue)
    ? {
      ...issue,
      evidence: {
        ...issue.evidence,
        edge_grace_attempts: attempts,
        edge_grace_window_ms: windowMs,
        edge_grace_outcome: 'EXHAUSTED_STILL_MISMATCHED',
        live_content_corroborated: corroborated,
      },
    }
    : issue));
}

export function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? -1;
}

export function maxSeverity(issues) {
  let best = null;
  for (const issue of issues) {
    if (best === null || severityRank(issue.severity) > severityRank(best)) best = issue.severity;
  }
  return best;
}

function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new Error(`qa-contract: invalid ${field} "${value}" (allowed: ${allowed.join(', ')})`);
  }
}

/**
 * Build a single structured issue. Every field that Phase 2B will need to
 * route an issue without re-reading the site is required here, so an
 * under-specified detector cannot silently emit an unroutable finding.
 */
export function makeIssue({
  code,
  severity,
  category,
  domain,
  check,
  route = null,
  locale = null,
  observed = null,
  expected = null,
  evidence = {},
  deterministic = true,
  resolver_class = 'UNKNOWN',
  retryable = false,
  auto_remediation_candidate = false,
}) {
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(code)) {
    throw new Error(`qa-contract: issue code must be SCREAMING_SNAKE_CASE, got "${code}"`);
  }
  assertEnum(severity, SEVERITIES, 'severity');
  assertEnum(category, CATEGORIES, 'category');
  assertEnum(domain, DOMAINS, 'domain');
  assertEnum(resolver_class, RESOLVER_CLASSES, 'resolver_class');
  if (typeof check !== 'string' || !check) throw new Error(`qa-contract: issue ${code} is missing check`);
  return {
    code,
    severity,
    category,
    domain,
    route,
    locale,
    check,
    observed,
    expected,
    evidence,
    deterministic: Boolean(deterministic),
    resolver_class,
    retryable: Boolean(retryable),
    auto_remediation_candidate: Boolean(auto_remediation_candidate),
  };
}

export function makeCheck({
  id,
  domain,
  name,
  status,
  route = null,
  locale = null,
  observed = null,
  expected = null,
  duration_ms = null,
  evidence = {},
}) {
  assertEnum(domain, DOMAINS, 'domain');
  assertEnum(status, CHECK_STATUSES, 'check status');
  return { id, domain, name, status, route, locale, observed, expected, duration_ms, evidence };
}

/**
 * Overall status rollup.
 *
 * Rules, in order:
 *  1. Any ERROR or CRITICAL issue -> FAILED. A real first-party defect always
 *     wins, including when deployment provenance is unknown.
 *  2. Otherwise an unknown deployed SHA -> UNKNOWN. We refuse to report
 *     HEALTHY about a deployment we could not identify.
 *  3. Otherwise any WARNING -> DEGRADED.
 *  4. Otherwise HEALTHY.
 *
 * DEPLOYMENT_PENDING deliberately does not degrade the run on its own: a site
 * still inside the Pages propagation window is not a defect. The propagation
 * downgrade in makeReport() handles the live checks that pending affects.
 */
export function rollupOverallStatus(issues, deploymentState) {
  const top = maxSeverity(issues);
  if (top === 'ERROR' || top === 'CRITICAL') return 'FAILED';
  if (deploymentState === 'DEPLOYMENT_UNKNOWN') return 'UNKNOWN';
  if (top === 'WARNING') return 'DEGRADED';
  return 'HEALTHY';
}

function rollupDomainStatus(issues, domain, ran) {
  if (!ran) return 'SKIPPED';
  const scoped = issues.filter((issue) => issue.domain === domain);
  const top = maxSeverity(scoped);
  if (top === 'ERROR' || top === 'CRITICAL') return 'FAILED';
  if (top === 'WARNING') return 'DEGRADED';
  return 'HEALTHY';
}

/**
 * Propagation grace: while GitHub reports the expected SHA as still deploying,
 * a live 404/5xx/content mismatch is far more likely to be CDN propagation
 * than a real defect, so live ERRORs are downgraded to WARNING and tagged.
 * Deployment-domain and source-domain issues are never downgraded — a source
 * validator failure is true regardless of what the CDN is serving.
 */
export function applyPropagationGrace(issues, deploymentState) {
  if (deploymentState !== 'DEPLOYMENT_PENDING') return issues;
  return issues.map((issue) => {
    const live = issue.domain === 'LIVE_HTTP_VALIDATION' || issue.domain === 'LIVE_BROWSER_VALIDATION';
    if (!live) return issue;
    if (issue.severity !== 'ERROR' && issue.severity !== 'CRITICAL') return issue;
    return {
      ...issue,
      severity: 'WARNING',
      retryable: true,
      evidence: {
        ...issue.evidence,
        downgraded_from: issue.severity,
        downgrade_reason: 'DEPLOYMENT_PENDING_PROPAGATION_WINDOW',
      },
    };
  });
}

export function makeReport({
  mode,
  target,
  started_at,
  completed_at,
  checks,
  issues,
  domainsRun,
  run = {},
  evidence_artifacts = [],
  notes = [],
}) {
  assertEnum(mode, MODES, 'mode');
  assertEnum(target.deployment_state, DEPLOYMENT_STATES, 'deployment_state');

  const graced = applyPropagationGrace(issues, target.deployment_state);
  const issues_by_severity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const issue of graced) issues_by_severity[issue.severity] += 1;

  const domains = Object.fromEntries(
    DOMAINS.map((domain) => [domain, rollupDomainStatus(graced, domain, domainsRun.includes(domain))])
  );

  return {
    schema: REPORT_SCHEMA,
    version: REPORT_VERSION,
    mode,
    run,
    target,
    started_at,
    completed_at,
    duration_ms: Date.parse(completed_at) - Date.parse(started_at),
    overall_status: rollupOverallStatus(graced, target.deployment_state),
    domains,
    counts: {
      checks: checks.length,
      checks_failed: checks.filter((c) => c.status === 'FAIL').length,
      issues: graced.length,
      issues_by_severity,
    },
    checks,
    issues: graced,
    evidence_artifacts,
    notes,
  };
}
