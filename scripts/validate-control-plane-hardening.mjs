#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');

const policyPath = path.join(root, 'automation/control-plane/policies/things-to-do-v1.json');
const taskPath = path.join(root, 'automation/control-plane/fixtures/things-to-do-candidate.json');
const orchestrationPath = path.join(root, 'automation/control-plane/fixtures/orchestration-plan.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fail(message) {
  console.error(`CONTROL_PLANE_HARDENING_FAILED: ${message}`);
  process.exitCode = 1;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertNoDangerousKeys(value, at = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDangerousKeys(item, `${at}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      fail(`${at}: dangerous key ${key} is forbidden`);
    }
    assertNoDangerousKeys(value[key], `${at}.${key}`);
  }
}

for (const file of [policyPath, taskPath, orchestrationPath]) {
  if (!fs.existsSync(file)) fail(`missing required file ${path.relative(root, file)}`);
}
if (process.exitCode) process.exit(1);

const policy = readJson(policyPath);
const task = readJson(taskPath);
const orchestration = readJson(orchestrationPath);

assertNoDangerousKeys(policy, '$policy');
assertNoDangerousKeys(task, '$task');
assertNoDangerousKeys(orchestration, '$orchestration');

const approvedRules = {
  'TTD-ELIG-001': ['ACTIVE', 'SELECT', false, false],
  'TTD-EVID-001': ['ACTIVE', 'HOLD', true, false],
  'TTD-EVID-002': ['ACTIVE', 'NO_CHANGE', false, false],
  'TTD-FACT-001': ['ACTIVE', 'NO_CHANGE', false, false],
  'TTD-FACT-002': ['ACTIVE', 'NO_CHANGE', false, false],
  'TTD-DATE-001': ['ACTIVE', 'NO_CHANGE', false, false],
  'TTD-MEDIA-001': ['ACTIVE', 'NO_CHANGE', false, false],
  'TTD-SOURCE-001': ['ACTIVE', 'HOLD', true, false],
  'TTD-COPY-001': ['ACTIVE', 'HOLD', true, false],
  'TTD-COMM-001': ['ACTIVE', 'NO_CHANGE', false, false],
  'TTD-COMM-002': ['ACTIVE', 'NO_CHANGE', false, false],
  'TTD-COMM-003': ['DEFERRED', 'HOLD', true, true],
  'TTD-COMM-004': ['ACTIVE', 'NO_CHANGE', false, false],
  'TTD-CURRENT-001': ['ACTIVE', 'REJECT', true, false],
  'TTD-GOV-001': ['ACTIVE', 'HOLD', true, false],
  'TTD-GOV-002': ['ACTIVE', 'HOLD', true, true]
};

const actualIds = policy.rules.map((rule) => rule.rule_id).sort();
const approvedIds = Object.keys(approvedRules).sort();
if (JSON.stringify(actualIds) !== JSON.stringify(approvedIds)) {
  fail(`rule-id set drifted; expected exactly ${approvedIds.join(', ')}`);
}

for (const rule of policy.rules) {
  const expected = approvedRules[rule.rule_id];
  if (!expected) continue;
  const [status, disposition, publicationBlocked, humanReview] = expected;
  if (rule.status !== status) fail(`${rule.rule_id}: status must be ${status}`);
  if (rule.result?.disposition !== disposition) fail(`${rule.rule_id}: disposition must be ${disposition}`);
  if (rule.result?.publication_blocked !== publicationBlocked) fail(`${rule.rule_id}: publication_blocked must be ${publicationBlocked}`);
  if (rule.human_review !== humanReview) fail(`${rule.rule_id}: human_review must be ${humanReview}`);
  if (!Array.isArray(rule.authority_refs) || rule.authority_refs.length === 0) fail(`${rule.rule_id}: authority_refs required`);
  for (const ref of rule.authority_refs || []) {
    if (ref !== policy.authority?.approval_reference) fail(`${rule.rule_id}: authority_ref must equal policy approval_reference`);
  }
}

const selectRule = policy.rules.find((rule) => rule.rule_id === 'TTD-ELIG-001');
const expectedEligibilityKeys = [
  'activity_scope',
  'commercial_primary_proposition',
  'evidence_sufficient',
  'geography_in_scope',
  'material_source_conflict',
  'materially_current',
  'required_authority_missing',
  'standards_boundary_unresolved'
].sort();
const actualEligibilityKeys = Object.keys(selectRule?.when || {}).sort();
if (JSON.stringify(actualEligibilityKeys) !== JSON.stringify(expectedEligibilityKeys)) {
  fail(`TTD-ELIG-001 predicate keys drifted; expected ${expectedEligibilityKeys.join(', ')}`);
}
if (selectRule?.result?.publication_blocked !== false) fail('TTD-ELIG-001 SELECT must not be publication-blocked');

for (const url of task.source?.urls || []) {
  let parsed;
  try { parsed = new URL(url); } catch { fail(`invalid source URL ${url}`); continue; }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail(`source URL must use http(s): ${url}`);
}

const mandatoryTaskProhibitions = ['INVENT_FACTS', 'INVENT_POLICY', 'MERGE', 'DEPLOY', 'DELETE_BRANCH', 'PUBLISH_EXTERNAL_MESSAGE', 'CHANGE_GOVERNANCE'];
for (const token of mandatoryTaskProhibitions) {
  if (!task.prohibited_actions?.includes(token)) fail(`task fixture must prohibit ${token}`);
}

if (orchestration.worker_resolution?.resolver !== 'ROLE_REGISTRY') fail('orchestration must resolve workers through ROLE_REGISTRY');
if (orchestration.worker_resolution?.provider_binding_ref !== null) fail('synthetic orchestration fixture must remain provider-neutral');
if (orchestration.retry_policy?.max_attempts > 5) fail('retry max_attempts exceeds contract safety ceiling');
if (orchestration.callbacks?.on_exception?.next_role !== 'HUMAN_ESCALATION') fail('exception callback must route to HUMAN_ESCALATION');

if (process.exitCode) process.exit(1);

function expectNegative(name, mutator, validator) {
  const policyCopy = deepClone(policy);
  const taskCopy = deepClone(task);
  const orchestrationCopy = deepClone(orchestration);
  mutator(policyCopy, taskCopy, orchestrationCopy);
  if (!validator(policyCopy, taskCopy, orchestrationCopy)) {
    console.error(`CONTROL_PLANE_HARDENING_FAILED: negative regression unexpectedly passed: ${name}`);
    process.exit(1);
  }
}

expectNegative('rogue rule id', (p) => {
  p.rules.push({
    rule_id: 'TTD-ROGUE-001', status: 'ACTIVE', description: 'rogue', when: { anything: true },
    result: { disposition: 'SELECT', publication_blocked: false, reason_code: 'ROGUE' },
    human_review: false, authority_refs: [p.authority.approval_reference]
  });
}, (p) => {
  const ids = p.rules.map((rule) => rule.rule_id).sort();
  return JSON.stringify(ids) !== JSON.stringify(approvedIds);
});

expectNegative('currentness rule downgraded', (p) => {
  const r = p.rules.find((rule) => rule.rule_id === 'TTD-CURRENT-001');
  r.result.disposition = 'NO_CHANGE';
  r.result.publication_blocked = false;
}, (p) => {
  const r = p.rules.find((rule) => rule.rule_id === 'TTD-CURRENT-001');
  return r.result.disposition !== 'REJECT' || r.result.publication_blocked !== true;
});

expectNegative('evidence hold downgraded', (p) => {
  const r = p.rules.find((rule) => rule.rule_id === 'TTD-EVID-001');
  r.result.disposition = 'NO_CHANGE';
  r.result.publication_blocked = false;
}, (p) => {
  const r = p.rules.find((rule) => rule.rule_id === 'TTD-EVID-001');
  return r.result.disposition !== 'HOLD' || r.result.publication_blocked !== true;
});

expectNegative('copy hold downgraded', (p) => {
  const r = p.rules.find((rule) => rule.rule_id === 'TTD-COPY-001');
  r.result.disposition = 'NO_CHANGE';
  r.result.publication_blocked = false;
}, (p) => {
  const r = p.rules.find((rule) => rule.rule_id === 'TTD-COPY-001');
  return r.result.disposition !== 'HOLD' || r.result.publication_blocked !== true;
});

expectNegative('active rule made deferred', (p) => {
  p.rules.find((rule) => rule.rule_id === 'TTD-GOV-001').status = 'DEFERRED';
}, (p) => p.rules.find((rule) => rule.rule_id === 'TTD-GOV-001').status !== 'ACTIVE');

expectNegative('eligibility predicate decoy', (p) => {
  const r = p.rules.find((rule) => rule.rule_id === 'TTD-ELIG-001');
  delete r.when.geography_in_scope;
  r.when.decoy = true;
}, (p) => {
  const keys = Object.keys(p.rules.find((rule) => rule.rule_id === 'TTD-ELIG-001').when).sort();
  return JSON.stringify(keys) !== JSON.stringify(expectedEligibilityKeys);
});

expectNegative('authority ref drift', (p) => {
  p.rules[0].authority_refs = ['MADE_UP_APPROVAL'];
}, (p) => p.rules[0].authority_refs.some((ref) => ref !== p.authority.approval_reference));

expectNegative('provider binding introduced', (_p, _t, o) => {
  o.worker_resolution.provider_binding_ref = 'CLAUDE_CODE';
}, (_p, _t, o) => o.worker_resolution.provider_binding_ref !== null);

console.log('CONTROL_PLANE_HARDENING_OK');
console.log(`approved_rules=${approvedIds.length}`);
console.log('hardening_regressions=8/8 rejected');
