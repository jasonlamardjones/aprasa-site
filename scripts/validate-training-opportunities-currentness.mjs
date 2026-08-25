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

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const indexPath = path.join(root, 'index.html');
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

const RECORDS = [
  { id: 'emar-motorista-n3', title: 'Motorista — Nível 3', end_date: '2026-08-30' },
  {
    id: 'emar-assistente-eletrotecnico-naval-n4',
    title: 'Assistente Eletrotécnico Naval — Nível 4',
    end_date: '2026-08-30',
  },
];

const errors = [];

for (const record of RECORDS) {
  const expiredByDate = record.end_date < asOf;
  if (!expiredByDate) continue;

  const appearsOnHome =
    indexHtml.includes(`data-event-id="${record.id}"`) || indexHtml.includes(`<h3>${record.title}</h3>`);

  if (appearsOnHome) {
    errors.push(`${record.id}: expired ${record.end_date} but still appears on Home as of ${asOf}`);
  }
}

if (errors.length) {
  console.error('Training opportunity currentness errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Training opportunity currentness validation passed as of ${asOf}.`);
