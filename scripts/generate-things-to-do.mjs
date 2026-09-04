import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, hasKey } from './lib/locale.mjs';
import { bodyParagraphs, factKeyBase } from './lib/things-to-do-keys.mjs';
import { currentnessState, isExpired as recordIsExpired, EXPIRED, REVIEW_DUE } from './lib/things-to-do-currentness.mjs';
import { HOME_PREVIEW_LIMIT, collectionRecords, homePreviewIds, hubOutputPath, hubCanonical } from './lib/things-to-do-collection.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const input = path.join(root, 'data', 'things-to-do-events.json');
const records = JSON.parse(fs.readFileSync(input, 'utf8')).records;
const thingsToDoRoot = path.join(root, 'things-to-do');
const ptThingsToDoRoot = path.join(root, 'pt', 'things-to-do');
const detailRoutePattern = /^things-to-do\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;

const asOfArg = process.argv.find((arg) => arg.startsWith('--as-of='));
const idArg = process.argv.find((arg) => arg.startsWith('--id='));
const localeArg = process.argv.find((arg) => arg.startsWith('--locale='));
if (!asOfArg) {
  console.error('Missing required --as-of=YYYY-MM-DD');
  process.exit(1);
}
const asOf = asOfArg.split('=')[1];
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error(`Invalid --as-of date: ${asOf}`);
  process.exit(1);
}
const requestedId = idArg ? idArg.split('=')[1] : null;
const write = process.argv.includes('--write');
const locale = localeArg ? localeArg.split('=')[1] : 'en';
if (locale !== 'en' && locale !== 'pt') {
  console.error(`Invalid --locale: ${locale} (expected "en" or "pt")`);
  process.exit(1);
}

// Governed per-record presentation lookup. Canonical facts (provider,
// location.name, source_url, ids, coordinates, dates) come straight from
// data/things-to-do-events.json for BOTH locales and are never looked up
// here — only presentation/copy fields are locale-keyed. For locale "en"
// this returns the JSON's own English value unchanged (zero EN regression
// risk); for "pt" it throws if the governed overlay has no approved value,
// per the no-silent-fallback contract.
function evt(record, suffix, jsonValue) {
  if (locale === 'en') return jsonValue;
  return t(`event.${record.id}.${suffix}`, 'pt');
}

// Reconstructs a locale-localized value_html for a fact whose English value
// carries markup (links). Anchor tags are canonical (URLs are locale-
// independent) and are preserved as-is; only the connecting text around them
// is swapped for the governed PT display text. Throws rather than guessing
// if the PT text doesn't contain the same anchor visible-text in the same
// order, so this never silently mangles a link.
function localizeFactValueHtml(enHtml, ptDisplay, record, fact) {
  const anchors = enHtml.match(/<a\b[^>]*>.*?<\/a>/gs) || [];
  if (anchors.length === 0) return escapeHtml(ptDisplay);
  const anchorTexts = anchors.map((a) => a.replace(/<[^>]+>/g, ''));
  let rest = ptDisplay;
  const segments = [];
  for (const text of anchorTexts) {
    const idx = rest.indexOf(text);
    if (idx === -1) {
      throw new Error(
        `${record.id}: cannot safely localize HTML value for fact "${fact.label}" — governed PT display text does not contain expected link text "${text}"`
      );
    }
    segments.push(rest.slice(0, idx));
    rest = rest.slice(idx + text.length);
  }
  segments.push(rest);
  let result = '';
  anchors.forEach((anchor, i) => {
    result += escapeHtml(segments[i]) + anchor;
  });
  result += escapeHtml(segments[anchors.length]);
  return result;
}

function localeRoutePrefix() {
  return locale === 'pt' ? 'pt/' : '';
}

// Site chrome strings (nav/footer/generic UI copy shared by every generated
// page) resolved once per run. For locale "en" these come from the
// governed overlay's own source_en values (sanctioned by the localization
// spec section 12E) and are verified to match the pre-existing hardcoded
// EN copy; for "pt" a missing value throws (no-silent-fallback contract).
const CHROME = {
  skipToContent: t('global.skip_to_content', locale),
  navHome: t('nav.home', locale),
  navMindelo: t('nav.mindelo_essentials', locale),
  navAbout: t('nav.about', locale),
  navAria: t('nav.site_navigation', locale),
  brandAria: t('home.brand_aria', locale),
  breadcrumbAria: t('things.shared.breadcrumb_aria', locale),
  backToThings: t('things.shared.back_to_things', locale),
  detailsHeading: t('things.shared.details_heading', locale),
  goodToKnowHeading: t('things.shared.good_to_know_heading', locale),
  pastEvent: t('ui.past_event', locale),
  viewPage: t('ui.view_page', locale),
  backToTop: t('ui.back_to_top', locale),
  footerTagline: t('footer.tagline', locale),
  footerIndependence: t('footer.independence_note', locale),
  footerContactTitle: t('footer.contact_title', locale),
  footerContactPrompt: t('footer.contact_prompt', locale),
  footerContactAction: t('footer.contact_action', locale),
  // Things-to-Do collection hub (Project 03 product / Project 09 approved copy).
  thingsKicker: t('home.things.kicker', locale),
  hubH1: t('things.hub.h1', locale),
  hubIntro: t('things.hub.intro', locale),
  hubBoundary: t('things.hub.boundary', locale),
  hubCardAction: t('things.hub.card_action.label', locale),
  hubEmptyState: t('things.hub.empty_state', locale),
  hubMetaTitle: t('things.hub.meta.title', locale),
  hubMetaDescription: t('things.hub.meta.description', locale),
};

const sitewideSocialFallback = {
  asset: 'assets/social/aprasa-social-share-card-identity-v2.jpg',
  type: 'image/jpeg',
  width: 1536,
  height: 807,
  alt: 'A PRASA Identity v2.0 social card with the A PRASA symbol and wordmark, the line A place to find what moves you., aprasa.org, and an illustrated Mindelo praça scene.'
};

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// EXPIRED only. A REVIEW_DUE record is still public: it keeps its collection
// membership and its detail page is not labelled a past event. Reverification
// is demanded by the currentness validator, never by silently removing the
// record.
function isExpired(record) {
  return recordIsExpired(record, asOf);
}

// The approved Home preview. Project 03 approved Home as a LIMITED PREVIEW of
// the first three eligible records in canonical order, with the full eligible
// collection living on the dedicated hub — so eligibility alone no longer puts
// a record on Home. Membership and ordering come from the shared collection
// module, never from a second copy of the rule here.
//
// Ordering is canonical record order filtered to eligible records. It is not
// popularity, SEO demand, provider status, commercial relationship, payment or
// sponsorship, and must never become any of those.
const hubRecords = collectionRecords(records, asOf);
const homePreview = homePreviewIds(records, asOf);

function resolveDetailTarget(record) {
  if (typeof record.detail_page !== 'string' || !detailRoutePattern.test(record.detail_page)) {
    throw new Error(`${record.id}: invalid detail_page; expected things-to-do/<slug>/`);
  }

  const base = locale === 'pt' ? path.join(root, 'pt') : root;
  const allowedRoot = locale === 'pt' ? ptThingsToDoRoot : thingsToDoRoot;
  const targetDir = path.resolve(base, record.detail_page);
  const allowedPrefix = `${allowedRoot}${path.sep}`;
  if (!targetDir.startsWith(allowedPrefix)) {
    throw new Error(`${record.id}: detail_page resolves outside things-to-do/`);
  }

  const target = path.join(targetDir, 'index.html');
  if (!target.startsWith(allowedPrefix)) {
    throw new Error(`${record.id}: detail output resolves outside things-to-do/`);
  }

  return target;
}

function mediaType(asset) {
  if (asset.endsWith('.png')) return 'image/png';
  if (asset.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function detailMediaClass(record) {
  return record.id === 'part-ilhas-nuno-miranda' ? 'dialog-media' : 'record-media';
}

// Builds the locale-resolved presentation view of a record. Canonical facts
// (provider, location.name, source_url, ids, coordinates, dates) are read
// straight off `record` for both locales, never looked up here. For
// locale "en" every field below is the JSON's own English value, so the
// English generation path has no dependency on the locale overlay at all.
function localizeRecord(record) {
  const facts = (record.detail?.facts || []).map((fact) => {
    if (locale === 'en') {
      return fact.value_html
        ? { label: fact.label, value_html: fact.value_html }
        : { label: fact.label, value: fact.value };
    }
    const base = factKeyBase(record.id, fact);
    const label = t(`event.${record.id}.detail.fact.${base}.label`, 'pt');
    if (fact.value_html) {
      const ptDisplay = t(`event.${record.id}.detail.fact.${base}.value_display`, 'pt');
      return { label, value_html: localizeFactValueHtml(fact.value_html, ptDisplay, record, fact) };
    }
    return { label, value: t(`event.${record.id}.detail.fact.${base}.value_display`, 'pt') };
  });

  return {
    title: evt(record, 'title', record.title),
    summary: evt(record, 'summary', record.summary),
    displayStatus: evt(record, 'display.status', record.display?.status),
    displayMeta: evt(record, 'display.meta', record.display?.meta),
    displayChecked: evt(record, 'display.checked', record.display?.checked),
    mediaAlt: record.media ? evt(record, 'media.alt', record.media.alt) : null,
    cardActionLabel: record.card_action ? evt(record, 'card_action.label', record.card_action.label) : null,
    goodToKnow: record.detail?.good_to_know ? evt(record, 'detail.good_to_know', record.detail.good_to_know) : null,
    detailBody: evt(record, 'detail.body', record.detail?.body),
    detailChecked: evt(record, 'detail.checked', record.detail?.checked),
    actionLabel: record.detail?.action_label ? evt(record, 'detail.action_label', record.detail.action_label) : null,
    seoDescription: evt(record, 'seo.description', record.seo.description),
    seoTitle: evt(record, 'seo.title', record.seo.title),
    facts,
  };
}

// Renders a governed detail body as one <p> per paragraph, indented to sit in
// the surrounding markup. Paragraph structure comes from the shared
// bodyParagraphs() rule (blank line = paragraph break, single newline is not),
// and each paragraph is escaped exactly as before — governed source copy never
// supplies raw HTML and still cannot. A single-paragraph body produces the
// identical one-<p> string this used to emit inline, so incumbent event output
// is unchanged byte-for-byte.
function renderBodyParagraphs(body, indent) {
  return bodyParagraphs(body)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join(`\n${indent}`);
}

function renderFacts(facts = []) {
  return facts.map((fact) => {
    const value = fact.value_html ?? escapeHtml(fact.value ?? '');
    return `<div><dt>${escapeHtml(fact.label)}</dt><dd>${value}</dd></div>`;
  }).join('');
}

function renderSchema(record, loc, expired) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': record.seo?.schema_type ?? 'Event',
    name: loc.title,
    url: `https://aprasa.org/${localeRoutePrefix()}${record.detail_page}`,
    description: loc.summary,
    // Schema.org EventStatusType has no "completed" value; omit eventStatus
    // for expired events rather than emit an invalid enumeration member.
    ...(expired ? {} : { eventStatus: 'https://schema.org/EventScheduled' }),
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: record.location?.name,
      address: {
        '@type': 'PostalAddress',
        ...(record.location?.street ? { streetAddress: record.location.street } : {}),
        ...(record.location?.locality ? { addressLocality: record.location.locality } : {})
      }
    },
    organizer: { '@type': 'Organization', name: record.provider }
  };

  if (record.start_datetime) schema.startDate = record.start_datetime;
  else if (record.start_date) schema.startDate = record.start_date;
  // endDate is emitted only from a verified exact value. A month-precision
  // record deliberately serializes no endDate at all: Schema.org has no
  // month-granular end, and inventing a day would publish a closing date no
  // source establishes.
  if (record.end_datetime) schema.endDate = record.end_datetime;
  else if (record.start_date && record.end_date) schema.endDate = record.end_date;
  if (typeof record.free_admission === 'boolean') schema.isAccessibleForFree = record.free_admission;
  if (record.media?.asset) schema.image = `https://aprasa.org/${record.media.asset}`;

  return JSON.stringify(schema, null, 2);
}

function renderHomeArticle(record, loc) {
  // Home lives at index.html (EN) or pt/index.html (PT), and detail pages at
  // things-to-do/<slug>/ or pt/things-to-do/<slug>/ respectively — Home and
  // its detail pages are always siblings-under-the-same-root, so the
  // relative link is identical text in both locales; it must NOT be
  // prefixed with "pt/" here (that would double up once pt/index.html
  // itself lives under pt/, producing pt/pt/things-to-do/...).
  const detailHref = record.detail_page;
  // Home's own media path (unlike detailHref above) IS locale-depth
  // sensitive: EN Home lives at the true root (asset path unprefixed is
  // correct), PT Home lives one directory deeper at pt/index.html and
  // needs the same single "../" every other shared asset on that page
  // gets (see build-static-pages.mjs's deepenSharedAssetPaths).
  const homeMediaPrefix = locale === 'pt' ? '../' : '';
  const media = record.media ? `\n          <div class="card-media"><img src="${homeMediaPrefix}${escapeHtml(record.media.asset)}" alt="${escapeHtml(loc.mediaAlt)}" loading="lazy" width="${record.media.width}" height="${record.media.height}"></div>` : '';
  const externalAction = record.card_action ? `\n            <a class="resource-link" href="${escapeHtml(record.card_action.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(loc.cardActionLabel)} <span aria-hidden="true">↗</span></a>` : '';
  const dialogMedia = record.media ? `\n              <div class="dialog-media"><img src="${homeMediaPrefix}${escapeHtml(record.media.asset)}" alt="${escapeHtml(loc.mediaAlt)}" loading="lazy" width="${record.media.width}" height="${record.media.height}"></div>` : '';
  const goodToKnow = loc.goodToKnow ? `\n              <h3>${escapeHtml(CHROME.goodToKnowHeading)}</h3>\n              <p>${escapeHtml(loc.goodToKnow)}</p>` : '';
  const dialogAction = loc.actionLabel ? `\n              <a class="dialog-link" href="${escapeHtml(record.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(loc.actionLabel)} <span aria-hidden="true">↗</span></a>` : '';
  // Only an exact day-precision end is published here. A month-precision
  // record has no verified closing day, so no end attribute is emitted --
  // never a day synthesized from end_month.
  const endAttribute = record.end_date ? ` data-event-end="${record.end_date}"` : '';

  return `        <article class="resource-card" data-event-id="${escapeHtml(record.id)}"${endAttribute} data-checked="${escapeHtml(record.checked_at)}">${media}
          <p class="card-status">${escapeHtml(loc.displayStatus)}</p>
          <h3>${escapeHtml(loc.title)}</h3>
          <p class="card-meta">${escapeHtml(loc.displayMeta)}</p>
          <p class="provider">${escapeHtml(record.provider)}</p>
          <p class="checked">${escapeHtml(loc.displayChecked)}</p>
          <div class="card-actions">
            <button class="details-button" type="button" data-details>${escapeHtml(CHROME.detailsHeading)}</button>${externalAction}
            <a class="resource-link" href="${escapeHtml(detailHref)}">${escapeHtml(CHROME.viewPage)}</a>
          </div>
          <template class="details-template">
            <div class="dialog-record" data-event-id="${escapeHtml(record.id)}">${dialogMedia}
              <p class="provider">${escapeHtml(record.provider)}</p>
              <h2>${escapeHtml(loc.title)}</h2>
              <dl class="detail-list">${renderFacts(loc.facts)}</dl>
              <h3>${escapeHtml(CHROME.detailsHeading)}</h3>
              ${renderBodyParagraphs(loc.detailBody, '              ')}${goodToKnow}
              <p class="checked">${escapeHtml(loc.detailChecked)}</p>${dialogAction}
            </div>
          </template>
        </article>`;
}

function renderSocialMeta(record, loc) {
  const social = record.media ? {
    asset: record.media.asset,
    type: mediaType(record.media.asset),
    width: record.media.width,
    height: record.media.height,
    alt: loc.mediaAlt
  } : sitewideSocialFallback;

  return `<meta property="og:image" content="https://aprasa.org/${escapeHtml(social.asset)}">\n<meta property="og:image:type" content="${social.type}">\n<meta property="og:image:width" content="${social.width}">\n<meta property="og:image:height" content="${social.height}">\n<meta property="og:image:alt" content="${escapeHtml(social.alt)}">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:title" content="${escapeHtml(loc.title)}">\n<meta name="twitter:description" content="${escapeHtml(loc.seoDescription)}">\n<meta name="twitter:image" content="https://aprasa.org/${escapeHtml(social.asset)}">`;
}

// href targets for the language switch and nav links, relative to a detail
// page at things-to-do/<slug>/ (EN, 2 levels deep) or pt/things-to-do/<slug>/
// (PT, 3 levels deep).
function detailPageLinks(record) {
  const rootPrefix = locale === 'pt' ? '../../../' : '../../';
  const slug = record.detail_page.replace(/^things-to-do\//, '').replace(/\/$/, '');
  return {
    rootPrefix,
    // Clean canonical directory form. Home's canonical URL is
    // https://aprasa.org/ (and /pt/), so internal navigation points at the
    // directory, never at the explicit index.html document URL. This changes
    // no canonical policy and adds no redirect — see scripts/lib/canonical-links.mjs.
    home: locale === 'en' ? rootPrefix : `${rootPrefix}pt/`,
    mindelo: locale === 'en' ? `${rootPrefix}mindelo-essentials/` : `${rootPrefix}pt/mindelo-essentials/`,
    about: locale === 'en' ? `${rootPrefix}about/` : `${rootPrefix}pt/about/`,
    // The collection this record belongs to. A detail page is a direct child
    // of its locale's hub route (things-to-do/<slug>/ under things-to-do/, and
    // pt/things-to-do/<slug>/ under pt/things-to-do/), so the parent-collection
    // href is the same "../" in both locales and always stays same-locale.
    collection: '../',
    // Equivalent-page mapping for the language switch: the same slug under
    // things-to-do/ (EN) or pt/things-to-do/ (PT), relative from either page.
    enHref: `${rootPrefix}things-to-do/${slug}/`,
    ptHref: `${rootPrefix}pt/things-to-do/${slug}/`,
  };
}

function renderDetailPage(record, loc) {
  const expired = isExpired(record);
  const canonicalEn = `https://aprasa.org/${record.detail_page}`;
  const canonicalPt = `https://aprasa.org/pt/${record.detail_page}`;
  const canonical = locale === 'pt' ? canonicalPt : canonicalEn;
  const links = detailPageLinks(record);
  const media = record.media ? `\n      <div class="${detailMediaClass(record)}"><img src="${links.rootPrefix}${escapeHtml(record.media.asset)}" alt="${escapeHtml(loc.mediaAlt)}" loading="lazy" width="${record.media.width}" height="${record.media.height}"></div>` : '';
  const pastStatus = expired ? `\n      <p class="card-status">${escapeHtml(CHROME.pastEvent)}</p>` : '';
  const goodToKnow = loc.goodToKnow ? `\n      <h2>${escapeHtml(CHROME.goodToKnowHeading)}</h2>\n      <p>${escapeHtml(loc.goodToKnow)}</p>` : '';
  const action = loc.actionLabel ? `\n      <a class="dialog-link" href="${escapeHtml(record.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(loc.actionLabel)} <span aria-hidden="true">↗</span></a>` : '';

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${escapeHtml(loc.seoDescription)}">
<title>${escapeHtml(loc.seoTitle)}</title>
<link rel="canonical" href="${canonical}">
<link rel="alternate" hreflang="en" href="${canonicalEn}">
<link rel="alternate" hreflang="pt" href="${canonicalPt}">
<link rel="alternate" hreflang="x-default" href="${canonicalEn}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="A PRASA">
<meta property="og:title" content="${escapeHtml(loc.title)}">
<meta property="og:description" content="${escapeHtml(loc.seoDescription)}">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="${locale === 'pt' ? 'pt_PT' : 'en_US'}">
${renderSocialMeta(record, loc)}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Libre+Baskerville&family=Work+Sans&display=swap">
<link rel="stylesheet" href="${links.rootPrefix}prasa-launch.css">
<script src="${links.rootPrefix}prasa-launch.js" defer></script>
<!-- Privacy-friendly analytics by Plausible -->
<script async src="https://plausible.io/js/pa-eShJ2lYHDu0B2CdpzVYvZ.js"></script>
<script>
  window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
  plausible.init()
</script>
<script type="application/ld+json">
${renderSchema(record, loc, expired)}
</script>
</head>
<body>
<!-- Generated from data/things-to-do-events.json: ${escapeHtml(record.id)} (locale: ${locale}) -->
<a class="skip-link" href="#main">${escapeHtml(CHROME.skipToContent)}</a>

<header class="site-header" aria-label="A PRASA">
  <div class="container header-inner">
    <a class="brand" href="${links.home}" aria-label="${escapeHtml(CHROME.brandAria)}">
      <img src="${links.rootPrefix}assets/brand/A_PRASA_Lockup_Horizontal_v2_Primary_Green.svg" alt="" width="4959" height="725">
    </a>
    <div class="header-actions">
      <nav class="site-nav" aria-label="${escapeHtml(CHROME.navAria)}">
        <a href="${links.home}">${escapeHtml(CHROME.navHome)}</a>
        <a href="${links.mindelo}">${escapeHtml(CHROME.navMindelo)}</a>
        <a href="${links.about}">${escapeHtml(CHROME.navAbout)}</a>
      </nav>
      <nav class="lang-switch" aria-label="Language / Idioma">
        <a href="${links.enHref}" lang="en" hreflang="en"${locale === 'en' ? ' aria-current="true" class="lang-current"' : ''}>EN</a>
        <a href="${links.ptHref}" lang="pt" hreflang="pt"${locale === 'pt' ? ' aria-current="true" class="lang-current"' : ''}>PT</a>
      </nav>
    </div>
  </div>
</header>

<main id="main">
  <div class="container record-page">
    <nav class="breadcrumb" aria-label="${escapeHtml(CHROME.breadcrumbAria)}">
      <a href="${links.collection}">${escapeHtml(CHROME.backToThings)}</a>
    </nav>
    <article class="dialog-record record-article" data-event-id="${escapeHtml(record.id)}">${media}${pastStatus}
      <p class="provider">${escapeHtml(record.provider)}</p>
      <h1>${escapeHtml(loc.title)}</h1>
      <dl class="detail-list">${renderFacts(loc.facts)}</dl>
      <h2>${escapeHtml(CHROME.detailsHeading)}</h2>
      ${renderBodyParagraphs(loc.detailBody, '      ')}${goodToKnow}
      <p class="checked">${escapeHtml(loc.detailChecked)}</p>${action}
    </article>
  </div>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <a class="footer-brand" href="${links.home}" aria-label="${escapeHtml(CHROME.brandAria)}">
      <img src="${links.rootPrefix}assets/brand/A_PRASA_Lockup_Horizontal_v2_Reversed_Cream.svg" alt="" width="4959" height="725">
    </a>
    <p>${escapeHtml(CHROME.footerTagline)}</p>
    <p class="footer-note">${escapeHtml(CHROME.footerIndependence)}</p>
    <div class="footer-contact">
      <p class="footer-contact-title">${escapeHtml(CHROME.footerContactTitle)}</p>
      <p>${escapeHtml(CHROME.footerContactPrompt)} <a href="https://wa.me/message/GC3C5Q4MSF37I1" target="_blank" rel="noopener noreferrer">${escapeHtml(CHROME.footerContactAction)}</a>.</p>
    </div>
    <a class="back-top" href="#main">${escapeHtml(CHROME.backToTop)}</a>
  </div>
</footer>
</body>
</html>
`;
}

// --- Things-to-Do collection hub -------------------------------------------
//
// One generated collection surface per locale:
//   EN  things-to-do/index.html      -> https://aprasa.org/things-to-do/
//   PT  pt/things-to-do/index.html   -> https://aprasa.org/pt/things-to-do/
//
// It is a PROJECTION of the same canonical corpus (data/things-to-do-events.json)
// and the same currentness state every other Things-to-Do surface consumes. It
// creates no event record, no second factual corpus and no taxonomy of its own,
// and its per-record strings are the existing governed event.<id>.* presentation
// reused unchanged — nothing here retranslates event copy.
//
// The card carries ONE call to action, the governed hub CTA, pointing at the
// same-locale canonical detail route. A record's own external card_action is
// deliberately not reproduced here: the hub's job is to lead into the
// collection's own detail pages, not to become an outbound provider index.

// href targets for a page at things-to-do/ (EN, 1 level deep) or
// pt/things-to-do/ (PT, 2 levels deep).
function hubPageLinks() {
  const rootPrefix = locale === 'pt' ? '../../' : '../';
  return {
    rootPrefix,
    // Clean canonical directory form — see detailPageLinks() above.
    home: locale === 'en' ? rootPrefix : `${rootPrefix}pt/`,
    mindelo: locale === 'en' ? `${rootPrefix}mindelo-essentials/` : `${rootPrefix}pt/mindelo-essentials/`,
    about: locale === 'en' ? `${rootPrefix}about/` : `${rootPrefix}pt/about/`,
    enHref: `${rootPrefix}things-to-do/`,
    ptHref: `${rootPrefix}pt/things-to-do/`,
  };
}

// A hub card links to its own locale's detail route. The hub lives at
// things-to-do/ (EN) or pt/things-to-do/ (PT) and each detail page is a direct
// child of it, so the relative href is the bare slug in BOTH locales — it must
// not be prefixed with "pt/" (that would produce pt/things-to-do/pt/...).
function hubDetailHref(record) {
  return record.detail_page.replace(/^things-to-do\//, '');
}

function renderHubCard(record, loc, links) {
  const media = record.media
    ? `\n        <div class="card-media"><img src="${links.rootPrefix}${escapeHtml(record.media.asset)}" alt="${escapeHtml(loc.mediaAlt)}" loading="lazy" width="${record.media.width}" height="${record.media.height}"></div>`
    : '';
  // Same day-precision rule as Home: only a verified exact end is published.
  const endAttribute = record.end_date ? ` data-event-end="${record.end_date}"` : '';

  return `      <article class="resource-card" data-event-id="${escapeHtml(record.id)}"${endAttribute} data-checked="${escapeHtml(record.checked_at)}">${media}
        <p class="card-status">${escapeHtml(loc.displayStatus)}</p>
        <h3>${escapeHtml(loc.title)}</h3>
        <p class="card-meta">${escapeHtml(loc.displayMeta)}</p>
        <p class="provider">${escapeHtml(record.provider)}</p>
        <p class="checked">${escapeHtml(loc.displayChecked)}</p>
        <div class="card-actions">
          <a class="resource-link" href="${escapeHtml(hubDetailHref(record))}">${escapeHtml(CHROME.hubCardAction)}</a>
        </div>
      </article>`;
}

// Collection-level structured data.
//
// Project 03's specific technical position on collection-level schema was not
// supplied with this implementation packet, so this emits ORDINARY WebPage
// semantics only. No ItemList and no CollectionPage node is invented here, and
// the individual Event/ExhibitionEvent payloads on the detail pages remain the
// primary — and only — event-schema surfaces: duplicating them across hub
// cards for SEO is explicitly out of scope.
function renderHubSchema() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: CHROME.hubH1,
    description: CHROME.hubMetaDescription,
    url: hubCanonical(locale),
    inLanguage: locale === 'pt' ? 'pt-PT' : 'en',
    isPartOf: { '@type': 'WebSite', name: 'A PRASA', url: 'https://aprasa.org/' },
  }, null, 2);
}

function renderHubPage(eligible) {
  const links = hubPageLinks();
  const canonicalEn = hubCanonical('en');
  const canonicalPt = hubCanonical('pt');
  const canonical = locale === 'pt' ? canonicalPt : canonicalEn;
  const social = sitewideSocialFallback;

  // Empty state comes from canonical currentness output: when no record is
  // eligible the hub says so in governed copy. An expired record is never
  // surfaced here as filler to avoid an empty grid.
  const body = eligible.length === 0
    ? `\n        <p>${escapeHtml(CHROME.hubEmptyState)}</p>`
    : '';
  const grid = eligible.length === 0
    ? ''
    : `\n\n    <div class="resource-grid things-grid">\n${eligible
        .map((record) => renderHubCard(record, localizeRecord(record), links))
        .join('\n\n')}\n    </div>`;

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${escapeHtml(CHROME.hubMetaDescription)}">
<title>${escapeHtml(CHROME.hubMetaTitle)}</title>
<link rel="canonical" href="${canonical}">
<link rel="alternate" hreflang="en" href="${canonicalEn}">
<link rel="alternate" hreflang="pt" href="${canonicalPt}">
<link rel="alternate" hreflang="x-default" href="${canonicalEn}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="A PRASA">
<meta property="og:title" content="${escapeHtml(CHROME.hubMetaTitle)}">
<meta property="og:description" content="${escapeHtml(CHROME.hubMetaDescription)}">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="${locale === 'pt' ? 'pt_PT' : 'en_US'}">
<meta property="og:image" content="https://aprasa.org/${escapeHtml(social.asset)}">
<meta property="og:image:type" content="${social.type}">
<meta property="og:image:width" content="${social.width}">
<meta property="og:image:height" content="${social.height}">
<meta property="og:image:alt" content="${escapeHtml(social.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(CHROME.hubMetaTitle)}">
<meta name="twitter:description" content="${escapeHtml(CHROME.hubMetaDescription)}">
<meta name="twitter:image" content="https://aprasa.org/${escapeHtml(social.asset)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Libre+Baskerville&family=Work+Sans&display=swap">
<link rel="stylesheet" href="${links.rootPrefix}prasa-launch.css">
<script src="${links.rootPrefix}prasa-launch.js" defer></script>
<!-- Privacy-friendly analytics by Plausible -->
<script async src="https://plausible.io/js/pa-eShJ2lYHDu0B2CdpzVYvZ.js"></script>
<script>
  window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
  plausible.init()
</script>
<script type="application/ld+json">
${renderHubSchema()}
</script>
</head>
<body>
<!-- Generated from data/things-to-do-events.json: things-to-do collection hub (locale: ${locale}) -->
<a class="skip-link" href="#main">${escapeHtml(CHROME.skipToContent)}</a>

<header class="site-header" aria-label="A PRASA">
  <div class="container header-inner">
    <a class="brand" href="${links.home}" aria-label="${escapeHtml(CHROME.brandAria)}">
      <img src="${links.rootPrefix}assets/brand/A_PRASA_Lockup_Horizontal_v2_Primary_Green.svg" alt="" width="4959" height="725">
    </a>
    <div class="header-actions">
      <nav class="site-nav" aria-label="${escapeHtml(CHROME.navAria)}">
        <a href="${links.home}">${escapeHtml(CHROME.navHome)}</a>
        <a href="${links.mindelo}">${escapeHtml(CHROME.navMindelo)}</a>
        <a href="${links.about}">${escapeHtml(CHROME.navAbout)}</a>
      </nav>
      <nav class="lang-switch" aria-label="Language / Idioma">
        <a href="${links.enHref}" lang="en" hreflang="en"${locale === 'en' ? ' aria-current="true" class="lang-current"' : ''}>EN</a>
        <a href="${links.ptHref}" lang="pt" hreflang="pt"${locale === 'pt' ? ' aria-current="true" class="lang-current"' : ''}>PT</a>
      </nav>
    </div>
  </div>
</header>

<main id="main">
  <div class="container record-page">
    <div class="section-heading">
      <p class="section-kicker">${escapeHtml(CHROME.thingsKicker)}</p>
      <h1>${escapeHtml(CHROME.hubH1)}</h1>
      <p>${escapeHtml(CHROME.hubIntro)}</p>
      <p>${escapeHtml(CHROME.hubBoundary)}</p>${body}
    </div>${grid}
  </div>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <a class="footer-brand" href="${links.home}" aria-label="${escapeHtml(CHROME.brandAria)}">
      <img src="${links.rootPrefix}assets/brand/A_PRASA_Lockup_Horizontal_v2_Reversed_Cream.svg" alt="" width="4959" height="725">
    </a>
    <p>${escapeHtml(CHROME.footerTagline)}</p>
    <p class="footer-note">${escapeHtml(CHROME.footerIndependence)}</p>
    <div class="footer-contact">
      <p class="footer-contact-title">${escapeHtml(CHROME.footerContactTitle)}</p>
      <p>${escapeHtml(CHROME.footerContactPrompt)} <a href="https://wa.me/message/GC3C5Q4MSF37I1" target="_blank" rel="noopener noreferrer">${escapeHtml(CHROME.footerContactAction)}</a>.</p>
    </div>
    <a class="back-top" href="#main">${escapeHtml(CHROME.backToTop)}</a>
  </div>
</footer>
</body>
</html>
`;
}

// Home dated-event slots are bounded by stable, never-removed generated
// markers keyed on the canonical event id (not visible title text). Every
// run replaces only the content between a record's own markers, so output
// depends solely on data/things-to-do-events.json + --as-of, never on
// whatever Home currently contains. This keeps repeated/later runs
// idempotent even after earlier runs have expired-and-emptied a slot.
function replaceGeneratedEvent(homeHtml, record, loc) {
  const beginMarker = `<!-- BEGIN GENERATED EVENT: ${record.id} -->`;
  const endMarker = `<!-- END GENERATED EVENT: ${record.id} -->`;
  const beginIndex = homeHtml.indexOf(beginMarker);
  const endIndex = homeHtml.indexOf(endMarker);
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    throw new Error(`${record.id}: could not locate generated event markers in Home`);
  }

  const contentStart = beginIndex + beginMarker.length;
  // A slot renders only for a record in the approved Home preview. Two
  // distinct reasons empty a slot, and they are not interchangeable:
  //   EXPIRED           the record has left the collection entirely and is
  //                     absent from Home AND from the hub.
  //   not in preview    the record is eligible and IS on the hub; Home simply
  //                     shows the first three. Nothing about the record's
  //                     currentness state changes, and the hub CTA leads to it.
  // CURRENT and REVIEW_DUE are both eligible; only EXPIRED is not.
  const body = homePreview.has(record.id) ? `\n${renderHomeArticle(record, loc)}\n        ` : '';
  return homeHtml.slice(0, contentStart) + body + homeHtml.slice(endIndex);
}

const selected = requestedId ? records.filter((record) => record.id === requestedId) : records;
if (requestedId && selected.length !== 1) {
  console.error(`Unknown event id: ${requestedId}`);
  process.exit(1);
}

// --home lets the Home-pass build script drive this generator against
// pt/index.html once that shell exists (created in the Home/About pass).
// Defaults to the locale's own conventional Home path.
const homeArg = process.argv.find((arg) => arg.startsWith('--home='));
const homePath = homeArg
  ? path.join(root, homeArg.split('=')[1])
  : path.join(root, locale === 'pt' ? 'pt' : '.', 'index.html');

let homeHtml = null;
let homeExists = fs.existsSync(homePath);
if (homeExists) {
  homeHtml = fs.readFileSync(homePath, 'utf8');
} else if (locale === 'en') {
  throw new Error(`Home file not found: ${homePath}`);
} else {
  console.warn(`[generate-things-to-do] ${path.relative(root, homePath)} does not exist yet — skipping Home update for locale "pt" (run again once the PT Home shell exists).`);
}

for (const record of selected) {
  const target = resolveDetailTarget(record);
  const loc = localizeRecord(record);
  const output = renderDetailPage(record, loc);
  if (homeExists) homeHtml = replaceGeneratedEvent(homeHtml, record, loc);

  if (write) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, output);
    console.log(`Wrote ${locale}/${record.detail_page}index.html as of ${asOf}`);
  } else {
    const state = currentnessState(record, asOf);
    const disposition = state === EXPIRED
      ? 'past detail + removed from Home'
      : state === REVIEW_DUE
        ? 'review-due detail + retained Home card (reverification required)'
        : 'current detail + Home card';
    console.log(`Prepared ${record.id} (${locale}): ${disposition}`);
  }
}

if (write && homeExists) {
  fs.writeFileSync(homePath, homeHtml);
  console.log(`Wrote ${path.relative(root, homePath)} as of ${asOf}`);
}

// --- Collection hub -------------------------------------------------------
// The hub is a WHOLE-COLLECTION projection, so it is produced only by a
// whole-collection run. A --id run is a bounded single-record operation
// (Phase 2B currentness remediation drives the generator that way, under a
// bounded write set that does not include this file), and rewriting the hub
// from inside one would take that run outside its authorized scope. The hub
// is reconciled by the next full run — scripts/build-all.mjs, the Things-to-Do
// CI workflow, and the guarded event-publication write path all invoke the
// generator without --id — and a hub left stale by a bounded repair is caught
// by CI's "committed surfaces match canonical generation" gate rather than
// shipping unnoticed.
const hubRelativePath = hubOutputPath(locale);
if (requestedId) {
  console.log(`Skipped ${hubRelativePath}: --id runs are single-record and do not rewrite the whole-collection hub.`);
} else if (write) {
  const hubTarget = path.join(root, hubRelativePath);
  fs.mkdirSync(path.dirname(hubTarget), { recursive: true });
  fs.writeFileSync(hubTarget, renderHubPage(hubRecords));
  console.log(`Wrote ${hubRelativePath} — ${hubRecords.length} eligible record(s), ${Math.min(hubRecords.length, HOME_PREVIEW_LIMIT)} on the Home preview, as of ${asOf}`);
} else {
  console.log(`Prepared ${hubRelativePath}: ${hubRecords.length} eligible record(s), ${Math.min(hubRecords.length, HOME_PREVIEW_LIMIT)} on the Home preview, as of ${asOf}`);
}
