// Canonical internal-link forms for A PRASA's own pages.
//
// A live technical SEO audit found internal navigation pointing at explicit
// Home document URLs — /index.html, /pt/index.html and the
// /index.html#things-to-do return anchor. Those URLs return 200 and
// canonicalize correctly, so this is a link-hygiene correction, not a
// canonical-policy change: the canonical URL of Home is, and stays,
// https://aprasa.org/ (and https://aprasa.org/pt/). Nothing here adds a
// redirect or changes any <link rel="canonical">.
//
// The rewrite is deliberately narrow. It only touches an href whose ENTIRE
// value is a Home document reference: an optional run of "../" hops followed
// by "index.html" (optionally carrying the legacy #things-to-do fragment).
// It therefore cannot reach a deeper page reference, an absolute URL, an
// asset path, or an in-page anchor such as href="#things-to-do", and it is
// idempotent — a value already in directory form contains no "index.html" to
// match, so re-running the builders is a no-op.

/** href value forms this normalizer targets, for reporting and regression checks. */
export const NONCANONICAL_HOME_HREF = /href="((?:\.\.\/)*)index\.html(#[^"]*)?"/g;

/**
 * Rewrites Home document links to their clean directory form.
 *
 * `href="index.html"`        -> `href="./"`
 * `href="../index.html"`     -> `href="../"`
 * `href="../../index.html"`  -> `href="../../"`
 *
 * When `collectionHref` is supplied, the legacy Home return anchor
 * `href="…index.html#things-to-do"` is repointed at the page's own
 * same-locale Things-to-Do collection route instead of a Home fragment. The
 * caller supplies that href because it is depth-relative to the page being
 * written; this module never guesses it.
 */
export function normalizeCanonicalHomeLinks(html, { collectionHref = null } = {}) {
  let out = html;
  if (collectionHref) {
    out = out.replace(/href="(?:\.\.\/)*index\.html#things-to-do"/g, `href="${collectionHref}"`);
  }
  out = out.replace(/href="((?:\.\.\/)*)index\.html"/g, (whole, ups) => `href="${ups || './'}"`);
  return out;
}

/** Every remaining noncanonical Home href in `html`, for regression reporting. */
export function findNoncanonicalHomeLinks(html) {
  return [...html.matchAll(NONCANONICAL_HOME_HREF)].map((match) => match[0]);
}
