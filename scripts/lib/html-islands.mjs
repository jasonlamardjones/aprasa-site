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
const START_TAG = /^<([a-zA-Z][-\w:]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/;
const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

// Elements whose body is raw text, not markup. A tag-shaped string inside one
// is data, never an element - which is why a JavaScript literal such as
// const sample = '<div id="contact-config">' must not register as a duplicate.
const RAW_TEXT = new Set(['script', 'style']);

// An HTML parser DECODES character references in attribute values, so
// id="i18n&#45;strings" is the element id "i18n-strings" to the browser and to
// querySelectorAll - while the undecoded source spelling matches nothing here.
// Left undecoded, an encoded duplicate id makes the runtime see two elements
// and refuse both (Portuguese copy silently falling back to English) while
// every build-time check still passes.
//
// Numeric references are decoded in full. Named references are not a table
// here: the five XML predefined names are decoded, and anything else that
// survives is reported by `hasUndecodedReference` so the caller can refuse the
// page rather than quietly compare the wrong string. A governed page has no
// business carrying an entity-encoded id at all.
// The trailing semicolon is OPTIONAL on a numeric reference, measured against
// Chromium rather than assumed: id="i18n&#45strings" and id="i18n&#x2Dstrings"
// both resolve to the id "i18n-strings" in the DOM. Requiring the semicolon
// left exactly the demonstrated attack working, one character shorter.
const NUMERIC_REFERENCE = /&#(x[0-9a-f]+|[0-9]+);?/gi;
const PREDEFINED = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
const NAMED_REFERENCE = /&([a-z][a-z0-9]{1,31});/gi;

function decodeReferences(value) {
  return value
    .replace(NUMERIC_REFERENCE, (whole, code) => {
      const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    })
    .replace(NAMED_REFERENCE, (whole, name) => PREDEFINED[name.toLowerCase()] ?? whole);
}

/** True when a value still holds a reference this module could not decode. */
export function hasUndecodedReference(value) {
  return /&(#[0-9a-fx]+;?|[a-z][a-z0-9]{1,31};)/i.test(value);
}

/**
 * Attribute name -> value, lower-cased names, order- and quote-independent,
 * with character references decoded so comparisons see what the DOM sees.
 * On a malformed tag that repeats an attribute the HTML parser keeps the FIRST
 * occurrence, so this does too: with <div id="contact-config" id="other"> the
 * DOM holds a contact-config element, and a parser that kept the last would
 * record it as "other" and miss the duplicate entirely.
 */
export function parseAttributes(raw) {
  const attributes = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (name in attributes) continue;
    attributes[name] = decodeReferences(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/**
 * Every element carrying this id, ANY tag, in document order - the order
 * getElementById resolves.
 *
 * This walks the document rather than pattern-matching over it, because only a
 * walk can tell an element from text that merely looks like one. Skipped, as a
 * browser skips them: comment bodies, the raw-text bodies of <script> and
 * <style>, and the CONTENTS of <template> (which parse into a separate
 * fragment, so getElementById never returns anything inside one - though the
 * <template> element itself is in the document and is reported).
 */
export function findElementsById(html, id) {
  const found = [];
  let index = 0;
  let templateDepth = 0;

  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) break;

    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', open) || html.startsWith('<?', open)) {
      const end = html.indexOf('>', open);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', open)) {
      const end = html.indexOf('>', open);
      const name = html.slice(open + 2, end === -1 ? html.length : end).trim().toLowerCase();
      if (name === 'template' && templateDepth > 0) templateDepth -= 1;
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const match = START_TAG.exec(html.slice(open));
    if (!match) {
      index = open + 1;
      continue;
    }

    const tag = match[1].toLowerCase();
    const attributes = parseAttributes(match[2]);
    const afterTag = open + match[0].length;
    let content = null;
    let raw = match[0];
    let next = afterTag;

    if (RAW_TEXT.has(tag)) {
      const closeStart = html.toLowerCase().indexOf(`</${tag}`, afterTag);
      if (closeStart === -1) {
        content = html.slice(afterTag);
        next = html.length;
      } else {
        content = html.slice(afterTag, closeStart);
        const closeEnd = html.indexOf('>', closeStart);
        raw = html.slice(open, closeEnd === -1 ? closeStart : closeEnd + 1);
        next = closeEnd === -1 ? closeStart : closeEnd + 1;
      }
    }

    // The <template> element itself is in the document; its contents are not.
    if (templateDepth === 0 && attributes.id === id) {
      found.push({tag, attributes, content, raw, index: open});
    }
    if (tag === 'template' && !match[2].trimEnd().endsWith('/')) templateDepth += 1;

    index = next;
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
