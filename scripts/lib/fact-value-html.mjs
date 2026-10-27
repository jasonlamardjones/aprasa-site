// HTML TEXT NODES ONLY: preserve source character references (&amp;, &#169;,
// &lt;, etc.) as encoded text. HTML character references are decoded by the
// browser into *text*, never re-tokenized as executable markup. The caller
// first validates the surrounding fact with parseFactValueHtml(), which rejects
// literal tags other than approved links; attribute values use escapeHtml().
export function escapeFactHtmlText(value) {
  return String(value)
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// The approved fact markup is plain text interleaved with simple links.
// Keep the original bytes for valid input; this parser is a publication gate,
// not an HTML normalizer.
export function parseFactValueHtml(value) {
  if (typeof value !== 'string') throw new Error('value_html must be a string');
  const anchors = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('<', cursor);
    if (open === -1) break;
    const tag = /^<a\s+([^<>]+)>/.exec(value.slice(open));
    if (!tag) throw new Error('value_html contains unsupported or malformed markup');
    const attributes = new Map();
    let rest = tag[1];
    while (rest.length) {
      const attribute = /^\s*([a-z]+)="([^"<>]*)"/.exec(rest);
      if (!attribute || !['href', 'target', 'rel'].includes(attribute[1]) || attributes.has(attribute[1])) {
        throw new Error('value_html contains an unexpected or malformed anchor attribute');
      }
      attributes.set(attribute[1], attribute[2]);
      rest = rest.slice(attribute[0].length);
    }
    const href = attributes.get('href');
    if (!href || /[\s&'`\\\u0000-\u001f\u007f]/.test(href)
      || !(href.startsWith('https://') && new URL(href).protocol === 'https:'
        || /^tel:\+?[0-9]+$/.test(href))) {
      throw new Error('value_html contains an unapproved anchor URL');
    }
    const target = attributes.get('target');
    const rel = attributes.get('rel');
    if ((target !== undefined || rel !== undefined)
      && (target !== '_blank' || rel !== 'noopener noreferrer')) {
      throw new Error('value_html contains unapproved anchor attributes');
    }
    const textStart = open + tag[0].length;
    const close = value.indexOf('</a>', textStart);
    if (close === -1 || value.slice(textStart, close).includes('<')) {
      throw new Error('value_html contains a malformed or nested anchor');
    }
    anchors.push({
      html: value.slice(open, close + 4), text: value.slice(textStart, close),
      start: open, end: close + 4, href, target, rel,
    });
    cursor = close + 4;
  }
  if (value.slice(cursor).includes('<')) throw new Error('value_html contains unsupported markup');
  return anchors;
}
