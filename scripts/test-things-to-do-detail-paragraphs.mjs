#!/usr/bin/env node
// Regression coverage for governed detail-body paragraph structure.
//
// Project 03 requires the approved 50 Anos body to reach a reader as TWO
// visibly separate paragraphs while its semantic text stays byte-for-byte the
// approved copy. That is served by a generic rule -- a blank line in a
// governed body is a paragraph break -- rather than by special-casing the
// record, so this suite has two obligations of equal weight:
//
//   1. prove the multi-paragraph record renders exactly two paragraphs, each
//      carrying its exact governed text, in BOTH locales; and
//   2. prove every single-paragraph incumbent record still renders exactly one
//      paragraph carrying its exact governed text, on every surface -- the
//      generic rule must be unreachable for them.
//
// It asserts against the committed generated HTML, not against a re-derivation
// of it, so a generator change that stops matching the governed source fails
// here even if the generator and its helper agree with each other.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './lib/locale.mjs';
import { bodyParagraphs } from './lib/things-to-do-keys.mjs';
import { isExpired } from './lib/things-to-do-currentness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const records = JSON.parse(fs.readFileSync(path.join(root, 'data', 'things-to-do-events.json'), 'utf8')).records;
const asOf = JSON.parse(fs.readFileSync(path.join(root, 'data', 'things-to-do-currentness.json'), 'utf8')).as_of;

const MULTI_PARAGRAPH_ID = '50-anos-de-memoria-criacao-e-resistencia';

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${label}`);
  } else {
    failures.push(`${label}${detail ? `\n       ${detail}` : ''}`);
    console.log(`FAIL — ${label}${detail ? `\n       ${detail}` : ''}`);
  }
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// The body paragraphs of a rendered surface: every <p> between the Details
// heading and whatever ends the body block (the next heading of the same
// level, the checked line, or the action link). Anchored on the governed
// heading TEXT, not merely the tag -- a Home card uses <h3> for the card title
// as well, so anchoring on the tag alone would start reading in the wrong
// place. Deliberately parsed out of the real markup so "two visible
// paragraphs" means two paragraph ELEMENTS, not one element with a newline in
// it -- the exact defect this patch exists to correct.
function renderedBodyParagraphs(html, headingTag, headingText) {
  const heading = `<${headingTag}>${escapeHtml(headingText)}</${headingTag}>`;
  const start = html.indexOf(heading);
  if (start === -1) return null;
  const after = html.slice(start + heading.length);
  const stop = [`<${headingTag}>`, '<p class="checked">', '<a class="dialog-link"']
    .map((marker) => after.indexOf(marker))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0];
  const block = stop === undefined ? after : after.slice(0, stop);
  return [...block.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((match) => match[1]);
}

function homeRegion(html, id) {
  const begin = `<!-- BEGIN GENERATED EVENT: ${id} -->`;
  const end = `<!-- END GENERATED EVENT: ${id} -->`;
  const start = html.indexOf(begin);
  const stop = html.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return null;
  return html.slice(start + begin.length, stop);
}

const enHome = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ptHome = fs.readFileSync(path.join(root, 'pt', 'index.html'), 'utf8');

// --- The shared rule itself -------------------------------------------------
check(
  'bodyParagraphs: a blank line separates paragraphs',
  JSON.stringify(bodyParagraphs('First.\n\nSecond.')) === JSON.stringify(['First.', 'Second.'])
);
check(
  'bodyParagraphs: a SINGLE newline is not a paragraph break',
  JSON.stringify(bodyParagraphs('wrapped\nline')) === JSON.stringify(['wrapped\nline'])
);
check(
  'bodyParagraphs: a body with no blank line is returned unmodified and untrimmed',
  bodyParagraphs('  exact bytes  ')[0] === '  exact bytes  ' && bodyParagraphs('  exact bytes  ').length === 1
);
check(
  'bodyParagraphs: an empty body stays a single (empty) paragraph, never zero',
  JSON.stringify(bodyParagraphs('')) === JSON.stringify(['']) && JSON.stringify(bodyParagraphs(null)) === JSON.stringify([''])
);

// --- Exactly one record is multi-paragraph ---------------------------------
const multiParagraphIds = records
  .filter((record) => bodyParagraphs(record.detail?.body).length > 1)
  .map((record) => record.id);
check(
  'exactly one governed record has a multi-paragraph body (50 Anos)',
  JSON.stringify(multiParagraphIds) === JSON.stringify([MULTI_PARAGRAPH_ID]),
  `multi-paragraph ids: ${JSON.stringify(multiParagraphIds)}`
);

// --- Every record, every surface, both locales ------------------------------
for (const record of records) {
  if (isExpired(record, asOf)) continue;

  for (const locale of ['en', 'pt']) {
    const expected = bodyParagraphs(t(`event.${record.id}.detail.body`, locale));
    const expectedCount = record.id === MULTI_PARAGRAPH_ID ? 2 : 1;

    check(
      `${record.id} (${locale}): governed body resolves to ${expectedCount} paragraph(s)`,
      expected.length === expectedCount,
      `got ${expected.length}`
    );

    const detailFile = path.join(root, locale === 'pt' ? 'pt' : '.', record.detail_page, 'index.html');
    const detailHtml = fs.readFileSync(detailFile, 'utf8');
    const detailsHeading = t('things.shared.details_heading', locale);
    const detailParagraphs = renderedBodyParagraphs(detailHtml, 'h2', detailsHeading);
    check(
      `${record.id} (${locale}): detail page renders exactly ${expectedCount} body paragraph element(s)`,
      detailParagraphs !== null && detailParagraphs.length === expectedCount,
      `got ${detailParagraphs === null ? 'no Details block' : detailParagraphs.length}`
    );
    if (detailParagraphs && detailParagraphs.length === expectedCount) {
      expected.forEach((paragraph, index) => {
        check(
          `${record.id} (${locale}): detail paragraph ${index + 1} is the exact governed text`,
          detailParagraphs[index] === escapeHtml(paragraph),
          `expected ${JSON.stringify(escapeHtml(paragraph))}\n       got      ${JSON.stringify(detailParagraphs[index])}`
        );
        check(
          `${record.id} (${locale}): detail paragraph ${index + 1} carries no raw newline`,
          !detailParagraphs[index].includes('\n')
        );
      });
    }

    const region = homeRegion(locale === 'pt' ? ptHome : enHome, record.id);
    if (region) {
      const homeParagraphs = renderedBodyParagraphs(region, 'h3', detailsHeading);
      check(
        `${record.id} (${locale}): Home dialog renders exactly ${expectedCount} body paragraph element(s)`,
        homeParagraphs !== null && homeParagraphs.length === expectedCount,
        `got ${homeParagraphs === null ? 'no Details block' : homeParagraphs.length}`
      );
      if (homeParagraphs && homeParagraphs.length === expectedCount) {
        expected.forEach((paragraph, index) => {
          check(
            `${record.id} (${locale}): Home dialog paragraph ${index + 1} is the exact governed text`,
            homeParagraphs[index] === escapeHtml(paragraph),
            `expected ${JSON.stringify(escapeHtml(paragraph))}\n       got      ${JSON.stringify(homeParagraphs[index])}`
          );
        });
      }
    }
  }
}

// --- The governed semantic text is unchanged by paragraph rendering ---------
// Concatenating the rendered paragraphs back together with the approved
// separator must reproduce the governed source string byte-for-byte, so this
// fails if rendering ever edits, reflows or drops approved copy.
for (const locale of ['en', 'pt']) {
  const governed = t(`event.${MULTI_PARAGRAPH_ID}.detail.body`, locale);
  const rejoined = bodyParagraphs(governed).join('\n\n');
  check(
    `50 Anos (${locale}): governed body round-trips through paragraph splitting byte-for-byte`,
    rejoined === governed,
    `governed ${JSON.stringify(governed)}\n       rejoined ${JSON.stringify(rejoined)}`
  );
}

console.log(`\nDetail-body paragraph tests: ${passed}/${passed + failures.length} passed.`);
if (failures.length) {
  console.error('\nFailures:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
