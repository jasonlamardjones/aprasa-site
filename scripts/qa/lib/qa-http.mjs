// Bounded, read-only HTTP client for live production checks.
//
// Read-only by construction: GET/HEAD only (enforced, not merely intended), no
// request body, no cookies kept, no crawling. Callers pass routes derived from
// repository data; this module never discovers new URLs by following links.
//
// Redirects are followed by hand so that every hop can be judged *before* it is
// requested. Comparing only the initial and final URL is not enough: by the
// time a final URL can be compared, the off-origin request has already been
// sent. Each Location header is resolved and origin-checked first, and the
// first off-origin hop stops the chain without transmitting anything.

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ATTEMPTS = 3;
const USER_AGENT = 'aprasa-post-publication-qa/1.0 (+https://aprasa.org; read-only site QA)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The only methods this client may ever issue. */
export const READ_ONLY_METHODS = Object.freeze(['GET', 'HEAD']);

/**
 * Enforced at the one place every request funnels through, so "GET-only" is a
 * property of the code rather than a convention callers are trusted to follow.
 */
export function assertReadOnlyMethod(method) {
  const normalized = String(method ?? 'GET').toUpperCase();
  if (!READ_ONLY_METHODS.includes(normalized)) {
    throw new Error(`qa-http: refusing ${normalized}; production QA traffic is ${READ_ONLY_METHODS.join('/')} only`);
  }
  return normalized;
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * A single non-following request. Redirects are surfaced, not swallowed, so
 * the caller can tell a benign trailing-slash normalisation from a route that
 * silently moved somewhere else.
 */
async function requestOnce(url, { method, timeoutMs }) {
  assertReadOnlyMethod(method);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    });
    const contentType = response.headers.get('content-type');
    const location = response.headers.get('location');
    const isRedirect = response.status >= 300 && response.status < 400;
    const body = isRedirect || method === 'HEAD' ? '' : await response.text();
    return {
      ok: true,
      url,
      status: response.status,
      contentType,
      location,
      body,
      bytes: body.length,
      duration_ms: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: null,
      contentType: null,
      location: null,
      body: '',
      bytes: 0,
      duration_ms: Date.now() - startedAt,
      networkError: error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error),
    };
  }
}

/**
 * Fetch with a bounded retry for transient conditions only.
 *
 * A transport error or a retryable status is retried with linear backoff; a
 * persistent 404 or a stable 200 with wrong content is returned on the first
 * attempt. This is the "do not retry away persistent first-party defects" rule:
 * retries exist for flakiness, never to launder a reproducible failure.
 */
export async function fetchRoute(url, { method = 'GET', attempts = DEFAULT_ATTEMPTS, timeoutMs = DEFAULT_TIMEOUT_MS, backoffMs = 750 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await requestOnce(url, { method, timeoutMs });
    last.attempts = attempt;
    const transient = !last.ok || RETRYABLE_STATUS.has(last.status);
    if (!transient) return last;
    if (attempt < attempts) await sleep(backoffMs * attempt);
  }
  return last;
}

/**
 * Follow a redirect chain by hand, up to a small bound, validating the origin
 * of every hop before it is requested.
 *
 * `allowedOrigin` defaults to the origin of the URL the caller asked for, which
 * for production QA is the pinned https://aprasa.org. A same-origin chain may
 * continue (subject to the hop bound); the first hop that resolves to any other
 * origin ends the chain immediately and is reported as `redirectBlocked` with
 * the evidence needed to act on it — source URL, redirect status, the raw
 * Location header, the resolved off-origin target, and the hop number. The
 * blocked hop is never requested.
 */
export async function fetchFollowing(url, options = {}) {
  const maxHops = options.maxHops ?? 3;
  const allowedOrigin = options.allowedOrigin ?? originOf(url);
  const chain = [];
  let current = url;

  // Hop 0 is the caller's own URL. Refusing it here means no code path can
  // reach a foreign origin by passing one in directly.
  if (originOf(current) !== allowedOrigin) {
    return offOriginResult({ url, current, allowedOrigin, chain, hop: 0, status: null, location: null, to: current });
  }

  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await fetchRoute(current, options);
    if (!response.ok || response.status < 300 || response.status >= 400 || !response.location) {
      return { ...response, chain, requestedUrl: url, allowedOrigin, redirectBlocked: null };
    }

    let next;
    try {
      next = new URL(response.location, current).toString();
    } catch {
      return {
        ...response,
        chain,
        requestedUrl: url,
        allowedOrigin,
        redirectBlocked: {
          reason: 'REDIRECT_LOCATION_UNPARSEABLE',
          hop: hop + 1,
          from: current,
          status: response.status,
          location: response.location,
          to: null,
          blocked_origin: null,
          allowed_origin: allowedOrigin,
        },
      };
    }

    // Validate before requesting. This is the whole point of the hand-rolled
    // chain: the decision happens while the next request is still hypothetical.
    if (originOf(next) !== allowedOrigin) {
      return offOriginResult({
        url,
        current,
        allowedOrigin,
        chain,
        hop: hop + 1,
        status: response.status,
        location: response.location,
        to: next,
      });
    }

    chain.push({ from: current, status: response.status, to: next });
    current = next;
  }

  return {
    ok: false,
    url: current,
    requestedUrl: url,
    allowedOrigin,
    status: null,
    contentType: null,
    location: null,
    body: '',
    bytes: 0,
    attempts: 1,
    duration_ms: 0,
    networkError: `exceeded ${maxHops} redirect hops`,
    chain,
    redirectBlocked: null,
  };
}

function offOriginResult({ url, current, allowedOrigin, chain, hop, status, location, to }) {
  return {
    ok: false,
    url: current,
    requestedUrl: url,
    allowedOrigin,
    status: null,
    contentType: null,
    location: null,
    body: '',
    bytes: 0,
    attempts: 0,
    duration_ms: 0,
    networkError: `redirect to ${originOf(to) ?? 'an unresolvable origin'} refused; production QA never leaves ${allowedOrigin}`,
    chain,
    redirectBlocked: {
      reason: 'OFF_ORIGIN_REDIRECT',
      hop,
      from: current,
      status,
      location,
      to,
      blocked_origin: originOf(to),
      allowed_origin: allowedOrigin,
    },
  };
}

/**
 * A redirect chain counts as benign normalisation when *every hop* stays on the
 * same origin and the chain as a whole only adds https or a trailing slash.
 *
 * The per-hop check is not redundant with fetchFollowing's origin guard: this
 * function is also the classifier for chains recorded elsewhere, and judging a
 * chain by its endpoints alone would call an off-origin detour benign as long
 * as it came back. Anything else is a real route change and must be reported.
 */
export function isNormalizingRedirect(requestedUrl, finalUrl, chain) {
  if (chain.length === 0) return true;
  const from = new URL(requestedUrl);
  const to = new URL(finalUrl);
  // Hosts, not origins: an http -> https upgrade is exactly the normalisation
  // this predicate exists to bless, and comparing full origins would reject it.
  const hostOf = (value) => {
    try {
      return new URL(value).host;
    } catch {
      return null;
    }
  };
  for (const hop of chain) {
    if (hostOf(hop.from) !== from.host || hostOf(hop.to) !== from.host) return false;
  }
  if (from.host !== to.host) return false;
  if (to.protocol !== 'https:' && to.protocol !== from.protocol) return false;
  const normalize = (pathname) => (pathname.endsWith('/') ? pathname : `${pathname}/`);
  return normalize(from.pathname) === normalize(to.pathname) && from.search === to.search;
}
