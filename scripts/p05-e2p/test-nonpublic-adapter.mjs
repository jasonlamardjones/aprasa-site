// Execute: node --test scripts/p05-e2p/test-nonpublic-adapter.mjs
// All data is synthetic; tests read one local fixture and never write files or use network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  screenSyntheticBatch, verifySyntheticRelationships, classifyCurrentness,
  fingerprint, ContractError,
} from './nonpublic-adapter.mjs';

const url = new URL('../../automation/p05-e2p/nonpublic/synthetic-fixtures.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
const copy = () => structuredClone(fixture);
const find = (b, id = 'SYN-LEARN-01') => b.records.find(r => r.stable_resource_id === id);
const reject = (fn, code) => assert.throws(fn, err => err instanceof ContractError && err.code === code);
const outcome = (b,id) => screenSyntheticBatch(b).report.results.find(r=>r.id===id);

// Sixteen R1 acceptance categories, mapped to synthetic test assertions.
test('R1-01 stable ID preserved independently of site slug and provider ID', () => {
  const b = copy(); const x = outcome(b,'SYN-LEARN-01');
  assert.equal(x.preview.stable_resource_id,'SYN-LEARN-01');
  assert.equal(x.preview.site_slug,'synthetic-learning');
  assert.notEqual(x.preview.stable_resource_id,find(b).primary_provider_id);
});
test('R1-02 deterministic output regardless of insertion order and repeat runs', () => {
  const first=screenSyntheticBatch(copy());
  const reordered=copy();reordered.records.reverse();
  const second=screenSyntheticBatch(reordered);
  assert.deepEqual(first,second);
  assert.equal(first.digest,fingerprint(first.report));
});
test('R1-03 missing or duplicate stable resource IDs fail closed', () => {
  const a=copy();find(a).stable_resource_id='';reject(()=>screenSyntheticBatch(a),'INVALID_ID');
  const b=copy(); b.records.push(structuredClone(b.records[0]));reject(()=>screenSyntheticBatch(b),'DUPLICATE_STABLE_ID');
});
test('R1-04 unknown provider fails closed even if display name is plausible', () => {
  const b=copy();find(b).primary_provider_id='SYN-PROV-OTHER';reject(()=>screenSyntheticBatch(b),'UNRESOLVED_PROVIDER');
});
test('R1-05 private/unexpected field cannot reach screening output', () => {
  const b=copy();find(b).reviewer='Synthetic private name';reject(()=>screenSyntheticBatch(b),'UNEXPECTED_FIELD');
  const c=copy();find(c).public_values.private_contacts='synthetic-private@example.invalid';reject(()=>screenSyntheticBatch(c),'UNEXPECTED_FIELD');
  const screening=screenSyntheticBatch(copy());
  const serial=JSON.stringify(screening.report);
  for(const field of ['decision_id','evidence_refs','last_reviewed','next_review_trigger','primary_provider_id'])assert.equal(serial.includes(`"${field}"`),false,field);
});
test('R1-06 Held negative fixture is not a public candidate', () => {
  assert.deepEqual(outcome(copy(),'SYN-HOLD-06'), {id:'SYN-HOLD-06',status:'HOLD',reason:'PUBLICATION_HELD'});
});
test('R1-07 Closed / Expired is suppressed, not deleted from input', () => {
  const b=copy();assert.equal(outcome(b,'SYN-EXPIRED-08').status,'SUPPRESS');assert.equal(b.records.length,8);
});
test('R1-08 currentness unknown never yields current action link', () => {
  const x=outcome(copy(),'SYN-UNKNOWN-07');assert.equal(x.status,'HOLD');assert.equal(x.preview,undefined);
});
test('R1-09 parent/gateway is not evidence for a child record', () => {
  const b=copy();const hub=find(b,'SYN-HUB-03');
  hub.public_values.deadline='2026-12-31';hub.approved_claims.push('deadline');
  reject(()=>screenSyntheticBatch(b),'UNSUPPORTED_CLAIM_VALUE');
});
test('R1-10 missing optional supported claim may be omitted', () => {
  const b=copy();const rec=find(b);delete rec.public_values.cost_status;
  rec.approved_claims=rec.approved_claims.filter(k=>k!=='cost_status');
  const x=outcome(b,'SYN-LEARN-01');assert.equal(x.status,'CONTRACT_CANDIDATE');assert.equal('cost_status' in x.preview,false);
});
test('R1-11 missing required consequential claim fails affected output', () => {
  const b=copy();const r=find(b);delete r.public_values.summary_en;r.approved_claims=r.approved_claims.filter(x=>x!=='summary_en');
  reject(()=>screenSyntheticBatch(b),'MISSING_REQUIRED_CLAIM');
});
test('R1-12 claim value not supported by the independently frozen oracle fails', () => {
  const b=copy();find(b).public_values.summary_en='Unsupported assertion about guaranteed jobs.';
  reject(()=>screenSyntheticBatch(b),'UNSUPPORTED_CLAIM_VALUE');
});
test('R1-13 PT approval is not asserted and unexpected locale tokens are rejected', () => {
  const out=screenSyntheticBatch(copy());assert.equal(out.report.locale_approved_pt,false);
  const b=copy();find(b).locale_status='en_pt_approved_synthetic_only';reject(()=>screenSyntheticBatch(b),'AUTHORITY_OR_LOCALE_NOT_ALLOWED');
});
test('R1-14 unexpected digest/diff fails closed without writing anything', () => {
  const b=copy();const old=screenSyntheticBatch(b).digest;
  reject(()=>screenSyntheticBatch(b,{expectedDigest:'0'.repeat(64)}),'UNEXPECTED_DIFF');
  assert.equal(screenSyntheticBatch(b,{expectedDigest:old}).digest,old);
});
test('R1-15 functions do not mutate input or authoritative records', () => {
  const b=copy();const snapshot=structuredClone(b);
  screenSyntheticBatch(b);assert.deepEqual(b,snapshot);
  assert.equal(JSON.stringify(b).includes('Temporary pilot only'),false);
});
test('R1-16 output is screening-only; no routes or publishable manifest', () => {
  const out=screenSyntheticBatch(copy());assert.equal(out.report.production_authorized,false);
  assert.equal(JSON.stringify(out).includes('/trainings-tools/'),false);
  assert.equal(JSON.stringify(out).includes('/pt/trainings-tools/'),false);
  assert.equal(out.report.results.filter(x=>x.status==='CONTRACT_CANDIDATE').length,5);
  assert.equal(out.report.results.filter(x=>x.status==='HOLD').length,2);
  assert.equal(out.report.results.filter(x=>x.status==='SUPPRESS').length,1);
});

// Independent security regressions identified by the N1 review.
test('SEC-01 title substitution bypass from N1 is now rejected', () => {
  const b=copy();find(b).public_values.title_en='Unapproved title offering instant funding';
  reject(()=>screenSyntheticBatch(b),'UNSUPPORTED_CLAIM_VALUE');
});
test('SEC-02 HTTPS action URL redirection bypass from N1 is now rejected', () => {
  const b=copy();find(b).public_values.action_url='https://attacker.example.invalid/collect';
  reject(()=>screenSyntheticBatch(b),'UNSUPPORTED_CLAIM_VALUE');
});
test('SEC-03 same-domain path redirection also rejected', () => {
  const b=copy();find(b).public_values.action_url='https://learning.example.invalid/collect';
  reject(()=>screenSyntheticBatch(b),'UNSUPPORTED_CLAIM_VALUE');
});
test('SEC-04 value and claim-key edited together do not override oracle', () => {
  const b=copy();const r=find(b);r.public_values.title_en='Unapproved branded title';
  r.approved_claims.push('not_in_oracle');
  reject(()=>screenSyntheticBatch(b),'UNSUPPORTED_CLAIM_VALUE');
});
test('SEC-05 independently attested synthetic relationship supported; invented row rejected', () => {
  const sample={relationship_id:'SYN-REL-GATE-OPERATOR',record_id:'SYN-GATE-04',provider_id:'SYN-PROV-GATE',role:'operator',related_provider_id:'SYN-PROV-GATE-OP',evidence_ref:'SYN-REL-EVIDENCE-GATE'};
  assert.deepEqual(verifySyntheticRelationships('SYN-GATE-04','SYN-PROV-GATE',[sample]),[sample]);
  const b=copy();find(b,'SYN-GATE-04').provider_relationships=[sample];assert.equal(outcome(b,'SYN-GATE-04').status,'CONTRACT_CANDIDATE');
  const rogue=copy();find(rogue,'SYN-GATE-04').provider_relationships=[{...sample,related_provider_id:'SYN-PROV-ATTACKER'}];
  reject(()=>screenSyntheticBatch(rogue),'UNVERIFIED_RELATIONSHIP');
});
test('SEC-06 duplicate relationships rejected; empty list valid', () => {
  assert.deepEqual(verifySyntheticRelationships('SYN-GATE-04','SYN-PROV-GATE',[]),[]);
  const r={relationship_id:'SYN-REL-GATE-OPERATOR',record_id:'SYN-GATE-04',provider_id:'SYN-PROV-GATE',role:'operator',related_provider_id:'SYN-PROV-GATE-OP',evidence_ref:'SYN-REL-EVIDENCE-GATE'};
  reject(()=>verifySyntheticRelationships('SYN-GATE-04','SYN-PROV-GATE',[r,r]),'DUPLICATE_RELATIONSHIP');
});
test('SEC-07 material source conflict causes HOLD even if record otherwise passes', () => {
  const b=copy();find(b).material_conflict=true;
  assert.equal(outcome(b,'SYN-LEARN-01').status,'HOLD');
});
test('SEC-08 Revalidation Due is a conservative N2 HOLD, not automatic expiry', () => {
  assert.deepEqual(classifyCurrentness('Revalidation Due','Public-Safe Approved'),{status:'HOLD',reason:'REVALIDATION_PENDING'});
});
test('SEC-09 unexpected family or synthetic permission override rejected', () => {
  const b=copy();find(b).record_family='fixed_window_opportunity';reject(()=>screenSyntheticBatch(b),'UNAPPROVED_FAMILY');
  const c=copy();find(c).project03_disposition='production_approved';reject(()=>screenSyntheticBatch(c),'AUTHORITY_OR_LOCALE_NOT_ALLOWED');
});
test('SEC-10 source URL change is rejected as firmly as action URL', () => {
  const b=copy();find(b).public_values.source_url='https://unrelated.example.invalid';
  reject(()=>screenSyntheticBatch(b),'UNSUPPORTED_CLAIM_VALUE');
});
test('SEC-11 duplicate site slug rejected', () => {
  const b=copy();find(b,'SYN-SKILLS-02').site_slug='synthetic-learning';reject(()=>screenSyntheticBatch(b),'DUPLICATE_SLUG');
});
test('SEC-12 no network/write APIs imported by production-independent adapter', () => {
  const text=readFileSync(fileURLToPath(new URL('./nonpublic-adapter.mjs',import.meta.url)),'utf8');
  assert.equal(/from ['"]node:(fs|https|http|net|child_process)['"]/.test(text),false);
  assert.equal(/\b(fetch|writeFile|execSync|spawnSync|process\.env)\b/.test(text),false);
  assert.equal(text.includes("from 'node:crypto'"),true);
});
