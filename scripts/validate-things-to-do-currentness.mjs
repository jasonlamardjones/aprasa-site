import fs from 'node:fs';
import path from 'node:path';
import { currentnessState, reviewDueFrom, EXPIRED, REVIEW_DUE } from './lib/things-to-do-currentness.mjs';

const root = process.cwd();
const input = path.join(root, 'data', 'things-to-do-events.json');
const indexPath = path.join(root, 'index.html');
const records = JSON.parse(fs.readFileSync(input, 'utf8')).records;
const indexHtml = fs.readFileSync(indexPath, 'utf8');

const asOfArg = process.argv.find((arg) => arg.startsWith('--as-of='));
if (!asOfArg) {
  console.error('Missing required --as-of=YYYY-MM-DD');
  process.exit(1);
}
const asOf = asOfArg.split('=')[1];
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error(`Invalid --as-of date: ${asOf}`);
  process.exit(1);
}

// Exit codes are part of this validator's contract with its consumers.
//
//   0  everything current
//   1  EXPIRED drift -- deterministic, generator-repairable
//   3  REVIEW-DUE only -- a human must reverify against the source
//
// The split exists because scripts/remediation/run-things-to-do-currentness-remediation.mjs
// treats exit 1 as an authorized deterministic repair signal and refuses any
// other non-zero code (PHASE2B_CURRENTNESS_REVALIDATION_ERROR). A review-due
// record has no verified closing day, so no generator can repair it; reporting
// it as exit 1 would offer Phase 2B a removal it must never perform.
const EXIT_DRIFT = 1;
const EXIT_REVIEW_DUE = 3;

const errors = [];
const reviewDue = [];

for (const record of records) {
  if (record.kind !== 'dated-event') continue;

  const state = currentnessState(record, asOf);

  if (state === REVIEW_DUE) {
    // Reported unconditionally, not only when the record is on Home: the
    // obligation is to reverify the source, and quietly dropping the card
    // from Home must not be able to discharge it.
    reviewDue.push({ record, boundary: reviewDueFrom(record) });
    continue;
  }

  if (state !== EXPIRED) continue;

  const appearsOnHome = indexHtml.includes(`<h3>${record.title}</h3>`);
  if (appearsOnHome) {
    const reason = record.publication_state === 'expired'
      ? 'publication_state "expired"'
      : `expired ${record.end_date}`;
    errors.push(`${record.id}: ${reason} but still appears in Home current Things to Do markup as of ${asOf}`);
  }
}

// --- EXPIRED drift ---------------------------------------------------------
// This block's line shape is load-bearing. parseObservedDriftIds/
// parseValidatorDriftIds in the Phase 2B remediation library extract record ids
// with /^\s*-\s+([a-z0-9-]+):\s/, so "- <id>: " marks a record as
// deterministically repairable. Nothing else this validator prints may use it.
if (errors.length) {
  console.error('Things to Do currentness errors:');
  for (const error of errors) console.error(`- ${error}`);
}

// --- REVIEW-DUE ------------------------------------------------------------
// Deliberately NOT in the "- <id>: " drift grammar above. These lines must
// stay unparseable as drift ids so a review-due record can never enter a
// Phase 2B write set, be marked expired, or have a closing day synthesized
// for it. The month boundary below is why reverification is due; it is not a
// closing date and must not be published as one.
if (reviewDue.length) {
  console.error('Things to Do reverification required:');
  for (const { record, boundary } of reviewDue) {
    console.error(
      `  REVIEW-DUE ${record.id} — month-precision end ${record.end_month} reached its ${boundary} boundary as of ${asOf};`
      + ' the exact closing day is not established. Reverify against the authoritative source.'
    );
  }
}

if (errors.length) {
  // Drift dominates: a genuinely expired record still needs its deterministic
  // repair even when some other record is separately review-due.
  process.exit(EXIT_DRIFT);
}
if (reviewDue.length) {
  console.error(`Reverification required for ${reviewDue.length} record(s) as of ${asOf}.`);
  process.exit(EXIT_REVIEW_DUE);
}

console.log(`Currentness validation passed as of ${asOf}.`);
