#!/usr/bin/env node
// Verifies that the committed Things-to-Do trust anchor still describes the
// committed policy, and that the normalized-fact registry can express every
// predicate the policy consumes.
//
// This is the drift gate: a policy edit that is not accompanied by a matching,
// separately reviewed anchor update makes the evaluator fail closed at runtime,
// and makes this validator fail in CI.

import process from 'node:process';
import { digest, isAdmissibleDenseArray, deepEqual } from './lib/ttd-canonical-json.mjs';
import {
  loadPolicy,
  loadTrustAnchor,
  deriveTrustedFactPolicy,
  normalizeFactConsistencyConstraints,
  REQUIRED_FACT_CONSISTENCY_CONSTRAINTS,
  REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES
} from './lib/ttd-policy-evaluator.mjs';
import { loadFactRegistry } from './lib/ttd-normalizer.mjs';

const errors = [];
const add = (condition, message) => { if (!condition) errors.push(message); };

let policy;
let anchor;
let registry;
try {
  policy = loadPolicy();
  anchor = loadTrustAnchor();
  registry = loadFactRegistry();
} catch (error) {
  console.error(`TTD_TRUST_ANCHOR_VALIDATION_FAILED: ${error.message}`);
  process.exit(1);
}

add(anchor.policy_id === policy.policy_id, 'trust anchor policy_id does not match the committed policy');
add(anchor.version === policy.version, 'trust anchor version does not match the committed policy');
add(anchor.domain === policy.domain, 'trust anchor domain does not match the committed policy');
add(anchor.approval_reference === policy.authority.approval_reference, 'trust anchor approval_reference does not match the committed policy');
add(anchor.approved_owner === policy.authority.owner, 'trust anchor approved_owner does not match the committed policy');
add(anchor.technical_interpreter === policy.authority.technical_interpreter, 'trust anchor technical_interpreter does not match the committed policy');

const computed = digest(policy);
add(anchor.content_sha256 === computed, `trust anchor content_sha256 ${anchor.content_sha256} does not match the committed policy digest ${computed}`);

add(isAdmissibleDenseArray(policy.rules), 'the committed policy rule set must be a dense array');
add(isAdmissibleDenseArray(anchor.rule_ids), 'trust anchor rule_ids must be a dense array');
add(isAdmissibleDenseArray(registry.predicates), 'the fact registry predicate set must be a dense array');
const policyRuleIds = policy.rules.map((rule) => rule.rule_id).sort();
add(JSON.stringify(anchor.rule_ids) === JSON.stringify(policyRuleIds), 'trust anchor rule_ids do not match the committed policy rule set');

// Every predicate the policy consumes must be expressible by the normalizer.
const registryByName = new Map(registry.predicates.map((predicate) => [predicate.name, predicate]));
for (const rule of policy.rules) {
  for (const [name, declared] of Object.entries(rule.when)) {
    const predicate = registryByName.get(name);
    add(predicate !== undefined, `${rule.rule_id} consumes predicate ${name}, which the fact registry does not declare`);
    if (predicate === undefined) continue;
    if (typeof declared === 'boolean') {
      add(predicate.type === 'boolean', `${rule.rule_id} compares ${name} to a boolean but the registry declares ${predicate.type}`);
    } else if (typeof declared === 'string') {
      add(predicate.type === 'enum', `${rule.rule_id} compares ${name} to a string but the registry declares ${predicate.type}`);
      add(Array.isArray(predicate.enum) && predicate.enum.includes(declared),
        `${rule.rule_id} compares ${name} to ${declared}, which the registry enum does not declare`);
    } else {
      add(false, `${rule.rule_id} declares an unsupported predicate value type for ${name}`);
    }
  }
}

// The standards boundary must remain derived, never directly assertable.
const standards = registryByName.get('standards_boundary_unresolved');
add(standards !== undefined, 'the fact registry must declare standards_boundary_unresolved');
add(standards?.directly_assertable === false, 'standards_boundary_unresolved must not be directly assertable');
add(standards?.conservative_absent_value === true, 'an absent standards classification must fail closed to true');

// Exact semantic integrity of the trusted fact-policy configuration, not merely
// its shape. The evaluator enforces the pinned MATERIAL_ELIGIBILITY set and the
// pinned constraint identities at run time, so a registry edit that narrows,
// empties or reclassifies either one must fail here rather than silently
// weakening enforcement. Presence alone is not sufficient evidence of identity.
let derivedFactPolicy = null;
try {
  derivedFactPolicy = deriveTrustedFactPolicy(registry);
} catch (error) {
  add(false, `the fact registry does not yield the trusted fact-policy configuration: ${error.message}`);
}
if (derivedFactPolicy !== null) {
  add(deepEqual(derivedFactPolicy.materialPredicates, REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES),
    'the registry MATERIAL_ELIGIBILITY predicate set is not identical to the pinned trusted set');
  add(deepEqual(derivedFactPolicy.factConsistencyConstraints, normalizeFactConsistencyConstraints(REQUIRED_FACT_CONSISTENCY_CONSTRAINTS)),
    'the registry fact-consistency constraints are not identical to the pinned trusted constraints');
}
for (const name of REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES) {
  const predicate = registryByName.get(name);
  add(predicate !== undefined, `the pinned material predicate ${name} is not declared by the fact registry`);
  add(predicate?.materiality === 'MATERIAL_ELIGIBILITY',
    `${name} must remain MATERIAL_ELIGIBILITY; a downgrade would remove it from unknown-dependency enforcement`);
}
for (const predicate of Array.isArray(registry.predicates) ? registry.predicates : []) {
  add(predicate.materiality === 'MATERIAL_ELIGIBILITY' || predicate.materiality === 'OPERATIONAL',
    `${String(predicate.name)} declares an unknown materiality ${String(predicate.materiality)}`);
  if (predicate.materiality === 'MATERIAL_ELIGIBILITY') {
    add(REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES.includes(predicate.name),
      `${predicate.name} is MATERIAL_ELIGIBILITY in the registry but is not in the pinned trusted set`);
  }
}

// Declared fact-consistency constraints must reference real predicates with
// type-correct values, so contradiction enforcement cannot silently no-op.
const constraints = registry.fact_consistency_constraints;
add(Array.isArray(constraints) && constraints.length > 0, 'the fact registry must declare at least one fact-consistency constraint');
for (const constraint of Array.isArray(constraints) ? constraints : []) {
  add(typeof constraint.constraint_id === 'string' && constraint.constraint_id.length > 0, 'every fact-consistency constraint needs a constraint_id');
  add(typeof constraint.reason_code === 'string' && constraint.reason_code.length > 0, `${constraint.constraint_id}: needs a reason_code`);
  const combination = constraint.forbidden_combination;
  add(combination !== null && typeof combination === 'object' && !Array.isArray(combination) && Object.keys(combination).length >= 2,
    `${constraint.constraint_id}: forbidden_combination must name at least two predicates`);
  for (const [name, value] of Object.entries(combination ?? {})) {
    const predicate = registryByName.get(name);
    add(predicate !== undefined, `${constraint.constraint_id}: references unknown predicate ${name}`);
    if (predicate === undefined) continue;
    if (predicate.type === 'boolean') add(typeof value === 'boolean', `${constraint.constraint_id}: ${name} must be compared to a boolean`);
    else add(Array.isArray(predicate.enum) && predicate.enum.includes(value), `${constraint.constraint_id}: ${name} must be compared to a declared enum value`);
  }
}
add(Array.isArray(constraints) && constraints.some((constraint) =>
  constraint.forbidden_combination?.materially_current === true && constraint.forbidden_combination?.candidate_already_ended === true),
  'the registry must forbid materially_current=true alongside candidate_already_ended=true');

if (errors.length > 0) {
  for (const error of errors) console.error(`TTD_TRUST_ANCHOR_VALIDATION_FAILED: ${error}`);
  process.exit(1);
}

console.log('TTD_TRUST_ANCHOR_VALIDATION_OK');
console.log(`policy=${policy.policy_id}@${policy.version}`);
console.log(`content_sha256=${computed}`);
console.log(`rules=${policyRuleIds.length}`);
console.log(`registry_predicates=${registry.predicates.length}`);
console.log(`material_eligibility_predicates=${REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES.length}`);
console.log(`fact_consistency_constraints=${registry.fact_consistency_constraints.length}`);
