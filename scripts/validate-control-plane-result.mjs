#!/usr/bin/env node
// Validates control-plane task-result records: schema shape, semantic
// invariants (fixed status/owner/resume_point/reviewer per result_type), and
// content-address integrity (result_id must equal the recomputed digest,
// which excludes created_at — see scripts/lib/control-plane-result.mjs).
//
// Usage:
//   node scripts/validate-control-plane-result.mjs [--ref=<results-ref>]
//     Validates every result persisted on the results ref (default
//     refs/heads/control-plane-task-results). Reports NO_RESULTS_FOUND if
//     that ref does not exist yet — this is expected before any real result
//     has ever been written.
//
//   node scripts/validate-control-plane-result.mjs --result=<path>
//     Validates exactly one local file (a draft before persisting, or a file
//     extracted from the ref for inspection). Does not consult the ref.
//
//   ... --candidate-sha=<sha>
//     Additionally asserts the result is not stale: for REVIEW_PASSED and
//     REVIEW_FAILED, --candidate-sha must equal the record's repository.sha,
//     or validation fails closed with STALE_REVIEW_RESULT.
//
//   ... --fetch[=<remote>]
//     Explicitly fetches the results ref from the remote (default origin)
//     into this local checkout before validating — the "a later worker
//     fetches the result" step. This is opt-in and never implicit: a plain
//     validate call never touches the network.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REMOTE,
  DEFAULT_RESULTS_REF,
  fetchResultsRef,
  isResultCurrent,
  listPersistedResults,
  readPersistedResult,
  validateResult
} from './lib/control-plane-result.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultArg = process.argv.find((arg) => arg.startsWith('--result='));
const refArg = process.argv.find((arg) => arg.startsWith('--ref='));
const candidateShaArg = process.argv.find((arg) => arg.startsWith('--candidate-sha='));
const fetchArg = process.argv.find((arg) => arg === '--fetch' || arg.startsWith('--fetch='));
const candidateSha = candidateShaArg ? candidateShaArg.slice('--candidate-sha='.length) : null;
const ref = refArg ? refArg.slice('--ref='.length) : DEFAULT_RESULTS_REF;

if (fetchArg) {
  const remote = fetchArg.includes('=') ? fetchArg.slice('--fetch='.length) : DEFAULT_REMOTE;
  fetchResultsRef(ROOT, { remote, ref });
}

function checkStaleness(record) {
  if (candidateSha === null) return null;
  if (isResultCurrent(record, candidateSha)) return null;
  return `STALE_REVIEW_RESULT: repository.sha ${record.repository.sha} no longer matches candidate ${candidateSha}`;
}

function validateRecord(record, label) {
  const errors = validateResult(record, { root: ROOT });
  if (errors.length > 0) return { label, ok: false, errors };
  const staleness = checkStaleness(record);
  if (staleness !== null) return { label, ok: false, errors: [staleness] };
  return { label, ok: true, result_id: record.result_id, result_type: record.result_type };
}

let outcomes;
if (resultArg) {
  const file = path.resolve(ROOT, resultArg.slice('--result='.length));
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  outcomes = [validateRecord(record, file)];
} else {
  const relPaths = listPersistedResults(ROOT, { ref });
  if (relPaths.length === 0) {
    console.log(JSON.stringify({ status: 'NO_RESULTS_FOUND', ref, checked: 0 }, null, 2));
    process.exit(0);
  }
  outcomes = relPaths.map((relPath) => {
    const resultId = path.basename(relPath, '.json');
    const record = readPersistedResult(ROOT, resultId, { ref });
    return validateRecord(record, `${ref}:${relPath}`);
  });
}

const failures = outcomes.filter((item) => !item.ok);
console.log(JSON.stringify({
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  ref: resultArg ? null : ref,
  checked: outcomes.length,
  passed: outcomes.length - failures.length,
  failed: failures.length,
  results: outcomes
}, null, 2));

process.exit(failures.length === 0 ? 0 : 1);
