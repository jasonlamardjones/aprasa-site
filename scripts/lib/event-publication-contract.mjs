import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THINGS_TO_DO_HUB_PUBLIC } from './things-to-do-collection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DETAIL = /^things-to-do\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const PUBLICATION_STATES = new Set(['draft', 'published', 'expired', 'withdrawn']);
const MEDIA_POLICIES = new Set(['required', 'fallback_allowed']);
const PT_STATUSES = new Set(['approved', 'approval_required', 'not_required']);
const APPROVAL_STATUSES = new Set(['approved', 'approval_required']);
const PROJECT09_STATUSES = new Set(['approved', 'approval_required', 'not_required']);
const MEDIA_STATUSES = new Set(['approved', 'review_required', 'not_required']);
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EVENT_MEDIA_ASSET = /^assets\/events\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:avif|jpe?g|png|webp)$/;

function issue(code, owner, reason, requiredInput, resumeFrom) {
  return { code, owner, reason, required_input: requiredInput, resume_from: resumeFrom };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value) {
  if (!DATE.test(value ?? '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validDateTime(value) {
  return DATETIME.test(value ?? '') && validDate(value.slice(0, 10)) && !Number.isNaN(Date.parse(value));
}

// Semantic HTTP(S) URL check, shared by every publication entrypoint (packet
// preflight, writer boundary, canonical validator, generator, media validator).
// It asks the platform URL parser, then rejects the forms the WHATWG parser
// silently repairs, because a public record must already hold the exact string
// it will serve: embedded whitespace/control characters and backslashes (stripped
// or rewritten), a missing "//" after the scheme, an empty authority such as
// "https:///x" (the host moves to "x"), and userinfo.
function validHttpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
  if (/[\s\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (value.slice(value.indexOf('//') + 2).startsWith('/')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

// --- Record-scoped evidence source union (Project 03, Project 04 handoff) ----
//
// Every Things-to-Do record names its public source with a verified HTTP(S)
// source_url (mode A). Project 03 approved exactly ONE exception, for exactly
// TWO event ids: source_url null plus a typed source_reference that points at
// restricted Project 25 evidence (mode B). The union is exclusive and
// fail-closed: mixed, absent, mismatched, unsupported or out-of-scope shapes
// are all rejected, and mode B never carries a public action.
//
// This repository is PUBLIC. A source_reference holds ONE opaque, governed
// evidence handle (evidence_ref) that identifies the event's Project 25 evidence
// record, which contains both the original flyer and the dated founder
// attestation. It must never hold an attachment id, a Drive/Docs locator, a URL,
// a hash, a restricted record id or attestation content, so the value is also
// screened against those shapes. The attestation date stays in the restricted
// Project 25 register, not here.
//
// The handle for each approved event is the event's own id (Project 25,
// independently verified). The allowlist below is explicit and immutable, and a
// record's evidence_ref must equal ITS OWN approved handle exactly.
export const SOURCE_REFERENCE_EVIDENCE_HANDLES = Object.freeze({
  'kutumbaia-edicao-03-2026': 'kutumbaia-edicao-03-2026',
  'manxi-liliane-reis-exhibition-2026': 'manxi-liliane-reis-exhibition-2026'
});
export const SOURCE_REFERENCE_EVENT_IDS = Object.freeze(Object.keys(SOURCE_REFERENCE_EVIDENCE_HANDLES));
const SOURCE_REFERENCE_KEYS = ['version', 'kind', 'evidence_ref'];
const SOURCE_REFERENCE_LEAKS = [
  [/https?:\/\//i, 'a URL'],
  [/(?:^|[^a-z])(?:drive|docs)\.google\./i, 'a Drive/Docs locator'],
  [/file_[0-9a-f]{32}/i, 'an attachment id'],
  [/[0-9a-f]{64}/i, 'a SHA-256 value'],
  [/@/, 'an email address'],
  [/[\\/]/, 'a path'],
  [/\s/, 'whitespace']
];

/**
 * Screens one candidate public string for evidence-locator shapes.
 * Returns the label of the first forbidden shape, or null.
 */
export function evidenceLeakShape(value) {
  if (typeof value !== 'string') return null;
  for (const [pattern, label] of SOURCE_REFERENCE_LEAKS) {
    if (pattern.test(value)) return label;
  }
  return null;
}

/**
 * Validates a record's source union. Returns human-readable problem strings
 * (empty when valid), without a record label so each caller can add its own.
 */
export function validateSourceUnion(record) {
  const problems = [];
  const hasUrl = typeof record?.source_url === 'string' && record.source_url !== '';
  const hasRef = record?.source_reference !== undefined;
  const scoped = Object.hasOwn(SOURCE_REFERENCE_EVIDENCE_HANDLES, record?.id);

  // Whenever card_action is an object it must name a destination: present,
  // non-empty and a semantically valid HTTP(S) URL.
  if (isObject(record?.card_action) && (typeof record.card_action.url !== 'string' || !validHttpUrl(record.card_action.url))) {
    problems.push('card_action.url must be a valid HTTP(S) URL');
  }

  if (!hasRef) {
    if (!hasUrl) problems.push('missing source_url');
    else if (!validHttpUrl(record.source_url)) problems.push('source_url must be an HTTP(S) URL');
    else if (scoped) problems.push('source_url is not permitted for this record; it requires a governed source_reference');
    return problems;
  }

  if (hasUrl) problems.push('source_url and source_reference are mutually exclusive');
  else if (record.source_url !== null) problems.push('source_reference requires source_url to be null');
  if (!scoped) problems.push('source_reference is only permitted for the two Project 03 approved event ids');

  const ref = record.source_reference;
  if (!isObject(ref)) {
    problems.push('source_reference must be an object');
    return problems;
  }
  const unknownKeys = Object.keys(ref).filter((key) => !SOURCE_REFERENCE_KEYS.includes(key));
  if (unknownKeys.length) problems.push(`source_reference has unsupported field(s): ${unknownKeys.join(', ')}`);
  if (ref.version !== 1) problems.push('source_reference.version must equal 1');
  if (ref.kind !== 'restricted-evidence') problems.push('source_reference.kind must be "restricted-evidence"');

  const value = ref.evidence_ref;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    problems.push('source_reference.evidence_ref must be a non-empty governed handle (128 characters or fewer)');
  } else {
    const leak = evidenceLeakShape(value);
    if (leak) problems.push(`source_reference.evidence_ref must not contain ${leak}`);
    else if (!scoped) problems.push('source_reference.evidence_ref has no approved handle for this record');
    else if (value !== SOURCE_REFERENCE_EVIDENCE_HANDLES[record.id]) problems.push('source_reference.evidence_ref must equal the approved evidence handle of this record');
  }

  // Restricted evidence is never a public destination.
  if (record.card_action != null) problems.push('a source_reference record must not carry a card_action (NO_CTA)');
  if (record.detail?.action_label != null) problems.push('a source_reference record must set detail.action_label to null (NO_CTA)');
  return problems;
}

// --- Public-input boundary ---------------------------------------------------
//
// The writer copies packet.event, packet.media.approved_manifest and the
// approved locale package into PUBLIC repository JSON. An open object there is a
// privacy escape: any extra field (an attachment id, a hash, a restricted
// record id, a Drive/Docs locator) would ride along. These explicit shapes list
// every field an incumbent record legitimately carries; anything else is
// REJECTED, never silently kept or dropped. The JSON schema in
// automation/things-to-do/event-publication-packet.schema.json states the same
// shapes, and scripts/test-things-to-do-event-schema.mjs executes it against
// this validator so the two cannot drift.
const leaf = (...types) => ({ types });
const obj = (fields, { nullable = false } = {}) => ({ fields, nullable });
const arr = (item) => ({ item });
const STR = leaf('string');
const STR_NULL = leaf('string', 'null');
const NUM = leaf('number');
const NUM_OR_NULL = leaf('number', 'null');
const BOOL_NULL = leaf('boolean', 'null');

export const PUBLIC_EVENT_SHAPE = obj({
  id: STR, kind: STR, title: STR, provider: STR, summary: STR, category: STR,
  location: obj({ name: STR, locality: STR, street: STR }),
  source_url: STR_NULL,
  source_reference: obj({ version: NUM, kind: STR, evidence_ref: STR }),
  source_type: STR, start_date: STR_NULL, start_datetime: STR_NULL, end_date: STR_NULL, end_datetime: STR_NULL,
  end_month: STR_NULL, end_precision: STR, checked_at: STR, publication_state: STR, media_policy: STR,
  media_manifest_title: STR, detail_page: STR, free_admission: BOOL_NULL, currentness_note: STR,
  display: obj({ status: STR, meta: STR, checked: STR }),
  media: obj({ asset: STR, alt: STR, width: NUM, height: NUM }, { nullable: true }),
  card_action: obj({ label: STR, url: STR }, { nullable: true }),
  detail: obj({
    facts: arr(obj({ label: STR, value: STR, value_html: STR })),
    body: STR, good_to_know: STR_NULL, checked: STR, action_label: STR_NULL
  }),
  seo: obj({ description: STR, title: STR, schema_type: STR })
});
export const PUBLIC_MANIFEST_SHAPE = obj({
  section: STR, title: STR, provider: STR, source_url: STR_NULL, media_type: STR, media_state: STR,
  media_source: STR_NULL, media_asset: STR_NULL, fallback_category: STR, fallback_reason: STR_NULL,
  media_provenance: STR, media_asset_source_url: STR_NULL, media_checked_date: STR_NULL, media_alt: STR_NULL,
  media_width: NUM_OR_NULL, media_height: NUM_OR_NULL
});
const APPROVED_PACKAGE_KEYS = ['package_id', 'source_revision', 'project_09_status', 'rows'];
const LOCALE_ROW_KEYS = ['key', 'source_revision', 'source_en', 'pt', 'scope_status', 'identity_policy', 'context_notes', 'record_id', 'linguistic_notes', 'translation_status'];
// Narrow screen for restricted-evidence shapes in any value bound for a public
// file. It is deliberately not a general scanner: ordinary copy and ordinary
// public URLs do not match any of these. A bare SHA-256 is screened everywhere
// except the media_provenance text of a manifest row, which may cite the hash of
// the approved public asset (and only that hash; see validatePublicInputShapes).
const PUBLIC_VALUE_LEAKS = [
  [/file_[0-9a-f]{32}/i, 'an attachment id'],
  [/(?:^|[^a-z])(?:drive|docs)\.google\./i, 'a Drive/Docs locator'],
  [/P25-EV-\d+/i, 'a restricted evidence record id']
];
const PUBLIC_VALUE_HASH_LEAK = [/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i, 'a SHA-256 value'];
const PUBLIC_VALUE_HASH_LEAK_GLOBAL = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi;

function publicValueLeak(value, { hash = true } = {}) {
  if (typeof value !== 'string') return null;
  for (const [pattern, label] of hash ? [...PUBLIC_VALUE_LEAKS, PUBLIC_VALUE_HASH_LEAK] : PUBLIC_VALUE_LEAKS) {
    if (pattern.test(value)) return label;
  }
  return null;
}

// A rejected key name is never echoed if it is itself a restricted shape.
const safeKey = (key) => (publicValueLeak(key) ? '<redacted>' : key);

function checkShape(value, spec, pointer, problems) {
  if (spec.types) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!spec.types.includes(actual)) problems.push(`${pointer} must be ${spec.types.join(' or ')}`);
    return;
  }
  if (spec.item) {
    if (!Array.isArray(value)) { problems.push(`${pointer} must be an array`); return; }
    value.forEach((item, index) => checkShape(item, spec.item, `${pointer}[${index}]`, problems));
    return;
  }
  if (value === null && spec.nullable) return;
  if (!isObject(value)) { problems.push(`${pointer} must be ${spec.nullable ? 'an object or null' : 'an object'}`); return; }
  for (const [key, child] of Object.entries(value)) {
    if (!Object.hasOwn(spec.fields, key)) problems.push(`${pointer}.${safeKey(key)} is not an allowed public field`);
    else checkShape(child, spec.fields[key], `${pointer}.${key}`, problems);
  }
}

function walkStrings(value, pointer, problems, options) {
  if (typeof value === 'string') {
    const leak = publicValueLeak(value, options);
    if (leak) problems.push(`${pointer} must not contain ${leak}`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${pointer}[${index}]`, problems, options));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) walkStrings(child, `${pointer}.${safeKey(key)}`, problems, options);
  }
}

/**
 * Validates every packet structure that is copied into public repository files:
 * the event, the approved media-manifest record and the approved locale package.
 * Returns problem strings (empty when admissible).
 */
export function validatePublicInputShapes(packet) {
  const problems = [];
  const event = packet?.event;
  if (isObject(event)) {
    checkShape(event, PUBLIC_EVENT_SHAPE, 'event', problems);
    for (const [index, fact] of (Array.isArray(event.detail?.facts) ? event.detail.facts : []).entries()) {
      if (!isObject(fact)) continue;
      if (typeof fact.label !== 'string') problems.push(`event.detail.facts[${index}].label is required`);
      if ((fact.value === undefined) === (fact.value_html === undefined)) {
        problems.push(`event.detail.facts[${index}] must carry exactly one of value or value_html`);
      }
    }
    walkStrings(event, 'event', problems);
  }
  const manifest = packet?.media?.approved_manifest;
  if (manifest !== undefined) {
    checkShape(manifest, PUBLIC_MANIFEST_SHAPE, 'media.approved_manifest', problems);
    for (const field of ['source_url', 'media_asset_source_url']) {
      if (isObject(manifest) && typeof manifest[field] === 'string' && !validHttpUrl(manifest[field])) {
        problems.push(`media.approved_manifest.${field} must be null or a valid HTTP(S) URL`);
      }
    }
    // media_provenance may cite the hash of the approved PUBLIC asset and no other
    // hash: an unrestricted 64-hex string could be a restricted evidence hash.
    // That hash is permitted only when a public asset really exists
    // (media.local_asset) and the packet's media.asset_sha256 names it. A fallback
    // record has no asset, so it may cite no hash at all. Real-write preflight
    // (validatePacket with checkRepository) and the writer both compare
    // asset_sha256 with the asset's actual bytes before anything is promoted.
    if (isObject(manifest)) {
      const { media_provenance: provenance, ...rest } = manifest;
      walkStrings(rest, 'media.approved_manifest', problems);
      walkStrings(provenance, 'media.approved_manifest.media_provenance', problems, { hash: false });
      const hasPublicAsset = typeof packet?.media?.local_asset === 'string' && packet.media.local_asset.length > 0;
      const approvedAssetHash = hasPublicAsset && SHA256.test(packet?.media?.asset_sha256 ?? '') ? packet.media.asset_sha256 : null;
      const cited = typeof provenance === 'string' ? provenance.match(PUBLIC_VALUE_HASH_LEAK_GLOBAL) ?? [] : [];
      if (cited.some((hash) => hash.toLowerCase() !== approvedAssetHash)) {
        problems.push('media.approved_manifest.media_provenance may cite only the SHA-256 of the approved public asset (media.local_asset with its media.asset_sha256)');
      }
    } else {
      walkStrings(manifest, 'media.approved_manifest', problems);
    }
  }
  const approved = packet?.localization?.approved_package;
  if (approved !== undefined) {
    if (!isObject(approved)) {
      problems.push('localization.approved_package must be an object');
    } else {
      for (const key of Object.keys(approved)) {
        if (!APPROVED_PACKAGE_KEYS.includes(key)) problems.push(`localization.approved_package.${safeKey(key)} is not an allowed public field`);
      }
      for (const [index, row] of (Array.isArray(approved.rows) ? approved.rows : []).entries()) {
        if (!isObject(row)) continue;
        for (const key of Object.keys(row)) {
          if (!LOCALE_ROW_KEYS.includes(key)) problems.push(`localization.approved_package.rows[${index}].${safeKey(key)} is not an allowed public field`);
        }
        for (const key of LOCALE_ROW_KEYS) {
          if (typeof row[key] !== 'string') problems.push(`localization.approved_package.rows[${index}].${key} must be a string`);
        }
      }
      walkStrings(approved, 'localization.approved_package', problems);
    }
  }
  return problems;
}

/** Throws when the packet holds anything the writer must not copy into public files. */
export function assertPublicInputBoundary(packet) {
  const problems = validatePublicInputShapes(packet);
  if (isObject(packet?.event)) problems.push(...validateSourceUnion(packet.event).map((problem) => `event: ${problem}`));
  if (problems.length) throw new Error(`PUBLIC_INPUT_BOUNDARY: ${problems.join('; ')}`);
}

function slugifyFactLabel(label = '') {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function requiredPtKeys(event) {
  if (!event?.id) return [];
  const prefix = `event.${event.id}`;
  const keys = [
    `${prefix}.title`,
    `${prefix}.summary`,
    `${prefix}.display.status`,
    `${prefix}.display.meta`,
    `${prefix}.display.checked`,
    `${prefix}.detail.body`,
    `${prefix}.detail.checked`,
    `${prefix}.seo.description`,
    `${prefix}.seo.title`
  ];
  if (event.media) keys.push(`${prefix}.media.alt`);
  if (event.card_action) keys.push(`${prefix}.card_action.label`);
  if (event.detail?.good_to_know) keys.push(`${prefix}.detail.good_to_know`);
  if (event.detail?.action_label) keys.push(`${prefix}.detail.action_label`);
  for (const fact of event.detail?.facts ?? []) {
    const base = slugifyFactLabel(fact.label);
    keys.push(`${prefix}.detail.fact.${base}.label`);
    keys.push(`${prefix}.detail.fact.${base}.value_display`);
  }
  return keys;
}

export function requiredLocaleRows(event) {
  if (!event?.id) return new Map();
  const prefix = `event.${event.id}`;
  const rows = new Map([
    [`${prefix}.title`, event.title],
    [`${prefix}.summary`, event.summary],
    [`${prefix}.display.status`, event.display?.status],
    [`${prefix}.display.meta`, event.display?.meta],
    [`${prefix}.display.checked`, event.display?.checked],
    [`${prefix}.detail.body`, event.detail?.body],
    [`${prefix}.detail.checked`, event.detail?.checked],
    [`${prefix}.seo.description`, event.seo?.description],
    [`${prefix}.seo.title`, event.seo?.title]
  ]);
  if (event.media) rows.set(`${prefix}.media.alt`, event.media.alt);
  if (event.card_action) rows.set(`${prefix}.card_action.label`, event.card_action.label);
  if (event.detail?.good_to_know) rows.set(`${prefix}.detail.good_to_know`, event.detail.good_to_know);
  if (event.detail?.action_label) rows.set(`${prefix}.detail.action_label`, event.detail.action_label);
  for (const fact of event.detail?.facts ?? []) {
    const base = slugifyFactLabel(fact.label);
    rows.set(`${prefix}.detail.fact.${base}.label`, fact.label);
    rows.set(`${prefix}.detail.fact.${base}.value_display`, fact.value);
  }
  return rows;
}

export function loadPacket(packetPath) {
  return JSON.parse(fs.readFileSync(packetPath, 'utf8'));
}

// --- Ephemeral working-tree teardown (issue #100) ---------------------------
//
// Every temp root this module and its callers tear down (trusted dry-run
// proof dirs, real-write staging copies, promotion backups, throwaway test
// repositories) is deleted immediately after heavy synchronous churn: many
// git invocations and generator/validator subprocesses writing and rewriting
// files through spawnSync, which blocks until each child has fully exited.
// An audit of that synchronous call graph found no lingering
// process/handle/resource-ownership defect that would explain a repeat
// ENOTEMPTY/EBUSY/EPERM here -- but non-discovery is not proof of
// impossibility. The remaining working hypothesis is a short OS/filesystem
// timing race on the removal call itself, occasionally observing the
// directory mid-settle right after that churn.
//
// This retries only that narrow, named set of transient codes, a bounded
// number of times, with a real (non-busy-spinning) synchronous delay between
// attempts. Any other error -- and a transient error that outlives the
// retry budget -- is rethrown immediately: this hardens the transient class
// without hiding an unrelated or persistent failure, so it stays fail-closed
// and is not a blanket retry-everything workaround for the historical flake.
const TRANSIENT_TEARDOWN_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function removeTempTree(root, {
  rm = (target) => fs.rmSync(target, { recursive: true, force: true }),
  retries = 5,
  delayMs = 100,
  sleep = sleepSync
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rm(root);
      return;
    } catch (error) {
      if (!TRANSIENT_TEARDOWN_CODES.has(error.code) || attempt >= retries) throw error;
      sleep(delayMs);
    }
  }
}

export function mediaIntakeRoot(root = ROOT) {
  return path.join(root, '.git', 'aprasa-media-intake');
}

// --- Media gate exit semantics ----------------------------------------------
//
// internal/publishing-media-convention.md defines three outcomes for
// scripts/validate-card-media.mjs, and only one of them is an error:
//
//   0  publication media gate PASSED
//   2  structurally valid, but unresolved media work remains -- the branch is
//      "not media-complete for merge"
//   1  structural validation FAILED
//
// 2 is a DOMAIN STATE, not an execution failure. The generic subprocess helpers
// on this path collapsed every non-zero status into "<script> failed (N)",
// which made a documented open gate indistinguishable from a crashed validator
// and took down publication preparation entirely.
//
// This narrows that: exit 2 FROM THIS ONE SCRIPT is recognized and carried
// forward as state. It is deliberately not a general "tolerate non-zero" rule
// -- every other script, and every other exit code from this one, stays fatal.
//
// The gate is not weakened. The convention scopes exit 2 to merge readiness,
// and nothing on this path merges: preparation still terminates at
// FOUNDER_APPROVAL_REQUIRED with merge_allowed false. Recognizing the state
// makes it visible to the approver instead of crashing before they see it.
export const MEDIA_GATE_SCRIPT = 'scripts/validate-card-media.mjs';
export const MEDIA_GATE_OPEN_EXIT = 2;

export const MEDIA_GATE_OPEN = 'OPEN';
export const MEDIA_GATE_PASSED = 'PASSED';

/**
 * True only for the exact media validator reporting the exact open-gate exit.
 *
 * Strictly numeric: a string "2" is a status nobody should be producing, and
 * treating it as the recognized state would let a stringified or coerced exit
 * code silently bypass a fatal path. Every other script, and every other code
 * from this one, is false here and therefore fatal to the caller.
 */
export function isMediaGateOpen(script, status) {
  return script === MEDIA_GATE_SCRIPT
    && typeof status === 'number'
    && status === MEDIA_GATE_OPEN_EXIT;
}

/**
 * The outcome of one validation step, modelled explicitly.
 *
 * Storing only the step NAME is what let an open gate be reported as "N
 * validators passed": a name carries no status, so exit 2 was indistinguishable
 * from exit 0 once the step list was built. Callers record these instead, and
 * every publication artifact derives its media-gate state from them rather than
 * from a count.
 */
export function validationOutcome(script, args, status) {
  const step = [script, ...args].join(' ');
  const mediaGateOpen = isMediaGateOpen(script, status);
  return Object.freeze({
    step,
    status,
    media_gate_open: mediaGateOpen,
    // "passed" means exit 0. An open media gate is structurally valid but is
    // NOT a pass, and must never be counted as one.
    passed: status === 0
  });
}

/** OPEN when any recorded outcome reports the media gate open. */
export function mediaGateStateFrom(outcomes) {
  return (outcomes ?? []).some((outcome) => outcome.media_gate_open)
    ? MEDIA_GATE_OPEN
    : MEDIA_GATE_PASSED;
}

/** One-line founder-facing explanation of the gate state. */
export function mediaGateSummary(state) {
  return state === MEDIA_GATE_OPEN
    ? 'OPEN — unresolved media records remain; the branch is not media-complete for merge'
    : 'PASSED — no temporary or pending-ingestion media records remain';
}

export function dryRunValidationCommands(packet) {
  return [
    ['scripts/validate-things-to-do-events.mjs'],
    ['scripts/generate-things-to-do.mjs', `--as-of=${packet.control.as_of}`, '--write'],
    ['scripts/generate-things-to-do.mjs', `--as-of=${packet.control.as_of}`, '--locale=pt', '--write'],
    ['scripts/build-sitemap.mjs', '--write'],
    ['scripts/validate-things-to-do-currentness.mjs', `--as-of=${packet.control.as_of}`],
    ['scripts/validate-things-to-do-surface-equivalence.mjs', `--as-of=${packet.control.as_of}`],
    ['scripts/validate-things-to-do-sitemap.mjs'],
    ['scripts/validate-card-media.mjs'],
    ['scripts/validate-pt-home-events.mjs']
  ];
}

export function expectedDryRunChangedFiles(packet, { root = ROOT } = {}) {
  const id = packet.event.id;
  const files = [
    'data/things-to-do-events.json',
    'internal/provider-media-manifest.json',
    'data/locales/locale-data.generated.json',
    'index.html',
    'pt/index.html',
    'sitemap.xml',
    // The Things-to-Do collection hub. Publishing a record changes the full
    // eligible collection, so a full both-locale generator run rewrites both
    // hub surfaces alongside Home. They are generator-owned output of the same
    // canonical data, not a widening of what a packet may author.
    //
    // Expected only while the hub is published. It is temporarily unpublished
    // (THINGS_TO_DO_HUB_PUBLIC in ./things-to-do-collection.mjs), so the
    // generator emits neither surface and a publication that listed them would
    // fail its own changed-file scope check for files that can never change.
    ...(THINGS_TO_DO_HUB_PUBLIC ? ['things-to-do/index.html', 'pt/things-to-do/index.html'] : []),
    `things-to-do/${id}/index.html`,
    `pt/things-to-do/${id}/index.html`
  ];
  const currentness = JSON.parse(fs.readFileSync(path.join(root, 'data', 'things-to-do-currentness.json'), 'utf8'));
  if (currentness.as_of !== packet.control.as_of) files.push('data/things-to-do-currentness.json');
  if (packet.media.supplied_asset) files.push(packet.media.local_asset);
  return files.sort();
}

export function validatePacket(packet, { root = ROOT, checkRepository = true } = {}) {
  const issues = [];

  if (!isObject(packet)) {
    return {
      ok: false,
      state: 'INVALID_INPUT',
      issues: [issue('INVALID_INPUT', 'Project 04', 'Packet must be a JSON object', 'Structured publication packet', 'RECEIVED')]
    };
  }

  const requiredSections = ['event', 'localization', 'media', 'governance', 'control'];
  for (const section of requiredSections) {
    if (!isObject(packet[section])) {
      issues.push(issue('INVALID_INPUT', 'Project 04', `${section} must be an object`, section, 'RECEIVED'));
    }
  }
  for (const problem of validatePublicInputShapes(packet)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', problem, 'Remove unsupported or restricted fields from the public packet structures', 'RECEIVED'));
  }
  const unknownSections = Object.keys(packet).filter((key) => !['contract_version', ...requiredSections].includes(key));
  if (unknownSections.length) {
    issues.push(issue('INVALID_INPUT', 'Project 04', `Unknown top-level field(s): ${unknownSections.join(', ')}`, 'Remove unsupported fields', 'RECEIVED'));
  }

  if (packet?.contract_version !== 1) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'contract_version must equal 1', 'contract_version: 1', 'RECEIVED'));
  }

  const event = packet?.event ?? {};
  const requiredEventFields = [
    'id', 'kind', 'title', 'provider', 'summary', 'category', 'location',
    'source_type', 'checked_at', 'publication_state',
    'media_policy', 'media_manifest_title', 'detail_page', 'display', 'detail', 'seo'
  ];
  for (const field of requiredEventFields) {
    const value = event[field];
    if (value == null || value === '') {
      issues.push(issue('INVALID_INPUT', 'Project 04', `event.${field} is required`, `event.${field}`, 'RECEIVED'));
    }
  }

  if (event.id && !ID.test(event.id)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.id must be a lowercase slug', 'event.id', 'RECEIVED'));
  }
  if (event.kind && event.kind !== 'dated-event') {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.kind must be dated-event', 'event.kind', 'RECEIVED'));
  }
  if (event.detail_page && !DETAIL.test(event.detail_page)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.detail_page must match things-to-do/<slug>/', 'event.detail_page', 'RECEIVED'));
  }
  if (event.checked_at && !validDate(event.checked_at)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.checked_at must be a real YYYY-MM-DD date', 'event.checked_at', 'RECEIVED'));
  }
  for (const field of ['location', 'display', 'detail', 'seo']) {
    if (event[field] != null && !isObject(event[field])) {
      issues.push(issue('INVALID_INPUT', 'Project 04', `event.${field} must be an object`, `event.${field}`, 'RECEIVED'));
    }
  }
  for (const field of ['start_date', 'end_date']) {
    if (event[field] && !validDate(event[field])) {
      issues.push(issue('INVALID_INPUT', 'Project 04', `event.${field} must be a real YYYY-MM-DD date`, `event.${field}`, 'RECEIVED'));
    }
  }
  for (const field of ['start_datetime', 'end_datetime']) {
    if (event[field] != null && !validDateTime(event[field])) {
      issues.push(issue('INVALID_INPUT', 'Project 04', `event.${field} must be an ISO 8601 datetime with an explicit timezone`, `event.${field}`, 'RECEIVED'));
    }
  }
  if (!event.start_date && !event.start_datetime) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'A dated event requires start_date or start_datetime', 'Approved event start date/time', 'RECEIVED'));
  }
  const startDay = event.start_date ?? event.start_datetime?.slice(0, 10);
  if (startDay && event.end_date && event.end_date < startDay) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.end_date cannot precede event.start_date', 'event.end_date', 'RECEIVED'));
  }
  if (event.start_datetime && event.end_datetime && Date.parse(event.end_datetime) < Date.parse(event.start_datetime)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.end_datetime cannot precede event.start_datetime', 'event.end_datetime', 'RECEIVED'));
  }
  for (const problem of validateSourceUnion(event)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', `event: ${problem}`, 'event.source_url / event.source_reference', 'RECEIVED'));
  }
  if (event.id && event.detail_page && event.detail_page !== `things-to-do/${event.id}/`) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.detail_page must be derived from event.id', `things-to-do/${event.id}/`, 'RECEIVED'));
  }
  if (event.publication_state && !PUBLICATION_STATES.has(event.publication_state)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.publication_state is invalid', 'event.publication_state', 'RECEIVED'));
  }
  if (event.media_policy && !MEDIA_POLICIES.has(event.media_policy)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.media_policy is invalid', 'event.media_policy', 'RECEIVED'));
  }

  const control = packet?.control ?? {};
  const realWrite = control.real_write === true;
  if (realWrite) {
    if (control.dry_run !== false || control.allow_branch !== true || control.allow_commit !== true || control.allow_pr !== true) {
      issues.push(issue('INVALID_INPUT', 'Project 04', 'Real-write authorization requires dry_run=false and explicit branch/commit/PR permission', 'Authorized real-write control block', 'RECEIVED'));
    }
    if (!COMMIT_SHA.test(control.expected_main_sha ?? '')) {
      issues.push(issue('INVALID_INPUT', 'Project 04', 'Real-write authorization requires an exact expected_main_sha', '40-character main commit SHA', 'RECEIVED'));
    }
  } else {
    if (control.dry_run !== true || control.real_write === true) {
      issues.push(issue('INVALID_INPUT', 'Project 04', 'Dry-run packets require dry_run=true and no real-write authorization', 'Dry-run control block', 'RECEIVED'));
    }
    if (control.allow_commit === true || control.allow_pr === true) {
      issues.push(issue('INVALID_INPUT', 'Project 04', 'Dry-run packets cannot authorize commits or PR creation', 'allow_commit=false and allow_pr=false', 'RECEIVED'));
    }
  }
  if (!validDate(control.as_of)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'control.as_of must be a real YYYY-MM-DD date', 'control.as_of', 'RECEIVED'));
  }
  if (control.merge_allowed !== false) {
    issues.push(issue('INVALID_INPUT', 'Founder', 'merge_allowed must remain false in Phase 1', 'control.merge_allowed: false', 'RECEIVED'));
  }
  for (const field of ['allow_branch', 'allow_commit', 'allow_pr']) {
    if (typeof control[field] !== 'boolean') {
      issues.push(issue('INVALID_INPUT', 'Project 04', `control.${field} must be boolean`, `control.${field}`, 'RECEIVED'));
    }
  }

  const governance = packet?.governance ?? {};
  if (typeof governance.publication_authorized !== 'boolean') {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'governance.publication_authorized must be boolean', 'governance.publication_authorized', 'RECEIVED'));
  }
  if (!APPROVAL_STATUSES.has(governance.project03_status)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'governance.project03_status is invalid', 'governance.project03_status', 'RECEIVED'));
  }
  if (!PROJECT09_STATUSES.has(governance.project09_status)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'governance.project09_status is invalid', 'governance.project09_status', 'RECEIVED'));
  }
  if (!MEDIA_STATUSES.has(governance.media_status)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'governance.media_status is invalid', 'governance.media_status', 'RECEIVED'));
  }
  if (governance.publication_authorized !== true || governance.project03_status !== 'approved') {
    issues.push(issue('BLOCKED_OWNER_APPROVAL', 'Project 03 / owning Project', 'Publication/factual approval is not complete', 'Approved publication packet', 'GOVERNANCE_CHECKED'));
  }

  const localization = packet?.localization ?? {};
  if (!PT_STATUSES.has(localization.pt_status) || typeof localization.new_strings_required !== 'boolean' || !isObject(localization.pt_values)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'localization state is malformed', 'pt_status, new_strings_required, and pt_values', 'RECEIVED'));
  }
  if (localization.new_strings_required === true || localization.pt_status === 'approval_required' || governance.project09_status === 'approval_required') {
    issues.push(issue('BLOCKED_LOCALIZATION', 'Project 09', 'Approved Portuguese presentation is incomplete', 'Approved PT values for all required new event keys', 'GOVERNANCE_CHECKED'));
  }
  if (localization.pt_status === 'approved') {
    const ptValues = localization.pt_values ?? {};
    const missingKeys = requiredPtKeys(event).filter((key) => typeof ptValues[key] !== 'string' || ptValues[key].length === 0);
    if (missingKeys.length) {
      issues.push(issue('BLOCKED_LOCALIZATION', 'Project 09', `Approved Portuguese packet is missing ${missingKeys.length} required key(s)`, missingKeys.join(', '), 'GOVERNANCE_CHECKED'));
    }
  }

  const media = packet?.media ?? {};
  for (const field of ['rights_status', 'alt_status']) {
    if (!MEDIA_STATUSES.has(media[field])) {
      issues.push(issue('INVALID_INPUT', 'Project 04', `media.${field} is invalid`, `media.${field}`, 'RECEIVED'));
    }
  }
  if (realWrite) {
    const approvedPackage = localization.approved_package;
    if (!isObject(approvedPackage)
      || typeof approvedPackage.package_id !== 'string'
      || typeof approvedPackage.source_revision !== 'string'
      || approvedPackage.project_09_status !== 'approved'
      || !Array.isArray(approvedPackage.rows)) {
      issues.push(issue('BLOCKED_LOCALIZATION', 'Project 09', 'Real-write mode requires the complete approved additive locale package', 'Project 09 approved_package with governed rows', 'GOVERNANCE_CHECKED'));
    } else {
      const expectedRows = requiredLocaleRows(event);
      const seenRows = new Set();
      for (const row of approvedPackage.rows) {
        const requiredFields = ['key', 'source_revision', 'source_en', 'pt', 'scope_status', 'identity_policy', 'context_notes', 'record_id', 'linguistic_notes', 'translation_status'];
        if (!isObject(row) || requiredFields.some((field) => typeof row[field] !== 'string')) {
          issues.push(issue('INVALID_INPUT', 'Project 04', 'Approved locale package contains a malformed row', 'Complete governed locale row metadata', 'RECEIVED'));
          continue;
        }
        if (seenRows.has(row.key)) {
          issues.push(issue('INVALID_INPUT', 'Project 04', `Approved locale package duplicates ${row.key}`, 'Unique additive locale keys', 'RECEIVED'));
        }
        seenRows.add(row.key);
        if (!expectedRows.has(row.key) || row.source_en !== expectedRows.get(row.key)) {
          issues.push(issue('INVALID_INPUT', 'Project 04', `Approved locale row does not match canonical EN presentation: ${row.key}`, 'Matching approved event and locale package', 'RECEIVED'));
        }
        if (row.pt !== localization.pt_values?.[row.key] || row.pt.length === 0) {
          issues.push(issue('BLOCKED_LOCALIZATION', 'Project 09', `Approved PT value mismatch for ${row.key}`, 'Matching approved PT value and locale row', 'GOVERNANCE_CHECKED'));
        }
        if (row.source_revision !== approvedPackage.source_revision || row.record_id !== event.id || row.translation_status !== 'APPROVED') {
          issues.push(issue('BLOCKED_LOCALIZATION', 'Project 09', `Locale governance metadata is not approved for ${row.key}`, 'Approved source revision, record id, and translation status', 'GOVERNANCE_CHECKED'));
        }
        if (!['REQUIRED_FOR_PT_LAUNCH', 'INTENTIONALLY_UNCHANGED'].includes(row.scope_status)) {
          issues.push(issue('INVALID_INPUT', 'Project 04', `Invalid locale scope for ${row.key}`, 'Governed scope_status', 'RECEIVED'));
        }
      }
      const missingRows = [...expectedRows.keys()].filter((key) => !seenRows.has(key));
      const extraRows = [...seenRows].filter((key) => !expectedRows.has(key));
      if (missingRows.length || extraRows.length) {
        issues.push(issue('BLOCKED_LOCALIZATION', 'Project 09', 'Approved locale package does not exactly cover the event presentation contract', [...missingRows, ...extraRows].join(', '), 'GOVERNANCE_CHECKED'));
      }
    }
  }
  if (media.source_url != null && !validHttpUrl(media.source_url)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'media.source_url must be null or an HTTP(S) URL', 'media.source_url', 'RECEIVED'));
  }
  if (media.local_asset != null && (typeof media.local_asset !== 'string' || media.local_asset.length === 0)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'media.local_asset must be null or a non-empty path', 'media.local_asset', 'RECEIVED'));
  }
  if (media.local_asset && !EVENT_MEDIA_ASSET.test(media.local_asset)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'media.local_asset must use the canonical assets/events image path policy', 'assets/events/<safe-name>.<avif|jpg|jpeg|png|webp>', 'RECEIVED'));
  }
  if (media.supplied_asset != null && (typeof media.supplied_asset !== 'string' || !path.isAbsolute(media.supplied_asset) || !SHA256.test(media.asset_sha256 ?? ''))) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'A supplied media asset requires an absolute path and approved SHA-256', 'media.supplied_asset + media.asset_sha256', 'RECEIVED'));
  }
  if (media.supplied_asset && media.local_asset) {
    const destinationStem = path.basename(media.local_asset, path.extname(media.local_asset));
    if (destinationStem !== event.id) {
      issues.push(issue('INVALID_INPUT', 'Project 04', 'New supplied media must use an event-derived destination filename', `assets/events/${event.id}.<approved-image-extension>`, 'RECEIVED'));
    }
  }
  const mediaBlocked = governance.media_status === 'review_required' || media.rights_status === 'review_required' || media.alt_status === 'review_required';
  if (mediaBlocked) {
    issues.push(issue('BLOCKED_MEDIA', 'Owning Project / Project 09 as applicable', 'Media rights or alt-text approval remains unresolved', 'Approved media disposition and alt text', 'GOVERNANCE_CHECKED'));
  }

  if (event.media_policy === 'required' && (!event.media || !media.local_asset)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'Required media needs canonical event.media and a local asset path', 'event.media + media.local_asset', 'RECEIVED'));
  }
  if (event.media?.asset && media.local_asset && event.media.asset !== media.local_asset) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.media.asset and media.local_asset must identify the same canonical asset', 'Matching media paths', 'RECEIVED'));
  }
  if (realWrite) {
    if (media.local_asset && !SHA256.test(media.asset_sha256 ?? '')) {
      issues.push(issue('BLOCKED_MEDIA', 'Owning Project', 'Real-write mode requires the approved media asset SHA-256', 'media.asset_sha256', 'GOVERNANCE_CHECKED'));
    }
    const approvedManifest = media.approved_manifest;
    const manifestFields = [
      'section', 'title', 'provider', 'source_url', 'media_type', 'media_state',
      'media_source', 'media_asset', 'fallback_category', 'fallback_reason',
      'media_provenance', 'media_asset_source_url', 'media_checked_date', 'media_alt'
    ];
    const manifestMatches = isObject(approvedManifest)
      && manifestFields.every((field) => Object.hasOwn(approvedManifest, field))
      && approvedManifest.section === 'things-to-do'
      && approvedManifest.title === event.media_manifest_title
      && approvedManifest.provider === event.provider
      && approvedManifest.source_url === event.source_url
      && !Object.hasOwn(approvedManifest, 'source_reference')
      && approvedManifest.media_asset === (event.media?.asset ?? null)
      && approvedManifest.media_alt === (event.media?.alt ?? '')
      && (!event.media || (approvedManifest.media_width === event.media.width && approvedManifest.media_height === event.media.height));
    if (!manifestMatches) {
      issues.push(issue('BLOCKED_MEDIA', 'Owning Project / Project 09 as applicable', 'Real-write mode requires a complete approved media-manifest record matching the event', 'media.approved_manifest', 'GOVERNANCE_CHECKED'));
    }
  }
  if (checkRepository && media.local_asset) {
    const assetPath = path.resolve(root, media.local_asset);
    const suppliedPath = media.supplied_asset ?? null;
    const eventAssetsRoot = fs.realpathSync(path.join(root, 'assets', 'events'));
    const assetParent = fs.realpathSync(path.dirname(assetPath));
    const destinationContained = assetParent === eventAssetsRoot
      && assetPath.startsWith(`${eventAssetsRoot}${path.sep}`)
      && (!fs.existsSync(assetPath) || !fs.lstatSync(assetPath).isSymbolicLink());
    const localExists = destinationContained && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile();
    let suppliedExists = false;
    if (suppliedPath) {
      const intake = mediaIntakeRoot(root);
      if (fs.existsSync(intake) && fs.existsSync(suppliedPath)) {
        const realIntake = fs.realpathSync(intake);
        const realSupplied = fs.realpathSync(suppliedPath);
        suppliedExists = realSupplied.startsWith(`${realIntake}${path.sep}`)
          && fs.statSync(realSupplied).isFile()
          && !fs.lstatSync(suppliedPath).isSymbolicLink();
      }
    }
    if (!destinationContained || (!localExists && !suppliedExists)) {
      issues.push(issue('BLOCKED_MEDIA', 'Project 04', `Local media asset does not exist: ${media.local_asset}`, 'Valid existing local asset', 'READY_FOR_IMPLEMENTATION'));
    }
    if (suppliedPath && localExists) {
      issues.push(issue('BLOCKED_MEDIA', 'Project 04', `Supplied media target already exists: ${media.local_asset}`, 'A new collision-free canonical asset destination', 'READY_FOR_IMPLEMENTATION'));
    }
    const verifiedPath = localExists ? assetPath : (suppliedExists ? fs.realpathSync(suppliedPath) : null);
    if (realWrite && verifiedPath && SHA256.test(media.asset_sha256 ?? '')) {
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(verifiedPath)).digest('hex');
      if (actualHash !== media.asset_sha256) {
        issues.push(issue('BLOCKED_MEDIA', 'Project 04', 'Approved media SHA-256 does not match supplied bytes', 'Correct approved media asset', 'READY_FOR_IMPLEMENTATION'));
      }
    }
  }

  if (checkRepository && event.id && event.detail_page) {
    const canonical = JSON.parse(fs.readFileSync(path.join(root, 'data', 'things-to-do-events.json'), 'utf8'));
    const idCollision = canonical.records.some((record) => record.id === event.id);
    const routeCollision = canonical.records.some((record) => record.detail_page === event.detail_page);
    if (idCollision || routeCollision) {
      issues.push(issue('INVALID_INPUT', 'Project 04', 'Packet collides with an existing canonical event id/detail route', 'A new unique event id/detail_page', 'RECEIVED'));
    }
  }

  const priority = ['INVALID_INPUT', 'BLOCKED_OWNER_APPROVAL', 'BLOCKED_LOCALIZATION', 'BLOCKED_MEDIA'];
  const primary = priority.map((code) => issues.find((item) => item.code === code)).find(Boolean) ?? null;

  return {
    ok: issues.length === 0,
    state: primary?.code ?? 'READY_FOR_IMPLEMENTATION',
    issues
  };
}

export function expectedChangedFiles(packet) {
  const id = packet.event.id;
  const files = [
    'data/things-to-do-events.json',
    'internal/provider-media-manifest.json',
    'index.html',
    'pt/index.html',
    // See expectedDryRunChangedFiles: a full generator run reconciles both
    // collection-hub surfaces along with Home — while the hub is published.
    ...(THINGS_TO_DO_HUB_PUBLIC ? ['things-to-do/index.html', 'pt/things-to-do/index.html'] : []),
    `things-to-do/${id}/index.html`,
    `pt/things-to-do/${id}/index.html`,
    'sitemap.xml'
  ];
  if (packet.media.supplied_asset) files.push(packet.media.local_asset);
  if (packet.localization.pt_status === 'approved') files.push(`data/locales/pt-overlay-event-${id}.source.json`);
  if (packet.control.real_write === true) {
    files.push('data/locales/locale-data.generated.json');
    files.push(`automation/things-to-do/runs/${id}.json`);
    files.push(`automation/things-to-do/runs/${id}.md`);
  }
  return files;
}
