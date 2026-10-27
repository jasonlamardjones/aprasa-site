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
  const root = fileURLToPath(new URL('..', import.meta.url));
  const entry = JSON.parse(fs.readFileSync(path.join(root, 'data/locales/locale-data.generated.json'), 'utf8')).keys[`training.record.${id}.requirements`];
  assert.ok(entry, 'FICASE requirements locale entry found');
  const decode = (h) => h.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  for (const [locale, home] of [['en', 'index.html'], ['pt', 'pt/index.html']]) {
    const html = fs.readFileSync(path.join(root, home), 'utf8');
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
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
