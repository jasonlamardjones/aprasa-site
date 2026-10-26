// P05-E2P v0.1-R1 N2: SYNTHETIC CONTRACT TEST HARNESS ONLY.
// Not a Project 05 importer, deployed adapter, approval service, or publication pipeline.
// Pure synchronous functions: no filesystem, network, process, or production imports.
import { createHash } from 'node:crypto';

export const CONTRACT_VERSION = 'P05-E2P v0.1-R1';
export const DISPOSITION = 'non_public_pilot_only';
export const LOCALE_STATUS = 'en_source_approved_pt_pending_project09';
const FAMILIES = new Set(['evergreen_learning_resource', 'institutional_provider_program_catalog', 'practical_business_support_tool']);
const STATES = new Set(['Current', 'Revalidation Due', 'Closed / Expired', 'Currentness Unknown']);
const ALLOWED_MANIFEST = new Set(['contract_version', 'export_id', 'projection_version', 'records']);
const REQUIRED_INPUT = [
  'contract_version', 'export_id', 'projection_version', 'stable_resource_id', 'site_slug',
  'primary_provider_id', 'provider_relationships', 'record_family', 'evidence_refs',
  'decision_id', 'approved_claims', 'publication_readiness', 'currentness_condition',
  'last_verified', 'last_reviewed', 'next_review_trigger', 'project03_disposition',
  'locale_status', 'public_values',
];
const ALLOWED_INPUT = new Set([...REQUIRED_INPUT, 'material_conflict']);
const PUBLIC_VALUES = new Set([
  'title_en', 'summary_en', 'provider_name', 'source_url', 'checked_at',
  'action_url', 'actionability', 'location_scope', 'delivery_mode', 'cost_status',
  'eligibility_summary', 'deadline', 'start_date', 'end_date',
  'credential_or_support', 'public_caveat', 'media_ref',
]);
const REQUIRED_CLAIMS = ['title_en', 'summary_en', 'source_url'];
const RELATIONSHIP_FIELDS = new Set(['relationship_id', 'record_id', 'provider_id', 'role', 'related_provider_id', 'evidence_ref']);
const ID = /^SYN-[A-Z0-9-]+$/;
const SLUG = /^synthetic-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const val of Object.values(v)) deepFreeze(val);
    Object.freeze(v);
  }
  return v;
};

// Intentionally code-owned oracle, INDEPENDENT of the editable synthetic-fixtures.json.
// Nothing here claims actual Project 05 evidence, authority, source checking or public approval.
// Every allowed title, summary, URL and optional claim is VALUE-BINDED to this oracle.
const ORACLE = deepFreeze({
  'SYN-LEARN-01': {
    provider: 'SYN-PROV-LEARN', family: 'evergreen_learning_resource',
    decision: 'SYN-DEC-LEARN', evidence: ['SYN-EV-LEARN'], state: 'Current', readiness: 'Public-Safe Approved',
    values: {title_en: 'Synthetic business-learning platform', summary_en: 'Synthetic catalog of practical learning resources.', provider_name: 'Synthetic Learning Provider', source_url: 'https://learning.example.invalid/catalog', checked_at: '2026-10-20', action_url: 'https://learning.example.invalid/start', cost_status: 'Free'},
  },
  'SYN-SKILLS-02': {
    provider: 'SYN-PROV-SKILLS', family: 'evergreen_learning_resource',
    decision: 'SYN-DEC-SKILLS', evidence: ['SYN-EV-SKILLS'], state: 'Current', readiness: 'Public-Safe Approved',
    values: {title_en: 'Synthetic digital-skills platform', summary_en: 'Synthetic skills modules; credentials have separate requirements.', provider_name: 'Synthetic Skills Provider', source_url: 'https://skills.example.invalid/about', checked_at: '2026-10-20', action_url: 'https://skills.example.invalid/learn', credential_or_support: 'Qualifications vary by individual module.'},
  },
  'SYN-HUB-03': {
    provider: 'SYN-PROV-HUB', family: 'institutional_provider_program_catalog',
    decision: 'SYN-DEC-HUB', evidence: ['SYN-EV-HUB'], state: 'Current', readiness: 'Public-Safe Approved',
    values: {title_en: 'Synthetic course hub', summary_en: 'Synthetic central hub; child-course availability is not established.', provider_name: 'Synthetic Hub Provider', source_url: 'https://hub.example.invalid/info', checked_at: '2026-10-20', action_url: 'https://hub.example.invalid/catalog'},
  },
  'SYN-GATE-04': {
    provider: 'SYN-PROV-GATE', family: 'institutional_provider_program_catalog',
    decision: 'SYN-DEC-GATE', evidence: ['SYN-EV-GATE'], state: 'Current', readiness: 'Public-Safe Approved',
    values: {title_en: 'Synthetic local training gateway', summary_en: 'Synthetic institutional gateway; specific cohort deadlines are unverified.', provider_name: 'Synthetic Gateway Provider', source_url: 'https://gateway.example.invalid/training', checked_at: '2026-10-20', action_url: 'https://gateway.example.invalid/offerings', location_scope: 'Synthetic locality'},
  },
  'SYN-BIZ-05': {
    provider: 'SYN-PROV-BIZ', family: 'practical_business_support_tool',
    decision: 'SYN-DEC-BIZ', evidence: ['SYN-EV-BIZ'], state: 'Current', readiness: 'Public-Safe Approved',
    values: {title_en: 'Synthetic business-support navigation', summary_en: 'Synthetic service directory; financing eligibility is not established.', provider_name: 'Synthetic Business Provider', source_url: 'https://business.example.invalid/services', checked_at: '2026-10-20', action_url: 'https://business.example.invalid/service-desk'},
  },
  'SYN-HOLD-06': {
    provider: 'SYN-PROV-HELD', family: 'evergreen_learning_resource',
    decision: 'SYN-DEC-HELD', evidence: ['SYN-EV-HELD'], state: 'Current', readiness: 'Held',
    values: {title_en: 'Synthetic access-restricted platform', summary_en: 'Synthetic candidate with unresolved access restrictions.', provider_name: 'Synthetic Restricted Provider', source_url: 'https://restricted.example.invalid/info', checked_at: '2026-10-20'},
  },
  'SYN-UNKNOWN-07': {
    provider: 'SYN-PROV-UNKNOWN', family: 'institutional_provider_program_catalog',
    decision: 'SYN-DEC-UNKNOWN', evidence: ['SYN-EV-UNKNOWN'], state: 'Currentness Unknown', readiness: 'Held', material_conflict: true,
    values: {title_en: 'Synthetic unconfirmed provider', summary_en: 'Synthetic identity requiring direct-source verification.', provider_name: 'Synthetic Unconfirmed Provider', source_url: 'https://unknown.example.invalid/info', checked_at: '2026-10-20'},
  },
  'SYN-EXPIRED-08': {
    provider: 'SYN-PROV-EXPIRED', family: 'institutional_provider_program_catalog',
    decision: 'SYN-DEC-EXPIRED', evidence: ['SYN-EV-EXPIRED'], state: 'Closed / Expired', readiness: 'Held',
    values: {title_en: 'Synthetic closed application', summary_en: 'Synthetic opportunity with a closed application window.', provider_name: 'Synthetic Closed Provider', source_url: 'https://expired.example.invalid/history', checked_at: '2026-10-20'},
  },
});

// Synthetic-only explicit relationship witness. Normal five positives use [].
const RELATIONSHIP_ORACLE = deepFreeze({
  'SYN-REL-GATE-OPERATOR': {
    relationship_id: 'SYN-REL-GATE-OPERATOR', record_id: 'SYN-GATE-04',
    provider_id: 'SYN-PROV-GATE', role: 'operator',
    related_provider_id: 'SYN-PROV-GATE-OP', evidence_ref: 'SYN-REL-EVIDENCE-GATE',
  },
});

export class ContractError extends Error {
  constructor(code, detail = '') {
    super(`${code}${detail ? ': ' + detail : ''}`);
    this.name = 'ContractError';
    this.code = code;
  }
}
const fail = (code, detail) => { throw new ContractError(code, detail); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, label) => { if (typeof v !== 'string' || !v.trim()) fail('BAD_VALUE', label); };
function onlyKeys(value, allowed, label) {
  if (!object(value)) fail('BAD_SHAPE', label);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('UNEXPECTED_FIELD', `${label}.${key}`);
}
function exactIsoDate(value, label) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) fail('INVALID_DATE', label);
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) fail('INVALID_DATE', label);
}
function https(value, label) {
  text(value, label);
  let url;
  try { url = new URL(value); } catch { fail('INVALID_URL', label); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) fail('INVALID_URL', label);
}
// Explicit UTF-16 lexicographic ordering; no localeCompare or environment locale dependency.
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (object(v)) return `{${Object.keys(v).sort(compare).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const fingerprint = (v) => createHash('sha256').update(stable(v), 'utf8').digest('hex');

export function verifySyntheticRelationships(recordId, providerId, relationships) {
  if (!Array.isArray(relationships)) fail('BAD_RELATIONSHIPS', recordId);
  const used = new Set();
  const cleaned = [];
  for (const rel of relationships) {
    onlyKeys(rel, RELATIONSHIP_FIELDS, 'provider_relationship');
    if (Object.keys(rel).length !== RELATIONSHIP_FIELDS.size) fail('RELATIONSHIP_INCOMPLETE', recordId);
    const approved = RELATIONSHIP_ORACLE[rel.relationship_id];
    if (!approved || rel.record_id !== recordId || rel.provider_id !== providerId ||
      Object.keys(approved).some(k => rel[k] !== approved[k])) fail('UNVERIFIED_RELATIONSHIP', recordId);
    if (used.has(rel.relationship_id)) fail('DUPLICATE_RELATIONSHIP', recordId);
    used.add(rel.relationship_id);
    cleaned.push({...approved});
  }
  return cleaned.sort((a,b) => compare(a.relationship_id,b.relationship_id));
}

// Conservative non-public screening only; not Project 03's final public state mapping.
export function classifyCurrentness(currentness, readiness, conflict = false) {
  if (conflict) return {status:'HOLD', reason:'MATERIAL_CONFLICT'};
  if (currentness === 'Closed / Expired') return {status:'SUPPRESS', reason:'EXPIRED_NOT_ACTIONABLE'};
  if (readiness === 'Held') return {status:'HOLD', reason:'PUBLICATION_HELD'};
  if (currentness === 'Currentness Unknown') return {status:'HOLD', reason:'ACTIONABILITY_UNKNOWN'};
  if (currentness === 'Revalidation Due') return {status:'HOLD', reason:'REVALIDATION_PENDING'};
  if (currentness !== 'Current' || readiness !== 'Public-Safe Approved') return {status:'HOLD', reason:'NOT_PUBLIC_SAFE'};
  return null;
}

function screenOne(rec, batch) {
  onlyKeys(rec, ALLOWED_INPUT, 'record');
  for (const key of REQUIRED_INPUT) if (!Object.hasOwn(rec, key)) fail('MISSING_KEY', key);
  if (!ID.test(rec.stable_resource_id)) fail('INVALID_ID', String(rec.stable_resource_id));
  const expected = ORACLE[rec.stable_resource_id];
  if (!expected) fail('UNTRUSTED_SYNTHETIC_ID', rec.stable_resource_id);
  if (!SLUG.test(rec.site_slug)) fail('INVALID_SLUG', rec.stable_resource_id);
  for (const key of ['contract_version', 'export_id', 'projection_version']) if (rec[key] !== batch[key]) fail('VERSION_OR_BATCH_MISMATCH', key);
  if (rec.primary_provider_id !== expected.provider) fail('UNRESOLVED_PROVIDER', rec.stable_resource_id);
  if (!FAMILIES.has(rec.record_family) || rec.record_family !== expected.family) fail('UNAPPROVED_FAMILY', rec.stable_resource_id);
  if (rec.decision_id !== expected.decision) fail('UNTRUSTED_DECISION', rec.stable_resource_id);
  if (!Array.isArray(rec.evidence_refs) || rec.evidence_refs.length !== expected.evidence.length ||
    rec.evidence_refs.some((id, i) => id !== expected.evidence[i])) fail('CLAIM_EVIDENCE_SCOPE', rec.stable_resource_id);
  if (rec.project03_disposition !== DISPOSITION || rec.locale_status !== LOCALE_STATUS) fail('AUTHORITY_OR_LOCALE_NOT_ALLOWED', rec.stable_resource_id);
  if (!STATES.has(rec.currentness_condition) || rec.currentness_condition !== expected.state || rec.publication_readiness !== expected.readiness) fail('UNTRUSTED_CURRENTNESS', rec.stable_resource_id);
  if (rec.last_verified !== '2026-10-20' || rec.last_reviewed !== '2026-10-20') fail('UNTRUSTED_CHECK_DATE', rec.stable_resource_id);
  if (rec.next_review_trigger !== 'synthetic scheduled review') fail('UNTRUSTED_REVIEW_TRIGGER', rec.stable_resource_id);
  if (rec.material_conflict !== undefined && typeof rec.material_conflict !== 'boolean') fail('BAD_CONFLICT_FLAG', rec.stable_resource_id);
  verifySyntheticRelationships(rec.stable_resource_id, rec.primary_provider_id, rec.provider_relationships);
  onlyKeys(rec.public_values, PUBLIC_VALUES, 'public_values');
  if (!Array.isArray(rec.approved_claims) || new Set(rec.approved_claims).size !== rec.approved_claims.length) fail('DUPLICATE_OR_MISSING_CLAIMS', rec.stable_resource_id);
  for (const k of Object.keys(rec.public_values)) {
    if (!Object.hasOwn(expected.values, k) || rec.public_values[k] !== expected.values[k]) fail('UNSUPPORTED_CLAIM_VALUE', `${rec.stable_resource_id}.${k}`);
    if (k === 'action_url' || k === 'source_url') https(rec.public_values[k], k);
    if (k.endsWith('_date') || k === 'checked_at') exactIsoDate(rec.public_values[k], k);
    if (k !== 'checked_at' && !rec.approved_claims.includes(k)) fail('CLAIM_SCOPE_MISMATCH', `${rec.stable_resource_id}.${k}`);
  }
  for (const claim of rec.approved_claims) {
    if (!PUBLIC_VALUES.has(claim) || claim === 'checked_at' || !Object.hasOwn(expected.values, claim) || !Object.hasOwn(rec.public_values, claim)) fail('CLAIM_SCOPE_MISMATCH', `${rec.stable_resource_id}.${claim}`);
  }
  for (const required of [...REQUIRED_CLAIMS, 'checked_at']) if (!Object.hasOwn(rec.public_values, required)) fail('MISSING_REQUIRED_CLAIM', `${rec.stable_resource_id}.${required}`);
  if (rec.public_values.checked_at !== rec.last_verified) fail('CHECKED_AT_MISMATCH', rec.stable_resource_id);

  // Negative controls contain no public preview: only id/outcome/reason.
  const stateResult = classifyCurrentness(rec.currentness_condition, rec.publication_readiness, expected.material_conflict || rec.material_conflict === true);
  if (stateResult) return {id:rec.stable_resource_id, ...stateResult};
  // No private manifest fields or records from the workbook are returned.
  const preview = {stable_resource_id:rec.stable_resource_id, site_slug:rec.site_slug};
  for (const key of Object.keys(rec.public_values).sort(compare)) preview[key] = rec.public_values[key];
  return {id:rec.stable_resource_id, status:'CONTRACT_CANDIDATE', preview};
}

export function screenSyntheticBatch(batch, { expectedDigest } = {}) {
  onlyKeys(batch, ALLOWED_MANIFEST, 'batch');
  if (batch.contract_version !== CONTRACT_VERSION || batch.projection_version !== 'SYN-N2-1') fail('VERSION_MISMATCH');
  text(batch.export_id, 'export_id');
  if (!batch.export_id.startsWith('SYN-')) fail('UNTRUSTED_EXPORT_ID');
  if (!Array.isArray(batch.records)) fail('INVALID_RECORDS');
  const ids = new Set(), slugs = new Set();
  for (const rec of batch.records) {
    if (!object(rec)) fail('BAD_RECORD');
    if (ids.has(rec.stable_resource_id)) fail('DUPLICATE_STABLE_ID');
    if (slugs.has(rec.site_slug)) fail('DUPLICATE_SLUG');
    ids.add(rec.stable_resource_id); slugs.add(rec.site_slug);
  }
  const results = batch.records.map(rec => screenOne(rec, batch)).sort((a,b) => compare(a.id,b.id));
  const report = {schema:'aprasa.synthetic-e2p-n2.screening.v1', contract_version:CONTRACT_VERSION,
    production_authorized:false, locale_approved_pt:false, results};
  const digest = fingerprint(report); // Diff guard ONLY, not a signature, trust anchor or approval.
  if (expectedDigest !== undefined && (typeof expectedDigest !== 'string' || expectedDigest !== digest)) fail('UNEXPECTED_DIFF');
  return {report, digest};
}
