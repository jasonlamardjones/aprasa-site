#!/usr/bin/env node
// Generates the PT counterpart of each hand-authored static page (Home,
// About, and the two hand-authored Things-to-Do pages) from its EN source
// file plus the governed locale data, and injects the bounded EN/PT
// language-switch + hreflang infrastructure into both the EN source (in
// place) and the generated PT output.
//
// The EN source HTML remains the single authored copy; the PT page is
// mechanically regenerated from it on every run (never hand-edited), per
// the localization spec's ban on an independently-maintained PT HTML copy.
//
// Mindelo Essentials is handled separately (scripts/build-mindelo-pt.mjs)
// because its directory listing is derived from canonical JSON records by
// record_id rather than from prose paragraphs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './lib/locale.mjs';
import { renderLangSwitchNote, LANG_SWITCH_NOTE_KEY } from './lib/lang-switch-note.mjs';
import { RUNTIME_STRING_KEYS, LAUNCHER_SURFACE_KEYS, applyRuntimeStrings } from './lib/runtime-strings.mjs';
import { applyContactConfig } from './lib/contact-channels.mjs';
import { localizeStaticHtml } from './lib/static-page-transform.mjs';
import { deepenSharedAssetPaths } from './lib/asset-paths.mjs';
import { normalizeCanonicalHomeLinks } from './lib/canonical-links.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const write = process.argv.includes('--write');

// Text/attribute strings that are expected to remain untranslated on PT
// pages (protected identities, place names, proper nouns, technical
// values) and should NOT fail generation when the localizer reports them
// as unmatched English. Kept short and explicit — anything not on this
// list that shows up unmatched is treated as a real gap and fails the
// build, per the no-silent-fallback contract.
const ALLOWED_UNTRANSLATED = new Set([
  'A PRASA',
  'A PRASA, SOCIEDADE UNIPESSOAL LDA.',
  'Jason La Mard Jones',
  'Founder & Principal Consultant',
  'Mindelo',
  'São Vicente',
  'São Vicente, Cabo Verde',
  'Cabo Verde',
  'Porto Grande',
  'Monte Cara',
  'width=device-width, initial-scale=1',
  'summary_large_image',
  'website',
  'Language / Idioma',
  // Canonical provider/organization/place identity — deliberately absent
  // from the overlay (same pattern as event.<id>.* never carrying
  // `provider`/`location.name`): these are locale-independent facts, not
  // translatable UI copy, so their absence from the governed overlay is
  // expected, not a gap.
  'Academia de Estudo Crescer',
  'Kafê Djan Djan, Mindelo',
  'HP Foundation',
  'The Open University / OpenLearn',
  'Instituto do Emprego e Formação Profissional (IEFP)',
  'IEFP Cabo Verde',
  'IBM',
  'Microsoft',
  'Cruz Vermelha de Cabo Verde',
  'Biosfera',
  'Nô Bai Associação',
  'Associação Espaço Jovem',
  'Aldeias Infantis SOS Cabo Verde',
  'SabMais',
  'Associação SabMais',
  'São Vicente',
  // Simabo: organization identity (card title, dialog title and provider
  // line) plus its public volunteer address. Both are locale-independent
  // facts, deliberately absent from the governed overlay for the same reason
  // as the other provider identities above — the address in particular must
  // stay byte-identical in both locales.
  'Simabo',
  'volunteers@simabo.org',
  // Start CV (Learning Spotlight): provider identity, plus the two contact
  // lines Project 09 froze as INTENTIONALLY_UNCHANGED for this record. They
  // are rendered as the <dt>/<dd> halves of the governed contact block and
  // must stay byte-identical on both Home surfaces.
  'Start CV',
  'Phone / WhatsApp',
  '(+238) 970 49 62',
  'Email',
  'startcvschool@gmail.com',
  // Locale-matched temporary thumbnail alt text for the EMAR / Kre+ cards:
  // both the EN and PT variant of each image (and its alt) is present in
  // the shared EN source and shown/hidden per-locale by CSS (.lang-only-en
  // / .lang-only-pt), not by the overlay/translation pipeline — so neither
  // string has (or needs) a governed key.
  'Screenshot of the Kre+ course page for Driver – Level 3',
  'Captura de ecrã da página da Kre+ para Motorista — Nível 3',
  'Screenshot of the Kre+ course page for Naval Electrotechnical Assistant – Level 4',
  'Captura de ecrã da página da Kre+ para Assistente Eletrotécnico Naval — Nível 4',
  // Institutional identities carried by the weekly fixed-window opportunity
  // records. Project 09 marked every one of them "provider — intentionally
  // unchanged" and listed provider/institution identities among the values
  // that stay mechanically preserved as canonical data rather than being
  // translated. They are therefore deliberately absent from the overlay, for
  // the same reason as the provider identities above — not a localization gap.
  'Universidade de Cabo Verde',
  'Universidade de Cabo Verde — Gabinete de Estudos, Planeamento e Cooperação (GEPC)',
  'Universidade de Cabo Verde / Embassy of the People\'s Republic of China in Cabo Verde',
  'Universidade de Cabo Verde / CIGEF',
  'Instituto Confúcio na Universidade de Cabo Verde',
  'Direção-Geral das Artes (DGARTES)',
  // timbuktoo (UNDP): institutional provider identity for the
  // timbuktoo-greentech-launchpad rolling opportunity, carried verbatim from
  // the Project 03 IMPLEMENTATION_COPY_COMPLETE package of 18 September 2026.
  // The governed package supplies exactly one provider value and explicitly
  // reserves provider identity from reopening, so it is preserved as a
  // locale-independent institutional fact here rather than translated. No
  // Portuguese rendering of the UNDP name is composed: authoring one would be
  // inventing governed copy, which this lane has no authority to do. The
  // programme identity "timbuktoo" keeps its lowercase initial in both
  // locales.
  'United Nations Development Programme (UNDP) — timbuktoo',
]);

// Two spots in Home's hero use inline markup to control visual line-breaks
// or emphasis around individual English words ("Why | A PRASA | exists"
// split across 3 <span class="line">, and "moves" wrapped in <em>). Because
// Portuguese word order/count differs, there is no governed word-for-word
// mapping to preserve that per-word markup; these two blocks are replaced
// wholesale with their single governed sentence (home.why.title,
// home.hero.closing) for the PT page only, at the cost of losing the
// per-word visual grouping (not a translation decision — no PT wording is
// invented, only the EN structural markup is collapsed).
function applyHomeHeroFixups(html, locale) {
  if (locale !== 'pt') return html;
  let out = html;
  out = out.replace(
    /<h2 id="why-prasa-title" class="narrative-title">[\s\S]*?<\/h2>/,
    `<h2 id="why-prasa-title" class="narrative-title"><!--i18n:skip-->${t('home.why.title', 'pt')}<!--/i18n:skip--></h2>`
  );
  out = out.replace(
    /<p class="hero-close">Find what <em class="accent-word">moves<\/em> you\.<\/p>/,
    `<p class="hero-close"><!--i18n:skip-->${t('home.hero.closing', 'pt')}<!--/i18n:skip--></p>`
  );
  return out;
}

function fail(page, msg) {
  console.error(`[build-static-pages] FAIL (${page}): ${msg}`);
  process.exit(1);
}


function injectHeadLinks(html, { canonicalEn, canonicalPt, selfCanonical, lang }) {
  let out = html.replace(/<html lang="[a-z]+">/, `<html lang="${lang}">`);
  out = out.replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${selfCanonical}">`);
  if (/hreflang="pt"/.test(out)) {
    // Already injected (idempotent re-run or PT derived from an
    // EN source that already carries the block) — just refresh the
    // three reciprocal targets in place rather than duplicating them.
    out = out.replace(/<link rel="alternate" hreflang="en" href="[^"]*">/, `<link rel="alternate" hreflang="en" href="${canonicalEn}">`);
    out = out.replace(/<link rel="alternate" hreflang="pt" href="[^"]*">/, `<link rel="alternate" hreflang="pt" href="${canonicalPt}">`);
    out = out.replace(/<link rel="alternate" hreflang="x-default" href="[^"]*">/, `<link rel="alternate" hreflang="x-default" href="${canonicalEn}">`);
  } else {
    out = out.replace(
      /<link rel="canonical" href="[^"]*">/,
      (m) => `${m}\n<link rel="alternate" hreflang="en" href="${canonicalEn}">\n<link rel="alternate" hreflang="pt" href="${canonicalPt}">\n<link rel="alternate" hreflang="x-default" href="${canonicalEn}">`
    );
  }
  out = out.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${selfCanonical}">`);
  if (!/og:locale/.test(out)) {
    out = out.replace(/(<meta property="og:url" content="[^"]*">)/, `$1\n<meta property="og:locale" content="${lang === 'pt' ? 'pt_PT' : 'en_US'}">`);
  } else {
    out = out.replace(/<meta property="og:locale" content="[^"]*">/, `<meta property="og:locale" content="${lang === 'pt' ? 'pt_PT' : 'en_US'}">`);
  }
  return out;
}

// Injects the header-actions wrapper + lang-switch nav (mirrors the markup
// already added by scripts/generate-things-to-do.mjs) around the existing
// <nav class="site-nav">...</nav>, and localizes its own aria-labels/link
// text/targets for the given locale + page depth.
function injectLangSwitch(html, { navHtml, enHref, ptHref, locale }) {
  const navAria = t('nav.site_navigation', locale);
  const wrapped = `<div class="header-actions">
      ${navHtml.trim()}
      <nav class="lang-switch" aria-label="Language / Idioma">
        <a href="${enHref}" lang="en" hreflang="en"${locale === 'en' ? ' aria-current="true" class="lang-current"' : ''}>EN</a>
        <a href="${ptHref}" lang="pt" hreflang="pt"${locale === 'pt' ? ' aria-current="true" class="lang-current"' : ''}>PT</a>
      </nav>
    </div>`;
  return html.replace(/<nav class="site-nav"[\s\S]*?<\/nav>/, () => wrapped).replace(/aria-label="Site navigation"/, `aria-label="${navAria}"`);
}

// Injects the shared secondary "Portuguese coverage is expanding" note
// (scripts/lib/lang-switch-note.mjs) immediately after the lang-switch nav —
// presentation only, never touching the switcher's own
// href/lang/hreflang/aria-current markup. Gated by its own idempotency check
// (rather than folded into injectLangSwitch above) because every EN source
// file this builder owns already carries lang-switch infrastructure from
// earlier runs, so injectLangSwitch's own "!/lang-switch/" guard above never
// fires again for them; this note needs to land on top of that already-
// bootstrapped markup exactly once, on its own.
function injectLangSwitchNote(html, locale) {
  if (/lang-switch-note/.test(html)) return html;
  return html.replace(/(<nav class="lang-switch"[\s\S]*?<\/nav>)/, (m) => `${m}\n      ${renderLangSwitchNote(locale)}`);
}

// About's founder paragraph wraps the founder's name in a link mid-sentence
// ("A PRASA was founded by <a>Jason La Mard Jones</a>, who serves as..."),
// fragmenting the governed about.founder.body_2 sentence across 3 text
// nodes. Reconstructs the PT sentence around the same anchor (href
// untouched — a plain external identity link, not a locale-dependent
// route) by locating the anchor's own visible text (an identity string
// preserved verbatim in PT) inside the governed PT sentence.
function applyAboutFounderFixup(html, locale) {
  if (locale !== 'pt') return html;
  return html.replace(
    /A PRASA was founded by (<a[^>]*>)([^<]*)(<\/a>), who serves as Founder &amp; Principal Consultant\./,
    (whole, openTag, anchorText, closeTag) => {
      const ptSentence = t('about.founder.body_2', 'pt');
      const idx = ptSentence.indexOf(anchorText);
      if (idx === -1) {
        throw new Error(`about founder fixup: PT sentence does not contain expected anchor text "${anchorText}"`);
      }
      const before = ptSentence.slice(0, idx);
      const after = ptSentence.slice(idx + anchorText.length);
      return `<!--i18n:skip-->${before}<!--/i18n:skip-->${openTag}${anchorText}${closeTag}<!--i18n:skip-->${after}<!--/i18n:skip-->`;
    }
  );
}

// Governed runtime strings for prasa-launch.js.
//
// prasa-launch.js renders copy the static-page localizer never sees, because
// the runtime injects it after the page is built: the editorial media-fallback
// labels on Home's card grids, and the on-site panel the floating WhatsApp
// launcher opens. A live audit previously found the media-fallback labels
// rendering in English on PT Home for exactly that reason. The builder writes
// the governed values for the page's OWN locale into the
// <script type="application/json" id="i18n-strings"> block Mindelo Essentials
// already uses for its runtime copy; prasa-launch.js reads them from there and
// never translates.
//
// The key map lives in scripts/lib/runtime-strings.mjs so Home, About, the
// Things-to-Do templates and the detail pages cannot drift apart on which keys
// a surface carries. Only keys with an approved governed value are emitted; a
// key with no approved Portuguese value must be left out rather than
// translated here.
//
// Reach: the media-fallback copy is Home-only, but the launcher initializes on
// every surface carrying the governed WhatsApp anchor, so the panel keys must
// reach every page this builder owns — not just Home. Home therefore gets the
// full set and every other page gets the launcher set.
function runtimeKeysFor(name) {
  return name === 'home' ? RUNTIME_STRING_KEYS : LAUNCHER_SURFACE_KEYS;
}

// localizeStaticHtml deliberately treats <script> content as opaque raw
// text (it must never attempt to parse/rewrite arbitrary JavaScript) —
// which means the governed presentation text inside Home's Organization
// JSON-LD block was silently carried over from EN unchanged. This is a
// narrow, explicit exception for that one known structured-data payload:
// parse it as JSON, replace ONLY the governed `description` field, and
// re-serialize — every other field (canonical @type/name/url/logo, and the
// factual areaServed place records) passes through byte-for-byte.
function applyHomeStructuredDataFixup(html, locale) {
  if (locale !== 'pt') return html;
  return html.replace(
    /(<script type="application\/ld\+json">\n)([\s\S]*?)(\n<\/script>)/,
    (whole, open, jsonText, close) => {
      const schema = JSON.parse(jsonText);
      if (schema['@type'] !== 'Organization') return whole;
      schema.description = t('home.structured_data.organization_description', 'pt');
      return `${open}${JSON.stringify(schema, null, 2)}${close}`;
    }
  );
}

function buildPage({ name, enPath, ptPath, canonicalEn, canonicalPt, enHrefFromRoot, ptHrefFromRoot, collectionHref = null }) {
  const enAbs = path.join(root, enPath);
  const ptAbs = path.join(root, ptPath);
  let enSource = fs.readFileSync(enAbs, 'utf8');

  // 0. Canonical internal-link hygiene, applied to the authored EN source
  //    before anything is derived from it so EN and PT can never disagree.
  //    Home links take their clean directory form, and the legacy
  //    "Home#things-to-do" return anchor on a Things-to-Do page points at that
  //    page's own same-locale collection route. Idempotent, and it changes no
  //    canonical tag and adds no redirect.
  enSource = normalizeCanonicalHomeLinks(enSource, { collectionHref });
  enSource = applyRuntimeStrings(enSource, 'en', runtimeKeysFor(name));
  enSource = applyContactConfig(enSource);

  // 1. Inject bounded EN infrastructure (hreflang + lang-switch) into the EN
  //    source in place, if not already present (idempotent).
  if (!/hreflang="pt"/.test(enSource)) {
    enSource = injectHeadLinks(enSource, { canonicalEn, canonicalPt, selfCanonical: canonicalEn, lang: 'en' });
  }
  if (!/lang-switch/.test(enSource)) {
    enSource = injectLangSwitch(enSource, { navHtml: enSource.match(/<nav class="site-nav"[\s\S]*?<\/nav>/)[0], enHref: enHrefFromRoot.en, ptHref: enHrefFromRoot.pt, locale: 'en' });
  }
  enSource = injectLangSwitchNote(enSource, 'en');

  // 2. Derive the PT page from the (now infrastructure-complete) EN source.
  let ptSource = injectHeadLinks(enSource, { canonicalEn, canonicalPt, selfCanonical: canonicalPt, lang: 'pt' });
  ptSource = ptSource.replace(/<nav class="lang-switch"[\s\S]*?<\/nav>/, (m) =>
    m
      .replace(/href="[^"]*"(\s+lang="en")/, `href="${ptHrefFromRoot.en}"$1`)
      .replace(/href="[^"]*"(\s+lang="pt")/, `href="${ptHrefFromRoot.pt}"$1`)
      .replace(/ aria-current="true" class="lang-current"/g, '')
      .replace(/lang="pt" hreflang="pt"/, 'lang="pt" hreflang="pt" aria-current="true" class="lang-current"')
  );
  // The note was baked into enSource above in English; re-derive it here
  // explicitly for PT, idempotently on every run. Wrapped in <!--i18n:skip-->
  // like the other page-specific fixups below: it is already the final PT
  // text (governed by the same ui.pt_expansion_note key the EN copy came
  // from), and re-scanning Portuguese prose through the EN->PT text matcher
  // a few lines down would just report it as unmatched English.
  ptSource = ptSource.replace(
    /<p class="lang-switch-note">[\s\S]*?<\/p>/,
    () => `<p class="lang-switch-note"><!--i18n:skip-->${t(LANG_SWITCH_NOTE_KEY, 'pt')}<!--/i18n:skip--></p>`
  );
  ptSource = deepenSharedAssetPaths(ptSource);
  // The PT page sits one directory deeper, so its inherited "../"-relative
  // Home links already resolve to the PT Home; only the document form needs
  // normalizing, exactly as on the EN source above.
  ptSource = normalizeCanonicalHomeLinks(ptSource, { collectionHref });
  ptSource = applyHomeHeroFixups(ptSource, name === 'home' ? 'pt' : 'en');
  ptSource = applyAboutFounderFixup(ptSource, name === 'about' ? 'pt' : 'en');
  ptSource = applyHomeStructuredDataFixup(ptSource, name === 'home' ? 'pt' : 'en');
  ptSource = applyRuntimeStrings(ptSource, 'pt', runtimeKeysFor(name));
  ptSource = applyContactConfig(ptSource);

  const { html: rawLocalized, unmatchedEnglish } = localizeStaticHtml(ptSource, 'pt');
  const localized = rawLocalized.replaceAll('<!--i18n:skip-->', '').replaceAll('<!--/i18n:skip-->', '');
  const realGaps = unmatchedEnglish.filter((u) => !ALLOWED_UNTRANSLATED.has(u.text));

  // Atomicity invariant: an EN page must never advertise or visibly link to
  // a PT counterpart unless that counterpart actually exists. enSource
  // above already has the hreflang/lang-switch infrastructure baked in
  // in-memory, but nothing is written to disk — for either file — until we
  // know the PT page itself succeeded. A blocked page leaves BOTH files
  // exactly as they were on disk (no dangling EN→PT link, no partial PT
  // write), so re-running the pipeline is always safe.
  if (realGaps.length) {
    console.error(`[build-static-pages] BLOCKED (${name}): ${realGaps.length} required English string(s) have no governed PT value in the overlay — neither EN infrastructure nor PT page written (no-silent-fallback / no-dangling-link contract):`);
    for (const g of realGaps) console.error(`  - [${g.where}] "${g.text}"`);
    return { name, blocked: true, gaps: realGaps };
  }

  if (write) {
    fs.mkdirSync(path.dirname(enAbs), { recursive: true });
    fs.writeFileSync(enAbs, enSource);
    fs.mkdirSync(path.dirname(ptAbs), { recursive: true });
    fs.writeFileSync(ptAbs, localized);
    console.log(`[build-static-pages] wrote ${enPath} (infra-updated) and ${ptPath}`);
  } else {
    console.log(`[build-static-pages] prepared ${name}: ${unmatchedEnglish.length} allowed untranslated string(s), 0 gaps`);
  }
  return { name, blocked: false };
}

const pages = [
  {
    name: 'home',
    enPath: 'index.html',
    ptPath: 'pt/index.html',
    canonicalEn: 'https://aprasa.org/',
    canonicalPt: 'https://aprasa.org/pt/',
    // hrefs as they appear in the lang-switch nav INJECTED INTO THE EN FILE:
    enHrefFromRoot: { en: './', pt: 'pt/' },
    // hrefs after the regex swap that derives the PT file's own switch nav:
    ptHrefFromRoot: { en: '../', pt: './' },
  },
  {
    name: 'about',
    enPath: 'about/index.html',
    ptPath: 'pt/about/index.html',
    canonicalEn: 'https://aprasa.org/about/',
    canonicalPt: 'https://aprasa.org/pt/about/',
    enHrefFromRoot: { en: './', pt: '../pt/about/' },
    ptHrefFromRoot: { en: '../../about/', pt: './' },
  },
  {
    name: 'street-art-mindelo',
    enPath: 'things-to-do/street-art-mindelo/index.html',
    ptPath: 'pt/things-to-do/street-art-mindelo/index.html',
    canonicalEn: 'https://aprasa.org/things-to-do/street-art-mindelo/',
    canonicalPt: 'https://aprasa.org/pt/things-to-do/street-art-mindelo/',
    enHrefFromRoot: { en: '../../things-to-do/street-art-mindelo/', pt: '../../pt/things-to-do/street-art-mindelo/' },
    ptHrefFromRoot: { en: '../../../things-to-do/street-art-mindelo/', pt: '../../../pt/things-to-do/street-art-mindelo/' },
    // Same-locale Things-to-Do collection route, relative to this page: every
    // detail page is a direct child of its locale's hub, in both locales.
    collectionHref: '../',
  },
  {
    name: 'water-adventure-activities-mindelo',
    enPath: 'things-to-do/water-adventure-activities-mindelo/index.html',
    ptPath: 'pt/things-to-do/water-adventure-activities-mindelo/index.html',
    canonicalEn: 'https://aprasa.org/things-to-do/water-adventure-activities-mindelo/',
    canonicalPt: 'https://aprasa.org/pt/things-to-do/water-adventure-activities-mindelo/',
    enHrefFromRoot: { en: '../../things-to-do/water-adventure-activities-mindelo/', pt: '../../pt/things-to-do/water-adventure-activities-mindelo/' },
    ptHrefFromRoot: { en: '../../../things-to-do/water-adventure-activities-mindelo/', pt: '../../../pt/things-to-do/water-adventure-activities-mindelo/' },
    // Same-locale Things-to-Do collection route, relative to this page: every
    // detail page is a direct child of its locale's hub, in both locales.
    collectionHref: '../',
  },
];

const results = pages.map(buildPage);
const blocked = results.filter((r) => r.blocked);
console.log(
  `[build-static-pages] ${results.length - blocked.length}/${results.length} page(s) generated; ${blocked.length} blocked pending governed overlay content: ${blocked.map((r) => r.name).join(', ') || 'none'}`
);
if (blocked.length) process.exitCode = 1;
