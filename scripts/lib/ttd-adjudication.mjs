// Composed Things-to-Do adjudication: normalization -> evaluation -> routing,
// with a single auditable record. Deterministic and provider-neutral: no LLM,
// no network, no clock read. The evaluation timestamp is injected by the caller.

import {
  admitDataContainer,
  admitSnapshot,
  assertNotExoticView,
  canonicalize,
  containerEntry,
  digest,
  isExoticView,
  readAdmittedIdentity
} from './ttd-canonical-json.mjs';
import { normalizeCandidate, factSummary, loadFactRegistry } from './ttd-normalizer.mjs';
import { deriveTrustedFactPolicy, evaluateNormalizedFacts, loadPolicy, loadTrustAnchor, semanticFingerprint } from './ttd-policy-evaluator.mjs';
import { routeEvaluation, loadRoutingVocabulary } from './ttd-adjudication-routing.mjs';

// The fact-policy configuration is derived from the validated registry, never
// defaulted. A registry that cannot produce the trusted configuration makes
// context construction fail rather than yielding an empty constraint set.
export function loadAdjudicationContext(root = process.cwd()) {
  const factPolicy = deriveTrustedFactPolicy(loadFactRegistry(root));
  return {
    registry: factPolicy.registry,
    factConsistencyConstraints: factPolicy.factConsistencyConstraints,
    materialPredicates: factPolicy.materialPredicates,
    policy: loadPolicy(root),
    trustAnchor: loadTrustAnchor(root),
    vocabulary: loadRoutingVocabulary(root)
  };
}

// --- The single invocation admission boundary --------------------------------
//
// The whole externally supplied call crosses ONE fail-closed boundary before
// any decision-relevant property, descriptor, identity, control input,
// registry, evidence, authority resolution or error-path datum is consumed.
//
// The defect this closes: the entrypoint used to read the invocation's four
// fields with four separate Object.getOwnPropertyDescriptor calls. On a hostile
// outer view each of those is a trap, so caller code ran four times before any
// validation — enough to mutate the evidence object already handed out on an
// earlier read. LOW-confidence evidence that correctly HOLDs in an ordinary
// object was turned into SELECT that way. Descriptor reads were never the
// safeguard; not reading the hostile object at all is.
//
// Exactly these four keys are admitted. Every incumbent call site passes this
// shape; an unexpected key fails the call rather than being ignored.
const INVOCATION_KEYS = Object.freeze(['evidence', 'context', 'authorityResolution', 'evaluatedAt']);

// The decision-relevant context fields. The context also legitimately carries
// factConsistencyConstraints and materialPredicates, which this entrypoint has
// always deliberately ignored in favour of the values derived from the pinned
// registry; they are left out here for the same reason, not admitted and
// discarded.
const CONTEXT_KEYS = Object.freeze(['registry', 'policy', 'trustAnchor', 'vocabulary']);

function admitContextValue(entries, key) {
  const entry = containerEntry(entries, key);
  if (!entry.present) return undefined;
  // A trusted context value has no legitimate reason to be an exotic view, and
  // one here would run traps deep inside evaluation rather than at a boundary.
  assertNotExoticView(entry.value, `$invocation.context.${key}`);
  return entry.value;
}

function admitInvocation(raw) {
  const outer = admitDataContainer(raw, '$invocation', { allowedKeys: INVOCATION_KEYS });

  const evidence = containerEntry(outer, 'evidence');
  const suppliedContext = containerEntry(outer, 'context');
  const authority = containerEntry(outer, 'authorityResolution');

  // The context container crosses the same boundary, so `context.registry` and
  // the rest are values taken from single descriptor reads on a proven
  // non-exotic object — never ordinary property reads on a caller-controlled
  // view. Extra own keys are permitted (the incumbent context carries two this
  // entrypoint ignores), but an accessor, symbol or dangerous key anywhere on
  // it still fails the call.
  let context = null;
  if (suppliedContext.present
    && suppliedContext.value !== null
    && typeof suppliedContext.value === 'object'
    && !Array.isArray(suppliedContext.value)) {
    const inner = admitDataContainer(suppliedContext.value, '$invocation.context');
    context = Object.freeze({
      registry: admitContextValue(inner, 'registry'),
      policy: admitContextValue(inner, 'policy'),
      trustAnchor: admitContextValue(inner, 'trustAnchor'),
      vocabulary: admitContextValue(inner, 'vocabulary')
    });
  }

  const evidenceValue = evidence.present ? evidence.value : undefined;

  return Object.freeze({
    evidence: evidenceValue,
    context,
    // Incumbent semantics: an absent, undefined or null authority resolution is
    // all the same null.
    authorityResolution: (authority.present ? authority.value : undefined) ?? null,
    // Left TAGGED on purpose. Collapsing it to a value here would reintroduce
    // exactly the conflation F5 names.
    evaluatedAt: containerEntry(outer, 'evaluatedAt'),
    // The fixed safe fallback identity for the failure path, taken once, from
    // the admitted evidence container, without running any caller code. Null
    // whenever the identity cannot be read safely.
    candidateId: readAdmittedIdentity(evidenceValue, 'candidate_id')
  });
}

// evaluatedAt is injected by the caller and copied verbatim into the audit.
// The incumbent representation is a timestamp string, or null when no
// evaluation time is supplied. No date semantics are introduced here: the value
// is never parsed, formatted, or compared against a clock. Anything else is
// inadmissible, because a control value that cannot be canonically represented
// would produce an audit that cannot be canonically represented, and no
// advancing disposition may rest on one.
//
// Three states, kept distinct. The defect this closes: the old data-property
// helper returned `undefined` both for "the property is not there" and for "the
// property is there but its descriptor is an accessor", so an accessor-backed
// evaluatedAt was silently rewritten into an omission and the candidate went on
// to SELECT with evaluated_at: null. PRESENT-but-invalid never reaches this
// function now — admitDataContainer refuses the whole call — and what does
// reach it arrives tagged, so absence is a state, not a missing value.
//
//   ABSENT                        -> incumbent omission behavior (null)
//   PRESENT, null                 -> incumbent behavior (null)
//   PRESENT, non-empty string     -> incumbent behavior (copied verbatim)
//   PRESENT, any other value      -> fail closed, `undefined` included
//   PRESENT, invalid descriptor   -> already refused at the admission boundary
//
// `undefined` used to be accepted here as if it were null. That branch existed
// only because the old raw read reported an ABSENT property as `undefined`; it
// was absence handling, never a decision that `undefined` is a supported
// control value. Absence is its own tagged state now, so the branch has no
// remaining justification: an explicitly supplied `undefined` is a PRESENT
// value that JSON cannot express, and collapsing it into omission would be the
// very conflation this repair closes.
function admitEvaluatedAt(entry) {
  if (entry.present !== true) return { value: null, error: null };
  const value = entry.value;
  if (value === null) return { value: null, error: null };
  if (typeof value === 'string' && value.length > 0) return { value, error: null };
  return {
    value: null,
    error: `evaluatedAt must be a non-empty timestamp string or null; received ${typeof value}`
  };
}

// One admission of the candidate input, producing the frozen plain-data
// snapshot that controls both identity and semantics. Nothing downstream reads
// the caller's object again, so a stateful view cannot present one state to the
// digest and a different one to normalization.
function admitEvidence(evidence) {
  try {
    const snapshot = admitSnapshot(evidence === undefined ? null : evidence, '$evidence');
    return { snapshot, value: digest(snapshot), error: null };
  } catch (error) {
    return { snapshot: null, value: null, error: safeErrorMessage(error) };
  }
}

// Error-path metadata is input too. A thrown value can be caller-controlled, so
// an exotic view is refused before its descriptor is consulted: an audit record
// must never be the reason a hostile trap executes.
function safeErrorMessage(error) {
  const fallback = 'adjudication failed with an unrepresentable error';
  if (error === null || typeof error !== 'object') return fallback;
  if (isExoticView(error)) return fallback;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
      const message = descriptor.value;
      if (typeof message === 'string' && message.length > 0) return message;
    }
    if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message;
  } catch {
    // fall through to the bounded default
  }
  return fallback;
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
  // Boundary first. Nothing below this point has touched the caller's object:
  // the values used from here on came out of one admission, and the identity
  // used on every failure path came out of the same one.
  let admitted;
  try {
    admitted = admitInvocation(input);
  } catch (error) {
    const audit = boundedFailureAudit(null, null, safeErrorMessage(error), 'ADJUDICATION_INVOCATION_INADMISSIBLE');
    return { normalized: null, evaluation: null, routing: audit.routing, audit };
  }

  const { evidence, context, authorityResolution, candidateId } = admitted;

  const evaluatedAt = admitEvaluatedAt(admitted.evaluatedAt);
  if (evaluatedAt.error !== null) {
    const audit = boundedFailureAudit(candidateId, null, evaluatedAt.error, 'ADJUDICATION_CONTROL_INPUT_INADMISSIBLE');
    return { normalized: null, evaluation: null, routing: audit.routing, audit };
  }

  const bounded = (message, code) => {
    const audit = boundedFailureAudit(candidateId, evaluatedAt.value, message, code);
    return { normalized: null, evaluation: null, routing: audit.routing, audit };
  };

  let outcome;
  try {
    outcome = runPipeline({ evidence, context, authorityResolution, evaluatedAt: evaluatedAt.value, candidateId });
  } catch (error) {
    return bounded(safeErrorMessage(error), 'ADJUDICATION_ABORTED');
  }

  // Final defensive invariant. An adjudication result must itself be canonically
  // representable before it may leave this function: an outcome that cannot be
  // written to the audit record cannot be relied on, whatever it says. This is
  // defense in depth behind the admission of each control input, not a
  // substitute for it.
  try {
    canonicalize(outcome.audit);
  } catch (error) {
    return bounded(safeErrorMessage(error), 'AUDIT_NOT_CANONICALLY_REPRESENTABLE');
  }
  return outcome;
}

function runPipeline({ evidence, context, authorityResolution, evaluatedAt, candidateId }) {
  // Derived from the caller-supplied registry only after that registry has been
  // proven identical to the trusted one; the admitted snapshot it returns is
  // what normalization then reads.
  const factPolicy = deriveTrustedFactPolicy(context?.registry);

  // One admission, one snapshot. Canonical evidence identity is an integrity
  // precondition, not a decoration: a candidate whose input cannot be admitted
  // and canonically digested cannot participate in the auditable provenance
  // model, so it cannot advance. Everything below reads the snapshot, so the
  // exact state that produced the digest is the state that is evaluated.
  const evidenceDigest = admitEvidence(evidence);
  if (evidenceDigest.error !== null) {
    const audit = boundedFailureAudit(candidateId, evaluatedAt, evidenceDigest.error, 'EVIDENCE_DIGEST_UNAVAILABLE');
    return { normalized: null, evaluation: null, routing: audit.routing, audit };
  }
  const admittedEvidence = evidenceDigest.snapshot;

  // Authority resolution is externally supplied and is copied into the audit,
  // so it is admitted through the same boundary.
  const admittedAuthority = admitSnapshot(authorityResolution, '$authorityResolution');

  const normalized = normalizeCandidate(admittedEvidence, { registry: factPolicy.registry });
  const evaluation = evaluateNormalizedFacts({
    policy: context.policy,
    trustAnchor: context.trustAnchor,
    normalized,
    authorityResolution: admittedAuthority,
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
