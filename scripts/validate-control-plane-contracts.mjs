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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported external $ref ${ref}`);
  return ref.slice(2).split('/').reduce((node, part) => node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], rootSchema);
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function validateSchema(value, schema, rootSchema, at = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return [`${at}: invalid schema node`];

  if (schema.$ref) {
    const target = resolveRef(rootSchema, schema.$ref);
    if (!target) return [`${at}: unresolved $ref ${schema.$ref}`];
    return validateSchema(value, target, rootSchema, at);
  }

  if (schema.oneOf) {
    const branches = schema.oneOf.map((branch) => validateSchema(value, branch, rootSchema, at));
    const passing = branches.filter((branchErrors) => branchErrors.length === 0).length;
    if (passing !== 1) errors.push(`${at}: must match exactly one oneOf branch; matched ${passing}`);
    return errors;
  }

  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${at}: must equal const ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${at}: value ${JSON.stringify(value)} not in enum`);
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${at}: expected type ${types.join('|')}`);
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: string shorter than minLength ${schema.minLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${at}: does not match pattern ${schema.pattern}`);
    if (schema.format === 'uri') {
      try { new URL(value); } catch { errors.push(`${at}: invalid uri`); }
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${at}: invalid date-time`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.uniqueItems) {
      const encoded = value.map((item) => JSON.stringify(item));
      if (new Set(encoded).size !== encoded.length) errors.push(`${at}: duplicate array item`);
    }
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, rootSchema, `${at}[${index}]`)));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${at}: fewer than ${schema.minProperties} properties`);
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) errors.push(`${at}: missing required property ${required}`);
    }
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) errors.push(...validateSchema(child, properties[key], rootSchema, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`);
    }
  }

  return errors;
}

function semanticErrors(taskSchema, policySchema, policy, fixture) {
  const errors = [];
  const add = (condition, message) => { if (!condition) errors.push(message); };

  add(policy.policy_id === 'APRASA_TTD_EDITORIAL_V1', 'unexpected Things to Do policy_id');
  add(policy.version === '1.0.0', 'Things to Do policy version must be 1.0.0');
  add(policy.domain === 'THINGS_TO_DO', 'Things to Do policy domain mismatch');
  add(policy.default_disposition === 'HOLD', 'policy must fail closed with default HOLD');
  add(policy.authority?.owner === 'PROJECT_03', 'Project 03 must remain policy owner');
  add(policy.authority?.technical_interpreter === 'PROJECT_04', 'Project 04 must remain technical interpreter');
  add(Boolean(policy.authority?.approval_reference), 'policy must carry a governance approval reference');

  add(policy.composition?.predicate_semantics === 'ALL_DECLARED_PREDICATES_MUST_BE_PRESENT_AND_EQUAL', 'predicate semantics must fail closed on absent/mismatched inputs');
  add(policy.composition?.unknown_material_input === 'HOLD', 'unknown material input must HOLD');
  add(policy.composition?.deferred_match === 'HOLD_AND_BLOCK', 'DEFERRED rule match must HOLD and block');
  add(policy.composition?.blocking_is_monotonic === true, 'publication blocking must be monotonic');
  add(policy.composition?.no_change_is_non_clearing === true, 'NO_CHANGE must be non-clearing');
  add(JSON.stringify(policy.composition?.disposition_precedence) === JSON.stringify(['HOLD', 'REJECT', 'SELECT', 'NO_CHANGE']), 'unexpected disposition precedence');

  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const ruleIds = rules.map((rule) => rule.rule_id);
  add(new Set(ruleIds).size === ruleIds.length, 'policy rule_id values must be unique');

  const requiredRuleIds = [
    'TTD-ELIG-001', 'TTD-EVID-001', 'TTD-EVID-002', 'TTD-FACT-001', 'TTD-FACT-002',
    'TTD-DATE-001', 'TTD-MEDIA-001', 'TTD-SOURCE-001', 'TTD-COPY-001', 'TTD-COMM-001',
    'TTD-COMM-002', 'TTD-COMM-003', 'TTD-COMM-004', 'TTD-CURRENT-001', 'TTD-GOV-001', 'TTD-GOV-002'
  ];
  for (const id of requiredRuleIds) add(ruleIds.includes(id), `policy missing required baseline rule ${id}`);

  for (const forbiddenId of ['TTD-EXCL-001', 'TTD-EXCL-002', 'TTD-EXCL-003', 'TTD-EXCL-004', 'TTD-EXCL-005']) {
    add(!ruleIds.includes(forbiddenId), `${forbiddenId} is not approved for machine-enforced v1 rejection`);
  }

  const byId = Object.fromEntries(rules.map((rule) => [rule.rule_id, rule]));
  const eligible = byId['TTD-ELIG-001'];
  add(eligible?.status === 'ACTIVE', 'TTD-ELIG-001 must be ACTIVE');
  add(Object.keys(eligible?.when || {}).length >= 8, 'TTD-ELIG-001 selection predicate is unexpectedly weak');
  for (const key of ['material_source_conflict', 'required_authority_missing', 'standards_boundary_unresolved', 'commercial_primary_proposition']) {
    add(eligible?.when?.[key] === false, `TTD-ELIG-001 must explicitly require ${key}=false`);
  }

  const gov = byId['TTD-GOV-001'];
  add(gov?.when?.required_authority_missing === true, 'TTD-GOV-001 must match required_authority_missing=true');
  add(gov?.result?.disposition === 'HOLD' && gov?.result?.publication_blocked === true, 'missing governing authority must HOLD and block');

  const standards = byId['TTD-GOV-002'];
  add(standards?.when?.standards_boundary_unresolved === true, 'TTD-GOV-002 must match unresolved standards boundary');
  add(standards?.result?.disposition === 'HOLD' && standards?.result?.publication_blocked === true, 'unresolved standards boundary must HOLD and block');

  const admission = byId['TTD-FACT-001'];
  add(admission?.result?.field_actions?.admission === 'OMIT', 'unknown admission must be omitted');
  add(admission?.result?.field_actions?.free_admission === null, 'unknown admission must not infer free_admission');

  const commercial = byId['TTD-COMM-003'];
  add(commercial?.status === 'DEFERRED', 'TTD-COMM-003 must remain DEFERRED');
  add(commercial?.human_review === true, 'TTD-COMM-003 must remain human-review gated');
  add(commercial?.result?.disposition === 'HOLD' && commercial?.result?.publication_blocked === true, 'TTD-COMM-003 must HOLD and block');

  for (const rule of rules.filter((item) => item.result?.disposition === 'NO_CHANGE')) {
    add(rule.result.publication_blocked === false, `${rule.rule_id} NO_CHANGE rule must not itself create a publication block`);
  }

  const mandatoryProhibitions = ['INVENT_FACTS', 'INVENT_POLICY', 'MERGE', 'DEPLOY', 'DELETE_BRANCH', 'PUBLISH_EXTERNAL_MESSAGE', 'CHANGE_GOVERNANCE'];
  for (const token of mandatoryProhibitions) add(fixture.prohibited_actions?.includes(token), `fixture must prohibit ${token}`);
  add(!fixture.allowed_actions?.includes('MERGE'), 'fixture must never allow MERGE');
  add(fixture.authority?.authority_resolution === 'TRUSTED_RESOLVED', 'fixture authority must be explicitly trusted/resolved');

  const repoWriteActions = new Set(['WRITE_BRANCH', 'COMMIT', 'PUSH', 'OPEN_DRAFT_PR']);
  const hasRepoWrite = fixture.allowed_actions?.some((action) => repoWriteActions.has(action));
  if (hasRepoWrite) add(/^[0-9a-f]{40}$/.test(fixture.authority?.expected_main_sha || ''), 'repository-writing task requires expected_main_sha');

  add(Array.isArray(taskSchema.required) && taskSchema.required.includes('required_worker_role'), 'task envelope schema must require required_worker_role');
  add(Array.isArray(policySchema.required) && policySchema.required.includes('composition'), 'adjudication policy schema must require composition');

  return errors;
}

function validateAll(taskSchema, policySchema, policy, fixture) {
  return [
    ...validateSchema(fixture, taskSchema, taskSchema, '$task'),
    ...validateSchema(policy, policySchema, policySchema, '$policy'),
    ...semanticErrors(taskSchema, policySchema, policy, fixture)
  ];
}

for (const file of Object.values(files)) {
  if (!fs.existsSync(file)) {
    console.error(`CONTROL_PLANE_VALIDATION_FAILED: missing required file ${path.relative(root, file)}`);
    process.exit(1);
  }
}

let taskSchema;
let policySchema;
let policy;
let fixture;
try {
  taskSchema = readJson(files.taskSchema);
  policySchema = readJson(files.policySchema);
  policy = readJson(files.policy);
  fixture = readJson(files.fixture);
} catch (error) {
  console.error(`CONTROL_PLANE_VALIDATION_FAILED: ${error.message}`);
  process.exit(1);
}

const baselineErrors = validateAll(taskSchema, policySchema, policy, fixture);
if (baselineErrors.length) {
  for (const error of baselineErrors) console.error(`CONTROL_PLANE_VALIDATION_FAILED: ${error}`);
  process.exit(1);
}

function expectNegative(name, mutate) {
  const mutatedPolicy = deepClone(policy);
  const mutatedFixture = deepClone(fixture);
  mutate(mutatedPolicy, mutatedFixture);
  const errors = validateAll(taskSchema, policySchema, mutatedPolicy, mutatedFixture);
  if (!errors.length) throw new Error(`negative regression unexpectedly passed: ${name}`);
}

try {
  expectNegative('invalid task role/status/routing and MERGE permission', (_policy, task) => {
    task.required_worker_role = 'NOT_A_ROLE';
    task.status = 'NOT_A_STATUS';
    task.allowed_actions.push('MERGE');
    task.routing = {};
  });
  expectNegative('missing governing authority changed to SELECT', (mutatedPolicy) => {
    const rule = mutatedPolicy.rules.find((item) => item.rule_id === 'TTD-GOV-001');
    rule.result.disposition = 'SELECT';
    rule.result.publication_blocked = false;
  });
  expectNegative('selection predicate emptied', (mutatedPolicy) => {
    mutatedPolicy.rules.find((item) => item.rule_id === 'TTD-ELIG-001').when = {};
  });
  expectNegative('approved required operational rules removed', (mutatedPolicy) => {
    mutatedPolicy.rules = mutatedPolicy.rules.filter((item) => !['TTD-FACT-002', 'TTD-DATE-001', 'TTD-MEDIA-001', 'TTD-SOURCE-001', 'TTD-COPY-001', 'TTD-COMM-004'].includes(item.rule_id));
  });
  expectNegative('unapproved machine exclusion reintroduced', (mutatedPolicy) => {
    mutatedPolicy.rules.push({
      rule_id: 'TTD-EXCL-001', status: 'ACTIVE', description: 'synthetic forbidden exclusion',
      when: { category: 'SYNTHETIC' },
      result: { disposition: 'REJECT', publication_blocked: true, reason_code: 'SYNTHETIC' },
      human_review: false, authority_refs: ['SYNTHETIC']
    });
  });
  expectNegative('deferred commercial boundary made non-blocking', (mutatedPolicy) => {
    const rule = mutatedPolicy.rules.find((item) => item.rule_id === 'TTD-COMM-003');
    rule.status = 'ACTIVE';
    rule.human_review = false;
    rule.result.publication_blocked = false;
  });
  expectNegative('duplicate rule id', (mutatedPolicy) => {
    mutatedPolicy.rules.push(deepClone(mutatedPolicy.rules[0]));
  });
} catch (error) {
  console.error(`CONTROL_PLANE_VALIDATION_FAILED: ${error.message}`);
  process.exit(1);
}

console.log('CONTROL_PLANE_VALIDATION_OK');
console.log(`policy=${policy.policy_id}@${policy.version}`);
console.log(`rules=${policy.rules.length}`);
console.log(`fixture=${fixture.task_id}`);
console.log('negative_regressions=7/7 rejected');
