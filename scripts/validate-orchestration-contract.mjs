#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const schemaPath = path.join(root, 'automation/control-plane/orchestration-contract.schema.json');
const fixturePath = path.join(root, 'automation/control-plane/fixtures/orchestration-plan.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${at}: must equal const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) errors.push(`${at}: value ${JSON.stringify(value)} not in enum`);

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${at}: expected type ${types.join('|')}`);
      return errors;
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: string shorter than minLength ${schema.minLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${at}: does not match pattern ${schema.pattern}`);
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${at}: invalid date-time`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: must contain at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems) {
      const encoded = value.map((item) => JSON.stringify(item));
      if (new Set(encoded).size !== encoded.length) errors.push(`${at}: duplicate array item`);
    }
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, rootSchema, `${at}[${index}]`)));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) errors.push(`${at}: missing required property ${required}`);
    }
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) errors.push(...validateSchema(child, properties[key], rootSchema, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`);
    }
  }

  return errors;
}

function validateSemantics(fixture) {
  const errors = [];
  if (fixture.worker_resolution?.resolver !== 'ROLE_REGISTRY') errors.push('$orchestration.worker_resolution.resolver must be ROLE_REGISTRY');
  if (fixture.worker_resolution?.provider_binding_ref !== null) errors.push('$orchestration must remain provider-neutral in the synthetic fixture');
  if (fixture.task_ref !== 'TTD-2026-EXAMPLE-001') errors.push('$orchestration.task_ref must match the synthetic task fixture');

  const authorityPrereq = (fixture.prerequisites || []).find((item) => item.kind === 'AUTHORITY');
  if (!authorityPrereq) errors.push('$orchestration requires an AUTHORITY prerequisite');
  if (authorityPrereq && authorityPrereq.ref !== 'APRASA_TTD_EDITORIAL_V1@1.0.0') errors.push('$orchestration authority prerequisite must reference APRASA_TTD_EDITORIAL_V1@1.0.0');
  if (authorityPrereq && authorityPrereq.required_state !== 'TRUSTED_RESOLVED') errors.push('$orchestration authority prerequisite must be TRUSTED_RESOLVED');

  if (fixture.callbacks?.on_success?.next_role !== 'POLICY_ADJUDICATOR') errors.push('$orchestration success callback must route to POLICY_ADJUDICATOR');
  if (fixture.callbacks?.on_success?.next_task_type !== 'POLICY_ADJUDICATION') errors.push('$orchestration success callback must route to POLICY_ADJUDICATION task type');
  if (fixture.callbacks?.on_failure?.next_status !== 'BLOCKED') errors.push('$orchestration failure callback must remain BLOCKED in the synthetic fixture');
  if (fixture.callbacks?.on_blocked?.next_status !== 'HOLD') errors.push('$orchestration blocked callback must remain HOLD in the synthetic fixture');
  if (fixture.callbacks?.on_exception?.next_role !== 'HUMAN_ESCALATION') errors.push('$orchestration exception callback must route to HUMAN_ESCALATION');
  if (fixture.callbacks?.on_exception?.next_task_type !== 'HUMAN_ESCALATION') errors.push('$orchestration exception callback must use HUMAN_ESCALATION task type');
  if (fixture.callbacks?.on_exception?.next_status !== 'ESCALATED') errors.push('$orchestration exception callback must remain ESCALATED in the synthetic fixture');

  if (fixture.retry_policy?.max_attempts > 5) errors.push('$orchestration retry max_attempts exceeds safety ceiling');

  const capabilities = fixture.worker_resolution?.capabilities || [];
  if (fixture.worker_resolution?.worker_role !== 'PUBLICATION_WRITER' && capabilities.some((capability) => ['CODE_WRITE', 'REPOSITORY_WRITE'].includes(capability))) {
    errors.push('$orchestration non-writer role cannot receive write capabilities');
  }

  if (!['PROJECT_04_CONTROL_TOWER', 'OWNING_GOVERNANCE_AUTHORITY', 'FOUNDER_APPROVAL_GATE'].includes(fixture.escalation_policy?.default_target)) {
    errors.push('$orchestration escalation default_target is outside approved control targets');
  }

  return errors;
}

if (!fs.existsSync(schemaPath) || !fs.existsSync(fixturePath)) {
  console.error('ORCHESTRATION_CONTRACT_VALIDATION_FAILED: missing schema or fixture');
  process.exit(1);
}

let schema;
let fixture;
try {
  schema = readJson(schemaPath);
  fixture = readJson(fixturePath);
} catch (error) {
  console.error(`ORCHESTRATION_CONTRACT_VALIDATION_FAILED: ${error.message}`);
  process.exit(1);
}

const errors = [
  ...validateSchema(fixture, schema, schema, '$orchestration'),
  ...validateSemantics(fixture)
];

if (errors.length) {
  for (const error of errors) console.error(`ORCHESTRATION_CONTRACT_VALIDATION_FAILED: ${error}`);
  process.exit(1);
}

console.log('ORCHESTRATION_CONTRACT_VALIDATION_OK');
console.log(`orchestration=${fixture.orchestration_id}`);
console.log(`task_ref=${fixture.task_ref}`);
console.log(`worker_role=${fixture.worker_resolution.worker_role}`);
