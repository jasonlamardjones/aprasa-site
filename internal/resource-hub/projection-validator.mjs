// P04-RH-A synthetic projection validator. Fail-closed: every check adds an
// error; any error means REJECT. Errors carry a code and a field name only,
// never the offending value, so diagnostics cannot echo restricted input.

import * as C from './projection-contract.mjs';

const { isPlainObject } = C;
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

export function safeKey(key) {
  return /^[a-z][a-z0-9_]{0,39}$/.test(key) ? key : '[redacted]';
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !C.ISO_DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Offline URL screening only; no network access. Returns null when acceptable,
// otherwise a reason code.
export function checkPublicUrl(value) {
  if (typeof value !== 'string' || value === '') return 'URL_NOT_STRING';
  if (/[\u0000- \u007f-\u009f\\]/.test(value)) return 'URL_ILLEGAL_CHARACTER';
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'URL_NOT_ABSOLUTE';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'URL_UNSAFE_SCHEME';
  if (!/^https?:\/\/[^/]/i.test(value)) return 'URL_NOT_ABSOLUTE';
  if (url.username || url.password) return 'URL_CREDENTIALS';
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return 'URL_IP_LITERAL';
  if (!host.includes('.') || /\.(local|localhost|internal|lan)$/.test(host)) return 'URL_NON_PUBLIC_HOST';
  return null;
}

// Index by id. Ids that occur more than once are dropped entirely, so an
// ambiguous reference resolves to nothing and fails closed.
export function indexById(list, idKey) {
  const map = new Map();
  const ambiguous = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!isPlainObject(item) || !nonEmpty(item[idKey])) continue;
    const id = item[idKey];
    if (map.has(id) || ambiguous.has(id)) {
      map.delete(id);
      ambiguous.add(id);
    } else {
      map.set(id, item);
    }
  }
  return map;
}

export function buildEnv(ctx, records) {
  const count = (field) => {
    const seen = new Map();
    for (const r of Array.isArray(records) ? records : []) {
      if (isPlainObject(r) && nonEmpty(r[field])) seen.set(r[field], (seen.get(r[field]) || 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id));
  };
  const c = isPlainObject(ctx) ? ctx : {};
  return {
    providers: indexById(c.providers, 'provider_id'),
    evidence: indexById(c.evidence, 'evidence_id'),
    decisions: indexById(c.decisions, 'decision_id'),
    assessmentDate: c.assessment_date,
    directorySelectedIds: new Set(Array.isArray(c.directory_selected_ids) ? c.directory_selected_ids : []),
    homeFeatureIds: new Set(Array.isArray(c.home_feature_ids) ? c.home_feature_ids : []),
    duplicateResourceIds: count('stable_resource_id'),
    duplicateSlugs: count('site_slug'),
  };
}

function leaksValue(text) {
  return C.LEAK_VALUE_PATTERNS.some((p) => p.test(text));
}

function scopeCovers(evidence, field, value) {
  if (!Array.isArray(evidence.claim_scope)) return false;
  // Every approved wording, consequential or not, must be supported verbatim.
  return evidence.claim_scope.some((s) => isPlainObject(s) && s.field === field && s.value === value);
}

function evidenceWellFormed(ev) {
  return C.ID_PATTERNS.evidence.test(ev.evidence_id) && C.ID_PATTERNS.resource.test(ev.record_id)
    && Array.isArray(ev.claim_scope)
    && typeof ev.usable_for_public_claim === 'boolean'
    && C.CURRENTNESS_VALUES.includes(ev.currentness) && isIsoDate(ev.checked_at);
}

export function validateRecord(record, env) {
  const errors = [];
  const add = (code, field) => errors.push({ code, field });
  if (!isPlainObject(record)) return [{ code: 'RECORD_NOT_OBJECT', field: 'record' }];

  for (const key of Object.keys(record).sort()) {
    if (!C.RECORD_ENVELOPE_FIELDS.includes(key)) {
      add(C.FORBIDDEN_KEY_PATTERN.test(key) ? 'PRIVATE_FIELD_PRESENT' : 'UNEXPECTED_RECORD_FIELD', safeKey(key));
    }
  }

  if (record.contract_version !== C.CONTRACT_VERSION) add('CONTRACT_VERSION_MISMATCH', 'contract_version');
  if (!nonEmpty(record.export_id) || !C.ID_PATTERNS.export.test(record.export_id)) add('INVALID_EXPORT_ID', 'export_id');
  for (const f of ['projection_version', 'next_review_trigger']) {
    if (!nonEmpty(record[f])) add('MISSING_REQUIRED_FIELD', f);
  }
  for (const f of ['last_verified', 'last_reviewed']) {
    if (!isIsoDate(record[f])) add('INVALID_DATE', f);
  }
  if (record.project03_disposition !== C.PROJECT03_DISPOSITION) add('PROJECT03_DISPOSITION_MISMATCH', 'project03_disposition');
  if (record.locale_status !== C.LOCALE_STATUS) add('LOCALE_STATUS_MISMATCH', 'locale_status');
  if (!C.RECORD_FAMILIES.includes(record.record_family)) add('INVALID_RECORD_FAMILY', 'record_family');

  // Identity: the permanent Resource ID and the website projection ID are separate.
  const rid = record.stable_resource_id;
  if (!nonEmpty(rid)) add('MISSING_STABLE_RESOURCE_ID', 'stable_resource_id');
  else {
    if (!C.ID_PATTERNS.resource.test(rid)) add('NON_SYNTHETIC_ID', 'stable_resource_id');
    if (env.duplicateResourceIds.has(rid)) add('DUPLICATE_STABLE_RESOURCE_ID', 'stable_resource_id');
  }
  if (!nonEmpty(record.site_slug) || !C.SLUG_PATTERN.test(record.site_slug)) add('INVALID_SITE_SLUG', 'site_slug');
  else {
    if (nonEmpty(rid) && record.site_slug === rid.toLowerCase()) add('SLUG_EQUALS_RESOURCE_ID', 'site_slug');
    if (env.duplicateSlugs.has(record.site_slug)) add('DUPLICATE_SITE_SLUG', 'site_slug');
  }

  // Provider resolution and explicitly supplied relationships only.
  const provider = nonEmpty(record.primary_provider_id) ? env.providers.get(record.primary_provider_id) : undefined;
  if (!nonEmpty(record.primary_provider_id)) add('MISSING_PROVIDER', 'primary_provider_id');
  else if (!C.ID_PATTERNS.provider.test(record.primary_provider_id)) add('NON_SYNTHETIC_ID', 'primary_provider_id');
  else if (!provider || !nonEmpty(provider.public_name)) add('UNRESOLVED_PROVIDER', 'primary_provider_id');
  if (!Array.isArray(record.provider_relationships)) add('MISSING_REQUIRED_FIELD', 'provider_relationships');
  else {
    for (const rel of record.provider_relationships) {
      const ok = isPlainObject(rel) && rel.basis === 'explicit' && rel.approved === true
        && nonEmpty(rel.relationship_type) && C.ID_PATTERNS.provider.test(rel.provider_id)
        && env.providers.has(rel.provider_id);
      if (!ok) add('UNAPPROVED_PROVIDER_RELATIONSHIP', 'provider_relationships');
    }
  }

  if (record.publication_readiness !== C.READY_FOR_PROJECTION) add('PUBLICATION_NOT_READY', 'publication_readiness');
  if (!C.CURRENTNESS_VALUES.includes(record.currentness_condition)) add('INVALID_CURRENTNESS', 'currentness_condition');
  // Temporal checks use an explicit assessment date supplied with the context;
  // the wall clock is never read.
  const today = env.assessmentDate;
  if (!isIsoDate(today)) add('ASSESSMENT_DATE_INVALID', 'assessment_date');

  // Governing decision.
  const decision = nonEmpty(record.decision_id) ? env.decisions.get(record.decision_id) : undefined;
  if (nonEmpty(record.decision_id) && !C.ID_PATTERNS.decision.test(record.decision_id)) add('NON_SYNTHETIC_ID', 'decision_id');
  if (!decision) add('NO_GOVERNING_DECISION', 'decision_id');
  else {
    if (!nonEmpty(rid) || decision.record_id !== rid) add('DECISION_RECORD_MISMATCH', 'decision_id');
    if (decision.public_safe_decision !== C.READY_FOR_PROJECTION) add('DECISION_NOT_PUBLIC_SAFE', 'decision_id');
  }
  const decisionEvidence = new Set(decision && Array.isArray(decision.evidence_refs) ? decision.evidence_refs : []);
  const decisionClaims = decision && Array.isArray(decision.approved_claims) ? decision.approved_claims : [];

  // Record-level evidence.
  const recordEvidence = Array.isArray(record.evidence_refs) ? record.evidence_refs : [];
  if (recordEvidence.length === 0) add('MISSING_EVIDENCE', 'evidence_refs');
  for (const id of recordEvidence) {
    if (!C.ID_PATTERNS.evidence.test(id)) { add('NON_SYNTHETIC_ID', 'evidence_refs'); continue; }
    const ev = env.evidence.get(id);
    if (!ev || !evidenceWellFormed(ev)) add('MISSING_EVIDENCE', 'evidence_refs');
    else if (decision && !decisionEvidence.has(id)) add('EVIDENCE_NOT_IN_DECISION', 'evidence_refs');
  }

  // Claims.
  const claims = Array.isArray(record.approved_claims) ? record.approved_claims : [];
  if (claims.length === 0) add('NO_APPROVED_CLAIMS', 'approved_claims');
  const byField = new Map();
  for (const claim of claims) {
    if (!isPlainObject(claim) || !nonEmpty(claim.field)) { add('MALFORMED_CLAIM', 'approved_claims'); continue; }
    const field = claim.field;
    if (!C.CLAIM_FIELDS.includes(field)) {
      add(C.FORBIDDEN_KEY_PATTERN.test(field) ? 'PRIVATE_FIELD_PRESENT' : 'UNEXPECTED_CLAIM_FIELD', safeKey(field));
      continue;
    }
    for (const key of Object.keys(claim).sort()) {
      if (!C.CLAIM_KEYS.includes(key)) {
        add(C.FORBIDDEN_KEY_PATTERN.test(key) ? 'PRIVATE_FIELD_PRESENT' : 'UNEXPECTED_CLAIM_KEY', safeKey(key));
      }
    }
    if (byField.has(field)) { add('DUPLICATE_CLAIM', field); continue; }
    byField.set(field, claim);
    const consequential = C.CONSEQUENTIAL_FIELDS.includes(field);

    if (!nonEmpty(claim.value) || claim.value.length > 500) { add('INVALID_CLAIM_VALUE', field); continue; }
    if (leaksValue(claim.value)) add('PRIVATE_VALUE_LEAK', field);
    if (C.URL_FIELDS.includes(field) && checkPublicUrl(claim.value)) add('UNSAFE_URL', field);
    if (C.DATE_FIELDS.includes(field) && !isIsoDate(claim.value)) add('INVALID_DATE', field);

    if (!decisionClaims.some((d) => isPlainObject(d) && d.field === field && d.value === claim.value)) {
      add(consequential ? 'INFERRED_CONSEQUENTIAL_CLAIM' : 'CLAIM_NOT_APPROVED', field);
    }

    const refs = Array.isArray(claim.evidence_refs) ? claim.evidence_refs : [];
    if (refs.length === 0) { add('MISSING_EVIDENCE', field); continue; }
    let covered = false;
    for (const id of refs) {
      if (!C.ID_PATTERNS.evidence.test(id)) { add('NON_SYNTHETIC_ID', field); continue; }
      const ev = env.evidence.get(id);
      if (!ev || !evidenceWellFormed(ev) || !recordEvidence.includes(id)) { add('MISSING_EVIDENCE', field); continue; }
      // Explicit record-level binding; gateway/parent evidence never counts for a child.
      if (ev.record_id !== rid) add('EVIDENCE_RECORD_MISMATCH', field);
      else if (isIsoDate(today) && ev.checked_at > today) add('EVIDENCE_DATE_IN_FUTURE', field);
      else if (ev.usable_for_public_claim !== true) add('EVIDENCE_NOT_USABLE', field);
      else if (scopeCovers(ev, field, claim.value)) covered = true;
    }
    if (!covered && !errors.some((e) => e.field === field && /^(MISSING_EVIDENCE|EVIDENCE_)/.test(e.code))) {
      add('EVIDENCE_SCOPE_MISMATCH', field);
    }
  }
  if (byField.has('start_date') && byField.has('end_date')
    && isIsoDate(byField.get('start_date').value) && isIsoDate(byField.get('end_date').value)
    && byField.get('start_date').value > byField.get('end_date').value) add('INVALID_DATE_ORDER', 'start_date');

  // Currentness versus actionability. Actionable means "can be acted on now".
  const status = byField.get('actionability');
  const actionableFields = [];
  if (status && ACTIONABLE(status.value)) actionableFields.push(status);
  if (byField.has('action_url')) actionableFields.push(byField.get('action_url'));
  if (actionableFields.length > 0) {
    if (record.currentness_condition === C.CURRENTNESS.UNKNOWN) add('UNKNOWN_CURRENTNESS_ACTIONABLE', 'actionability');
    if (record.currentness_condition === C.CURRENTNESS.CLOSED) add('CLOSED_PROJECTED_AS_ACTIONABLE', 'actionability');
    if (record.currentness_condition === C.CURRENTNESS.CURRENT) {
      // A Current actionable claim cannot carry a deadline or end date already past.
      for (const f of ['deadline', 'end_date']) {
        const c = byField.get(f);
        if (c && isIsoDate(c.value) && isIsoDate(today) && c.value < today) add('DEADLINE_PAST_FOR_CURRENT_ACTIONABLE', f);
      }
      for (const claim of actionableFields) {
        for (const id of Array.isArray(claim.evidence_refs) ? claim.evidence_refs : []) {
          const ev = env.evidence.get(id);
          if (ev && ev.currentness !== C.CURRENTNESS.CURRENT) add('ACTIONABLE_EVIDENCE_NOT_CURRENT', claim.field);
        }
      }
    }
  }
  return errors;
}

function ACTIONABLE(value) {
  return !C.NON_ACTIONABLE_STATUSES.has(norm(value));
}

// Last line of defence on the projected object itself.
export function validateProjectionOutput(projection) {
  const errors = [];
  const add = (code, field) => errors.push({ code, field });
  if (!isPlainObject(projection)) return [{ code: 'OUTPUT_NOT_OBJECT', field: 'projection' }];
  for (const key of Object.keys(projection).sort()) {
    if (!C.PUBLIC_OUTPUT_FIELDS.includes(key)) {
      add(C.FORBIDDEN_KEY_PATTERN.test(key) ? 'PRIVATE_FIELD_IN_OUTPUT' : 'UNEXPECTED_OUTPUT_FIELD', safeKey(key));
      continue;
    }
    const value = projection[key];
    if (!nonEmpty(value)) { add('EMPTY_OUTPUT_FIELD', key); continue; }
    if (key !== 'stable_resource_id' && leaksValue(value)) add('PRIVATE_VALUE_IN_OUTPUT', key);
    if (C.URL_FIELDS.includes(key) && checkPublicUrl(value)) add('UNSAFE_URL', key);
  }
  for (const key of C.REQUIRED_OUTPUT_FIELDS) {
    if (!nonEmpty(projection[key])) add('MISSING_OUTPUT_FIELD', key);
  }
  return errors;
}
