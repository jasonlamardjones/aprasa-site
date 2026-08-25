// Deterministic, dependency-free HTML text/attribute localizer for the
// hand-authored static pages (Home, About, Mindelo Essentials, and the two
// hand-authored Things-to-Do pages). This is NOT a hand-maintained PT copy:
// the PT output is mechanically regenerated from the EN source file plus
// the governed locale data on every run, so the EN file remains the single
// authored source of truth (per the localization spec's ban on independent
// PT translation authority).
//
// Strategy: walk the raw HTML as a simple token stream (tag / text /
// comment / raw-text element), and inside each text-content segment or
// translatable attribute value, look up the ENTIRE TRIMMED segment (after
// decoding HTML entities) against the governed EN->PT map. A match requires
// the whole segment to equal a governed English string exactly — never a
// substring — so a short common word (e.g. "Home") is only ever translated
// where it stands alone as its own element/attribute text, never where it
// happens to appear inside a longer untranslated sentence or inside
// markup/URLs.
//
// Content between <!-- BEGIN GENERATED EVENT: id --> / END markers is
// passed through unchanged: that region is owned by
// scripts/generate-things-to-do.mjs (run separately, after this pass) and
// re-translating it here would just be redone.
//
// Any EN text found in a translatable position that has NO governed match
// is reported back to the caller (unmatchedEnglish) rather than silently
// left as-is-and-ignored, so callers can decide whether that's expected
// (e.g. protected identity text) or a real gap.

import { loadLocaleData } from './locale.mjs';

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
const TRANSLATABLE_ATTRS = new Set(['alt', 'aria-label', 'title', 'placeholder']);
// meta[content] is only translatable for these name/property values; other
// meta content (viewport, charset-adjacent, theme-color, etc.) is technical
// and must never be run through the text/entity pipeline.
const TRANSLATABLE_META = new Set(['description', 'og:title', 'og:description', 'twitter:title', 'twitter:description', 'og:image:alt']);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', nbsp: ' ', hellip: '…',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ent in NAMED_ENTITIES ? NAMED_ENTITIES[ent] : m;
  });
}

// Only & < > need re-encoding for HTML validity; curly quotes, dashes, and
// accented characters are shipped as literal UTF-8, matching how the rest
// of these files already write accented text (São, praça, ...).
function encodeMinimal(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEnIndex() {
  const data = loadLocaleData();
  const index = new Map(); // decoded en text -> { pt, key, scope_status } | { ambiguous: true }
  for (const row of Object.values(data.keys)) {
    if (!row.en) continue;
    const pt = row.scope_status === 'INTENTIONALLY_UNCHANGED' ? row.en : row.pt;
    const existing = index.get(row.en);
    if (existing && !existing.ambiguous && existing.pt !== pt) {
      index.set(row.en, { ambiguous: true });
      continue;
    }
    index.set(row.en, { pt, key: row.key, scope_status: row.scope_status });
  }
  return index;
}

function findTagEnd(html, start) {
  let i = start + 1;
  let inQuote = null;
  while (i < html.length) {
    const c = html[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (c === '>') {
      return i + 1;
    }
    i++;
  }
  return html.length;
}

// Tries an exact (untrimmed, only entity-decoded) match first — this is
// what makes a segment like "A PRASA — " (meaningful trailing space before
// hidden text) match its governed key exactly, PT trailing space included.
// Falls back to a trimmed match for ordinary indentation-padded block text.
// A leading "— " (bullet-style dash before an inline value, e.g. "<strong>L1</strong> — Ribeirinha...")
// or a trailing ":" (a label rendered as "Location:" where the governed key
// is just "Location") is punctuation the template adds around a governed
// value, not part of the governed text itself — strip it before matching
// and restore it around the translated result.
const AAFFIX_PREFIX = '— ';
const AFFIX_SUFFIX = ':';

function lookup(rawText, enIndex, unmatched, where) {
  const exact = decodeEntities(rawText);
  const exactHit = enIndex.get(exact);
  if (exactHit) return exactHit.ambiguous ? reportAmbiguous(exact, unmatched, where) : { ...exactHit, matchedText: exact, trimmed: false };

  const trimmed = decodeEntities(rawText.trim());
  if (!trimmed) return null;
  const hit = enIndex.get(trimmed);
  if (hit) {
    if (hit.ambiguous) return reportAmbiguous(trimmed, unmatched, where);
    return { ...hit, matchedText: trimmed, trimmed: true };
  }

  if (trimmed.startsWith(AAFFIX_PREFIX)) {
    const inner = lookup(trimmed.slice(AAFFIX_PREFIX.length), enIndex, [], where);
    if (inner) return { ...inner, pt: AAFFIX_PREFIX + inner.pt, matchedText: trimmed, trimmed: true };
  }
  if (trimmed.endsWith(AFFIX_SUFFIX)) {
    const inner = lookup(trimmed.slice(0, -AFFIX_SUFFIX.length), enIndex, [], where);
    if (inner) return { ...inner, pt: inner.pt + AFFIX_SUFFIX, matchedText: trimmed, trimmed: true };
  }

  if (/[A-Za-z]{3,}/.test(trimmed)) unmatched.push({ where, text: trimmed });
  return null;
}

function reportAmbiguous(text, unmatched, where) {
  unmatched.push({ where: `${where} (ambiguous key)`, text });
  return null;
}

function metaContentContext(tagHtml) {
  const nameMatch = tagHtml.match(/\b(?:name|property)\s*=\s*"([^"]+)"/i);
  return nameMatch ? nameMatch[1].toLowerCase() : null;
}

function translateAttrs(tagHtml, enIndex, unmatched, locale) {
  const isMeta = /^<meta\b/i.test(tagHtml);
  const metaCtx = isMeta ? metaContentContext(tagHtml) : null;
  return tagHtml.replace(/([a-zA-Z-]+)(\s*=\s*)("([^"]*)"|'([^']*)')/g, (whole, name, eq, quoted, dq, sq) => {
    const lname = name.toLowerCase();
    const isContent = lname === 'content';
    if (!TRANSLATABLE_ATTRS.has(lname) && !isContent) return whole;
    if (isContent && (!isMeta || !TRANSLATABLE_META.has(metaCtx))) return whole;
    const quoteChar = quoted[0];
    const value = dq !== undefined ? dq : sq;
    if (!value.trim()) return whole;
    const hit = lookup(value, enIndex, unmatched, `attr:${lname}`);
    if (!hit || locale === 'en') return whole;
    const encoded = encodeMinimal(hit.pt).replaceAll(quoteChar, quoteChar === '"' ? '&quot;' : '&#039;');
    return `${name}${eq}${quoteChar}${encoded}${quoteChar}`;
  });
}

function translateText(text, enIndex, unmatched, locale) {
  if (!text.trim()) return text;
  const hit = lookup(text, enIndex, unmatched, 'text');
  if (!hit || locale === 'en') return text;
  if (!hit.trimmed) return encodeMinimal(hit.pt);
  const trimmedStart = text.length - text.trimStart().length;
  const leadingWs = text.slice(0, trimmedStart);
  const trailingWs = text.slice(trimmedStart + hit.matchedText.length);
  return leadingWs + encodeMinimal(hit.pt) + trailingWs;
}

/**
 * Localizes text content and translatable attributes in an HTML document.
 * Returns { html, unmatchedEnglish } — unmatchedEnglish lists every
 * translatable-looking English string that had no governed key, so the
 * caller can fail generation on anything unexpected rather than silently
 * shipping untranslated copy on a PT page.
 */
export function localizeStaticHtml(html, locale) {
  const enIndex = buildEnIndex();
  const unmatched = [];
  let out = '';
  let i = 0;
  const n = html.length;

  while (i < n) {
    if (html.startsWith('<!-- BEGIN GENERATED EVENT:', i)) {
      const endMarkerStart = html.indexOf('<!-- END GENERATED EVENT:', i);
      const endMarkerClose = endMarkerStart === -1 ? -1 : html.indexOf('-->', endMarkerStart);
      const stop = endMarkerClose === -1 ? n : endMarkerClose + 3;
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    // A page-specific fixup (e.g. a governed sentence reconstructed around
    // an inline <a> that fragments it) already inserted final localized
    // text here — pass it through without re-scanning/re-matching it.
    if (html.startsWith('<!--i18n:skip-->', i)) {
      const marker = '<!--i18n:skip-->';
      const endMarker = '<!--/i18n:skip-->';
      const endIdx = html.indexOf(endMarker, i + marker.length);
      const stop = endIdx === -1 ? n : endIdx + endMarker.length;
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i);
      const stop = end === -1 ? n : end + 3;
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    if (html[i] === '<') {
      const tagEnd = findTagEnd(html, i);
      let tagHtml = html.slice(i, tagEnd);
      const nameMatch = tagHtml.match(/^<\/?([a-zA-Z0-9]+)/);
      const tagName = nameMatch ? nameMatch[1].toLowerCase() : null;
      const isClosing = tagHtml.startsWith('</');
      if (!isClosing) tagHtml = translateAttrs(tagHtml, enIndex, unmatched, locale);
      out += tagHtml;
      i = tagEnd;
      if (tagName && RAW_TEXT_TAGS.has(tagName) && !isClosing && !tagHtml.endsWith('/>')) {
        const closeTag = `</${tagName}`;
        const lower = html.toLowerCase();
        const closeIdx = lower.indexOf(closeTag, i);
        const stop = closeIdx === -1 ? n : closeIdx;
        // <title> content is translatable text, unlike script/style/textarea.
        if (tagName === 'title') {
          out += translateText(html.slice(i, stop), enIndex, unmatched, locale);
        } else {
          out += html.slice(i, stop);
        }
        i = stop;
      }
      continue;
    }
    const nextTag = html.indexOf('<', i);
    const textEnd = nextTag === -1 ? n : nextTag;
    out += translateText(html.slice(i, textEnd), enIndex, unmatched, locale);
    i = textEnd;
  }

  return { html: out, unmatchedEnglish: unmatched };
}
