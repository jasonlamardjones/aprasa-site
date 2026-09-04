#!/usr/bin/env node
// Verifies that the committed Things-to-Do trust anchor still describes the
// committed policy, and that the normalized-fact registry can express every
// predicate the policy consumes.
//
// This is the drift gate: a policy edit that is not accompanied by a matching,
// separately reviewed anchor update makes the evaluator fail closed at runtime,
// and makes this validator fail in CI.

import process from 'node:process';
import { digest } from './lib/ttd-canonical-json.mjs';
import { loadPolicy, loadTrustAnchor } from './lib/ttd-policy-evaluator.mjs';
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

if (errors.length > 0) {
  for (const error of errors) console.error(`TTD_TRUST_ANCHOR_VALIDATION_FAILED: ${error}`);
  process.exit(1);
}

console.log('TTD_TRUST_ANCHOR_VALIDATION_OK');
console.log(`policy=${policy.policy_id}@${policy.version}`);
console.log(`content_sha256=${computed}`);
console.log(`rules=${policyRuleIds.length}`);
console.log(`registry_predicates=${registry.predicates.length}`);
