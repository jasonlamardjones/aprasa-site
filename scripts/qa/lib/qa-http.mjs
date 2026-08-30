// Bounded, read-only HTTP client for live production checks.
//
// Read-only by construction: GET/HEAD only, no request body, no cookies kept,
// no crawling. Callers pass routes derived from repository data; this module
// never discovers new URLs by following links.

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ATTEMPTS = 3;
const USER_AGENT = 'aprasa-post-publication-qa/1.0 (+https://aprasa.org; read-only site QA)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A single non-following request. Redirects are surfaced, not swallowed, so
 * the caller can tell a benign trailing-slash normalisation from a route that
 * silently moved somewhere else.
 */
async function requestOnce(url, { method, timeoutMs }) {
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
 * Follow a redirect chain by hand, up to a small bound, recording each hop.
 * Returns the final response plus the chain so redirect correctness can be
 * judged rather than assumed.
 */
export async function fetchFollowing(url, options = {}) {
  const maxHops = options.maxHops ?? 3;
  const chain = [];
  let current = url;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await fetchRoute(current, options);
    if (!response.ok || response.status < 300 || response.status >= 400 || !response.location) {
      return { ...response, chain, requestedUrl: url };
    }
    const next = new URL(response.location, current).toString();
    chain.push({ from: current, status: response.status, to: next });
    current = next;
  }
  return {
    ok: false,
    url: current,
    requestedUrl: url,
    status: null,
    contentType: null,
    location: null,
    body: '',
    bytes: 0,
    attempts: 1,
    duration_ms: 0,
    networkError: `exceeded ${maxHops} redirect hops`,
    chain,
  };
}

/**
 * A redirect chain counts as benign normalisation when every hop stays on the
 * same origin and only adds https or a trailing slash. Anything else is a real
 * route change and must be reported.
 */
export function isNormalizingRedirect(requestedUrl, finalUrl, chain) {
  if (chain.length === 0) return true;
  const from = new URL(requestedUrl);
  const to = new URL(finalUrl);
  if (from.host !== to.host) return false;
  if (to.protocol !== 'https:' && to.protocol !== from.protocol) return false;
  const normalize = (pathname) => (pathname.endsWith('/') ? pathname : `${pathname}/`);
  return normalize(from.pathname) === normalize(to.pathname) && from.search === to.search;
}
