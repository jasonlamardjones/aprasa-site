// Composed Things-to-Do adjudication: normalization -> evaluation -> routing,
// with a single auditable record. Deterministic and provider-neutral: no LLM,
// no network, no clock read. The evaluation timestamp is injected by the caller.

import { digest } from './ttd-canonical-json.mjs';
import { normalizeCandidate, factSummary, loadFactRegistry } from './ttd-normalizer.mjs';
import { evaluateNormalizedFacts, loadPolicy, loadTrustAnchor, semanticFingerprint } from './ttd-policy-evaluator.mjs';
import { routeEvaluation, loadRoutingVocabulary } from './ttd-adjudication-routing.mjs';

export function loadAdjudicationContext(root = process.cwd()) {
  const registry = loadFactRegistry(root);
  return {
    registry,
    materialPredicates: registry.predicates
      .filter((predicate) => predicate.materiality === 'MATERIAL_ELIGIBILITY')
      .map((predicate) => predicate.name)
      .sort(),
    policy: loadPolicy(root),
    trustAnchor: loadTrustAnchor(root),
    vocabulary: loadRoutingVocabulary(root)
  };
}

export function adjudicateCandidate(input) {
  const {
    evidence,
    context,
    authorityResolution,
    evaluatedAt = null
  } = input;

  const normalized = normalizeCandidate(evidence, { registry: context.registry });
  const evaluation = evaluateNormalizedFacts({
    policy: context.policy,
    trustAnchor: context.trustAnchor,
    normalized,
    authorityResolution,
    evaluatedAt,
    materialPredicates: context.materialPredicates ?? null
  });
  const routing = routeEvaluation(evaluation, { policy: context.policy, vocabulary: context.vocabulary });

  const audit = {
    audit_version: '1.0.0',
    candidate_id: normalized.candidate_id,
    evidence_digest: digest(evidence ?? null),
    source_refs: normalized.source_refs,
    normalization: {
      ok: normalized.ok,
      registry_version: normalized.registry_version,
      facts: normalized.facts,
      fact_states: factSummary(normalized),
      claimed_authority_resolution: normalized.claimed_authority_resolution,
      claim_is_authorizing: false,
      errors: normalized.normalization_errors
    },
    policy: {
      policy_id: evaluation.trace.policy_id,
      policy_version: evaluation.trace.policy_version,
      approval_reference: evaluation.trace.approval_reference,
      content_sha256: evaluation.trace.policy_content_sha256
    },
    authority_resolution: {
      resolution: evaluation.trace.authority_resolution,
      resolver: evaluation.trace.authority_resolver ?? null
    },
    evaluated_at: evaluatedAt,
    evaluation: {
      ok: evaluation.ok,
      result_type: evaluation.result_type,
      disposition: evaluation.disposition,
      publication_blocked: evaluation.publication_blocked,
      human_review: evaluation.human_review,
      governing_rule_id: evaluation.governing_rule_id,
      matched_rule_ids: evaluation.matched_rule_ids,
      matched_deferred_rule_ids: evaluation.trace.matched_deferred_rule_ids ?? [],
      reason_codes: evaluation.reason_codes,
      field_actions: evaluation.field_actions,
      field_action_provenance: evaluation.field_action_provenance ?? {},
      unresolved_dependencies: evaluation.unresolved_dependencies,
      rule_evaluations: evaluation.trace.rule_evaluations,
      nonmatches_from_missing_inputs: evaluation.trace.nonmatches_from_missing_inputs ?? [],
      composition: evaluation.trace.composition,
      failures: evaluation.trace.failures
    },
    routing,
    semantic_fingerprint: semanticFingerprint(evaluation)
  };

  return { normalized, evaluation, routing, audit };
}
