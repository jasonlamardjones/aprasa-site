import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function validHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
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

export function loadPacket(packetPath) {
  return JSON.parse(fs.readFileSync(packetPath, 'utf8'));
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
    'source_url', 'source_type', 'checked_at', 'publication_state',
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
  if (event.source_url && !validHttpUrl(event.source_url)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.source_url must be an HTTP(S) URL', 'event.source_url', 'RECEIVED'));
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
  if (control.dry_run !== true) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'Phase 1 accepts dry_run=true only', 'control.dry_run: true', 'RECEIVED'));
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
  if (media.source_url != null && !validHttpUrl(media.source_url)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'media.source_url must be null or an HTTP(S) URL', 'media.source_url', 'RECEIVED'));
  }
  if (media.local_asset != null && (typeof media.local_asset !== 'string' || media.local_asset.length === 0)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'media.local_asset must be null or a non-empty path', 'media.local_asset', 'RECEIVED'));
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
  if (checkRepository && media.local_asset) {
    const assetPath = path.resolve(root, media.local_asset);
    if (!assetPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
      issues.push(issue('BLOCKED_MEDIA', 'Project 04', `Local media asset does not exist: ${media.local_asset}`, 'Valid existing local asset', 'READY_FOR_IMPLEMENTATION'));
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
    `things-to-do/${id}/index.html`,
    `pt/things-to-do/${id}/index.html`,
    'sitemap.xml'
  ];
  if (packet.media.local_asset) files.push(packet.media.local_asset);
  if (packet.localization.pt_status === 'approved') files.push('data/locales/<approved-additive-delta>.source.json');
  return files;
}
