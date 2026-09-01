import fs from 'node:fs';
import { currentnessState, reviewDueFrom, CURRENT, REVIEW_DUE, EXPIRED } from './lib/things-to-do-currentness.mjs';

const input = new URL('../data/things-to-do-events.json', import.meta.url);
const records = JSON.parse(fs.readFileSync(input, 'utf8')).records;

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

// Three buckets, not two. review_due is reported separately from expired
// precisely so a consumer cannot read "not current" as "safe to remove": a
// review-due record is still public and still needs a human to reverify it.
const current = records.filter((record) => currentnessState(record, asOf) === CURRENT);
const reviewDue = records.filter((record) => currentnessState(record, asOf) === REVIEW_DUE);
const expired = records.filter((record) => currentnessState(record, asOf) === EXPIRED);

console.log(JSON.stringify({
  asOf,
  total: records.length,
  current: current.map(({ id, title, detail_page }) => ({ id, title, detail_page })),
  // end_month is the month the source establishes; review_due_from is the
  // month boundary that triggered reverification, never a closing date.
  review_due: reviewDue.map(({ id, title, detail_page, end_month }) => ({
    id,
    title,
    detail_page,
    end_month,
    review_due_from: reviewDueFrom({ end_precision: 'month', end_month }),
    resolution: 'HUMAN_REVERIFICATION_REQUIRED',
  })),
  expired: expired.map(({ id, title, detail_page, end_date }) => ({ id, title, detail_page, end_date }))
}, null, 2));
