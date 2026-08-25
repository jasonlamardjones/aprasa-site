#!/usr/bin/env node
// Narrowly-scoped currentness validator for the two EMAR / Kre+ time-sensitive
// opportunity records on Home (Trainings, Tools & Opportunities). These
// records are hand-authored resource cards, not part of the Things-to-Do
// generator/currentness system, so they are not covered by
// validate-things-to-do-currentness.mjs. This validator applies the same
// semantics — a record whose end date has passed must not still appear on
// Home — narrowly to these two governed records, without altering the
// Things-to-Do currentness policy or building a parallel general-purpose
// expiry system.
//
// Both EN and PT Home are canonical production surfaces, so both must be
// checked: a state where an expired record is absent from EN but still
// present on PT (or vice versa) is exactly the kind of drift this validator
// exists to catch, not just simple "still on Home" staleness. Record titles
// are identity-preserved (kept in Portuguese) in both EN and PT copy, so the
// same title/id match works unchanged against either file.
//
// Usage: node scripts/validate-training-opportunities-currentness.mjs
//          --as-of=YYYY-MM-DD [--home=index.html] [--home=pt/index.html]
// Repeat --home for each Home surface to check; defaults to index.html only
// when no --home is given, preserving prior standalone-invocation behavior.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

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

const homeArgs = process.argv.filter((arg) => arg.startsWith('--home=')).map((arg) => arg.split('=')[1]);
const homePaths = homeArgs.length ? homeArgs : ['index.html'];

const RECORDS = [
  { id: 'emar-motorista-n3', title: 'Motorista — Nível 3', end_date: '2026-08-30' },
  {
    id: 'emar-assistente-eletrotecnico-naval-n4',
    title: 'Assistente Eletrotécnico Naval — Nível 4',
    end_date: '2026-08-30',
  },
];

const errors = [];

for (const homePath of homePaths) {
  const absPath = path.join(root, homePath);
  let html;
  try {
    html = fs.readFileSync(absPath, 'utf8');
  } catch {
    errors.push(`${homePath}: Home surface not found`);
    continue;
  }

  for (const record of RECORDS) {
    const expiredByDate = record.end_date < asOf;
    if (!expiredByDate) continue;

    const appearsOnHome = html.includes(`data-event-id="${record.id}"`) || html.includes(`<h3>${record.title}</h3>`);

    if (appearsOnHome) {
      errors.push(`${homePath}: ${record.id} expired ${record.end_date} but still appears as of ${asOf}`);
    }
  }
}

if (errors.length) {
  console.error('Training opportunity currentness errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Training opportunity currentness validation passed as of ${asOf} across ${homePaths.length} Home surface(s): ${homePaths.join(', ')}.`
);
