import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFactValueHtml } from './lib/fact-value-html.mjs';
import { markdownTableCell, renderStepSummary } from './qa/run-post-publication-qa.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let count = 0;
function check(name, fn) {
  fn();
  count++;
  console.log(`PASS ${name}`);
}
const incumbent = JSON.parse(fs.readFileSync(path.join(root, 'data/things-to-do-events.json'), 'utf8'))
  .records.find((record) => record.id === 'mon-pikenin').detail.facts.find((fact) => fact.value_html).value_html;
check('incumbent Mon Pikenin links', () => {
  const links = parseFactValueHtml(incumbent);
  assert.equal(links.length, 2);
  assert.equal(links.map((link) => link.html).join(' or '), incumbent);
});
for (const [name, html] of [
  ['malformed opening tag', '<a href="https://example.org"'],
  ['unclosed anchor', '<a href="https://example.org">x'],
  ['nested tag', '<a href="https://example.org"><img src=x></a>'],
  ['nested anchor', '<a href="https://example.org"><a href="tel:+123">x</a></a>'],
  ['unexpected attribute', '<a href="https://example.org" class="x">x</a>'],
  ['event handler', '<a href="https://example.org" onclick="alert(1)">x</a>'],
  ['duplicate href', '<a href="https://example.org" href="https://evil.org">x</a>'],
  ['javascript URL', '<a href="javascript:alert(1)">x</a>'],
  ['encoded javascript URL', '<a href="&#106;avascript:alert(1)">x</a>'],
  ['data URL', '<a href="data:text/html,x">x</a>'],
  ['unsafe target', '<a href="https://example.org" target="_blank">x</a>'],
  ['trailing script', 'text<script>alert(1)</script>'],
]) check(name, () => assert.throws(() => parseFactValueHtml(html)));
check('ordinary text and supported link', () => {
  assert.equal(parseFactValueHtml('Text <a href="https://example.org">link</a> more').length, 1);
  assert.equal(parseFactValueHtml('ordinary text').length, 0);
});
check('Markdown cell escapes metacharacters and newlines', () => {
  assert.equal(markdownTableCell('a\\|b`c\r\nd\ne'), 'a\\\\\\|b&#96;c d e');
});
check('hostile dynamic fields stay in one Markdown issue row', () => {
  const hostile = 'https://evil.example/a\\|b`\r\n| forged | row |';
  const report = {
    mode: 'MANUAL', overall_status: 'FAILED',
    target: { base_url: 'https://aprasa.org', deployment_state: 'VERIFIED' },
    domains: {}, counts: { checks: 1, checks_failed: 1, issues: 1,
      issues_by_severity: { CRITICAL: 0, ERROR: 1, WARNING: 0, INFO: 0 } },
    issues: [{ severity: 'ERROR|x', code: 'REDIRECT`X', route: '/a\\|b\r\nnext',
      resolver_class: 'CONTENT|X', observed: hostile }],
  };
  const markdown = renderStepSummary(report);
  const rows = markdown.split('\n').filter((line) => line.startsWith('| ERROR'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].split(/(?<!\\)\|/).length, 7);
  assert(!rows[0].includes('\n'));
  assert(rows[0].includes('\\| forged \\| row \\|'));
});
console.log(`${count}/${count} bounded checks passed.`);
