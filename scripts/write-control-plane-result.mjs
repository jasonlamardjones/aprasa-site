#!/usr/bin/env node
// Builds and persists one provider-neutral control-plane task-result record.
//
// Usage:
//   node scripts/write-control-plane-result.mjs --draft=<path-to-draft.json>
//
// The draft file supplies exactly the fields that vary per instance
// (resultType, taskId/candidateId, repositorySha, reason, requiredInput,
// evidenceDigest, reviewer, upstreamRefs, ...). status/owner/resume_point are
// always derived from the fixed result_type mapping in
// scripts/lib/control-plane-result.mjs; a draft cannot override them.
//
// This never commits, pushes, merges, deploys, or grants any authority. It
// writes exactly one content-addressed JSON file under
// automation/control-plane/results/.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildResult, writeResult } from './lib/control-plane-result.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const draftArg = process.argv.find((arg) => arg.startsWith('--draft='));

if (!draftArg) {
  console.error('Usage: node scripts/write-control-plane-result.mjs --draft=<path-to-draft.json>');
  process.exit(2);
}

try {
  const draftPath = path.resolve(ROOT, draftArg.slice('--draft='.length));
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  const record = buildResult(draft);
  const outcome = writeResult(ROOT, record);
  console.log(JSON.stringify({
    status: outcome.written ? 'WRITTEN' : 'ALREADY_PRESENT',
    result_id: record.result_id,
    result_type: record.result_type,
    path: path.relative(ROOT, outcome.path),
    grants_publication_authority: record.grants_publication_authority
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'TASK_RESULT_WRITE_FAILED', reason: error.message }, null, 2));
  process.exit(1);
}
