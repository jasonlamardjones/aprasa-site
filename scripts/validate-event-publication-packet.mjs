#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacket, validatePacket } from './lib/event-publication-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packetArg = process.argv.find((arg) => arg.startsWith('--packet='));
const noRepoCheck = process.argv.includes('--no-repo-check');

if (!packetArg) {
  console.error('Usage: node scripts/validate-event-publication-packet.mjs --packet=<path> [--no-repo-check]');
  process.exit(2);
}

const packetPath = path.resolve(ROOT, packetArg.slice('--packet='.length));
let packet;
try {
  packet = loadPacket(packetPath);
} catch (error) {
  console.error(JSON.stringify({ ok: false, state: 'INVALID_INPUT', error: error.message }, null, 2));
  process.exit(1);
}

const result = validatePacket(packet, { root: ROOT, checkRepository: !noRepoCheck });
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
