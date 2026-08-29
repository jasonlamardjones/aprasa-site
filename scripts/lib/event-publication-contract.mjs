import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DETAIL = /^things-to-do\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const PUBLICATION_STATES = new Set(['draft', 'published', 'expired', 'withdrawn']);
const MEDIA_POLICIES = new Set(['required', 'fallback_allowed']);

function issue(code, owner, reason, requiredInput, resumeFrom) {
  return { code, owner, reason, required_input: requiredInput, resume_from: resumeFrom };
}

export function loadPacket(packetPath) {
  return JSON.parse(fs.readFileSync(packetPath, 'utf8'));
}

export function validatePacket(packet, { root = ROOT, checkRepository = true } = {}) {
  const issues = [];

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
  if (event.checked_at && !DATE.test(event.checked_at)) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.checked_at must be YYYY-MM-DD', 'event.checked_at', 'RECEIVED'));
  }
  for (const field of ['start_date', 'end_date']) {
    if (event[field] && !DATE.test(event[field])) {
      issues.push(issue('INVALID_INPUT', 'Project 04', `event.${field} must be YYYY-MM-DD`, `event.${field}`, 'RECEIVED'));
    }
  }
  if (event.start_date && event.end_date && event.end_date < event.start_date) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'event.end_date cannot precede event.start_date', 'event.end_date', 'RECEIVED'));
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
  if (!DATE.test(control.as_of ?? '')) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'control.as_of must be YYYY-MM-DD', 'control.as_of', 'RECEIVED'));
  }
  if (control.merge_allowed !== false) {
    issues.push(issue('INVALID_INPUT', 'Founder', 'merge_allowed must remain false in Phase 1', 'control.merge_allowed: false', 'RECEIVED'));
  }

  const governance = packet?.governance ?? {};
  if (governance.publication_authorized !== true || governance.project03_status !== 'approved') {
    issues.push(issue('BLOCKED_OWNER_APPROVAL', 'Project 03 / owning Project', 'Publication/factual approval is not complete', 'Approved publication packet', 'GOVERNANCE_CHECKED'));
  }

  const localization = packet?.localization ?? {};
  if (localization.new_strings_required === true || localization.pt_status === 'approval_required' || governance.project09_status === 'approval_required') {
    issues.push(issue('BLOCKED_LOCALIZATION', 'Project 09', 'Approved Portuguese presentation is incomplete', 'Approved PT values for all required new event keys', 'GOVERNANCE_CHECKED'));
  }
  if (localization.pt_status === 'approved' && Object.keys(localization.pt_values ?? {}).length === 0) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'pt_status=approved requires supplied approved PT values', 'localization.pt_values', 'RECEIVED'));
  }

  const media = packet?.media ?? {};
  const mediaBlocked = governance.media_status === 'review_required' || media.rights_status === 'review_required' || media.alt_status === 'review_required';
  if (mediaBlocked) {
    issues.push(issue('BLOCKED_MEDIA', 'Owning Project / Project 09 as applicable', 'Media rights or alt-text approval remains unresolved', 'Approved media disposition and alt text', 'GOVERNANCE_CHECKED'));
  }

  if (event.media_policy === 'required' && !media.local_asset) {
    issues.push(issue('INVALID_INPUT', 'Project 04', 'Required media needs a local asset path', 'media.local_asset', 'RECEIVED'));
  }
  if (checkRepository && media.local_asset) {
    const assetPath = path.resolve(root, media.local_asset);
    if (!assetPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(assetPath)) {
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
