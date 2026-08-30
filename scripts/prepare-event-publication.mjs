#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPacket, validatePacket } from './lib/event-publication-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packetArg = process.argv.find((arg) => arg.startsWith('--packet='));
const TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.txt', '.xml',
  '.yaml', '.yml'
]);

if (!packetArg) {
  console.error('Usage: node scripts/prepare-event-publication.mjs --packet=<path>');
  process.exit(2);
}

const packetPath = path.resolve(ROOT, packetArg.slice('--packet='.length));
const packet = loadPacket(packetPath);
const preflight = validatePacket(packet, { root: ROOT, checkRepository: true });

if (!preflight.ok) {
  const first = preflight.issues.find((item) => item.code === preflight.state) ?? preflight.issues[0];
  console.log([
    `EVENT: ${packet.event?.title ?? packet.event?.id ?? 'Unknown'}`,
    '',
    `STATUS: ${preflight.state}`,
    '',
    `OWNER: ${first.owner}`,
    `REASON: ${first.reason}`,
    `REQUIRED INPUT: ${first.required_input}`,
    `RESUME POINT: ${first.resume_from}`,
    '',
    'ACTION: RETURN TO OWNER / FIX INPUT'
  ].join('\n'));
  process.exit(1);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function insertHomeMarkers(file, id) {
  let html = fs.readFileSync(file, 'utf8');
  const begin = `<!-- BEGIN GENERATED EVENT: ${id} -->`;
  const end = `<!-- END GENERATED EVENT: ${id} -->`;
  if (html.includes(begin) || html.includes(end)) {
    throw new Error(`${path.relative(ROOT, file)} already contains markers for ${id}`);
  }
  const re = /<!-- END GENERATED EVENT: [a-z0-9]+(?:-[a-z0-9]+)* -->/g;
  const matches = [...html.matchAll(re)];
  if (!matches.length) throw new Error(`${path.relative(ROOT, file)} has no incumbent generated-event marker block`);
  const last = matches[matches.length - 1];
  const at = last.index + last[0].length;
  const insertion = `\n        ${begin}\n        ${end}`;
  html = html.slice(0, at) + insertion + html.slice(at);
  fs.writeFileSync(file, html);
}

function inventory(root) {
  const result = new Map();
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        const bytes = fs.readFileSync(full);
        const content = TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
          ? bytes.toString('utf8').replace(/\r\n/g, '\n')
          : bytes;
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        result.set(rel, hash);
      }
    }
  }
  visit(root);
  return result;
}

function normalizeTextEol(root) {
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const text = fs.readFileSync(full, 'utf8');
        const normalized = text.replace(/\r\n/g, '\n');
        if (normalized !== text) fs.writeFileSync(full, normalized);
      }
    }
  }
  visit(root);
}

function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

function run(tempRoot, script, args = []) {
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: tempRoot,
    encoding: 'utf8',
    env: process.env
  });
  if (proc.status !== 0) {
    const message = [proc.stdout, proc.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${script} failed (${proc.status})${message ? `:\n${message}` : ''}`);
  }
  return proc.stdout.trim();
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-event-publication-'));
const validations = [];

try {
  fs.cpSync(ROOT, tempRoot, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.git'
  });
  // Git may materialize CRLF on Windows, while incumbent generators emit LF.
  // Normalize only the isolated copy so changed-file checks stay semantic and
  // validators with repository-canonical LF assumptions behave consistently.
  normalizeTextEol(tempRoot);
  const before = inventory(tempRoot);

  const eventsPath = path.join(tempRoot, 'data', 'things-to-do-events.json');
  const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
  events.records.push(packet.event);
  writeJson(eventsPath, events);

  const manifestPath = path.join(tempRoot, 'internal', 'provider-media-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const media = packet.event.media;
  manifest.records.push({
    section: 'things-to-do',
    title: packet.event.media_manifest_title,
    provider: packet.event.provider,
    source_url: packet.event.source_url,
    media_type: media ? 'provider-supplied' : 'editorial-fallback',
    media_state: media ? 'authentic-present' : 'fallback-final',
    media_source: 'approved machine-readable publication packet',
    media_asset: media?.asset ?? null,
    fallback_category: `things-${packet.event.category}`,
    fallback_reason: media ? null : 'No canonical media supplied; fallback allowed by approved packet.',
    media_provenance: 'Dry-run record derived only from the approved publication packet; never committed by Phase 1 automation.',
    media_asset_source_url: packet.media.source_url,
    media_checked_date: packet.event.checked_at,
    media_alt: media?.alt ?? '',
    ...(media?.width ? { media_width: media.width } : {}),
    ...(media?.height ? { media_height: media.height } : {})
  });
  writeJson(manifestPath, manifest);

  const localePath = path.join(tempRoot, 'data', 'locales', 'locale-data.generated.json');
  const locale = JSON.parse(fs.readFileSync(localePath, 'utf8'));
  for (const [key, pt] of Object.entries(packet.localization.pt_values)) {
    locale.keys[key] = {
      key,
      en: '',
      pt,
      scope_status: 'REQUIRED_FOR_PT_LAUNCH',
      identity_policy: 'TRANSLATE_NORMALLY',
      record_id: packet.event.id,
      translation_status: 'APPROVED',
      source_revision: 'PHASE1_DRY_RUN_APPROVED_PACKET',
      context_notes: 'Ephemeral dry-run row from approved packet; not a governed locale source mutation.',
      linguistic_notes: ''
    };
  }
  writeJson(localePath, locale);

  const currentnessPath = path.join(tempRoot, 'data', 'things-to-do-currentness.json');
  const currentness = JSON.parse(fs.readFileSync(currentnessPath, 'utf8'));
  currentness.as_of = packet.control.as_of;
  writeJson(currentnessPath, currentness);

  insertHomeMarkers(path.join(tempRoot, 'index.html'), packet.event.id);
  insertHomeMarkers(path.join(tempRoot, 'pt', 'index.html'), packet.event.id);

  validations.push(run(tempRoot, 'scripts/validate-things-to-do-events.mjs'));
  validations.push(run(tempRoot, 'scripts/generate-things-to-do.mjs', [`--as-of=${packet.control.as_of}`, '--write']));
  validations.push(run(tempRoot, 'scripts/generate-things-to-do.mjs', [`--as-of=${packet.control.as_of}`, '--locale=pt', '--write']));
  validations.push(run(tempRoot, 'scripts/build-sitemap.mjs', ['--write']));
  validations.push(run(tempRoot, 'scripts/validate-things-to-do-currentness.mjs', [`--as-of=${packet.control.as_of}`]));
  validations.push(run(tempRoot, 'scripts/validate-things-to-do-surface-equivalence.mjs', [`--as-of=${packet.control.as_of}`]));
  validations.push(run(tempRoot, 'scripts/validate-things-to-do-sitemap.mjs'));
  validations.push(run(tempRoot, 'scripts/validate-card-media.mjs'));
  validations.push(run(tempRoot, 'scripts/validate-pt-home-events.mjs'));

  const after = inventory(tempRoot);
  const changed = changedFiles(before, after);
  const allowed = new Set([
    'data/things-to-do-events.json',
    'data/things-to-do-currentness.json',
    'internal/provider-media-manifest.json',
    'data/locales/locale-data.generated.json',
    'index.html',
    'pt/index.html',
    'sitemap.xml',
    `things-to-do/${packet.event.id}/index.html`,
    `pt/things-to-do/${packet.event.id}/index.html`
  ]);
  const unexpected = changed.filter((file) => !allowed.has(file));
  if (unexpected.length) {
    throw new Error(`Unexpected dry-run diff scope: ${unexpected.join(', ')}`);
  }

  console.log([
    `EVENT: ${packet.event.title}`,
    '',
    'STATUS: REVIEW_READY',
    '',
    'SOURCE: verified approved machine-readable packet',
    `AS OF: ${packet.control.as_of}`,
    'LOCALIZATION: approved; required PT keys present',
    'MEDIA: approved; local asset verified',
    'GOVERNANCE: publication authorized',
    `VALIDATION: ${validations.length} deterministic checks/generation stages passed`,
    'DIFF: bounded expected files only in isolated dry-run workspace',
    'CURRENTNESS: validated',
    '',
    'DRY-RUN CHANGED FILES:',
    ...changed.map((file) => `- ${file}`),
    '',
    'RISK: no production/repository mutation performed by this command',
    'ACTION: FOUNDER APPROVAL REQUIRED BEFORE ANY REAL COMMIT/PR/MERGE',
    'MERGE: NOT ALLOWED'
  ].join('\n'));
} catch (error) {
  console.log([
    `EVENT: ${packet.event.title}`,
    '',
    'STATUS: VALIDATION_FAILED',
    '',
    'OWNER: Project 04',
    `REASON: ${error.message}`,
    'REQUIRED INPUT: technical correction or validator resolution',
    'RESUME POINT: IMPLEMENTED'
  ].join('\n'));
  process.exitCode = 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
