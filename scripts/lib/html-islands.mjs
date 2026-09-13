// Locating the JSON islands the runtime reads, the way a BROWSER locates them.
//
// The runtime calls document.getElementById(). That has two properties a
// regex keyed to one exact spelling does not:
//
//   1. Attribute order, quote style and extra whitespace are not part of an
//      element's identity. <script type="..." id="x"> and <script id="x"
//      type="..."> are the same element to a browser and different strings to
//      a regex.
//   2. getElementById returns the FIRST match in document order. A check that
//      reads "the canonical island" while the browser reads a different one is
//      not checking what ships.
//
// Together those let a second island - written with the attributes the other
// way round, placed first - be read by the runtime while every build-time
// check parses the canonical one and stays green. Parsing by tag and id, in
// document order, is what closes that.
//
// This is deliberately a shared helper: it is parsing mechanics, not the
// governed content under test. The key maps that validate-runtime-locale-
// strings.mjs checks stay duplicated there on purpose, because importing those
// from the module they verify would make the check vacuous. Locating an
// element is not in that category.

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** Attribute name -> value, lower-cased names, order- and quote-independent. */
export function parseAttributes(raw) {
  const attributes = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

/** Every <script> carrying this id, in document order. */
export function findIslands(html, id) {
  const found = [];
  for (const match of html.matchAll(SCRIPT)) {
    const attributes = parseAttributes(match[1]);
    if (attributes.id !== id) continue;
    found.push({attributes, content: match[2], raw: match[0], index: match.index});
  }
  return found;
}

/** The island the runtime would actually read, or null. */
export function firstIsland(html, id) {
  return findIslands(html, id)[0] ?? null;
}
