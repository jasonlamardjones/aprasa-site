// Shared locale utilities for A PRASA EN/PT localization.
//
// Source of truth chain (do not invert):
//   Project 03 (semantic authority) -> Project 09 governed PT overlay (linguistic authority)
//   -> data/locales/pt-overlay-r2.source.json (raw governed export, unmodified)
//   -> data/locales/locale-data.generated.json (normalized, built by scripts/build-locale-data.mjs)
//
// This module never invents translations. A missing REQUIRED_FOR_PT_LAUNCH key for
// locale "pt" is a hard failure (throws), by design (no-silent-fallback contract).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALE_DATA_PATH = path.join(__dirname, "..", "..", "data", "locales", "locale-data.generated.json");

let cachedData = null;

export function loadLocaleData() {
  if (cachedData) return cachedData;
  const raw = readFileSync(LOCALE_DATA_PATH, "utf8");
  cachedData = JSON.parse(raw);
  return cachedData;
}

export const RETIRED_KEY_REMAP = {
  "ui.external_link_accessible_label": "ui.external_link_marker",
  "submission.event.prompt": "home.things.submit_prompt",
  "submission.event.action": "home.things.submit_action",
  "spotlight.local.availability_status": "home.local_spotlight.status",
  "spotlight.local.details_heading": "ui.details",
  "spotlight.local.good_to_know_heading": "ui.good_to_know",
  "system.map.location_default_label": "ui.location",
  "system.map.tile_error_guidance": "mindelo.map.fallback",
};

class LocaleLookupError extends Error {}

/**
 * Resolve a governed locale key for the given locale ("en" | "pt").
 * Throws LocaleLookupError instead of silently falling back to English on
 * a Portuguese page — this is the no-silent-fallback contract.
 */
export function t(key, locale) {
  if (key in RETIRED_KEY_REMAP) {
    throw new LocaleLookupError(
      `Retired locale key "${key}" referenced; use "${RETIRED_KEY_REMAP[key]}" instead.`
    );
  }
  const data = loadLocaleData();
  const row = data.keys[key];
  if (!row) {
    throw new LocaleLookupError(`Unknown locale key "${key}" (not present in governed overlay).`);
  }
  if (locale === "en") {
    return row.en;
  }
  if (locale === "pt") {
    if (row.scope_status === "INTENTIONALLY_UNCHANGED") {
      return row.en;
    }
    if (row.pt == null || row.pt === "") {
      throw new LocaleLookupError(
        `Missing governed Portuguese value for required key "${key}". Generation must fail rather than fall back to English.`
      );
    }
    return row.pt;
  }
  throw new LocaleLookupError(`Unsupported locale "${locale}"`);
}

/** Look up presentation text for a record-scoped key (record_id + field suffix), e.g. "SV-MIN-PAY-001" + "description". */
export function tRecord(recordId, fieldKey, locale) {
  const data = loadLocaleData();
  const row = Object.values(data.keys).find(
    (r) => r.record_id === recordId && r.key.endsWith(`.${fieldKey}`)
  );
  if (!row) {
    throw new LocaleLookupError(`No locale row found for record "${recordId}" field "${fieldKey}".`);
  }
  if (locale === "en") return row.en;
  if (row.scope_status === "INTENTIONALLY_UNCHANGED") return row.en;
  if (!row.pt) {
    throw new LocaleLookupError(`Missing governed Portuguese value for record "${recordId}" field "${fieldKey}".`);
  }
  return row.pt;
}

export function hasKey(key) {
  const data = loadLocaleData();
  return key in data.keys;
}

export { LocaleLookupError };
