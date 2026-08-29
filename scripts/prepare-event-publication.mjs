#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacket, validatePacket, expectedChangedFiles } from './lib/event-publication-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packetArg = process.argv.find((arg) => arg.startsWith('--packet='));

if (!packetArg) {
  console.error('Usage: node scripts/prepare-event-publication.mjs --packet=<path>');
  process.exit(2);
}

const packetPath = path.resolve(ROOT, packetArg.slice('--packet='.length));
const packet = loadPacket(packetPath);
const preflight = validatePacket(packet, { root: ROOT, checkRepository: true });

if (!preflight.ok) {
  const first = preflight.issues[0];
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

const files = expectedChangedFiles(packet);
console.log([
  `EVENT: ${packet.event.title}`,
  '',
  'STATUS: READY_FOR_IMPLEMENTATION',
  '',
  'SOURCE: approved machine-readable packet',
  `AS OF: ${packet.control.as_of}`,
  'LOCALIZATION: approved / no unresolved PT gate',
  'MEDIA: approved / local asset verified when supplied',
  'GOVERNANCE: publication authorized',
  '',
  'EXPECTED BOUNDED CHANGE SCOPE:',
  ...files.map((file) => `- ${file}`),
  '',
  'PHASE 1 MODE: DRY RUN ONLY',
  'MERGE: NOT ALLOWED',
  '',
  'NEXT AUTOMATION STATE: READY_FOR_IMPLEMENTATION',
  'FOUNDER ACTION: none until a generated/validated review candidate exists'
].join('\n'));
