#!/usr/bin/env node
// Stage C acceptance: composed evaluation -> routing and audit.
//
// Routing is driven from the oracle's expected evaluation results, so routing
// is proven independently of the evaluator. The composed pipeline is then run
// end to end to prove the three stages agree and that the audit record is
// complete.

import fs from 'node:fs';
import { createHarness, evaluationFromOracle, TRUSTED_AUTHORITY_RESOLUTION, FIXED_EVALUATION_TIMESTAMP } from './lib/ttd-test-harness.mjs';
import { routeEvaluation, loadRoutingVocabulary } from './lib/ttd-adjudication-routing.mjs';
import { loadAdjudicationContext, adjudicateCandidate } from './lib/ttd-adjudication.mjs';
import { canonicalize } from './lib/ttd-canonical-json.mjs';

const harness = createHarness('TTD_ADJUDICATION_COMPOSITION');
const oracle = JSON.parse(fs.readFileSync('automation/control-plane/fixtures/ttd-adjudication-oracle.json', 'utf8'));
const context = loadAdjudicationContext();
const vocabulary = loadRoutingVocabulary();

const REQUIRED_AUDIT_KEYS = [
  'audit_version', 'candidate_id', 'evidence_digest', 'source_refs', 'normalization',
  'policy', 'authority_resolution', 'evaluated_at', 'evaluation', 'routing', 'semantic_fingerprint'
];
const REQUIRED_EVALUATION_AUDIT_KEYS = [
  'ok', 'result_type', 'disposition', 'publication_blocked', 'human_review', 'governing_rule_id',
  'matched_rule_ids', 'matched_deferred_rule_ids', 'reason_codes', 'field_actions',
  'field_action_provenance', 'unresolved_dependencies', 'rule_evaluations',
  'nonmatches_from_missing_inputs', 'composition', 'failures'
];

for (const fixture of oracle.fixtures) {
  const id = fixture.fixture_id;

  // Stage C in isolation: route the oracle's expected evaluation.
  const routed = routeEvaluation(evaluationFromOracle(fixture), { policy: context.policy, vocabulary });
  harness.equal(`${id}: automatic route`, routed.automatic_route, fixture.expected_routing.automatic_route);
  harness.equal(`${id}: authority target`, routed.authority_target, fixture.expected_routing.authority_target);
  harness.equal(`${id}: escalation class`, routed.escalation_class, fixture.expected_routing.escalation_class);
  harness.equal(`${id}: routing never reports downstream execution`, routed.downstream_execution, { attempted: false, status: 'NOT_EXECUTED' });
  harness.equal(`${id}: routing carries the blocking state forward`, routed.publication_blocked, fixture.expected_evaluation.publication_blocked);
  harness.equal(`${id}: routing carries the human-review state forward`, routed.human_review, fixture.expected_evaluation.human_review);
  if (routed.automatic_route !== null) {
    harness.ok(`${id}: routed role is in the committed vocabulary`, vocabulary.worker_roles.includes(routed.automatic_route.next_role));
    harness.ok(`${id}: routed status is in the committed vocabulary`, vocabulary.statuses.includes(routed.automatic_route.next_status));
  }
  // Only a clean SELECT may progress toward publication.
  if (routed.automatic_route?.next_status === 'SELECTED') {
    harness.equal(`${id}: only an unblocked SELECT progresses`, fixture.expected_evaluation.disposition, 'SELECT');
    harness.equal(`${id}: a progressing candidate is not blocked`, fixture.expected_evaluation.publication_blocked, false);
    harness.equal(`${id}: a progressing candidate needs no human review`, fixture.expected_evaluation.human_review, false);
  }

  // Composed pipeline: evidence in, audit out.
  const composed = adjudicateCandidate({
    evidence: fixture.evidence,
    context,
    authorityResolution: TRUSTED_AUTHORITY_RESOLUTION,
    evaluatedAt: FIXED_EVALUATION_TIMESTAMP
  });

  harness.equal(`${id}: composed disposition`, composed.evaluation.disposition, fixture.expected_evaluation.disposition);
  harness.equal(`${id}: composed publication_blocked`, composed.evaluation.publication_blocked, fixture.expected_evaluation.publication_blocked);
  harness.equal(`${id}: composed human_review`, composed.evaluation.human_review, fixture.expected_evaluation.human_review);
  harness.equal(`${id}: composed matched rules`, composed.evaluation.matched_rule_ids, fixture.expected_evaluation.matched_rule_ids);
  harness.equal(`${id}: composed field actions`, composed.evaluation.field_actions, fixture.expected_evaluation.field_actions);
  harness.equal(`${id}: composed routing`, composed.routing.automatic_route, fixture.expected_routing.automatic_route);

  const audit = composed.audit;
  for (const key of REQUIRED_AUDIT_KEYS) harness.ok(`${id}: audit records ${key}`, Object.hasOwn(audit, key));
  for (const key of REQUIRED_EVALUATION_AUDIT_KEYS) harness.ok(`${id}: audit evaluation records ${key}`, Object.hasOwn(audit.evaluation, key));
  harness.equal(`${id}: audit names the candidate`, audit.candidate_id, id);
  harness.equal(`${id}: audit names the policy`, audit.policy.policy_id, context.policy.policy_id);
  harness.equal(`${id}: audit names the policy version`, audit.policy.policy_version, context.policy.version);
  harness.equal(`${id}: audit names the approval reference`, audit.policy.approval_reference, context.policy.authority.approval_reference);
  harness.equal(`${id}: audit records the evaluation timestamp`, audit.evaluated_at, FIXED_EVALUATION_TIMESTAMP);
  harness.equal(`${id}: audit records trusted authority resolution`, audit.authority_resolution.resolution, 'TRUSTED_RESOLVED');
  harness.equal(`${id}: audit marks candidate claims as non-authorizing`, audit.normalization.claim_is_authorizing, false);
  harness.ok(`${id}: audit preserves unknown fact states`,
    Object.values(audit.normalization.fact_states).every((entry) => entry.state === 'KNOWN' || entry.state === 'UNKNOWN'));
  harness.ok(`${id}: audit preserves a composition trace`, audit.evaluation.composition.length > 0);
  harness.ok(`${id}: audit preserves every rule evaluation`, audit.evaluation.rule_evaluations.length === context.policy.rules.length);
  harness.equal(`${id}: audit never claims downstream execution`, audit.routing.downstream_execution, { attempted: false, status: 'NOT_EXECUTED' });

  // Frozen inputs produce identical semantic output on repeat.
  const repeat = adjudicateCandidate({
    evidence: fixture.evidence,
    context,
    authorityResolution: TRUSTED_AUTHORITY_RESOLUTION,
    evaluatedAt: FIXED_EVALUATION_TIMESTAMP
  });
  harness.equal(`${id}: repeated adjudication is byte-identical`, canonicalize(repeat.audit), canonicalize(audit));
}

harness.finish([`fixtures=${oracle.fixtures.length}`]);
