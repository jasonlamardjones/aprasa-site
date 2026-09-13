#!/usr/bin/env node
// Regression coverage for the floating WhatsApp launcher's on-site panel
// (Project 09 runtime copy P09-PT-RUNTIME-WHATSAPP-LAUNCHER-2026-09-12-r1).
//
// Runs with no dependencies so the hosted workflow can execute it directly.
// Behavioural checks that genuinely need a browser (real click dispatch,
// focus movement) are covered by browser QA; what this file pins is the
// contract that makes that behaviour possible, plus every governed-delivery
// and destination property, which are the things that can regress silently.
//
// Usage: node scripts/test-whatsapp-launcher-panel.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './lib/locale.mjs';
import { LAUNCHER_PANEL_KEYS, PREFILL_KEYS, QUICK_ACTION_PREFILL } from './lib/runtime-strings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOVERNED_WHATSAPP_URL = 'https://wa.me/message/GC3C5Q4MSF37I1';

let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
}

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// The canonical number is read from the governed config, never restated here:
// a copy in the tests would defeat the single-source rule it is meant to prove.
const CONTACT = JSON.parse(read('data/contact-channels.json')).whatsapp;

function walkHtml(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(abs, out);
    else if (entry.name.endsWith('.html')) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out;
}

// Same discovery semantics as the runtime selector a[href*="wa.me/"], so this
// test cannot drift narrower than the set of pages the launcher runs on.
// Coverage is inverted and fail-closed, mirroring
// scripts/validate-runtime-locale-strings.mjs: every HTML page in the
// repository is a launcher surface unless it is explicitly exempted here.
// Discovering surfaces by pattern-matching WhatsApp anchors was fail-open —
// a page whose markup the scan did not recognize was silently dropped from
// coverage — so the exemption list carries that judgement instead, where it
// is visible and reviewable.
const PAGES_WITHOUT_LAUNCHER = new Set([
  'internal/analytics-exclude.html',
]);

const surfaces = walkHtml(root).filter((rel) => !PAGES_WITHOUT_LAUNCHER.has(rel)).sort();

const launcherJs = read('prasa-launch.js');
const mindeloJs = read('mindelo-essentials/mindelo-essentials.js');

// --- 1. Every floating-launcher surface receives all 8 runtime keys --------
console.log(`[1] governed runtime-key delivery across ${surfaces.length} launcher surface(s)`);
check('at least the four Home/Mindelo surfaces plus the generated pages exist', surfaces.length >= 30,
  `found ${surfaces.length}`);
for (const rel of surfaces) {
  const match = read(rel).match(/<script type="application\/json" id="i18n-strings">([\s\S]*?)<\/script>/);
  check(`${rel} carries the governed runtime-strings block`, !!match);
  if (!match) continue;
  let block;
  try { block = JSON.parse(match[1]); } catch (error) {
    check(`${rel} runtime-strings block is valid JSON`, false, error.message);
    continue;
  }
  for (const runtimeKey of Object.keys(LAUNCHER_PANEL_KEYS)) {
    check(`${rel} carries "${runtimeKey}"`, typeof block[runtimeKey] === 'string' && block[runtimeKey].length > 0);
  }
}

// --- 2. PT never receives EN panel copy ------------------------------------
console.log('[2] no English panel copy on any PT surface');
for (const rel of surfaces.filter((r) => r.startsWith('pt/'))) {
  const block = JSON.parse(read(rel).match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1]);
  for (const [runtimeKey, localeKey] of Object.entries(LAUNCHER_PANEL_KEYS)) {
    const en = t(localeKey, 'en');
    const pt = t(localeKey, 'pt');
    check(`${rel} "${runtimeKey}" holds the governed PT value`, block[runtimeKey] === pt,
      `got ${JSON.stringify(block[runtimeKey])}, expected ${JSON.stringify(pt)}`);
    if (en !== pt) {
      check(`${rel} "${runtimeKey}" is not the English value`, block[runtimeKey] !== en);
    }
  }
}
// The runtime files must carry no translation of their own.
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  for (const localeKey of Object.values(LAUNCHER_PANEL_KEYS)) {
    const pt = t(localeKey, 'pt');
    const en = t(localeKey, 'en');
    if (pt === en) continue;
    check(`${name} does not hardcode the PT value for "${localeKey}"`, !source.includes(pt));
  }
}

// --- 3. Initial launcher activation does not navigate ----------------------
console.log('[3] launcher is a toggle, not an outbound link');
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  const control = source.slice(source.indexOf('floating-utility floating-utility-whatsapp'));
  const controlBlock = control.slice(0, 1200);
  check(`${name} builds the launcher as a button`, /createElement\("button"\)/.test(
    source.slice(Math.max(0, source.indexOf('floating-utility floating-utility-whatsapp') - 600),
      source.indexOf('floating-utility floating-utility-whatsapp'))));
  check(`${name} marks the launcher with aria-expanded`, controlBlock.includes('"aria-expanded", "false"'));
  check(`${name} associates the launcher with the panel via aria-controls`, controlBlock.includes('"aria-controls", PANEL_ID'));
  check(`${name} never assigns the governed URL to the launcher control itself`,
    !/button\.href\s*=/.test(source));
}

// --- 4. The explicit Open WhatsApp action uses the exact governed destination
console.log('[4] panel CTA carries the exact governed destination');
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  check(`${name} pins the governed destination`, source.includes(`"${GOVERNED_WHATSAPP_URL}"`));
  check(`${name} sets the CTA href from the asserted governed anchor`, /cta\.href = sourceAnchor\.href;/.test(source));
  const others = [...source.matchAll(/https:\/\/wa\.me\/[^"' )]*/g)].map((m) => m[0]);
  check(`${name} contains no other wa.me literal`, others.every((u) => u === GOVERNED_WHATSAPP_URL),
    `found ${JSON.stringify([...new Set(others)])}`);
  check(`${name} introduces no prefilled-message parameter`, !/[?&](text|message)=/.test(source));
}

// --- 5. Destination conflict still fails closed ----------------------------
console.log('[5] fail-closed destination guard intact');
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  check(`${name} rejects a conflicting or absent destination set`,
    source.includes('destinations.size !== 1 || !destinations.has(GOVERNED_WHATSAPP_URL)'));
  check(`${name} re-asserts the resolved anchor before initializing`,
    source.includes('normalizeUrl(sourceAnchor.href) !== GOVERNED_WHATSAPP_URL'));
  check(`${name} returns without building the cluster when the guard trips`,
    /console\.warn\("A PRASA floating WhatsApp control not initialized/.test(source));
}

// --- 6. Panel open/close state ---------------------------------------------
console.log('[6] panel open/close state is wired');
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  check(`${name} starts the panel hidden`, /panel\.hidden = true;/.test(source));
  check(`${name} opens by unhiding and setting aria-expanded`,
    /panel\.hidden = false;[\s\S]{0,120}"aria-expanded", "true"/.test(source));
  check(`${name} closes by hiding and clearing aria-expanded`,
    /panel\.hidden = true;[\s\S]{0,120}"aria-expanded", "false"/.test(source));
  check(`${name} closes on Escape`, /event\.key !== "Escape"/.test(source));
  check(`${name} returns focus to the launcher on close`, /if \(returnFocus\) button\.focus\(\);/.test(source));
  check(`${name} moves focus into the panel on open`, /panel\.focus\(\);/.test(source));
  check(`${name} gives the panel an accessible name`, source.includes('"aria-labelledby", PANEL_TITLE_ID'));
}

// --- 7. Quick-action selection ---------------------------------------------
console.log('[7] quick actions are single-select, local, and expose state');
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  check(`${name} exposes selection through aria-pressed`, source.includes('"aria-pressed", "false"'));
  check(`${name} clears every other action before selecting`,
    /for \(const other of quickActions\) other\.setAttribute\("aria-pressed", "false"\);/.test(source));
  check(`${name} toggles the activated action`,
    /action\.setAttribute\("aria-pressed", selected \? "false" : "true"\);/.test(source));
  check(`${name} renders exactly the four governed quick actions`,
    (source.match(/launcherQuickAction(Share|Correction|Question|Submissions)"/g) || []).length >= 4);
}

// --- 7b. Floating navigation-control surface contract ----------------------
// The Up control is available on every launcher surface, so its governed label
// must reach every surface too — including Mindelo Essentials, which carries no
// in-page "Back to top" anchor for the runtime to borrow from. Down stays
// section-aware and therefore only exists where a governed in-page nav supplies
// both its targets and their names.
console.log('[7b] navigation-control surface contract');
for (const rel of surfaces) {
  const block = JSON.parse(read(rel).match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1]);
  const locale = rel.startsWith('pt/') ? 'pt' : 'en';
  check(`${rel} carries the governed Up label`,
    block.navBackToTop === t('ui.back_to_top', locale),
    `got ${JSON.stringify(block.navBackToTop)}`);
  check(`${rel} carries the governed Down label`,
    block.navScrollDown === t('ui.scroll_down', locale),
    `got ${JSON.stringify(block.navScrollDown)}`);
  if (locale === 'pt') {
    check(`${rel} Down label is not the English fallback`,
      block.navScrollDown !== t('ui.scroll_down', 'en'));
  }
}
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  check(`${name} names the Up control from the governed string, not page markup`,
    /navBackToTop/.test(source) && !/a\.back-top/.test(source));
  check(`${name} builds the nav controls as buttons`, /floating-utility floating-utility-nav/.test(source));
  check(`${name} hides Up at the document top`, /up\.hidden = window\.scrollY <= 0;/.test(source));
  check(`${name} throttles scroll updates through rAF`, /requestAnimationFrame/.test(source));
  check(`${name} honours reduced motion`, /prefers-reduced-motion: reduce/.test(source));
}
// Down exists on every surface. Its TARGETING splits: section stepping where a
// governed in-page nav supplies named targets, viewport paging everywhere else.
check('prasa-launch.js splits Down targeting on the governed in-page nav',
  /const sectionAware = targets\.length > 0;/.test(launcherJs) && /\.home-page-nav/.test(launcherJs));
check('prasa-launch.js names the generic Down from the governed string',
  /down\.setAttribute\("aria-label", STRINGS\.navScrollDown\)/.test(launcherJs));
check('prasa-launch.js pages by viewport when not section-aware',
  /window\.innerHeight \* \(1 - VIEWPORT_PAGE_OVERLAP\)/.test(launcherJs));
check('prasa-launch.js clamps paging to the document bottom',
  /Math\.min\(window\.scrollY \+ step, limit\)/.test(launcherJs));
check('prasa-launch.js hides Down at the document bottom',
  /atDocumentBottom\(\)/.test(launcherJs));
check('mindelo-essentials.js ships a Down control',
  /CHEVRON_DOWN/.test(mindeloJs) && /navScrollDown/.test(mindeloJs));
check('mindelo-essentials.js pages by viewport and clamps to the bottom',
  /window\.innerHeight \* \(1 - VIEWPORT_PAGE_OVERLAP\)/.test(mindeloJs)
  && /Math\.min\(window\.scrollY \+ step, limit\)/.test(mindeloJs));
check('mindelo-essentials.js hides Down at the document bottom',
  /down\.hidden = window\.scrollY \+ window\.innerHeight >=/.test(mindeloJs));
// The generic model must target no editorial content. Scoped to the navigation
// code: elsewhere in these files the details dialog legitimately reads headings,
// so a whole-file scan would be a false positive.
function navigationSource(source) {
  const start = source.indexOf('function createNavigationControls');
  if (start === -1) return '';
  const after = source.slice(start);
  const end = after.indexOf('\n  }\n');
  return end === -1 ? after : after.slice(0, end);
}
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  const nav = navigationSource(source);
  check(`${name} exposes its navigation code to this check`, nav.length > 0);
  check(`${name} navigation targets no headings`, !/h[123]/.test(nav), nav.match(/.{0,40}h[123].{0,40}/)?.[0]);
  check(`${name} navigation reads no element text content`, !/textContent/.test(nav.replace(/anchor\.textContent/g, '')),
    nav.match(/.{0,40}textContent.{0,40}/)?.[0]);
}
// Hiding the control a keyboard user just activated must not strand focus on
// <body>. The guard has to use focus sampled BEFORE hiding — once hidden the
// browser has already reset activeElement — so assert that shape explicitly.
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  check(`${name} hands focus on before hiding an activated control`,
    /keepFocusOnStack\(/.test(source));
  check(`${name} samples focus before hiding, not after`,
    /const wasFocused = document\.activeElement;/.test(source)
    && /keepFocusOnStack\((?:up|down), wasFocused\)/.test(source)
    && /wasFocused !== hiding/.test(source));
  check(`${name} falls back to the sibling control then the launcher`,
    /hiding === up \? down : up/.test(source) && /floating-utility-whatsapp/.test(source));
}

// The stack is one vertical column, in CSS, on both stylesheets.
for (const css of ['prasa-launch.css', 'mindelo-essentials/mindelo-essentials.css']) {
  const text = read(css);
  // The selector appears in more than one rule (it is also grouped into the
  // pointer-events rule), so check every rule that targets it, not the first.
  const rules = [...text.matchAll(/\.floating-nav-controls\s*\{[^}]*\}/g)].map((m) => m[0]);
  check(`${css} stacks the nav controls vertically`,
    rules.some((rule) => /flex-direction:\s*column/.test(rule)),
    rules.length ? rules.map((r) => r.replace(/\s+/g, ' ')).join(' | ') : 'no .floating-nav-controls rule');
  check(`${css} keeps the 44px nav hit area`, /\.floating-utility-nav::after \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/.test(text));
  // The panel sits above the whole stack, so its height limit must reserve the
  // space everything below it occupies: cluster gap + launcher + cluster gap +
  // the Up/Down column + the bottom offset = 10.75rem. At the old 9rem the
  // panel's heading rendered above the viewport on landscape and short phones.
  const panelLimit = text.match(/max-height:\s*min\([^,]+,\s*calc\(100d?vh - ([\d.]+)rem\)\)/);
  check(`${css} reserves viewport height for the full control stack`,
    !!panelLimit && parseFloat(panelLimit[1]) >= 11,
    panelLimit ? `reserves only ${panelLimit[1]}rem, needs >= 11rem` : 'no panel max-height limit found');
  check(`${css} gives the launcher a light separation ring`,
    /\.floating-utility-whatsapp \{[\s\S]*?box-shadow:[\s\S]*?rgba\(246,240,226,/.test(text));
}

// --- 7c. WhatsApp quick-action prefill -------------------------------------
console.log('[7c] governed prefill delivery, intent mapping and destination guard');

// The number lives in exactly one place.
check('config carries a canonical international number', /^[0-9]{8,15}$/.test(CONTACT.whatsapp_business_number),
  JSON.stringify(CONTACT.whatsapp_business_number));
check('config number_base_url derives from the number',
  CONTACT.number_base_url === `https://wa.me/${CONTACT.whatsapp_business_number}`);
check('config display and digits agree',
  (CONTACT.display || '').replace(/\D/g, '') === CONTACT.whatsapp_business_number);
check('config short_link is the incumbent governed short code',
  CONTACT.short_link === GOVERNED_WHATSAPP_URL);
// No independent literal of the number anywhere else. This walks the whole
// repository rather than a hand-listed set of files: a list has to be
// remembered, and the single-source rule is worth nothing if introducing the
// digits into a new generator, validator, fixture or data file leaves the
// tripwire green. The only two places the digits may appear are the governed
// config itself, and the derived #contact-config island inside generated HTML
// -- and in HTML they may appear ONLY inside that island, so a hand-authored
// page cannot carry them either.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'validation-artifacts', '.netlify']);
// Only genuinely binary formats are skipped. SVG is deliberately NOT in this
// list: it is text/XML and can carry the digits in a <text> node, a link,
// metadata or a comment, so a contact badge with an independently maintained
// number would otherwise sit outside the single-source contract.
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|eot|mp4|webm|mp3|zip|gz)$/i;
const CONTACT_ISLAND = /<script type="application\/json" id="contact-config">[\s\S]*?<\/script>/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir || '.'), {withFileTypes: true})) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(rel, out);
    } else if (entry.isFile() && !BINARY.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const digits = CONTACT.whatsapp_business_number;
const scanned = walk('');
const offenders = [];
for (const rel of scanned) {
  if (rel === 'data/contact-channels.json') continue;
  let source;
  try {
    source = read(rel);
  } catch {
    continue;
  }
  // In HTML the derived island is legitimate; everything outside it is not.
  if (rel.endsWith('.html')) source = source.replace(CONTACT_ISLAND, '');
  if (source.includes(digits)) offenders.push(rel);
}
check('the canonical number is restated nowhere outside its governed config',
  offenders.length === 0, offenders.length ? `found in: ${offenders.join(', ')}` : undefined);
// The scan is only worth anything if it actually reached the source tree.
check('the single-source scan covered the repository',
  scanned.length > 100 && scanned.includes('prasa-launch.js')
    && scanned.includes('mindelo-essentials/mindelo-essentials.js')
    && scanned.includes('scripts/test-whatsapp-launcher-panel.mjs'),
  `scanned ${scanned.length} file(s)`);
// Text formats that look asset-shaped are the easy ones to skip by mistake.
check('the scan reaches text assets such as SVG',
  scanned.some((rel) => rel.endsWith('.svg')),
  'no .svg file was scanned');

// All four prefills reach every surface, in that surface's own locale.
for (const rel of surfaces) {
  const block = JSON.parse(read(rel).match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1]);
  const locale = rel.startsWith('pt/') ? 'pt' : 'en';
  for (const [runtimeKey, localeKey] of Object.entries(PREFILL_KEYS)) {
    check(`${rel} carries governed ${runtimeKey}`, block[runtimeKey] === t(localeKey, locale),
      `got ${JSON.stringify(block[runtimeKey])}`);
    if (locale === 'pt') {
      check(`${rel} ${runtimeKey} is not the English fallback`, block[runtimeKey] !== t(localeKey, 'en'));
    }
  }
  // The derived destinations island, from the one governed source.
  const cfg = JSON.parse(read(rel).match(/id="contact-config">([\s\S]*?)<\/script>/)[1]);
  check(`${rel} carries the governed short link`, cfg.shortLink === GOVERNED_WHATSAPP_URL);
  check(`${rel} carries the derived number destination`, cfg.numberBaseUrl === CONTACT.number_base_url);
  check(`${rel} exposes no other contact config`, Object.keys(cfg).sort().join(',') === 'numberBaseUrl,shortLink');
}

// Intent mapping: one action, one prefill, no cross-wiring.
const mappingPairs = Object.entries(QUICK_ACTION_PREFILL);
check('exactly four quick actions are mapped', mappingPairs.length === 4);
check('every mapped prefill is a governed prefill key',
  mappingPairs.every(([, prefill]) => prefill in PREFILL_KEYS));
check('the mapping is injective (no two actions share a prefill)',
  new Set(mappingPairs.map(([, p]) => p)).size === mappingPairs.length);
for (const [action, prefill] of mappingPairs) {
  const suffix = action.replace('launcherQuickAction', '').toLowerCase();
  check(`${action} maps to the matching ${prefill}`, prefill.toLowerCase() === `prefill${suffix}`);
  check(`${prefill} resolves to its own governed key`,
    PREFILL_KEYS[prefill] === `runtime.whatsapp_launcher.prefill.${suffix}`);
}

// Runtime contract: encoding, the two authorized forms, and fail-closed.
for (const [name, source] of [['prasa-launch.js', launcherJs], ['mindelo-essentials.js', mindeloJs]]) {
  check(`${name} builds the destination with URLSearchParams, not concatenation`,
    /url\.searchParams\.set\("text", message\)/.test(source));
  check(`${name} never concatenates the text parameter by hand`,
    !/\?text=/.test(source) && !/encodeURIComponent/.test(source));
  check(`${name} reads the number from the config island only`,
    /CONTACT\.numberBaseUrl/.test(source) && /getElementById\("contact-config"\)/.test(source));
  check(`${name} rejects a config whose short link disagrees`,
    /supplied\.shortLink !== GOVERNED_WHATSAPP_URL/.test(source));
  check(`${name} validates the configured number destination shape`,
    /\^https:\\\/\\\/wa\\\.me\\\/\[0-9\]\{8,15\}\$/.test(source));
  // Authorization is exact equality against the set of destinations this
  // launcher can itself produce -- not an enumeration of URL components. An
  // enumeration has to stay exhaustive forever, and userinfo, a fragment and an
  // explicit port each slipped past the component form of this check.
  check(`${name} builds the authorized set from the governed prefills`,
    /function authorizedDestinations\(\)/.test(source)
    && /new Set\(\[GOVERNED_WHATSAPP_URL\]\)/.test(source)
    && /for \(const message of governedPrefillValues\(\)\)/.test(source));
  check(`${name} authorizes by whole-URL serialization`,
    /return authorizedDestinations\(\)\.has\(normalized\);/.test(source)
    && /normalized = new URL\(href\)\.href;/.test(source));
  check(`${name} no longer authorizes by component inspection`,
    !/url\.origin !== base\.origin/.test(source)
    && !/searchParams\.get\("text"\)/.test(source));
  check(`${name} falls back to the short link without a selection`,
    /: GOVERNED_WHATSAPP_URL;/.test(source));
  // Click alone is not every activation path: a middle click dispatches
  // auxclick, and the context menu's "open in new tab" follows the href with no
  // cancellable event at all. The href is repaired ahead of the paths that
  // cannot be cancelled, and cancelled on the two that can.
  check(`${name} repairs the destination before every activation path`,
    /for \(const type of \["pointerdown", "mousedown", "touchstart", "contextmenu", "focus", "keydown", "dragstart"\]\)/.test(source)
    && /cta\.addEventListener\(type, enforceAuthorizedDestination, true\);/.test(source));
  check(`${name} cancels both cancellable activation events`,
    /for \(const type of \["click", "auxclick"\]\)/.test(source)
    && /if \(!enforceAuthorizedDestination\(\)\) event\.preventDefault\(\);/.test(source));
  check(`${name} reverts an unauthorized destination to the short link`,
    /cta\.href = GOVERNED_WHATSAPP_URL;[\s\S]{0,200}return false;/.test(source));
  check(`${name} excludes its own CTA from the incumbent anchor guard`,
    /!anchor\.closest\("\[data-floating-utilities\]"\)/.test(source));
  check(`${name} keeps the governed CTA accessible name`,
    /launcherPrimaryAction/.test(source));
}

// --- 8. Generated output remains deterministic -----------------------------
// The block is a JSON island: key order and spacing must be stable, or every
// rebuild would churn 32 files. Assert the serialization is canonical rather
// than re-running the generators here (build-all is exercised separately).
console.log('[8] governed block serialization is canonical and stable');
for (const rel of surfaces) {
  const raw = read(rel).match(/id="i18n-strings">([\s\S]*?)<\/script>/)[1];
  check(`${rel} block is emitted on a single line`, !/\n/.test(raw));
  // Byte-identical round-trip is the real determinism property: it proves the
  // block is canonical compact JSON.stringify output, so a rebuild cannot
  // churn key order or spacing across all 32 surfaces. (A naive "contains no
  // ': '" check would be wrong here — governed strings contain colons.)
  check(`${rel} block round-trips byte-identically`, JSON.stringify(JSON.parse(raw)) === raw);
}

console.log(`\n[test-whatsapp-launcher-panel] ${checks - failures}/${checks} checks passed across ${surfaces.length} surface(s).`);
if (failures) {
  console.error(`[test-whatsapp-launcher-panel] FAILED with ${failures} failing check(s).`);
  process.exit(1);
}
