import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const input = path.join(root, 'data', 'things-to-do-events.json');
const records = JSON.parse(fs.readFileSync(input, 'utf8')).records;

const asOfArg = process.argv.find((arg) => arg.startsWith('--as-of='));
const idArg = process.argv.find((arg) => arg.startsWith('--id='));
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

function isExpired(record) {
  return Boolean(record.end_date && record.end_date < asOf);
}

function mediaType(asset) {
  if (asset.endsWith('.png')) return 'image/png';
  if (asset.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function detailMediaClass(record) {
  return record.id === 'part-ilhas-nuno-miranda' ? 'dialog-media' : 'record-media';
}

function renderFacts(facts = []) {
  return facts.map((fact) => {
    const value = fact.value_html ?? escapeHtml(fact.value ?? '');
    return `<div><dt>${escapeHtml(fact.label)}</dt><dd>${value}</dd></div>`;
  }).join('');
}

function renderSchema(record, expired) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': record.seo?.schema_type ?? 'Event',
    name: record.title,
    url: `https://aprasa.org/${record.detail_page}`,
    description: record.summary,
    eventStatus: expired ? 'https://schema.org/EventCompleted' : 'https://schema.org/EventScheduled',
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
  if (record.end_datetime) schema.endDate = record.end_datetime;
  else if (record.start_date && record.end_date) schema.endDate = record.end_date;
  if (typeof record.free_admission === 'boolean') schema.isAccessibleForFree = record.free_admission;
  if (record.media?.asset) schema.image = `https://aprasa.org/${record.media.asset}`;

  return JSON.stringify(schema, null, 2);
}

function renderHomeArticle(record) {
  const media = record.media ? `\n          <div class="card-media"><img src="${escapeHtml(record.media.asset)}" alt="${escapeHtml(record.media.alt)}" loading="lazy" width="${record.media.width}" height="${record.media.height}"></div>` : '';
  const externalAction = record.card_action ? `\n            <a class="resource-link" href="${escapeHtml(record.card_action.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(record.card_action.label)} <span aria-hidden="true">↗</span></a>` : '';
  const dialogMedia = record.media ? `\n              <div class="dialog-media"><img src="${escapeHtml(record.media.asset)}" alt="${escapeHtml(record.media.alt)}" loading="lazy" width="${record.media.width}" height="${record.media.height}"></div>` : '';
  const goodToKnow = record.detail?.good_to_know ? `\n              <h3>Good to know</h3>\n              <p>${escapeHtml(record.detail.good_to_know)}</p>` : '';
  const dialogAction = record.detail?.action_label ? `\n              <a class="dialog-link" href="${escapeHtml(record.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(record.detail.action_label)} <span aria-hidden="true">↗</span></a>` : '';
  const endAttribute = record.end_date ? ` data-event-end="${record.end_date}"` : '';

  return `        <article class="resource-card" data-event-id="${escapeHtml(record.id)}"${endAttribute} data-checked="${escapeHtml(record.checked_at)}">${media}
          <p class="card-status">${escapeHtml(record.display?.status)}</p>
          <h3>${escapeHtml(record.title)}</h3>
          <p class="card-meta">${escapeHtml(record.display?.meta)}</p>
          <p class="provider">${escapeHtml(record.provider)}</p>
          <p class="checked">${escapeHtml(record.display?.checked)}</p>
          <div class="card-actions">
            <button class="details-button" type="button" data-details>Details</button>${externalAction}
            <a class="resource-link" href="${escapeHtml(record.detail_page)}">View page</a>
          </div>
          <template class="details-template">
            <div class="dialog-record" data-event-id="${escapeHtml(record.id)}">${dialogMedia}
              <p class="provider">${escapeHtml(record.provider)}</p>
              <h2>${escapeHtml(record.title)}</h2>
              <dl class="detail-list">${renderFacts(record.detail?.facts)}</dl>
              <h3>Details</h3>
              <p>${escapeHtml(record.detail?.body)}</p>${goodToKnow}
              <p class="checked">${escapeHtml(record.detail?.checked)}</p>${dialogAction}
            </div>
          </template>
        </article>`;
}

function renderSocialMeta(record) {
  const social = record.media ? {
    asset: record.media.asset,
    type: mediaType(record.media.asset),
    width: record.media.width,
    height: record.media.height,
    alt: record.media.alt
  } : sitewideSocialFallback;

  return `<meta property="og:image" content="https://aprasa.org/${escapeHtml(social.asset)}">\n<meta property="og:image:type" content="${social.type}">\n<meta property="og:image:width" content="${social.width}">\n<meta property="og:image:height" content="${social.height}">\n<meta property="og:image:alt" content="${escapeHtml(social.alt)}">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:title" content="${escapeHtml(record.title)}">\n<meta name="twitter:description" content="${escapeHtml(record.seo.description)}">\n<meta name="twitter:image" content="https://aprasa.org/${escapeHtml(social.asset)}">`;
}

function renderDetailPage(record) {
  const expired = isExpired(record);
  const canonical = `https://aprasa.org/${record.detail_page}`;
  const media = record.media ? `\n      <div class="${detailMediaClass(record)}"><img src="../../${escapeHtml(record.media.asset)}" alt="${escapeHtml(record.media.alt)}" loading="lazy" width="${record.media.width}" height="${record.media.height}"></div>` : '';
  const pastStatus = expired ? '\n      <p class="card-status">Past event</p>' : '';
  const goodToKnow = record.detail?.good_to_know ? `\n      <h2>Good to know</h2>\n      <p>${escapeHtml(record.detail.good_to_know)}</p>` : '';
  const action = record.detail?.action_label ? `\n      <a class="dialog-link" href="${escapeHtml(record.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(record.detail.action_label)} <span aria-hidden="true">↗</span></a>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${escapeHtml(record.seo.description)}">
<title>${escapeHtml(record.seo.title)}</title>
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="A PRASA">
<meta property="og:title" content="${escapeHtml(record.title)}">
<meta property="og:description" content="${escapeHtml(record.seo.description)}">
<meta property="og:url" content="${canonical}">
${renderSocialMeta(record)}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Libre+Baskerville&family=Work+Sans&display=swap">
<link rel="stylesheet" href="../../prasa-launch.css">
<script src="../../prasa-launch.js" defer></script>
<!-- Privacy-friendly analytics by Plausible -->
<script async src="https://plausible.io/js/pa-eShJ2lYHDu0B2CdpzVYvZ.js"></script>
<script>
  window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
  plausible.init()
</script>
<script type="application/ld+json">
${renderSchema(record, expired)}
</script>
</head>
<body>
<!-- Generated from data/things-to-do-events.json: ${escapeHtml(record.id)} -->
<a class="skip-link" href="#main">Skip to content</a>

<header class="site-header" aria-label="A PRASA">
  <div class="container header-inner">
    <a class="brand" href="../../index.html" aria-label="A PRASA — Home">
      <img src="../../assets/brand/A_PRASA_Lockup_Horizontal_v2_Primary_Green.svg" alt="" width="4959" height="725">
    </a>
    <nav class="site-nav" aria-label="Site navigation">
      <a href="../../index.html">Home</a>
      <a href="../../mindelo-essentials/">Mindelo Essentials</a>
      <a href="../../about/">About</a>
    </nav>
  </div>
</header>

<main id="main">
  <div class="container record-page">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="../../index.html#things-to-do">← Things to Do</a>
    </nav>
    <article class="dialog-record record-article" data-event-id="${escapeHtml(record.id)}">${media}${pastStatus}
      <p class="provider">${escapeHtml(record.provider)}</p>
      <h1>${escapeHtml(record.title)}</h1>
      <dl class="detail-list">${renderFacts(record.detail?.facts)}</dl>
      <h2>Details</h2>
      <p>${escapeHtml(record.detail?.body)}</p>${goodToKnow}
      <p class="checked">${escapeHtml(record.detail?.checked)}</p>${action}
    </article>
  </div>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <a class="footer-brand" href="../../index.html" aria-label="A PRASA — Home">
      <img src="../../assets/brand/A_PRASA_Lockup_Horizontal_v2_Reversed_Cream.svg" alt="" width="4959" height="725">
    </a>
    <p>A place to find what moves you.</p>
    <p class="footer-note">A PRASA is independent and does not act on behalf of the providers linked here.</p>
    <div class="footer-contact">
      <p class="footer-contact-title">Contact A PRASA</p>
      <p>Questions, corrections, or something useful to share? <a href="https://wa.me/message/GC3C5Q4MSF37I1" target="_blank" rel="noopener noreferrer">Message A PRASA on WhatsApp</a>.</p>
    </div>
    <a class="back-top" href="#main">Back to top</a>
  </div>
</footer>
</body>
</html>
`;
}

function replaceHomeArticle(homeHtml, record) {
  const titleNeedle = `<h3>${record.title}</h3>`;
  const titleIndex = homeHtml.indexOf(titleNeedle);
  if (titleIndex === -1) throw new Error(`${record.id}: could not locate Home card by exact title`);

  const start = homeHtml.lastIndexOf('        <article class="resource-card"', titleIndex);
  const end = homeHtml.indexOf('        </article>', titleIndex);
  if (start === -1 || end === -1) throw new Error(`${record.id}: could not resolve Home article boundaries`);

  const after = end + '        </article>'.length;
  const replacement = isExpired(record) ? '' : renderHomeArticle(record);
  return homeHtml.slice(0, start) + replacement + homeHtml.slice(after);
}

const selected = requestedId ? records.filter((record) => record.id === requestedId) : records;
if (requestedId && selected.length !== 1) {
  console.error(`Unknown event id: ${requestedId}`);
  process.exit(1);
}

let homeHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

for (const record of selected) {
  const output = renderDetailPage(record);
  const target = path.join(root, record.detail_page, 'index.html');
  homeHtml = replaceHomeArticle(homeHtml, record);

  if (write) {
    fs.writeFileSync(target, output);
    console.log(`Wrote ${record.detail_page}index.html as of ${asOf}`);
  } else {
    console.log(`Prepared ${record.id}: ${isExpired(record) ? 'past detail + removed from Home' : 'current detail + Home card'}`);
  }
}

if (write) {
  fs.writeFileSync(path.join(root, 'index.html'), homeHtml);
  console.log(`Wrote index.html as of ${asOf}`);
}
