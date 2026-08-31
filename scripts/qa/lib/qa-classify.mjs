// Console / network classification policy.
//
// The rule this file encodes: a failure of something A PRASA serves is an
// ERROR; a failure of a named, expected third party is an
// EXTERNAL_DEPENDENCY_WARNING; a failure of an *unrecognised* third party is
// still surfaced, as a warning, because silently ignoring every cross-origin
// error is how a real regression hides. Nothing is dropped without a rule.

/**
 * Third parties the production pages legitimately depend on. Each entry states
 * why the origin is expected, so adding one is a deliberate, reviewable act
 * rather than an ad-hoc mute.
 */
export const KNOWN_EXTERNAL_ORIGINS = Object.freeze({
  'plausible.io': { purpose: 'analytics', required: false },
  'fonts.googleapis.com': { purpose: 'webfont stylesheet', required: false },
  'fonts.gstatic.com': { purpose: 'webfont files', required: false },
});

/**
 * Console noise that headless Chrome emits for reasons unrelated to the site's
 * own correctness. Matched case-insensitively as a substring, and only ever
 * used to downgrade to INFO — never to delete a message from the evidence.
 */
export const BENIGN_CONSOLE_PATTERNS = Object.freeze([
  'favicon.ico',
  'download the react devtools',
  'was preloaded using link preload but not used',
]);

/**
 * Requests the browser makes on its own behalf, which no page markup asked for.
 * A PRASA declares no favicon, so every headless visit produces a same-origin
 * /favicon.ico 404 that is not a site defect. These are classified as INFO and
 * still recorded — never dropped from the evidence.
 */
export const BROWSER_IMPLICIT_REQUESTS = Object.freeze(['/favicon.ico']);

/**
 * Chrome logs a console error for every request the read-only guard refuses,
 * as net::ERR_BLOCKED_BY_CLIENT. Blaming the site for our own enforcement would
 * turn a correctly prevented analytics beacon into a first-party ERROR, which
 * is exactly the false failure the guard must not cause. The run is headless
 * with no extensions, so in this context that error text has one possible
 * source: us. The attempt is still fully recorded, with method and URL, as a
 * BROWSER_*_BLOCKED issue from the interception layer.
 */
export const GUARD_BLOCK_CONSOLE_PATTERN = /ERR_BLOCKED_BY_CLIENT/i;

export function isBrowserImplicitRequest(url) {
  if (!url) return false;
  try {
    return BROWSER_IMPLICIT_REQUESTS.includes(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function originOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function isSameOrigin(url, baseUrl) {
  const host = originOf(url);
  if (!host) return false;
  return host === originOf(baseUrl);
}

/**
 * Classify a failed network request into { severity, code, resolver_class }.
 * `required` marks a resource the page cannot render correctly without
 * (stylesheet, script, image the QA layer derived from canonical data).
 */
export function classifyNetworkFailure({ url, baseUrl, required = false }) {
  if (isBrowserImplicitRequest(url)) {
    return {
      severity: 'INFO',
      code: 'BROWSER_IMPLICIT_REQUEST_FAILED',
      category: 'NETWORK',
      resolver_class: 'UNKNOWN',
      party: 'browser-implicit',
    };
  }
  if (isSameOrigin(url, baseUrl)) {
    // Every same-origin failure is a first-party defect. `required` is carried
    // as evidence so Phase 2B can tell a broken stylesheet from a broken
    // opportunistic request, but it never softens the severity.
    return {
      severity: 'ERROR',
      code: 'FIRST_PARTY_REQUEST_FAILED',
      category: 'NETWORK',
      resolver_class: 'TECHNICAL',
      party: 'first-party',
      required,
    };
  }
  const host = originOf(url);
  const known = host ? KNOWN_EXTERNAL_ORIGINS[host] : null;
  if (known) {
    return {
      severity: 'WARNING',
      code: 'EXTERNAL_DEPENDENCY_WARNING',
      category: 'NETWORK',
      resolver_class: 'EXTERNAL_DEPENDENCY',
      party: 'known-third-party',
      purpose: known.purpose,
    };
  }
  return {
    severity: 'WARNING',
    code: 'EXTERNAL_UNCLASSIFIED_FAILURE',
    category: 'NETWORK',
    resolver_class: 'EXTERNAL_DEPENDENCY',
    party: 'unclassified-third-party',
  };
}

/**
 * Classify a console message or uncaught page error. Attribution is by the
 * script URL that produced it; a message we cannot attribute is a warning, not
 * an error, because blaming the site for an unattributable message is exactly
 * the false positive this layer must avoid.
 */
export function classifyConsoleMessage({ text, sourceUrl, baseUrl, kind = 'console' }) {
  const lowered = (text ?? '').toLowerCase();
  if (GUARD_BLOCK_CONSOLE_PATTERN.test(text ?? '')) {
    return {
      severity: 'INFO',
      code: 'BROWSER_READ_ONLY_GUARD_CONSOLE_ECHO',
      category: 'CONSOLE',
      resolver_class: 'UNKNOWN',
      party: 'qa-guard',
    };
  }
  if (isBrowserImplicitRequest(sourceUrl)) {
    return { severity: 'INFO', code: 'BROWSER_IMPLICIT_REQUEST_FAILED', category: 'CONSOLE', resolver_class: 'UNKNOWN', party: 'browser-implicit' };
  }
  if (BENIGN_CONSOLE_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return { severity: 'INFO', code: 'CONSOLE_BENIGN_NOISE', category: 'CONSOLE', resolver_class: 'UNKNOWN', party: 'noise' };
  }
  if (sourceUrl && isSameOrigin(sourceUrl, baseUrl)) {
    return {
      severity: 'ERROR',
      code: kind === 'pageerror' ? 'FIRST_PARTY_PAGE_ERROR' : 'FIRST_PARTY_CONSOLE_ERROR',
      category: 'CONSOLE',
      resolver_class: 'TECHNICAL',
      party: 'first-party',
    };
  }
  if (sourceUrl) {
    const host = originOf(sourceUrl);
    const known = host ? KNOWN_EXTERNAL_ORIGINS[host] : null;
    return {
      severity: 'WARNING',
      code: known ? 'EXTERNAL_DEPENDENCY_WARNING' : 'EXTERNAL_UNCLASSIFIED_CONSOLE_ERROR',
      category: 'CONSOLE',
      resolver_class: 'EXTERNAL_DEPENDENCY',
      party: known ? 'known-third-party' : 'unclassified-third-party',
    };
  }
  return {
    severity: 'WARNING',
    code: 'UNATTRIBUTED_CONSOLE_ERROR',
    category: 'CONSOLE',
    resolver_class: 'UNKNOWN',
    party: 'unattributed',
  };
}

/**
 * Classify a request the read-only browser guard refused to transmit.
 *
 * The severities encode the review rule that a prevented analytics beacon must
 * never read as a site defect, while a first-party page that tries to mutate
 * something is genuinely unexpected on a static site and has to be surfaced
 * rather than silently allowed:
 *
 *   first-party mutating request   -> WARNING (explicit, never hidden)
 *   third-party beacon / mutation  -> INFO    (recorded, never a site defect)
 *   off-origin top-level navigation-> WARNING (the origin confinement fired)
 *
 * None of these are ERROR. If a page genuinely cannot render without the
 * blocked request, the render, content and required-asset checks fail on their
 * own merits and produce the ERROR — the block itself is evidence, not a verdict.
 */
export function classifyBlockedBrowserRequest({ url, method, baseUrl, reason }) {
  if (reason === 'OFF_ORIGIN_TOP_LEVEL_NAVIGATION') {
    return {
      severity: 'WARNING',
      code: 'BROWSER_OFFSITE_NAVIGATION_BLOCKED',
      category: 'NETWORK',
      resolver_class: 'TECHNICAL',
      party: 'off-origin',
    };
  }
  if (isSameOrigin(url, baseUrl)) {
    return {
      severity: 'WARNING',
      code: 'BROWSER_FIRST_PARTY_MUTATION_BLOCKED',
      category: 'NETWORK',
      resolver_class: 'TECHNICAL',
      party: 'first-party',
    };
  }
  const host = originOf(url);
  const known = host ? KNOWN_EXTERNAL_ORIGINS[host] : null;
  return {
    severity: 'INFO',
    code: 'BROWSER_THIRD_PARTY_MUTATION_BLOCKED',
    category: 'NETWORK',
    resolver_class: 'EXTERNAL_DEPENDENCY',
    party: known ? 'known-third-party' : 'unclassified-third-party',
    purpose: known?.purpose ?? null,
  };
}
