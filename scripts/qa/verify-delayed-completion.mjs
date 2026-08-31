#!/usr/bin/env node
// Completion marker for a delayed recheck.
//
// The problem this closes: the delayed run's evidence artifact was doing two
// jobs at once — carrying the evidence, and telling the reconciler "this SHA
// has been rechecked". Evidence has to be uploaded with always(), because a
// crashed run's screenshots and partial output are exactly what someone needs
// in order to understand the crash. But an artifact that exists because a
// runner died is not proof that the recheck happened, and using it as the
// dedupe marker means one crash silently cancels the recheck for that
// deployment forever.
//
// So the two jobs are separated. The evidence artifact stays always(). A
// distinct completion marker is written only when a real, schema-valid, final
// report exists, and only that marker suppresses a future recheck. A runner
// that dies before producing one leaves the SHA eligible for retry, which is
// the behaviour the window is supposed to guarantee.
//
// Read-only, like everything else in Phase 2A: it reads a report and writes one
// local JSON file into the run's own artifact directory.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSchema, validateAgainstSchema } from './lib/qa-schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_PATH = path.join(ROOT, 'scripts', 'qa', 'qa-report.schema.json');

export const MARKER_SCHEMA = 'aprasa-post-publication-qa-completion-marker';
export const MARKER_VERSION = '1.0.0';

/**
 * A verdict the QA layer actually reached.
 *
 * UNKNOWN is deliberately absent. It means the run could not identify what is
 * deployed — an inconclusive result, not a completed recheck — so a SHA that
 * produced UNKNOWN stays eligible for another attempt inside its window.
 */
export const TERMINAL_OVERALL_STATUSES = Object.freeze(['HEALTHY', 'DEGRADED', 'FAILED']);

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Decide whether a report is a valid completed delayed recheck.
 *
 * Every condition here is a way the old name-only marker could lie:
 * a partial upload (no report at all), a truncated or malformed report, a
 * report from a different SHA, and a report from a different mode.
 */
export function verifyDelayedCompletion({ report, expectedSha, expectedMode = 'DELAYED_RECHECK', schema }) {
  const reasons = [];

  if (!report || typeof report !== 'object') {
    return { valid: false, reasons: ['NO_REPORT'], marker: null };
  }

  const schemaErrors = validateAgainstSchema(report, schema);
  if (schemaErrors.length) reasons.push(`REPORT_SCHEMA_INVALID: ${schemaErrors.slice(0, 5).join('; ')}`);

  if (report.mode !== expectedMode) reasons.push(`MODE_MISMATCH: expected ${expectedMode}, got ${report.mode ?? 'none'}`);

  const reportedSha = report.target?.expected_main_sha ?? null;
  if (!expectedSha || !SHA_PATTERN.test(String(expectedSha))) {
    reasons.push('EXPECTED_SHA_MISSING_OR_MALFORMED');
  } else if (reportedSha !== expectedSha) {
    reasons.push(`SHA_MISMATCH: expected ${expectedSha}, report carries ${reportedSha ?? 'none'}`);
  }

  const completedAt = report.completed_at ?? null;
  if (!completedAt || !Number.isFinite(Date.parse(completedAt))) {
    reasons.push(`COMPLETED_AT_INVALID: ${completedAt ?? 'none'}`);
  }

  if (!TERMINAL_OVERALL_STATUSES.includes(report.overall_status)) {
    reasons.push(`NOT_TERMINAL: overall_status ${report.overall_status ?? 'none'} is not one of ${TERMINAL_OVERALL_STATUSES.join('/')}`);
  }

  if (reasons.length) return { valid: false, reasons, marker: null };

  return {
    valid: true,
    reasons: [],
    marker: {
      schema: MARKER_SCHEMA,
      version: MARKER_VERSION,
      mode: expectedMode,
      sha: expectedSha,
      completed_at: completedAt,
      overall_status: report.overall_status,
      report_schema: report.schema,
      report_version: report.version,
    },
  };
}

/** Bind the marker to the exact bytes it was derived from. */
export function fingerprintReport(reportBytes) {
  return `sha256:${crypto.createHash('sha256').update(reportBytes).digest('hex')}`;
}

function parseArgs(argv) {
  const args = { report: 'qa-artifacts/post-publication-qa.json', out: 'qa-marker/completion.json', mode: 'DELAYED_RECHECK' };
  for (const arg of argv) {
    const [key, ...rest] = arg.split('=');
    const value = rest.join('=');
    switch (key) {
      case '--report': args.report = value; break;
      case '--out': args.out = value; break;
      case '--sha': args.sha = value; break;
      case '--mode': args.mode = value; break;
      default:
        if (key.startsWith('--')) throw new Error(`unknown argument ${key}`);
    }
  }
  return args;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  let report = null;
  let bytes = null;
  try {
    bytes = fs.readFileSync(args.report);
    report = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    console.error(`no usable final report at ${args.report}: ${error.message}`);
  }

  const verdict = verifyDelayedCompletion({
    report,
    expectedSha: args.sha,
    expectedMode: args.mode,
    schema: loadSchema(SCHEMA_PATH),
  });

  if (!verdict.valid) {
    console.error('delayed recheck did not complete validly; no completion marker will be published:');
    for (const reason of verdict.reasons) console.error(`  - ${reason}`);
    process.exit(1);
  }

  const marker = { ...verdict.marker, report_fingerprint: fingerprintReport(bytes) };
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(marker, null, 2)}\n`);
  console.log(`completion marker written to ${args.out}`);
  console.log(JSON.stringify(marker, null, 2));
}
