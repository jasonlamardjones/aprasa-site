// P04-RH-A synthetic Resource Hub projection contract.
//
// Semantic authority: P05-E2P v0.1-R1 (Non-Public Pilot Contract). This module
// only restates the subset needed by the synthetic prototype; it does not
// modify or extend that contract. All identifiers handled here are SYNTHETIC
// (SYN-*) and the validator rejects anything else.

export const CONTRACT_VERSION = 'P05-E2P v0.1-R1';

export const OUTCOME = Object.freeze({
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  SUPPRESS: 'SUPPRESS_FROM_CURRENT_DISCOVERY',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  NO_ACTIONABLE_CLAIM: 'NO_ACTIONABLE_CLAIM',
});

export const CURRENTNESS = Object.freeze({
  CURRENT: 'Current',
  REVALIDATION_DUE: 'Revalidation Due',
  CLOSED: 'Closed / Expired',
  UNKNOWN: 'Currentness Unknown',
});
export const CURRENTNESS_VALUES = Object.freeze(Object.values(CURRENTNESS));

// The only publication readiness that is compatible with projection.
export const READY_FOR_PROJECTION = 'Public-Safe Approved';
// Controlled R1 Project 03 disposition. It marks non-public pilot material only
// and is NOT publication authority: projection still requires Public-Safe
// Approved readiness and a governing decision.
export const PROJECT03_DISPOSITION = 'non_public_pilot_only';
export const LOCALE_STATUS = 'en_source_approved_pt_pending_project09';

// R1 transport record classifications. No production classification is invented.
export const RECORD_FAMILIES = Object.freeze([
  'evergreen_learning_resource', 'institutional_provider_program_catalog', 'practical_business_support_tool',
]);

// Exact keys an approved-claim object may carry.
export const CLAIM_KEYS = Object.freeze(['field', 'value', 'evidence_refs']);

// Synthetic-only identifier shapes. Anything else is refused so that a real
// Project 05 identifier can never be projected by this prototype.
export const ID_PATTERNS = Object.freeze({
  resource: /^SYN-RES-\d{4}$/,
  provider: /^SYN-PRV-\d{4}$/,
  evidence: /^SYN-EV-\d{4,6}$/,
  decision: /^SYN-DEC-\d{4,6}$/,
  export: /^SYN-EXP-\d{4}$/,
});

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Top-level keys the private envelope may carry. Any other key is refused.
export const RECORD_ENVELOPE_FIELDS = Object.freeze([
  'contract_version', 'export_id', 'stable_resource_id', 'site_slug',
  'primary_provider_id', 'provider_relationships', 'record_family',
  'evidence_refs', 'decision_id', 'approved_claims', 'publication_readiness',
  'currentness_condition', 'last_verified', 'last_reviewed',
  'next_review_trigger', 'project03_disposition', 'locale_status',
  'projection_version',
]);

// Public output allowlist, in the exact serialized order.
export const PUBLIC_OUTPUT_FIELDS = Object.freeze([
  'stable_resource_id', 'site_slug', 'title', 'summary', 'provider',
  'record_family', 'currentness', 'actionability', 'location_scope',
  'delivery_mode', 'cost_status', 'eligibility_summary', 'deadline',
  'start_date', 'end_date', 'credential_or_support', 'action_url',
  'source_url', 'checked_at', 'public_caveat',
]);
export const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'stable_resource_id', 'site_slug', 'title', 'provider', 'record_family', 'currentness',
]);

// Fields that may only come from an explicitly approved claim.
export const CLAIM_FIELDS = Object.freeze([
  'title', 'summary', 'actionability', 'location_scope', 'delivery_mode',
  'cost_status', 'eligibility_summary', 'deadline', 'start_date', 'end_date',
  'credential_or_support', 'action_url', 'source_url', 'public_caveat',
]);
// Consequential claims need evidence whose scope covers the exact wording.
export const CONSEQUENTIAL_FIELDS = Object.freeze([
  'actionability', 'cost_status', 'eligibility_summary', 'deadline',
  'start_date', 'end_date', 'action_url',
]);
export const DATE_FIELDS = Object.freeze(['deadline', 'start_date', 'end_date']);
export const URL_FIELDS = Object.freeze(['action_url', 'source_url']);

// Fail-closed: any actionability wording is treated as actionable unless it is
// one of these explicitly non-actionable wordings. This is a synthetic-prototype
// guard, not a production actionability policy.
export const NON_ACTIONABLE_STATUSES = Object.freeze(new Set([
  'closed', 'expired', 'information only', 'not open', 'not available', 'unavailable',
]));

// Key names that must never appear in a claim field or projected output.
export const FORBIDDEN_KEY_PATTERN =
  /(reviewer|confidence|evidence|decision|approval|conflict|review_note|legacy|migration|contact|raw_|owner|audit|learner|consent|recommendation|correspondence|moderation|submission|email|phone|export)/i;

// Value shapes that must never appear in public text.
export const LEAK_VALUE_PATTERNS = Object.freeze([
  /\bSYN-(EV|DEC|PRV|EXP)-\d+/i,
  /\b(evidence|decision)[ _-]?(id|ref)/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\+\d[\d\s().-]{7,}\d/,
]);

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Deterministic JSON: object keys sorted by code unit, arrays keep their order.
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}
