// Shared "Portuguese coverage is expanding" secondary informational line,
// rendered immediately after the EN/PT lang-switch control (nav.lang-switch)
// on every generated surface that carries one.
//
// Three incumbent generators each construct <nav class="lang-switch"> markup
// independently (scripts/build-static-pages.mjs, scripts/generate-things-to-do.mjs,
// scripts/build-mindelo-pt.mjs) — this one shared helper is the smallest
// treatment that keeps all three coherent on this bounded signal's wording,
// markup, and placement, rather than duplicating a fourth copy of it in each.
//
// Presentation only: plain flowed text placed right after the switcher in
// document order, not an alert/warning/banner/modal/badge, and not a live
// region. It never touches the switcher's own href/lang/hreflang/aria-current
// markup. Governed by the single additive key ui.pt_expansion_note (see
// data/locales/pt-overlay-r22-lang-switch-note.source.json) — Project 03
// semantic authority; the approved EN/PT copy pair was supplied directly by
// the Project 04 task order of 17 September 2026, not by a Project 09
// linguistic-review handoff.

import { t } from './locale.mjs';

export const LANG_SWITCH_NOTE_KEY = 'ui.pt_expansion_note';

/**
 * Renders the shared note for the given locale ("en" | "pt"). Callers place
 * this immediately after their own <nav class="lang-switch">...</nav> markup
 * and never call it with any locale other than the page's own rendering
 * locale (no cross-locale/fallback use).
 */
export function renderLangSwitchNote(locale) {
  return `<p class="lang-switch-note">${t(LANG_SWITCH_NOTE_KEY, locale)}</p>`;
}
