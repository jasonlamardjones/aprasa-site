// Stage B: normalized facts -> deterministic APRASA_TTD_EDITORIAL_V1 evaluation.
//
// This module interprets the approved policy document. It contains no editorial
// semantics of its own: dispositions, blocking, human review, reason codes and
// field actions all come from the policy. What lives here is composition
// mechanics, typed predicate matching, and trust enforcement.
//
// No LLM, network, filesystem-of-record, clock-dependent, or external call is
// made during evaluation. Evaluation is a pure function of its inputs.

import fs from 'node:fs';
import path from 'node:path';
import { assertNoDangerousKeys, canonicalize, deepEqual, digest, emptyMap } from './ttd-canonical-json.mjs';

const POLICY_PATH = path.join('automation', 'control-plane', 'policies', 'things-to-do-v1.json');
const ANCHOR_PATH = path.join('automation', 'control-plane', 'trust', 'things-to-do-v1.trust-anchor.json');

export const SUBSTANTIVE_DISPOSITIONS = ['HOLD', 'REJECT', 'SELECT'];
export const REQUIRED_COMPOSITION = {
  predicate_semantics: 'ALL_DECLARED_PREDICATES_MUST_BE_PRESENT_AND_EQUAL',
  unknown_material_input: 'HOLD',
  deferred_match: 'HOLD_AND_BLOCK',
  blocking_is_monotonic: true,
  no_change_is_non_clearing: true,
  disposition_precedence: ['HOLD', 'REJECT', 'SELECT', 'NO_CHANGE'],
  human_review_semantics: 'STOP_AUTONOMOUS_PROGRESSION_AND_ROUTE_TO_DECLARED_AUTHORITY'
};

export function loadPolicy(root = process.cwd()) {
  const policy = JSON.parse(fs.readFileSync(path.join(root, POLICY_PATH), 'utf8'));
  assertNoDangerousKeys(policy, '$policy');
  return policy;
}

export function loadTrustAnchor(root = process.cwd()) {
  const anchor = JSON.parse(fs.readFileSync(path.join(root, ANCHOR_PATH), 'utf8'));
  assertNoDangerousKeys(anchor, '$anchor');
  return anchor;
}

function failClosed(resultType, reasonCodes, detail) {
  return {
    ok: false,
    result_type: resultType,
    disposition: 'HOLD',
    publication_blocked: true,
    human_review: true,
    governing_rule_id: null,
    matched_rule_ids: [],
    reason_codes: [...reasonCodes].sort(),
    field_actions: {},
    unresolved_dependencies: [...detail.unresolved_dependencies ?? []].sort(),
    trace: {
      policy_id: detail.policy_id ?? null,
      policy_version: detail.policy_version ?? null,
      approval_reference: detail.approval_reference ?? null,
      policy_content_sha256: detail.policy_content_sha256 ?? null,
      authority_resolution: detail.authority_resolution ?? null,
      evaluated_at: detail.evaluated_at ?? null,
      candidate_id: detail.candidate_id ?? null,
      rule_evaluations: [],
      composition: [{ step: 'PREFLIGHT', outcome: resultType, detail: detail.messages ?? [] }],
      failures: detail.messages ?? []
    }
  };
}

// Trust preflight. Policy identity, version, content integrity, expected
// approval identity and independently resolved authority must all hold before
// any rule is permitted to match.
function verifyTrust(policy, anchor, authorityResolution) {
  const messages = [];
  const reasonCodes = new Set();

  if (anchor === null || typeof anchor !== 'object') {
    messages.push('trust anchor is missing or malformed');
    reasonCodes.add('POLICY_TRUST_ANCHOR_UNAVAILABLE');
    return { ok: false, resultType: 'VALIDATION_FAILURE', messages, reasonCodes };
  }
  if (policy === null || typeof policy !== 'object') {
    messages.push('policy document is missing or malformed');
    reasonCodes.add('POLICY_UNAVAILABLE');
    return { ok: false, resultType: 'VALIDATION_FAILURE', messages, reasonCodes };
  }

  if (policy.policy_id !== anchor.policy_id) {
    messages.push(`policy_id ${String(policy.policy_id)} does not match approved identity ${String(anchor.policy_id)}`);
    reasonCodes.add('POLICY_IDENTITY_MISMATCH');
  }
  if (policy.version !== anchor.version) {
    messages.push(`policy version ${String(policy.version)} does not match approved version ${String(anchor.version)}`);
    reasonCodes.add('POLICY_VERSION_MISMATCH');
  }
  if (policy.domain !== anchor.domain) {
    messages.push(`policy domain ${String(policy.domain)} does not match approved domain ${String(anchor.domain)}`);
    reasonCodes.add('POLICY_IDENTITY_MISMATCH');
  }
  if (policy.authority?.approval_reference !== anchor.approval_reference) {
    messages.push('policy approval_reference does not match the expected approval identity');
    reasonCodes.add('POLICY_APPROVAL_IDENTITY_MISMATCH');
  }
  if (policy.authority?.owner !== anchor.approved_owner) {
    messages.push('policy owner does not match the expected approving authority');
    reasonCodes.add('POLICY_APPROVAL_IDENTITY_MISMATCH');
  }

  const declaredRuleIds = Array.isArray(policy.rules) ? policy.rules.map((rule) => rule?.rule_id).sort() : [];
  if (!deepEqual(declaredRuleIds, [...(anchor.rule_ids ?? [])].sort())) {
    messages.push('policy rule set does not match the approved rule set');
    reasonCodes.add('POLICY_RULE_SET_MISMATCH');
  }

  let contentSha = null;
  try {
    contentSha = digest(policy);
  } catch (error) {
    messages.push(`policy content could not be canonicalized: ${error.message}`);
    reasonCodes.add('POLICY_INTEGRITY_VERIFICATION_FAILED');
  }
  if (contentSha !== null && contentSha !== anchor.content_sha256) {
    messages.push('policy content digest does not match the approved content integrity value');
    reasonCodes.add('POLICY_INTEGRITY_VERIFICATION_FAILED');
  }

  for (const [key, expected] of Object.entries(REQUIRED_COMPOSITION)) {
    if (!deepEqual(policy.composition?.[key], expected)) {
      messages.push(`policy composition.${key} does not match required fail-closed semantics`);
      reasonCodes.add('POLICY_COMPOSITION_SEMANTICS_MISMATCH');
    }
  }
  if (policy.default_disposition !== 'HOLD') {
    messages.push('policy default_disposition must remain HOLD');
    reasonCodes.add('POLICY_COMPOSITION_SEMANTICS_MISMATCH');
  }

  if (reasonCodes.size > 0) {
    return { ok: false, resultType: 'VALIDATION_FAILURE', messages, reasonCodes, contentSha };
  }

  // Authority resolution must be supplied by a trusted resolver, never by the
  // candidate. An UNRESOLVED or absent resolution cannot authorize progression.
  if (authorityResolution === null || typeof authorityResolution !== 'object' || Array.isArray(authorityResolution)) {
    messages.push('authority resolution evidence was not supplied by a trusted resolver');
    reasonCodes.add('AUTHORITY_RESOLUTION_MISSING');
    return { ok: false, resultType: 'AUTHORITY_RESOLUTION_FAILURE', messages, reasonCodes, contentSha };
  }
  if (authorityResolution.resolution !== 'TRUSTED_RESOLVED') {
    messages.push(`authority resolution is ${String(authorityResolution.resolution)} and cannot authorize progression`);
    reasonCodes.add('AUTHORITY_RESOLUTION_UNTRUSTED');
    return { ok: false, resultType: 'AUTHORITY_RESOLUTION_FAILURE', messages, reasonCodes, contentSha };
  }
  if (typeof authorityResolution.resolver !== 'string' || authorityResolution.resolver.length === 0) {
    messages.push('authority resolution is missing a trusted resolver identity');
    reasonCodes.add('AUTHORITY_RESOLUTION_MISSING');
    return { ok: false, resultType: 'AUTHORITY_RESOLUTION_FAILURE', messages, reasonCodes, contentSha };
  }
  if (authorityResolution.source === 'CANDIDATE') {
    messages.push('candidate-supplied authority claims are not self-authorizing');
    reasonCodes.add('AUTHORITY_RESOLUTION_UNTRUSTED');
    return { ok: false, resultType: 'AUTHORITY_RESOLUTION_FAILURE', messages, reasonCodes, contentSha };
  }

  return { ok: true, messages, reasonCodes, contentSha };
}

// Exact typed predicate matching. No truthiness, no coercion. A missing or
// UNKNOWN value never satisfies a declared false.
function matchPredicate(declared, fact) {
  if (fact === undefined || fact === null) return { matched: false, reason: 'MISSING_MATERIAL_INPUT', observed: null };
  if (typeof fact !== 'object' || Array.isArray(fact)) return { matched: false, reason: 'MALFORMED_FACT', observed: null };
  if (fact.state !== 'KNOWN') return { matched: false, reason: 'UNKNOWN_MATERIAL_INPUT', observed: null };

  const declaredType = typeof declared;
  if (declaredType !== 'boolean' && declaredType !== 'string') {
    return { matched: false, reason: 'UNSUPPORTED_DECLARED_PREDICATE_TYPE', observed: null };
  }
  if (typeof fact.value !== declaredType) {
    return { matched: false, reason: 'TYPE_MISMATCH', observed: fact.value === undefined ? null : fact.value };
  }
  if (fact.value !== declared) {
    return { matched: false, reason: 'VALUE_MISMATCH', observed: fact.value };
  }
  return { matched: true, reason: 'MATCHED', observed: fact.value };
}

function evaluateRule(rule, facts) {
  const predicates = [];
  let matched = true;
  for (const name of Object.keys(rule.when).sort()) {
    const fact = Object.hasOwn(facts, name) ? facts[name] : undefined;
    const outcome = matchPredicate(rule.when[name], fact);
    if (!outcome.matched) matched = false;
    predicates.push({
      predicate: name,
      declared: rule.when[name],
      observed: outcome.observed,
      matched: outcome.matched,
      reason: outcome.reason
    });
  }

  // A matching DEFERRED rule always HOLDs and blocks, per composition
  // deferred_match: HOLD_AND_BLOCK. Deferred rules are evaluated, never skipped.
  const deferred = rule.status === 'DEFERRED';
  const effective = matched
    ? {
        disposition: deferred ? 'HOLD' : rule.result.disposition,
        publication_blocked: deferred ? true : rule.result.publication_blocked === true,
        human_review: deferred ? true : rule.human_review === true,
        reason_code: rule.result.reason_code,
        field_actions: rule.result.field_actions ?? null
      }
    : null;

  return {
    rule_id: rule.rule_id,
    rule_status: rule.status,
    matched,
    predicates,
    declared_result: {
      disposition: rule.result.disposition,
      publication_blocked: rule.result.publication_blocked,
      reason_code: rule.result.reason_code,
      human_review: rule.human_review === true
    },
    effective_result: effective,
    nonmatch_reasons: predicates.filter((item) => !item.matched).map((item) => `${item.predicate}:${item.reason}`).sort(),
    missing_material_inputs: predicates
      .filter((item) => item.reason === 'MISSING_MATERIAL_INPUT' || item.reason === 'UNKNOWN_MATERIAL_INPUT')
      .map((item) => item.predicate)
      .sort()
  };
}

function mergeFieldActions(matchedRules, composition) {
  const merged = emptyMap();
  const provenance = emptyMap();
  const conflicts = [];
  for (const evaluation of matchedRules) {
    const actions = evaluation.effective_result.field_actions;
    if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) continue;
    for (const key of Object.keys(actions).sort()) {
      const value = actions[key];
      if (Object.hasOwn(merged, key)) {
        if (!deepEqual(merged[key], value)) {
          conflicts.push({
            field: key,
            existing: { rule_id: provenance[key], value: merged[key] },
            incoming: { rule_id: evaluation.rule_id, value }
          });
        }
        continue;
      }
      merged[key] = value;
      provenance[key] = evaluation.rule_id;
    }
  }
  if (conflicts.length > 0) {
    composition.push({ step: 'FIELD_ACTION_MERGE', outcome: 'CONFLICT', detail: conflicts.map((item) => item.field).sort() });
  } else {
    composition.push({ step: 'FIELD_ACTION_MERGE', outcome: 'MERGED', detail: Object.keys(merged).sort() });
  }
  const plain = {};
  for (const key of Object.keys(merged).sort()) plain[key] = merged[key];
  const plainProvenance = {};
  for (const key of Object.keys(provenance).sort()) plainProvenance[key] = provenance[key];
  return { field_actions: plain, provenance: plainProvenance, conflicts };
}

export function evaluateNormalizedFacts(input) {
  const {
    policy,
    trustAnchor,
    normalized,
    authorityResolution,
    evaluatedAt = null,
    materialPredicates = null,
    factConsistencyConstraints = null
  } = input;

  const candidateId = normalized?.candidate_id ?? null;
  const trust = verifyTrust(policy, trustAnchor, authorityResolution);
  if (!trust.ok) {
    return failClosed(trust.resultType, trust.reasonCodes, {
      messages: trust.messages,
      candidate_id: candidateId,
      policy_id: policy?.policy_id ?? null,
      policy_version: policy?.version ?? null,
      approval_reference: policy?.authority?.approval_reference ?? null,
      policy_content_sha256: trust.contentSha ?? null,
      authority_resolution: authorityResolution?.resolution ?? null,
      evaluated_at: evaluatedAt,
      unresolved_dependencies: ['TRUSTED_POLICY_AUTHORITY']
    });
  }

  if (!Array.isArray(factConsistencyConstraints)) {
    return failClosed('VALIDATION_FAILURE', new Set(['FACT_CONSISTENCY_CONSTRAINTS_NOT_SUPPLIED']), {
      messages: ['fact-consistency constraints were not supplied; contradiction enforcement cannot be skipped'],
      candidate_id: candidateId,
      policy_id: policy.policy_id,
      policy_version: policy.version,
      approval_reference: policy.authority.approval_reference,
      policy_content_sha256: trust.contentSha,
      authority_resolution: authorityResolution.resolution,
      evaluated_at: evaluatedAt,
      unresolved_dependencies: ['FACT_CONSISTENCY_CONSTRAINTS']
    });
  }

  if (normalized === null || typeof normalized !== 'object' || normalized.ok !== true) {
    const detail = Array.isArray(normalized?.normalization_errors)
      ? normalized.normalization_errors.map((error) => `${error.code}: ${error.detail}`)
      : ['normalized candidate is missing or not ok'];
    return failClosed('VALIDATION_FAILURE', new Set(['NORMALIZATION_FAILED']), {
      messages: detail,
      candidate_id: candidateId,
      policy_id: policy.policy_id,
      policy_version: policy.version,
      approval_reference: policy.authority.approval_reference,
      policy_content_sha256: trust.contentSha,
      authority_resolution: authorityResolution.resolution,
      evaluated_at: evaluatedAt,
      unresolved_dependencies: ['NORMALIZED_CANDIDATE_FACTS']
    });
  }

  const facts = normalized.facts ?? emptyMap();
  const composition = [];

  // Every rule is evaluated, ACTIVE and DEFERRED alike.
  const ruleEvaluations = policy.rules
    .map((rule) => evaluateRule(rule, facts))
    .sort((left, right) => (left.rule_id < right.rule_id ? -1 : left.rule_id > right.rule_id ? 1 : 0));

  const matchedRules = ruleEvaluations.filter((evaluation) => evaluation.matched);
  composition.push({
    step: 'RULE_MATCHING',
    outcome: 'EVALUATED',
    detail: {
      evaluated: ruleEvaluations.length,
      matched: matchedRules.map((evaluation) => evaluation.rule_id),
      matched_deferred: matchedRules.filter((evaluation) => evaluation.rule_status === 'DEFERRED').map((evaluation) => evaluation.rule_id)
    }
  });

  const precedence = policy.composition.disposition_precedence;
  const substantive = matchedRules.filter((evaluation) => SUBSTANTIVE_DISPOSITIONS.includes(evaluation.effective_result.disposition));

  let disposition;
  let governingRuleId = null;
  if (substantive.length === 0) {
    disposition = policy.default_disposition;
    composition.push({ step: 'DISPOSITION', outcome: 'DEFAULT', detail: `no substantive rule authorized an outcome; default ${disposition}` });
  } else {
    disposition = substantive
      .map((evaluation) => evaluation.effective_result.disposition)
      .reduce((best, candidate) => (precedence.indexOf(candidate) < precedence.indexOf(best) ? candidate : best));
    // Deterministic, order-independent governing-rule selection.
    governingRuleId = substantive
      .filter((evaluation) => evaluation.effective_result.disposition === disposition)
      .map((evaluation) => evaluation.rule_id)
      .sort()[0];
    composition.push({ step: 'DISPOSITION', outcome: 'PRECEDENCE', detail: `${disposition} selected via ${canonicalize(precedence)}; governing rule ${governingRuleId}` });
  }

  // Blocking is monotonic: no later rule can clear an earlier block, and any
  // non-SELECT outcome remains blocked.
  const blockedByRule = matchedRules.some((evaluation) => evaluation.effective_result.publication_blocked === true);
  let publicationBlocked = blockedByRule || disposition !== 'SELECT';
  composition.push({
    step: 'PUBLICATION_BLOCK',
    outcome: publicationBlocked ? 'BLOCKED' : 'NOT_BLOCKED',
    detail: {
      blocked_by_rules: matchedRules.filter((evaluation) => evaluation.effective_result.publication_blocked === true).map((evaluation) => evaluation.rule_id),
      non_select_disposition: disposition !== 'SELECT'
    }
  });

  // human_review is monotonic across matched rules.
  let humanReview = matchedRules.some((evaluation) => evaluation.effective_result.human_review === true);

  const merge = mergeFieldActions(matchedRules, composition);
  let fieldActions = merge.field_actions;
  const reasonCodes = new Set(matchedRules.map((evaluation) => evaluation.effective_result.reason_code));

  if (merge.conflicts.length > 0) {
    // Conflicting field actions fail closed rather than silently reconciling.
    disposition = 'HOLD';
    governingRuleId = null;
    publicationBlocked = true;
    humanReview = true;
    fieldActions = {};
    reasonCodes.add('FIELD_ACTION_CONFLICT');
    composition.push({ step: 'FAIL_CLOSED', outcome: 'FIELD_ACTION_CONFLICT', detail: merge.conflicts });
  }

  if (substantive.length === 0) reasonCodes.add('DEFAULT_HOLD_NO_AUTHORIZING_RULE');

  // A material eligibility dependency is unresolved whenever it is not KNOWN:
  // missing, UNKNOWN, contradictory, or malformed all count. Absence is never
  // read as a favourable value, and a rule that failed on a known mismatch does
  // not hide a dependency that is still outstanding elsewhere.
  const declaredTypeByPredicate = new Map();
  for (const rule of policy.rules) {
    for (const [name, declared] of Object.entries(rule.when)) declaredTypeByPredicate.set(name, typeof declared);
  }
  const materialNames = materialPredicates === null ? [...declaredTypeByPredicate.keys()].sort() : [...materialPredicates].sort();
  const unresolvedDependencies = new Set();
  for (const name of materialNames) {
    const fact = Object.hasOwn(facts, name) ? facts[name] : undefined;
    if (fact === undefined || fact === null || typeof fact !== 'object' || Array.isArray(fact) || fact.state !== 'KNOWN') {
      unresolvedDependencies.add(name);
      continue;
    }
    // A KNOWN fact carrying a value the policy could never compare against is
    // malformed, not resolved.
    const declaredType = declaredTypeByPredicate.get(name);
    if (declaredType !== undefined && typeof fact.value !== declaredType) unresolvedDependencies.add(name);
  }
  composition.push({
    step: 'MATERIAL_DEPENDENCIES',
    outcome: unresolvedDependencies.size === 0 ? 'ALL_KNOWN' : 'UNRESOLVED',
    detail: { evaluated: materialNames.length, unresolved: [...unresolvedDependencies].sort() }
  });

  // Declared fact-consistency constraints. A contradiction between normalized
  // facts fails closed; neither side is silently preferred over the other.
  const violatedConstraints = [];
  for (const constraint of factConsistencyConstraints) {
    const combination = constraint.forbidden_combination ?? {};
    const names = Object.keys(combination);
    if (names.length === 0) continue;
    const violated = names.every((name) => {
      const fact = Object.hasOwn(facts, name) ? facts[name] : undefined;
      return fact !== undefined && fact !== null && typeof fact === 'object' && !Array.isArray(fact)
        && fact.state === 'KNOWN' && fact.value === combination[name];
    });
    if (violated) violatedConstraints.push(constraint);
  }
  if (violatedConstraints.length > 0) {
    disposition = 'HOLD';
    governingRuleId = null;
    publicationBlocked = true;
    humanReview = true;
    fieldActions = {};
    for (const constraint of violatedConstraints) reasonCodes.add(constraint.reason_code ?? 'CONTRADICTORY_MATERIAL_FACTS');
    composition.push({
      step: 'FAIL_CLOSED',
      outcome: 'FACT_CONSISTENCY_VIOLATION',
      detail: violatedConstraints.map((constraint) => ({
        constraint_id: constraint.constraint_id,
        forbidden_combination: constraint.forbidden_combination
      }))
    });
  }

  // A SELECT may stand only when every material eligibility dependency is KNOWN.
  // The approved composition declares unknown material input as HOLD, so an
  // outstanding material dependency cannot be carried into a selection.
  if (disposition === 'SELECT' && unresolvedDependencies.size > 0) {
    disposition = 'HOLD';
    governingRuleId = null;
    publicationBlocked = true;
    reasonCodes.add('UNKNOWN_MATERIAL_DEPENDENCY');
    composition.push({
      step: 'FAIL_CLOSED',
      outcome: 'UNKNOWN_MATERIAL_DEPENDENCY',
      detail: [...unresolvedDependencies].sort()
    });
  }

  // Defensive invariant: a blocked candidate can never stand as SELECT.
  if (disposition === 'SELECT' && publicationBlocked) {
    disposition = 'HOLD';
    governingRuleId = null;
    humanReview = true;
    reasonCodes.add('SELECT_BLOCKED_INVARIANT_VIOLATION');
    composition.push({ step: 'FAIL_CLOSED', outcome: 'SELECT_BLOCKED_INVARIANT_VIOLATION', detail: 'blocked candidate downgraded to HOLD' });
  }

  return {
    ok: true,
    result_type: 'EVALUATION',
    disposition,
    publication_blocked: publicationBlocked,
    human_review: humanReview,
    governing_rule_id: governingRuleId,
    matched_rule_ids: matchedRules.map((evaluation) => evaluation.rule_id).sort(),
    reason_codes: [...reasonCodes].sort(),
    field_actions: fieldActions,
    field_action_provenance: merge.provenance,
    unresolved_dependencies: [...unresolvedDependencies].sort(),
    trace: {
      candidate_id: candidateId,
      policy_id: policy.policy_id,
      policy_version: policy.version,
      approval_reference: policy.authority.approval_reference,
      policy_content_sha256: trust.contentSha,
      registry_version: normalized.registry_version ?? null,
      authority_resolution: authorityResolution.resolution,
      authority_resolver: authorityResolution.resolver,
      claimed_authority_resolution: normalized.claimed_authority_resolution ?? null,
      source_refs: normalized.source_refs ?? [],
      evaluated_at: evaluatedAt,
      rule_evaluations: ruleEvaluations,
      matched_deferred_rule_ids: matchedRules.filter((evaluation) => evaluation.rule_status === 'DEFERRED').map((evaluation) => evaluation.rule_id).sort(),
      nonmatches_from_missing_inputs: ruleEvaluations
        .filter((evaluation) => !evaluation.matched && evaluation.missing_material_inputs.length > 0)
        .map((evaluation) => ({ rule_id: evaluation.rule_id, missing: evaluation.missing_material_inputs })),
      material_predicates_evaluated: materialNames,
      fact_consistency_constraints_evaluated: factConsistencyConstraints.map((constraint) => constraint.constraint_id ?? null),
      fact_consistency_violations: violatedConstraints.map((constraint) => constraint.constraint_id ?? null),
      composition,
      failures: []
    }
  };
}

// Order-independent semantic identity of an evaluation. Used to prove that
// object key order, rule declaration order, and repeated evaluation of frozen
// inputs cannot alter meaning.
export function semanticFingerprint(result) {
  return digest({
    ok: result.ok,
    result_type: result.result_type,
    disposition: result.disposition,
    publication_blocked: result.publication_blocked,
    human_review: result.human_review,
    governing_rule_id: result.governing_rule_id ?? null,
    matched_rule_ids: [...result.matched_rule_ids].sort(),
    reason_codes: [...result.reason_codes].sort(),
    field_actions: result.field_actions,
    unresolved_dependencies: [...result.unresolved_dependencies].sort()
  });
}
