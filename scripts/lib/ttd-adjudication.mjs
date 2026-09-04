// Composed Things-to-Do adjudication: normalization -> evaluation -> routing,
// with a single auditable record. Deterministic and provider-neutral: no LLM,
// no network, no clock read. The evaluation timestamp is injected by the caller.

import { digest, readOwnDataProperty } from './ttd-canonical-json.mjs';
import { normalizeCandidate, factSummary, loadFactRegistry } from './ttd-normalizer.mjs';
import { deriveTrustedFactPolicy, evaluateNormalizedFacts, loadPolicy, loadTrustAnchor, semanticFingerprint } from './ttd-policy-evaluator.mjs';
import { routeEvaluation, loadRoutingVocabulary } from './ttd-adjudication-routing.mjs';

// The fact-policy configuration is derived from the validated registry, never
// defaulted. A registry that cannot produce the trusted configuration makes
// context construction fail rather than yielding an empty constraint set.
export function loadAdjudicationContext(root = process.cwd()) {
  const registry = loadFactRegistry(root);
  const factPolicy = deriveTrustedFactPolicy(registry);
  return {
    registry,
    factConsistencyConstraints: factPolicy.factConsistencyConstraints,
    materialPredicates: factPolicy.materialPredicates,
    policy: loadPolicy(root),
    trustAnchor: loadTrustAnchor(root),
    vocabulary: loadRoutingVocabulary(root)
  };
}

// Bounded, accessor-free identity extraction. Reading a descriptor never
// invokes a getter, so a hostile candidate cannot run code here — including on
// the failure path, after its own input has already raised an exception.
function safeCandidateId(evidence) {
  const value = readOwnDataProperty(evidence, 'candidate_id');
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeErrorMessage(error) {
  try {
    const message = readOwnDataProperty(error, 'message');
    if (typeof message === 'string' && message.length > 0) return message;
    if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message;
  } catch {
    // fall through to the bounded default
  }
  return 'adjudication failed with an unrepresentable error';
}

// Canonical digesting deliberately refuses sparse arrays, accessors, tampered
// prototypes, prototype-polluting keys and unsupported value types. Refusal
// must not abort the pipeline: the candidate is rejected, but a bounded audit
// record is still produced so the failure is visible and attributable.
function safeEvidenceDigest(evidence) {
  try {
    return { value: digest(evidence ?? null), error: null };
  } catch (error) {
    return { value: null, error: safeErrorMessage(error) };
  }
}

function boundedFailureAudit(candidateId, evaluatedAt, message, code) {
  return {
    audit_version: '1.0.0',
    candidate_id: candidateId,
    evidence_digest: null,
    evidence_digest_error: message,
    source_refs: [],
    normalization: {
      ok: false,
      registry_version: null,
      facts: {},
      fact_states: {},
      claimed_authority_resolution: null,
      claim_is_authorizing: false,
      errors: [{ code, detail: message }]
    },
    policy: { policy_id: null, policy_version: null, approval_reference: null, content_sha256: null },
    authority_resolution: { resolution: null, resolver: null },
    evaluated_at: evaluatedAt,
    evaluation: {
      ok: false,
      result_type: 'VALIDATION_FAILURE',
      disposition: 'HOLD',
      publication_blocked: true,
      human_review: true,
      governing_rule_id: null,
      matched_rule_ids: [],
      matched_deferred_rule_ids: [],
      reason_codes: [code],
      field_actions: {},
      field_action_provenance: {},
      unresolved_dependencies: [],
      rule_evaluations: [],
      nonmatches_from_missing_inputs: [],
      composition: [{ step: 'PREFLIGHT', outcome: code, detail: [message] }],
      failures: [message]
    },
    routing: {
      automatic_route: { next_role: 'HUMAN_ESCALATION', next_status: 'BLOCKED' },
      authority_target: 'PROJECT_04_CONTROL_TOWER',
      escalation_class: 'TECHNICAL_BLOCKER',
      publication_blocked: true,
      human_review: true,
      disposition: 'HOLD',
      unresolved_dependencies: [],
      rationale: 'adjudication could not complete; no downstream progression is authorized',
      downstream_execution: { attempted: false, status: 'NOT_EXECUTED' }
    },
    semantic_fingerprint: null
  };
}

// Production entrypoint. The trusted fact-policy configuration is pinned here,
// derived from the validated registry; any caller-supplied constraint set or
// material predicate set on the context is deliberately ignored.
export function adjudicateCandidate(input) {
  // Identity is captured before the pipeline runs, using accessor-free reads,
  // so the bounded failure path never has to re-read attacker-controlled input
  // that has already thrown once.
  const evidence = readOwnDataProperty(input, 'evidence');
  const evaluatedAt = readOwnDataProperty(input, 'evaluatedAt') ?? null;
  const candidateId = safeCandidateId(evidence);

  try {
    return runPipeline(input, candidateId);
  } catch (error) {
    const audit = boundedFailureAudit(candidateId, evaluatedAt, safeErrorMessage(error), 'ADJUDICATION_ABORTED');
    return { normalized: null, evaluation: null, routing: audit.routing, audit };
  }
}

function runPipeline(input, candidateId) {
  const { evidence, context, authorityResolution, evaluatedAt = null } = input;

  // Derived from the validated registry on every adjudication, so a forged or
  // narrowed context cannot weaken contradiction or materiality enforcement.
  const factPolicy = deriveTrustedFactPolicy(context?.registry);

  // Canonical evidence identity is an integrity precondition, not a decoration.
  // A candidate whose admitted input cannot be canonically digested cannot
  // participate in the auditable provenance model, so it cannot advance.
  const evidenceDigest = safeEvidenceDigest(evidence);
  if (evidenceDigest.error !== null) {
    const audit = boundedFailureAudit(candidateId, evaluatedAt, evidenceDigest.error, 'EVIDENCE_DIGEST_UNAVAILABLE');
    return { normalized: null, evaluation: null, routing: audit.routing, audit };
  }

  const normalized = normalizeCandidate(evidence, { registry: context.registry });
  const evaluation = evaluateNormalizedFacts({
    policy: context.policy,
    trustAnchor: context.trustAnchor,
    normalized,
    authorityResolution,
    evaluatedAt,
    materialPredicates: factPolicy.materialPredicates,
    factConsistencyConstraints: factPolicy.factConsistencyConstraints
  });
  const routing = routeEvaluation(evaluation, { policy: context.policy, vocabulary: context.vocabulary });

  const audit = {
    audit_version: '1.0.0',
    candidate_id: normalized.candidate_id,
    evidence_digest: evidenceDigest.value,
    evidence_digest_error: evidenceDigest.error,
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
