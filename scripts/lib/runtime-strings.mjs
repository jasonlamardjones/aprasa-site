// Governed runtime strings delivered to the page runtimes through the
// <script type="application/json" id="i18n-strings"> block.
//
// prasa-launch.js renders copy the static-page localizer never sees, because
// the runtime injects it after the page is built: the editorial media-fallback
// labels, and now the on-site contact panel the floating WhatsApp launcher
// opens. A live audit previously found the media-fallback labels rendering in
// English on PT Home for exactly that reason. The fix, kept here, is that the
// builder writes the governed values for the page's OWN locale into the block
// and the runtime reads them from there — it never translates.
//
// This module is the single place the generators agree on that contract, so
// the Home, About, Things-to-Do and detail templates cannot drift apart on
// which keys a surface carries. scripts/validate-runtime-locale-strings.mjs
// deliberately keeps its own independent copy of this map: it is the check
// that this file is correct, so it must not import from it.
//
// Only keys with an approved governed value belong here. A key with no
// approved Portuguese value must be left out rather than translated locally.
import { t } from './locale.mjs';

// Media-fallback copy: rendered into the Home card shelves.
export const MEDIA_FALLBACK_KEYS = {
  mediaFallbackLabel: 'system.media_fallback.label',
  mediaFallbackNote: 'system.media_fallback.note',
  sectionThumbnailNote: 'system.media_fallback.section_note',
  trainingsSectionLabel: 'home.training.title',
  organizationsSectionLabel: 'home.organizations.title',
};

// Launcher-panel copy (Project 09 r17): rendered into the on-site chat-style
// panel the
// floating WhatsApp launcher opens. The launcher initializes on every surface
// carrying the governed WhatsApp anchor, so unlike the media-fallback set
// these keys must reach every such surface, not just Home.
export const LAUNCHER_PANEL_KEYS = {
  launcherHeader: 'runtime.whatsapp_launcher.header',
  launcherIntro: 'runtime.whatsapp_launcher.intro',
  launcherQuickActionShare: 'runtime.whatsapp_launcher.quick_action.share',
  launcherQuickActionCorrection: 'runtime.whatsapp_launcher.quick_action.correction',
  launcherQuickActionQuestion: 'runtime.whatsapp_launcher.quick_action.question',
  launcherQuickActionSubmissions: 'runtime.whatsapp_launcher.quick_action.submissions',
  launcherPrimaryAction: 'runtime.whatsapp_launcher.primary_action',
  launcherSecondaryAction: 'runtime.whatsapp_launcher.secondary_action',
};

// Floating navigation controls. The Up control is available on every surface,
// including Mindelo Essentials, which carries no in-page "Back to top" anchor
// for the runtime to borrow a label from. ui.back_to_top is long-standing
// governed copy — this adds no new string, it only routes an existing one to
// the runtime that needs it.
export const NAV_CONTROL_KEYS = {
  navBackToTop: 'ui.back_to_top',
  // Names the Down control on surfaces with no governed in-page section nav,
  // where it pages the viewport rather than stepping named sections. Home does
  // not use it: its Down is named from its own nav anchors.
  navScrollDown: 'ui.scroll_down',
};

// Quick-action starter messages (Project 09 r19). One per governed quick
// action, keyed so the runtime can look one up from the selected action's own
// key without a second mapping table. There is deliberately no generic
// fallback message: selecting nothing keeps the incumbent short link.
export const PREFILL_KEYS = {
  prefillShare: 'runtime.whatsapp_launcher.prefill.share',
  prefillCorrection: 'runtime.whatsapp_launcher.prefill.correction',
  prefillQuestion: 'runtime.whatsapp_launcher.prefill.question',
  prefillSubmissions: 'runtime.whatsapp_launcher.prefill.submissions',
};

// Quick-action runtime key -> its prefill runtime key. The single place the
// intent mapping is expressed; the runtimes and the tests both read it.
export const QUICK_ACTION_PREFILL = {
  launcherQuickActionShare: 'prefillShare',
  launcherQuickActionCorrection: 'prefillCorrection',
  launcherQuickActionQuestion: 'prefillQuestion',
  launcherQuickActionSubmissions: 'prefillSubmissions',
};

export const RUNTIME_STRING_KEYS = { ...MEDIA_FALLBACK_KEYS, ...LAUNCHER_PANEL_KEYS, ...NAV_CONTROL_KEYS, ...PREFILL_KEYS };

// Every surface that carries the launcher needs the panel copy, the nav-control
// names and the prefill starters.
export const LAUNCHER_SURFACE_KEYS = { ...LAUNCHER_PANEL_KEYS, ...NAV_CONTROL_KEYS, ...PREFILL_KEYS };

export const RUNTIME_STRINGS_BLOCK = /<script type="application\/json" id="i18n-strings">[\s\S]*?<\/script>\n?/;

/** Resolve a runtime-key map to its governed values for one locale. */
export function resolveRuntimeStrings(keyMap, locale) {
  const payload = {};
  for (const [runtimeKey, localeKey] of Object.entries(keyMap)) {
    payload[runtimeKey] = t(localeKey, locale);
  }
  return payload;
}

export function renderRuntimeStringsBlock(payload) {
  return `<script type="application/json" id="i18n-strings">${JSON.stringify(payload)}</script>\n`;
}

/**
 * Write (or replace) the governed runtime-strings block on a page.
 * `keyMap` defaults to the full set; surfaces that carry only some of the
 * runtime copy pass their own subset.
 */
export function applyRuntimeStrings(html, locale, keyMap = RUNTIME_STRING_KEYS) {
  const block = renderRuntimeStringsBlock(resolveRuntimeStrings(keyMap, locale));
  if (RUNTIME_STRINGS_BLOCK.test(html)) return html.replace(RUNTIME_STRINGS_BLOCK, block);
  return html.replace('</head>', `${block}</head>`);
}
