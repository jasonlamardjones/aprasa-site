#!/usr/bin/env node
// Validates control-plane task-result records: schema shape, semantic
// invariants (fixed status/owner/resume_point/reviewer per result_type), and
// content-address integrity (result_id must equal the recomputed digest).
//
// Usage:
//   node scripts/validate-control-plane-result.mjs
//     Validates every *.json file under automation/control-plane/results/.
//
//   node scripts/validate-control-plane-result.mjs --result=<path>
//     Validates exactly one file.
//
//   node scripts/validate-control-plane-result.mjs --result=<path> --candidate-sha=<sha>
//     Additionally asserts the result is not stale: for REVIEW_PASSED and
//     REVIEW_FAILED, --candidate-sha must equal the record's repository.sha,
//     or validation fails closed with STALE_REVIEW_RESULT.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isResultCurrent, resultsDir, validateResult } from './lib/control-plane-result.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultArg = process.argv.find((arg) => arg.startsWith('--result='));
const candidateShaArg = process.argv.find((arg) => arg.startsWith('--candidate-sha='));
const candidateSha = candidateShaArg ? candidateShaArg.slice('--candidate-sha='.length) : null;

function targets() {
  if (resultArg) return [path.resolve(ROOT, resultArg.slice('--result='.length))];
  const dir = resultsDir(ROOT);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
}

function validateOne(file) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validateResult(record, { root: ROOT });
  if (errors.length > 0) return { file, ok: false, errors };
  if (candidateSha !== null && !isResultCurrent(record, candidateSha)) {
    return {
      file,
      ok: false,
      errors: [`STALE_REVIEW_RESULT: repository.sha ${record.repository.sha} no longer matches candidate ${candidateSha}`]
    };
  }
  return { file, ok: true, result_id: record.result_id, result_type: record.result_type };
}

const files = targets();
if (files.length === 0) {
  console.log(JSON.stringify({ status: 'NO_RESULTS_FOUND', checked: 0 }, null, 2));
  process.exit(0);
}

const outcomes = files.map(validateOne);
const failures = outcomes.filter((item) => !item.ok);

console.log(JSON.stringify({
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  checked: outcomes.length,
  passed: outcomes.length - failures.length,
  failed: failures.length,
  results: outcomes
}, null, 2));

process.exit(failures.length === 0 ? 0 : 1);
