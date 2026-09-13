// Locating the JSON islands the runtime reads, the way a BROWSER locates them.
//
// The runtime calls document.getElementById(). Three properties of that call
// have each, in turn, been got wrong here:
//
//   1. Attribute order, quote style and whitespace are not part of an
//      element's identity. <script type="..." id="x"> and <script id="x"
//      type="..."> are the same element to a browser and different strings to
//      a regex.
//   2. getElementById returns the FIRST match in document order. A check that
//      reads "the canonical island" while the browser reads a different one is
//      not checking what ships.
//   3. getElementById IS NOT CONSTRAINED BY TAG NAME. An earlier
//      <div id="contact-config"> holding JSON is what the browser returns,
//      even though no <script> anywhere is spelled wrongly.
//
// So this module deliberately does NOT filter by tag. It finds every element
// carrying the id, in document order, and reports the tag it found - leaving
// callers to assert that the first one is a <script type="application/json">
// rather than assuming it. Filtering here is what hid (3): a scan that only
// looks at <script> cannot see the element that shadows it.
//
// This is parsing mechanics, not governed content. The key maps that
// validate-runtime-locale-strings.mjs checks stay duplicated there on purpose,
// because importing those from the module they verify would make the check
// vacuous. Locating an element is not in that category.

// Attribute values may contain ">", so quoted runs are consumed whole.
const TAG = /<([a-zA-Z][-\w:]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** Attribute name -> value, lower-cased names, order- and quote-independent. */
export function parseAttributes(raw) {
  const attributes = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

/**
 * Every element carrying this id, ANY tag, in document order - the order
 * getElementById resolves. `content` is filled in for <script> elements only;
 * for anything else it is the element's start tag that matters, because the
 * finding is that the element exists at all.
 */
export function findElementsById(html, id) {
  const found = [];
  for (const match of html.matchAll(TAG)) {
    const attributes = parseAttributes(match[2]);
    if (attributes.id !== id) continue;
    const tag = match[1].toLowerCase();
    let content = null;
    let raw = match[0];
    if (tag === 'script') {
      const closeStart = html.indexOf('</script', match.index);
      if (closeStart !== -1) {
        content = html.slice(match.index + match[0].length, closeStart);
        const closeEnd = html.indexOf('>', closeStart);
        raw = html.slice(match.index, closeEnd === -1 ? closeStart : closeEnd + 1);
      }
    }
    found.push({tag, attributes, content, raw, index: match.index});
  }
  return found;
}

/** The element the runtime would actually read, whatever its tag, or null. */
export function firstElementById(html, id) {
  return findElementsById(html, id)[0] ?? null;
}

/** True when this element is the governed island shape, not merely id-matched. */
export function isJsonIsland(element) {
  return !!element
    && element.tag === 'script'
    && (element.attributes.type || '').toLowerCase() === 'application/json';
}
