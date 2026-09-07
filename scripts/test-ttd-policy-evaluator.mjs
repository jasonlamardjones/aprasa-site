#!/usr/bin/env node
// Stage B acceptance: normalized facts -> policy evaluation.
//
// Inputs are the oracle's hand-authored normalized facts, not normalizer
// output, so evaluation is proven independently of stage A.

import fs from 'node:fs';
import { createHarness, normalizedFromOracle, TRUSTED_AUTHORITY_RESOLUTION, FIXED_EVALUATION_TIMESTAMP } from './lib/ttd-test-harness.mjs';
import { loadPolicy, loadTrustAnchor, evaluateNormalizedFacts, semanticFingerprint, deriveTrustedFactPolicy } from './lib/ttd-policy-evaluator.mjs';
import { loadFactRegistry } from './lib/ttd-normalizer.mjs';
import { digest } from './lib/ttd-canonical-json.mjs';

const harness = createHarness('TTD_POLICY_EVALUATION');
const oracle = JSON.parse(fs.readFileSync('automation/control-plane/fixtures/ttd-adjudication-oracle.json', 'utf8'));
const policy = loadPolicy();
const trustAnchor = loadTrustAnchor();
const registry = loadFactRegistry();
// Derived from the validated registry, never defaulted: there is no empty
// fallback for the trusted fact-policy configuration.
const trustedFactPolicy = deriveTrustedFactPolicy(registry);
const materialPredicates = trustedFactPolicy.materialPredicates;

// The committed trust anchor must describe the committed policy exactly.
harness.equal('trust anchor binds the approved policy identity', trustAnchor.policy_id, policy.policy_id);
harness.equal('trust anchor binds the approved policy version', trustAnchor.version, policy.version);
harness.equal('trust anchor binds the approval reference', trustAnchor.approval_reference, policy.authority.approval_reference);
harness.equal('trust anchor binds the policy content digest', trustAnchor.content_sha256, digest(policy));

const evaluate = (normalized) => evaluateNormalizedFacts({
  policy,
  trustAnchor,
  normalized,
  authorityResolution: TRUSTED_AUTHORITY_RESOLUTION,
  evaluatedAt: FIXED_EVALUATION_TIMESTAMP,
  materialPredicates,
  factConsistencyConstraints: trustedFactPolicy.factConsistencyConstraints
});

for (const fixture of oracle.fixtures) {
  const id = fixture.fixture_id;
  const expected = fixture.expected_evaluation;
  const result = evaluate(normalizedFromOracle(fixture));

  harness.equal(`${id}: evaluation completes`, result.ok, true);
  harness.equal(`${id}: result type`, result.result_type, expected.result_type);
  harness.equal(`${id}: disposition`, result.disposition, expected.disposition);
  harness.equal(`${id}: publication_blocked`, result.publication_blocked, expected.publication_blocked);
  harness.equal(`${id}: human_review`, result.human_review, expected.human_review);
  harness.equal(`${id}: governing rule`, result.governing_rule_id, expected.governing_rule_id);
  harness.equal(`${id}: matched rule ids`, result.matched_rule_ids, expected.matched_rule_ids);
  harness.equal(`${id}: reason codes`, result.reason_codes, expected.reason_codes);
  harness.equal(`${id}: field actions`, result.field_actions, expected.field_actions);
  harness.equal(`${id}: unresolved dependencies`, result.unresolved_dependencies, expected.unresolved_dependencies);

  // Audit obligations that every evaluation must satisfy.
  harness.equal(`${id}: trace names the policy`, result.trace.policy_id, policy.policy_id);
  harness.equal(`${id}: trace names the policy version`, result.trace.policy_version, policy.version);
  harness.equal(`${id}: trace names the approval reference`, result.trace.approval_reference, policy.authority.approval_reference);
  harness.equal(`${id}: trace records the evaluation timestamp`, result.trace.evaluated_at, FIXED_EVALUATION_TIMESTAMP);
  harness.equal(`${id}: every rule is evaluated`, result.trace.rule_evaluations.length, policy.rules.length);
  harness.ok(`${id}: every rule evaluation records its status`,
    result.trace.rule_evaluations.every((entry) => entry.rule_status === 'ACTIVE' || entry.rule_status === 'DEFERRED'));
  harness.ok(`${id}: non-matching rules record their nonmatch reasons`,
    result.trace.rule_evaluations.filter((entry) => !entry.matched).every((entry) => entry.nonmatch_reasons.length > 0));

  // A blocked candidate can never stand as SELECT, and SELECT is never blocked.
  harness.ok(`${id}: SELECT is never publication-blocked`, result.disposition !== 'SELECT' || result.publication_blocked === false);
  harness.ok(`${id}: non-SELECT outcomes remain blocked`, result.disposition === 'SELECT' || result.publication_blocked === true);

  // Repeated evaluation of frozen inputs is semantically identical.
  const repeat = evaluate(normalizedFromOracle(fixture));
  harness.equal(`${id}: repeated evaluation is semantically identical`, semanticFingerprint(repeat), semanticFingerprint(result));
}

// Deferred rules are evaluated rather than skipped, in every fixture.
const deferredRuleIds = policy.rules.filter((rule) => rule.status === 'DEFERRED').map((rule) => rule.rule_id);
harness.ok('the policy still carries a DEFERRED rule to exercise', deferredRuleIds.length > 0);
for (const fixture of oracle.fixtures) {
  const result = evaluate(normalizedFromOracle(fixture));
  for (const ruleId of deferredRuleIds) {
    const entry = result.trace.rule_evaluations.find((item) => item.rule_id === ruleId);
    harness.ok(`${fixture.fixture_id}: DEFERRED rule ${ruleId} was evaluated`, entry !== undefined);
    if (entry?.matched) {
      harness.equal(`${fixture.fixture_id}: matched DEFERRED rule holds`, entry.effective_result.disposition, 'HOLD');
      harness.equal(`${fixture.fixture_id}: matched DEFERRED rule blocks`, entry.effective_result.publication_blocked, true);
      harness.equal(`${fixture.fixture_id}: matched DEFERRED rule requires human review`, entry.effective_result.human_review, true);
    }
  }
}

harness.finish([`fixtures=${oracle.fixtures.length}`, `rules=${policy.rules.length}`]);
