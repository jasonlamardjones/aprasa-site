#!/usr/bin/env node
// Hermetic FICASE EN/PT expiry-boundary checks without touching repository files.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const id = 'ficase-scholarship-renewals-2026-2027';
const source = fs.readFileSync(new URL('./validate-training-opportunities-currentness.mjs', import.meta.url), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-ficase-boundary-'));
let passed = 0;
try {
  for (const folder of ['scripts', 'data', 'pt']) fs.mkdirSync(path.join(tmp, folder), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'scripts/validate-training-opportunities-currentness.mjs'), source);
  const active = `<!-- BEGIN GENERATED TRAINING: ${id} -->
<article class="resource-card"><a class="resource-link" href="https://ficase.cv/">Renew online</a></article>
<!-- END GENERATED TRAINING: ${id} -->`;
  const empty = `<!-- BEGIN GENERATED TRAINING: ${id} -->
<!-- END GENERATED TRAINING: ${id} -->`;
  function check({day, state='CURRENT', en=active, pt=active, deadline='2026-10-31', accept=true, reason}) {
    fs.writeFileSync(path.join(tmp,'data/training-opportunities.json'), JSON.stringify({records:[{id,lifecycle_class:'fixed-window-opportunity',publication_state:state,end_date:deadline}]}));
    fs.writeFileSync(path.join(tmp,'index.html'),en);
    fs.writeFileSync(path.join(tmp,'pt/index.html'),pt);
    const r=spawnSync(process.execPath,['scripts/validate-training-opportunities-currentness.mjs',`--as-of=${day}`,'--home=index.html','--home=pt/index.html'],{cwd:tmp,encoding:'utf8'});
    assert.equal(r.status===0,accept,`${day}: ${r.stderr}`);
    if (reason) assert.match(r.stderr,reason);
    passed++;
  }
  check({day:'2026-10-30'});
  check({day:'2026-10-31'});
  check({day:'2026-11-01',accept:false,reason:/after deadline/});
  check({day:'2026-11-01',state:'EXPIRED',accept:false,reason:/active application\/renewal/});
  check({day:'2026-11-01',state:'EXPIRED',en:empty,accept:false,reason:/pt\/index.html/});
  check({day:'2026-11-01',state:'EXPIRED',pt:empty,accept:false,reason:/index.html/});
  check({day:'2026-11-01',state:'EXPIRED',en:empty,pt:empty});
  check({day:'2026-10-31',deadline:'2026-10-30',accept:false,reason:/after deadline/});
  check({day:'2026-11-01',state:'EXPIRED',en:active+'\n'+active,pt:empty,accept:false,reason:/duplicated markers/});
  console.log(`FICASE EN/PT deadline boundary: ${passed}/${passed} passed`);

  // FICASE document requirements must render as intro <p> + semantic <ul><li>,
  // never as one <p> holding the raw "- " lines, and every fragment must be the
  // approved EN/PT string verbatim (verified against the governed locale data).
  //
  // The committed FICASE record is EXPIRED (Project 05 CV-029 Closed / Expired, effective
  // 2026-11-01; Project 03 disposition of 19 November 2026), so its card is no longer present
  // on the committed Home pages. This regression is NOT weakened or skipped for that reason:
  // it runs, unchanged, against the markup the SHIPPED generator produces from an ACTIVE-state
  // sandbox copy of the repository (publication_state CURRENT, as-of inside the window). The
  // committed files are never modified.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-ficase-active-'));
  try {
    fs.cpSync(root, activeRoot, { recursive: true, filter: (src) => !['.git', 'node_modules'].includes(path.basename(src)) });
    const activeDataFile = path.join(activeRoot, 'data/training-opportunities.json');
    const activeDoc = JSON.parse(fs.readFileSync(activeDataFile, 'utf8'));
    const activeRecord = activeDoc.records.find((record) => record.id === id);
    assert.ok(activeRecord, 'FICASE canonical record found');
    assert.equal(activeRecord.end_date, '2026-10-31', 'the fixture is anchored to the governed 2026-10-31 deadline');
    activeRecord.publication_state = 'CURRENT';
    fs.writeFileSync(activeDataFile, `${JSON.stringify(activeDoc, null, 2)}\n`);
    for (const [locale, args] of [['en', []], ['pt', ['--home=pt/index.html']]]) {
      const generated = spawnSync(process.execPath, ['scripts/generate-training-opportunities.mjs', `--locale=${locale}`, '--as-of=2026-10-30', ...args, '--write'], { cwd: activeRoot, encoding: 'utf8' });
      assert.equal(generated.status, 0, `active-state ${locale} generation: ${generated.stderr}`);
    }
    // The REAL validator against the REAL generated active-state markup: inside the window it
    // accepts, from 2026-11-01 it refuses the same markup as a CURRENT record after its deadline.
    for (const [day, accept] of [['2026-10-30', true], ['2026-10-31', true], ['2026-11-01', false]]) {
      const verdict = spawnSync(process.execPath, ['scripts/validate-training-opportunities-currentness.mjs', `--as-of=${day}`, '--home=index.html', '--home=pt/index.html'], { cwd: activeRoot, encoding: 'utf8' });
      assert.equal(verdict.status === 0, accept, `active-state generated markup as of ${day}: ${verdict.stderr}`);
      if (!accept) assert.match(verdict.stderr, /after deadline/);
      passed++;
    }
    console.log('FICASE active-state generated markup, 30 Oct / 31 Oct accepted and 1 Nov refused: 3/3 passed');
  const entry = JSON.parse(fs.readFileSync(path.join(root, 'data/locales/locale-data.generated.json'), 'utf8')).keys[`training.record.${id}.requirements`];
  assert.ok(entry, 'FICASE requirements locale entry found');
  const decode = (h) => h.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  for (const [locale, home] of [['en', 'index.html'], ['pt', 'pt/index.html']]) {
    const html = fs.readFileSync(path.join(activeRoot, home), 'utf8');
    const m = html.match(new RegExp(`<!-- BEGIN GENERATED TRAINING: ${id} -->([\\s\\S]*?)<!-- END GENERATED TRAINING: ${id} -->`));
    assert.ok(m, `${home}: FICASE region present`);
    const dialog = m[1].slice(m[1].indexOf('<template class="details-template">'));
    const req = dialog.split('<h3>')[2]; // sections: [preamble, Details, Requirements, Good to know]
    const [intro, rest] = entry[locale].split('\n\n');
    const restLines = rest.split('\n');
    const introLines = restLines.filter((l) => !l.startsWith('- '));
    const itemLines = restLines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    const paras = [...req.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((x) => decode(x[1]));
    const lis = [...req.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => decode(x[1]));
    assert.deepEqual(paras, [intro, ...introLines], `${locale}: intro paragraphs verbatim`);
    assert.deepEqual(lis, itemLines, `${locale}: list items verbatim`);
    assert.equal(lis.length, 2, `${locale}: two document items`);
    assert.equal((req.match(/<ul>/g) || []).length, 1, `${locale}: exactly one <ul>`);
    assert.ok(!/<p>[^<]*(\n|(^|\s)- )/.test(req), `${locale}: no raw newline or "- " bullet text inside a <p>`);
    assert.ok(!req.includes('\n- '), `${locale}: no raw bullet lines`);
    passed++;
  }
  console.log('FICASE EN/PT document-requirements list structure: 2/2 passed');
  } finally { fs.rmSync(activeRoot, { recursive: true, force: true }); }

  // --- The COMMITTED state: FICASE renewals are expired and off current discovery -------------
  // Project 05 CV-029 Closed / Expired (effective 2026-11-01, DEC-CV-029-20261119, evidence
  // CUR-CV029-01 / CUR-CV029-02); Project 03 disposition of 19 November 2026: expire current
  // renewal discovery and suppress the EN/PT Home calls to action. The historical canonical
  // record, its provenance and every governed locale key are preserved.
  const passedBeforeCommitted = passed;
  const committed = JSON.parse(fs.readFileSync(path.join(root, 'data/training-opportunities.json'), 'utf8'));
  const record = committed.records.find((item) => item.id === id);
  assert.ok(record, 'FICASE canonical record is preserved');
  assert.equal(record.publication_state, 'EXPIRED', 'FICASE is EXPIRED, not deleted and not merely hidden');
  assert.equal(record.lifecycle_class, 'fixed-window-opportunity');
  assert.equal(record.end_date, '2026-10-31', 'the governed deadline is unchanged');
  assert.equal(record.ordinary_publication_eligibility, 'ELIGIBLE');
  assert.equal(record.checked_at, '2026-10-26', 'the historical verification date is unchanged');
  for (const token of ['CV-029', 'DEC-CV-029-20261026', 'CUR-CV029-01', 'CUR-CV029-02']) {
    assert.ok(record.source.provenance.includes(token), `historical evidence reference ${token} is preserved`);
  }
  assert.ok(record.source.source_url.includes('ficase.cv'), 'the historical source URL is preserved');
  assert.ok(record.card && record.detail, 'card and detail linkage is preserved on the historical record');
  passed++;
  const localeKeys = JSON.parse(fs.readFileSync(path.join(root, 'data/locales/locale-data.generated.json'), 'utf8')).keys;
  const governed = Object.keys(localeKeys).filter((key) => key.startsWith(`training.record.${id}.`));
  assert.ok(governed.length >= 10, `all governed FICASE locale keys are preserved (found ${governed.length})`);
  for (const key of governed) assert.ok(localeKeys[key].en && localeKeys[key].pt, `${key} keeps its approved EN and PT values`);
  passed++;
  const renewalNotice = 'noticia=_Ano_Acad';
  for (const home of ['index.html', 'pt/index.html']) {
    const html = fs.readFileSync(path.join(root, home), 'utf8');
    const m = html.match(new RegExp(`<!-- BEGIN GENERATED TRAINING: ${id} -->([\\s\\S]*?)<!-- END GENERATED TRAINING: ${id} -->`));
    assert.ok(m, `${home}: FICASE marker region stays generator-owned`);
    assert.equal(m[1].trim(), '', `${home}: FICASE region is cleared`);
    assert.ok(!html.includes(renewalNotice), `${home}: no active FICASE renewal call to action remains anywhere on the page`);
    passed++;
  }
  // The shipped validator accepts the committed Home pages at and after the boundary, and the
  // generator reports no drift for any region -- so no unrelated record changed.
  for (const day of ['2026-11-01', '2026-11-19']) {
    const verdict = spawnSync(process.execPath, ['scripts/validate-training-opportunities-currentness.mjs', `--as-of=${day}`, '--home=index.html', '--home=pt/index.html'], { cwd: root, encoding: 'utf8' });
    assert.equal(verdict.status, 0, `committed Home as of ${day}: ${verdict.stderr}`);
    passed++;
  }
  for (const [locale, args] of [['en', []], ['pt', ['--home=pt/index.html']]]) {
    const drift = spawnSync(process.execPath, ['scripts/generate-training-opportunities.mjs', `--locale=${locale}`, '--as-of=2026-11-19', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(drift.status, 0, `${locale}: committed Home matches generator output: ${drift.stderr}`);
    passed++;
  }
  const committedChecks = passed - passedBeforeCommitted;
  console.log(`FICASE expired committed state (record, locale keys, EN/PT Home suppression, validator, generator parity): ${committedChecks}/${committedChecks} passed`);
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
