#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const files = {
  taskSchema: path.join(root, 'automation/control-plane/task-envelope.schema.json'),
  policySchema: path.join(root, 'automation/control-plane/adjudication-policy.schema.json'),
  policy: path.join(root, 'automation/control-plane/policies/things-to-do-v1.json'),
  fixture: path.join(root, 'automation/control-plane/fixtures/things-to-do-candidate.json')
};

function fail(message) {
  console.error(`CONTROL_PLANE_VALIDATION_FAILED: ${message}`);
  process.exitCode = 1;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${path.relative(root, file)}: ${error.message}`);
    return null;
  }
}

for (const file of Object.values(files)) {
  if (!fs.existsSync(file)) {
    fail(`missing required file ${path.relative(root, file)}`);
  }
}

if (process.exitCode) process.exit();

const taskSchema = readJson(files.taskSchema);
const policySchema = readJson(files.policySchema);
const policy = readJson(files.policy);
const fixture = readJson(files.fixture);
if (!taskSchema || !policySchema || !policy || !fixture) process.exit();

const requiredTaskFields = [
  'schema_version', 'task_id', 'task_type', 'domain', 'status', 'authority',
  'source', 'payload', 'required_worker_role', 'allowed_actions',
  'prohibited_actions', 'routing'
];
for (const key of requiredTaskFields) {
  if (!(key in fixture)) fail(`fixture missing required field ${key}`);
}

if (fixture.schema_version !== '1.0.0') fail('fixture schema_version must be 1.0.0');
if (fixture.domain !== 'THINGS_TO_DO') fail('fixture must target THINGS_TO_DO');
if (fixture.source?.intake_method !== 'MONITORING') fail('fixture intake_method must be MONITORING');

const mandatoryProhibitions = [
  'INVENT_FACTS', 'INVENT_POLICY', 'MERGE', 'DEPLOY', 'DELETE_BRANCH',
  'PUBLISH_EXTERNAL_MESSAGE', 'CHANGE_GOVERNANCE'
];
for (const token of mandatoryProhibitions) {
  if (!fixture.prohibited_actions?.includes(token)) {
    fail(`fixture must prohibit ${token}`);
  }
}

if (policy.policy_id !== 'APRASA_TTD_EDITORIAL_V1') fail('unexpected Things to Do policy_id');
if (policy.version !== '1.0.0') fail('Things to Do policy version must be 1.0.0');
if (policy.domain !== 'THINGS_TO_DO') fail('Things to Do policy domain mismatch');
if (policy.default_disposition !== 'HOLD') fail('policy must fail closed with default HOLD');
if (policy.authority?.owner !== 'PROJECT_03') fail('Project 03 must remain policy owner');
if (policy.authority?.technical_interpreter !== 'PROJECT_04') fail('Project 04 must remain technical interpreter');

const rules = Array.isArray(policy.rules) ? policy.rules : [];
if (!rules.length) fail('policy must contain rules');
const ruleIds = rules.map((rule) => rule.rule_id);
if (new Set(ruleIds).size !== ruleIds.length) fail('policy rule_id values must be unique');

const requiredRuleIds = [
  'TTD-ELIG-001',
  'TTD-EVID-001',
  'TTD-FACT-001',
  'TTD-COMM-001',
  'TTD-COMM-002',
  'TTD-COMM-003',
  'TTD-CURRENT-001',
  'TTD-GOV-001'
];
for (const id of requiredRuleIds) {
  if (!ruleIds.includes(id)) fail(`policy missing required baseline rule ${id}`);
}

const commercialDeferred = rules.find((rule) => rule.rule_id === 'TTD-COMM-003');
if (commercialDeferred?.status !== 'DEFERRED' || commercialDeferred?.human_review !== true) {
  fail('TTD-COMM-003 must remain DEFERRED and human-review gated until commercial automation policy is approved');
}

const admissionRule = rules.find((rule) => rule.rule_id === 'TTD-FACT-001');
if (admissionRule?.result?.field_actions?.admission !== 'OMIT') {
  fail('unknown admission must be omitted');
}
if (admissionRule?.result?.field_actions?.free_admission !== null) {
  fail('unknown admission must not infer free_admission');
}

const escalationClasses = new Set(policy.escalation_classes || []);
for (const required of [
  'NOVEL_POLICY_QUESTION',
  'HIGH_QUALITY_SOURCE_CONFLICT',
  'COMMERCIAL_POLICY_UNRESOLVED',
  'MEDIA_RIGHTS_UNRESOLVED',
  'LEGAL_OR_REPUTATIONAL_RISK',
  'AUTHORITY_CONFLICT',
  'AUTOMATION_CONFIDENCE_BELOW_THRESHOLD'
]) {
  if (!escalationClasses.has(required)) fail(`missing escalation class ${required}`);
}

if (!Array.isArray(taskSchema.required) || !taskSchema.required.includes('required_worker_role')) {
  fail('task envelope schema must require required_worker_role');
}
if (!Array.isArray(policySchema.required) || !policySchema.required.includes('rules')) {
  fail('adjudication policy schema must require rules');
}

if (process.exitCode) process.exit();
console.log('CONTROL_PLANE_VALIDATION_OK');
console.log(`policy=${policy.policy_id}@${policy.version}`);
console.log(`rules=${rules.length}`);
console.log(`fixture=${fixture.task_id}`);
