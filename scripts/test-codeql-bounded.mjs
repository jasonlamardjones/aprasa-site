import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFactValueHtml, escapeFactHtmlText } from './lib/fact-value-html.mjs';
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
check('HTML character references retain text-node semantics without double encoding', () => {
  assert.equal(escapeFactHtmlText('Info &amp; fees: R&amp;D'), 'Info &amp; fees: R&amp;D');
  assert.equal(escapeFactHtmlText('R&D'), 'R&D');
  assert.equal(escapeFactHtmlText('&copy; &#169; &#x1F389; &nbsp; &amp'), '&copy; &#169; &#x1F389; &nbsp; &amp');
  assert.equal(escapeFactHtmlText('&lt;script&gt;'), '&lt;script&gt;');
  assert.equal(escapeFactHtmlText('<img src=x onerror="evil()">'),
    '&lt;img src=x onerror=&quot;evil()&quot;&gt;');
});
check('actual EN generator preserves encoded characters and rejects malformed facts before writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-fact-entity-'));
  try {
    fs.cpSync(root, dir, {
      recursive: true,
      filter: src => !src.split(path.sep).some(part =>
        ['.git', 'node_modules', '.netlify'].includes(part)),
    });
    const sourcePath = path.join(dir, 'data/things-to-do-events.json');
    const fixture = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const record = fixture.records.find(r => r.id === 'mon-pikenin');
    const fact = record.detail.facts.find(f => f.value_html);
    fact.value_html = 'Info &amp; fees: <a href="https://www.solm.land/calendar">R&amp;D</a> &copy; &lt;script&gt;';
    fs.writeFileSync(sourcePath, JSON.stringify(fixture, null, 2) + '\n');
    const args = ['scripts/generate-things-to-do.mjs', '--as-of=2026-10-12',
      '--locale=en', '--id=mon-pikenin', '--write'];
    const run = () => spawnSync(process.execPath, args,
      { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const detailPath = path.join(dir, record.detail_page, 'index.html');
    const html = fs.readFileSync(detailPath, 'utf8');
    const expected = '<dd>Info &amp; fees: <a href="https://www.solm.land/calendar">R&amp;D</a> &copy; &lt;script&gt;</dd>';
    assert(html.includes(expected), 'encoded facts must retain their rendered characters');
    assert(!html.includes('Info &amp;amp; fees'), 'source character references must not double-encode');
    assert(!html.includes('R&amp;amp;D'), 'anchor character references must not double-encode');
    const repeat = run();
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(fs.readFileSync(detailPath, 'utf8'), html, 'idempotent encoded detail output');

    fact.value_html = '<a href="javascript:alert(1)">Unsafe</a>';
    fs.writeFileSync(sourcePath, JSON.stringify(fixture, null, 2) + '\n');
    const rejected = run();
    assert.notEqual(rejected.status, 0, 'unsafe fact must be rejected');
    assert.equal(fs.readFileSync(detailPath, 'utf8'), html,
      'rejected fact must not overwrite the previously generated detail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
console.log(`${count}/${count} bounded checks passed.`);
