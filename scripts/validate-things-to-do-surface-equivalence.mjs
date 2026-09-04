import fs from 'node:fs';
import path from 'node:path';
import { isExpired } from './lib/things-to-do-currentness.mjs';
import { HOME_PREVIEW_LIMIT, homePreviewIds, hubOutputPath } from './lib/things-to-do-collection.mjs';

// EN public-surface equivalence for the canonical Things-to-Do corpus.
//
// Project 03 approved Home as a LIMITED PREVIEW of the collection: the first
// HOME_PREVIEW_LIMIT eligible records in canonical order, with the full
// eligible collection on the dedicated hub at /things-to-do/. This validator
// therefore polices membership across BOTH surfaces rather than requiring
// every eligible record on Home — the assertion is re-pointed, not dropped:
// an eligible record still has to be publicly reachable, and an expired one
// still may not appear on Home.
//
// One deliberate asymmetry: hub membership is asserted in the POSITIVE
// direction only (an eligible record must be on the hub). The negative
// direction — an expired record must be absent from the hub — is asserted by
// scripts/validate-things-to-do-hub.mjs instead. That split exists because
// this validator runs inside the Phase 2B bounded single-record repair lane,
// whose authorized write set covers Home and one detail page but not the
// whole-collection hub; asserting the negative here would fail a repair the
// lane is not authorized to complete. The full-run gate catches it instead.
const root = process.cwd();
const dataPath = path.join(root, 'data', 'things-to-do-events.json');
const indexPath = path.join(root, 'index.html');
const hubPath = path.join(root, hubOutputPath('en'));
const asOfArg = process.argv.find((arg) => arg.startsWith('--as-of='));
if (!asOfArg) {
  console.error('Missing required --as-of=YYYY-MM-DD');
  process.exit(1);
}
const asOf = asOfArg.split('=')[1];
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error(`Invalid --as-of date: ${asOf}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const errors = [];

if (!fs.existsSync(hubPath)) {
  console.error(`Things to Do surface equivalence errors as of ${asOf}:`);
  console.error(`- collection hub does not exist at ${hubOutputPath('en')}`);
  process.exit(1);
}
const hubHtml = fs.readFileSync(hubPath, 'utf8');
const previewIds = homePreviewIds(data.records ?? [], asOf);

// Every card the generator emits into a Home slot carries data-event-id, so
// counting them is an exact count of generated Home cards — it cannot be
// confused with the hand-authored evergreen cards in the same section.
const homeGeneratedCardCount = (indexHtml.match(/<article class="resource-card" data-event-id="/g) || []).length;
if (homeGeneratedCardCount > HOME_PREVIEW_LIMIT) {
  errors.push(`Home shows ${homeGeneratedCardCount} generated Things-to-Do cards; the approved preview is at most ${HOME_PREVIEW_LIMIT}`);
}

for (const record of data.records ?? []) {
  const label = `${record.id} :: ${record.title}`;
  const detailFile = path.join(root, record.detail_page, 'index.html');
  const expired = isExpired(record, asOf);
  const onHome = indexHtml.includes(`<h3>${record.title}</h3>`);
  const inPreview = previewIds.has(record.id);
  // The hub links each card by bare slug, since every detail page is a direct
  // child of the hub route.
  const hubHref = record.detail_page.replace(/^things-to-do\//, '');
  const onHub = hubHtml.includes(`<h3>${record.title}</h3>`);

  if (expired && onHome) errors.push(`${label}: expired record remains on Home as of ${asOf}`);
  if (!expired && !onHome && !onHub) errors.push(`${label}: eligible record is on neither the Home preview nor the collection hub`);

  // Home preview membership.
  if (inPreview && !onHome) errors.push(`${label}: approved Home preview record missing from Home Things to Do markup`);
  if (!inPreview && onHome) errors.push(`${label}: record is on Home but is not in the approved ${HOME_PREVIEW_LIMIT}-record preview as of ${asOf}`);
  if (inPreview && !indexHtml.includes(`href="${record.detail_page}"`)) errors.push(`${label}: preview detail route missing from Home markup`);
  if (inPreview && record.card_action?.url && !indexHtml.includes(record.card_action.url)) errors.push(`${label}: preview Home action URL missing from Home markup`);
  if (inPreview && record.media?.asset && !indexHtml.includes(record.media.asset)) errors.push(`${label}: preview media asset missing from Home markup`);

  // Collection hub membership (positive direction — see the header note).
  if (!expired && !onHub) errors.push(`${label}: eligible record missing from the collection hub`);
  if (!expired && !hubHtml.includes(`href="${hubHref}"`)) errors.push(`${label}: eligible detail route missing from the collection hub`);
  if (!expired && record.media?.asset && !hubHtml.includes(record.media.asset)) errors.push(`${label}: eligible media asset missing from the collection hub`);

  if (!fs.existsSync(detailFile)) {
    errors.push(`${label}: detail page does not exist at ${record.detail_page}`);
    continue;
  }

  const detailHtml = fs.readFileSync(detailFile, 'utf8');
  if (!detailHtml.includes(`<h1>${record.title}</h1>`)) errors.push(`${label}: title missing from detail page`);
  if (!detailHtml.includes(record.provider)) errors.push(`${label}: provider missing from detail page`);
  if (record.card_action?.url && !detailHtml.includes(record.card_action.url)) errors.push(`${label}: action URL missing from detail page`);
  if (record.media?.asset) {
    const relativeMedia = `../../${record.media.asset}`;
    if (!detailHtml.includes(relativeMedia)) errors.push(`${label}: media asset missing from detail page`);
  }
  if (expired && detailHtml.includes('EventScheduled') && detailHtml.includes('Generated from data/things-to-do-events.json')) {
    errors.push(`${label}: generated expired detail page still reports EventScheduled`);
  }
  if (detailHtml.includes('https://schema.org/EventCompleted')) {
    errors.push(`${label}: detail page emits invalid Schema.org EventCompleted status`);
  }
}

if (errors.length) {
  console.error(`Things to Do surface equivalence errors as of ${asOf}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Surface equivalence passed for ${data.records.length} canonical dated-event records as of ${asOf}`
  + ` (${previewIds.size} on the approved Home preview, ${homeGeneratedCardCount} generated Home card(s)).`
);
