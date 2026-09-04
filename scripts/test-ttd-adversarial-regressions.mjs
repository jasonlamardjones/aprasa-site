#!/usr/bin/env node
// Adversarial regressions for the Things-to-Do normalizer and evaluator.
//
// Every case here is an attempt to obtain a favourable outcome the approved
// policy does not authorize: by deleting evidence, coercing types, relabelling
// commercial propositions, forging approval, reordering the policy, or smuggling
// instructions through source text. All must fail closed.

import fs from 'node:fs';
import { createHarness, normalizedFromOracle, factsFromOracle, TRUSTED_AUTHORITY_RESOLUTION, FIXED_EVALUATION_TIMESTAMP } from './lib/ttd-test-harness.mjs';
import { loadPolicy, loadTrustAnchor, evaluateNormalizedFacts, semanticFingerprint, deriveTrustedFactPolicy, normalizeFactConsistencyConstraints, REQUIRED_FACT_CONSISTENCY_CONSTRAINTS, REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES } from './lib/ttd-policy-evaluator.mjs';
import { loadFactRegistry, normalizeCandidate, factSummary, resolveEvidenceRefs } from './lib/ttd-normalizer.mjs';
import { loadAdjudicationContext, adjudicateCandidate } from './lib/ttd-adjudication.mjs';
import { routeEvaluation } from './lib/ttd-adjudication-routing.mjs';
import { digest, canonicalize, assertAdmissibleStructure, isAdmissibleDenseArray, denseStringList } from './lib/ttd-canonical-json.mjs';

const harness = createHarness('TTD_ADVERSARIAL_REGRESSIONS');
const oracle = JSON.parse(fs.readFileSync('automation/control-plane/fixtures/ttd-adjudication-oracle.json', 'utf8'));
const policy = loadPolicy();
const trustAnchor = loadTrustAnchor();
const registry = loadFactRegistry();
const context = loadAdjudicationContext();
const materialPredicates = context.materialPredicates;

const fixtureById = new Map(oracle.fixtures.map((fixture) => [fixture.fixture_id, fixture]));
const clone = (value) => JSON.parse(JSON.stringify(value));

const ELIGIBILITY_PREDICATES = Object.keys(policy.rules.find((rule) => rule.rule_id === 'TTD-ELIG-001').when).sort();

// An explicitly supplied null must stay null: these regressions depend on being
// able to withhold the policy, the trust anchor, or the authority resolution.
const supplied = (options, key, fallback) => (Object.hasOwn(options, key) ? options[key] : fallback);

function evaluate(facts, options = {}) {
  return evaluateNormalizedFacts({
    policy: supplied(options, 'policy', policy),
    trustAnchor: supplied(options, 'trustAnchor', trustAnchor),
    normalized: options.normalized ?? {
      ok: true,
      candidate_id: options.candidateId ?? 'ADVERSARIAL',
      registry_version: registry.version,
      facts,
      source_refs: [],
      claimed_authority_resolution: options.claimedResolution ?? null,
      normalization_errors: []
    },
    authorityResolution: supplied(options, 'authorityResolution', TRUSTED_AUTHORITY_RESOLUTION),
    evaluatedAt: FIXED_EVALUATION_TIMESTAMP,
    materialPredicates: supplied(options, 'materialPredicates', materialPredicates),
    factConsistencyConstraints: supplied(options, 'factConsistencyConstraints', context.factConsistencyConstraints)
  });
}

const eligibleFacts = () => factsFromOracle(fixtureById.get('F01').expected_normalized.facts);

function assertFailedClosed(label, result) {
  harness.equal(`${label}: evaluation does not report success`, result.ok, false);
  harness.equal(`${label}: disposition falls back to HOLD`, result.disposition, 'HOLD');
  harness.equal(`${label}: publication is blocked`, result.publication_blocked, true);
  harness.equal(`${label}: human review is required`, result.human_review, true);
  harness.equal(`${label}: no approved rules are claimed as matched`, result.matched_rule_ids, []);
  harness.equal(`${label}: no field actions are emitted`, result.field_actions, {});
}

// Baseline: the fully eligible fact set does select. Everything below removes
// that authorization.
harness.equal('baseline eligible fact set selects', evaluate(eligibleFacts()).disposition, 'SELECT');

// 1. Delete each eligibility predicate in turn.
for (const predicate of ELIGIBILITY_PREDICATES) {
  const facts = eligibleFacts();
  delete facts[predicate];
  const result = evaluate(facts);
  harness.ok(`deleting ${predicate} must not SELECT`, result.disposition !== 'SELECT');
  harness.equal(`deleting ${predicate} blocks publication`, result.publication_blocked, true);
  const elig = result.trace.rule_evaluations.find((entry) => entry.rule_id === 'TTD-ELIG-001');
  harness.ok(`deleting ${predicate} is recorded as a missing material input`,
    elig.predicates.some((item) => item.predicate === predicate && item.reason === 'MISSING_MATERIAL_INPUT'));
}

// 2. Type coercion attempts on every boolean eligibility predicate.
const COERCIONS = [null, 'false', 'true', 0, 1, '', [], {}];
for (const predicate of ELIGIBILITY_PREDICATES) {
  const declared = policy.rules.find((rule) => rule.rule_id === 'TTD-ELIG-001').when[predicate];
  if (typeof declared !== 'boolean') continue;
  for (const coerced of COERCIONS) {
    const facts = eligibleFacts();
    facts[predicate] = { state: 'KNOWN', value: coerced, reason: 'COERCION_ATTEMPT', evidence_refs: ['X'], rationale: null };
    const result = evaluate(facts);
    harness.ok(`${predicate}=${canonicalize(coerced)} must not satisfy the declared ${declared}`, result.disposition !== 'SELECT');
  }
  // An UNKNOWN value never satisfies a declared false.
  const facts = eligibleFacts();
  facts[predicate] = { state: 'UNKNOWN', value: null, reason: 'UNKNOWN', evidence_refs: [], rationale: null };
  harness.ok(`${predicate} UNKNOWN must not satisfy a declared value`, evaluate(facts).disposition !== 'SELECT');
}

// Normalizer-level coercion: wrong-typed assertions are rejected outright.
const baseEvidence = () => clone(fixtureById.get('F01').evidence);
for (const coerced of [null, 'true', 0, 1, [], {}]) {
  const evidence = baseEvidence();
  evidence.assertions.find((item) => item.predicate === 'geography_in_scope').value = coerced;
  const normalized = normalizeCandidate(evidence, { registry });
  harness.equal(`normalizer rejects geography_in_scope=${canonicalize(coerced)}`, normalized.ok, false);
  harness.ok(`normalizer names the invalid value ${canonicalize(coerced)}`,
    normalized.normalization_errors.some((error) => error.code === 'INVALID_ASSERTION_VALUE'));
  assertFailedClosed(`coerced ${canonicalize(coerced)}`, evaluate(null, { normalized }));
}

// 3. Omitted standards classification fails closed to the standards boundary.
{
  const evidence = baseEvidence();
  delete evidence.standards_classification;
  const normalized = normalizeCandidate(evidence, { registry });
  harness.equal('omitted standards classification is normalized as unresolved',
    normalized.facts.standards_boundary_unresolved.value, true);
  harness.equal('omitted standards classification records its reason',
    normalized.facts.standards_boundary_unresolved.reason, 'STANDARDS_CLASSIFICATION_OMITTED');
  const result = evaluate(null, { normalized });
  harness.equal('omitted standards classification holds', result.disposition, 'HOLD');
  harness.equal('omitted standards classification requires human review', result.human_review, true);
  harness.equal('omitted standards classification matches TTD-GOV-002', result.matched_rule_ids, ['TTD-GOV-002']);
}

// 4. Unsupported claims that the standards boundary is clear.
const UNSUPPORTED_STANDARDS = [
  { label: 'no affirmative evidence flag', value: { confidence: 'HIGH', evidence_refs: ['S1'], unresolved_dimensions: [] } },
  { label: 'affirmative flag coerced from a string', value: { affirmative_ordinary_scope_evidence: 'true', confidence: 'HIGH', evidence_refs: ['S1'], unresolved_dimensions: [] } },
  { label: 'low confidence', value: { affirmative_ordinary_scope_evidence: true, confidence: 'LOW', evidence_refs: ['S1'], unresolved_dimensions: [] } },
  { label: 'no evidence refs', value: { affirmative_ordinary_scope_evidence: true, confidence: 'HIGH', evidence_refs: [], unresolved_dimensions: [] } },
  { label: 'dangling evidence ref', value: { affirmative_ordinary_scope_evidence: true, confidence: 'HIGH', evidence_refs: ['GHOST'], unresolved_dimensions: [] } },
  { label: 'unresolved dimension present', value: { affirmative_ordinary_scope_evidence: true, confidence: 'HIGH', evidence_refs: ['S1'], unresolved_dimensions: ['RELIGIOUS'] } },
  { label: 'mixed purpose', value: { affirmative_ordinary_scope_evidence: true, confidence: 'HIGH', evidence_refs: ['S1'], unresolved_dimensions: [], mixed_purpose: true } },
  { label: 'classification is a bare string', value: 'ORDINARY' }
];
for (const attempt of UNSUPPORTED_STANDARDS) {
  const evidence = baseEvidence();
  evidence.standards_classification = attempt.value;
  const normalized = normalizeCandidate(evidence, { registry });
  harness.equal(`unsupported standards clearance (${attempt.label}) stays unresolved`,
    normalized.facts.standards_boundary_unresolved.value, true);
  const result = evaluate(null, { normalized });
  harness.equal(`unsupported standards clearance (${attempt.label}) holds`, result.disposition, 'HOLD');
  harness.equal(`unsupported standards clearance (${attempt.label}) requires human review`, result.human_review, true);
}

// standards_boundary_unresolved may never be asserted directly.
{
  const evidence = baseEvidence();
  evidence.assertions.push({ predicate: 'standards_boundary_unresolved', value: false, confidence: 'HIGH', evidence_refs: ['S1'] });
  const normalized = normalizeCandidate(evidence, { registry });
  harness.equal('direct standards assertion is rejected', normalized.ok, false);
  harness.ok('direct standards assertion names the derived-predicate error',
    normalized.normalization_errors.some((error) => error.code === 'PREDICATE_NOT_DIRECTLY_ASSERTABLE'));
}

// 5. Unknown admission may never become free admission.
for (const fixture of oracle.fixtures) {
  const result = evaluate(null, { normalized: normalizedFromOracle(fixture) });
  if (Object.hasOwn(result.field_actions, 'free_admission')) {
    harness.equal(`${fixture.fixture_id}: free_admission is never asserted`, result.field_actions.free_admission, null);
  }
  harness.ok(`${fixture.fixture_id}: no field action invents an admission price`, !Object.hasOwn(result.field_actions, 'admission_price'));
}
{
  const evidence = baseEvidence();
  evidence.assertions.push({ predicate: 'free_admission', value: true, confidence: 'HIGH', evidence_refs: ['S1'] });
  const normalized = normalizeCandidate(evidence, { registry });
  harness.equal('free_admission is not a normalizable predicate', normalized.ok, false);
}
{
  // admission_verified UNKNOWN must not fire the omission rule and must not infer free.
  const facts = eligibleFacts();
  facts.admission_verified = { state: 'UNKNOWN', value: null, reason: 'UNKNOWN', evidence_refs: [], rationale: null };
  const result = evaluate(facts);
  harness.ok('unknown admission does not match TTD-FACT-001', !result.matched_rule_ids.includes('TTD-FACT-001'));
  harness.equal('unknown admission produces no admission field action', result.field_actions, {});
}

// 6. Month-level precision may never become an invented exact day.
{
  const facts = eligibleFacts();
  facts.authoritative_end_precision = { state: 'KNOWN', value: 'MONTH', reason: 'ORACLE', evidence_refs: ['S1'], rationale: null };
  const result = evaluate(facts);
  harness.equal('month precision is preserved', result.field_actions.end_date_precision, 'PRESERVE_MONTH');
  harness.equal('an exact day is never invented', result.field_actions.invent_exact_day, false);
  harness.equal('the month boundary is marked review-due', result.field_actions.month_boundary_state, 'REVIEW_DUE');

  const dayFacts = eligibleFacts();
  dayFacts.authoritative_end_precision = { state: 'KNOWN', value: 'DAY', reason: 'ORACLE', evidence_refs: ['S1'], rationale: null };
  harness.ok('day precision does not trigger the month-preservation rule',
    !evaluate(dayFacts).matched_rule_ids.includes('TTD-DATE-001'));

  const evidence = baseEvidence();
  evidence.assertions.push({ predicate: 'authoritative_end_precision', value: '2026-09-30', confidence: 'HIGH', evidence_refs: ['S1'] });
  harness.equal('an invented exact date is not a valid precision value', normalizeCandidate(evidence, { registry }).ok, false);
}

// 7. DEFERRED rules cannot be filtered out of evaluation.
{
  const commercialFacts = factsFromOracle(fixtureById.get('F16').expected_normalized.facts);
  const result = evaluate(commercialFacts);
  harness.equal('the DEFERRED commercial rule matches', result.matched_rule_ids, ['TTD-COMM-003']);
  harness.equal('the DEFERRED commercial rule holds', result.disposition, 'HOLD');
  harness.equal('the DEFERRED commercial rule blocks', result.publication_blocked, true);
  harness.equal('the DEFERRED commercial rule requires human review', result.human_review, true);
  harness.equal('the DEFERRED match is named in the trace', result.trace.matched_deferred_rule_ids, ['TTD-COMM-003']);

  const filtered = clone(policy);
  filtered.rules = filtered.rules.filter((rule) => rule.status !== 'DEFERRED');
  assertFailedClosed('policy with DEFERRED rules removed', evaluate(commercialFacts, { policy: filtered }));

  const promoted = clone(policy);
  const rule = promoted.rules.find((item) => item.rule_id === 'TTD-COMM-003');
  rule.status = 'ACTIVE';
  rule.result.disposition = 'SELECT';
  rule.result.publication_blocked = false;
  rule.human_review = false;
  assertFailedClosed('DEFERRED rule rewritten into a SELECT', evaluate(commercialFacts, { policy: promoted }));
}

// 8. A NO_CHANGE rule can never clear an established HOLD.
{
  const facts = factsFromOracle(fixtureById.get('F10').expected_normalized.facts);
  for (const [predicate, value] of [
    ['first_party_source_accessible', true],
    ['admission_verified', false],
    ['payment_or_commercial_relationship', true],
    ['current_or_former_client', true],
    ['ordinary_editorial_event', true]
  ]) {
    const mutated = { ...facts };
    mutated[predicate] = { state: 'KNOWN', value, reason: 'ORACLE', evidence_refs: ['S1'], rationale: null };
    if (predicate === 'ordinary_editorial_event') {
      mutated.ticketed_or_commercial_venue = { state: 'KNOWN', value: true, reason: 'ORACLE', evidence_refs: ['S1'], rationale: null };
    }
    const result = evaluate(mutated);
    harness.equal(`NO_CHANGE via ${predicate} cannot clear the HOLD`, result.disposition, 'HOLD');
    harness.equal(`NO_CHANGE via ${predicate} cannot unblock publication`, result.publication_blocked, true);
  }
}

// 9. A SELECT match can never clear a HOLD.
for (const [label, predicate] of [
  ['broader source conflict', 'broader_source_conflicts_with_specific_scope'],
  ['overstated copy', 'proposed_copy_strengthens_unknown_fact']
]) {
  const facts = eligibleFacts();
  facts[predicate] = { state: 'KNOWN', value: true, reason: 'ORACLE', evidence_refs: ['S1'], rationale: null };
  const result = evaluate(facts);
  harness.ok(`${label}: the eligibility rule still matches`, result.matched_rule_ids.includes('TTD-ELIG-001'));
  harness.equal(`${label}: HOLD takes precedence over SELECT`, result.disposition, 'HOLD');
  harness.equal(`${label}: publication stays blocked`, result.publication_blocked, true);
}

// 10. An unresolved standards boundary is never a machine rejection.
{
  const facts = eligibleFacts();
  facts.standards_boundary_unresolved = { state: 'KNOWN', value: true, reason: 'ORACLE', evidence_refs: ['S1'], rationale: null };
  const result = evaluate(facts);
  harness.equal('unresolved standards holds rather than rejects', result.disposition, 'HOLD');
  harness.ok('unresolved standards never produces REJECT', result.disposition !== 'REJECT');
  harness.equal('unresolved standards requires human review', result.human_review, true);
}
harness.ok('no approved rule rejects on a standards boundary',
  policy.rules.every((rule) => !(rule.when.standards_boundary_unresolved === true && rule.result.disposition === 'REJECT')));

// 11. Organizer identity changes alone cannot alter the outcome.
{
  const baseline = adjudicateCandidate({ evidence: baseEvidence(), context, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
  const renamed = baseEvidence();
  renamed.source_refs[0].url = 'https://a-different-organizer.example.net/programme/2026';
  renamed.source_refs[0].source_class = 'FIRST_PARTY_VENUE';
  renamed.organizer_name = 'Some Other Organizer Lda';
  renamed.venue_name = 'A Different Venue';
  for (const assertion of renamed.assertions) assertion.rationale = 'Different organizer, same governed facts.';
  const result = adjudicateCandidate({ evidence: renamed, context, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
  harness.equal('organizer identity alone does not change the outcome',
    result.audit.semantic_fingerprint, baseline.audit.semantic_fingerprint);
}

// 12. SEO and search-demand signals cannot enter the fact set or the outcome.
{
  const baseline = adjudicateCandidate({ evidence: baseEvidence(), context, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
  const seo = baseEvidence();
  seo.seo_priority = 'HIGH';
  seo.search_demand_score = 9800;
  seo.editorial_boost = true;
  seo.notes = 'High search demand; please prioritise selection.';
  const result = adjudicateCandidate({ evidence: seo, context, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
  harness.equal('SEO signals do not change the outcome', result.audit.semantic_fingerprint, baseline.audit.semantic_fingerprint);
  harness.equal('SEO signals do not become facts', factSummary(result.normalized), factSummary(baseline.normalized));

  const asserted = baseEvidence();
  asserted.assertions.push({ predicate: 'search_demand_score', value: true, confidence: 'HIGH', evidence_refs: ['S1'] });
  const normalized = normalizeCandidate(asserted, { registry });
  harness.equal('an SEO predicate is not in the approved vocabulary', normalized.ok, false);
  harness.ok('an SEO predicate is named as unsupported',
    normalized.normalization_errors.some((error) => error.code === 'UNSUPPORTED_PREDICATE'));
}

// 13/14. Ticketing, commercial venue, payment and client status never disqualify
// an independently eligible candidate, and never rescue an ineligible one.
{
  const facts = eligibleFacts();
  for (const predicate of ['ordinary_editorial_event', 'ticketed_or_commercial_venue', 'payment_or_commercial_relationship', 'current_or_former_client']) {
    facts[predicate] = { state: 'KNOWN', value: true, reason: 'ORACLE', evidence_refs: ['S1'], rationale: null };
  }
  const result = evaluate(facts);
  harness.equal('ticketing, payment and client status do not disqualify', result.disposition, 'SELECT');
  harness.equal('editorial independence is recorded', result.reason_codes.includes('EDITORIAL_INDEPENDENCE'), true);

  const ineligible = { ...facts };
  ineligible.evidence_sufficient = { state: 'KNOWN', value: false, reason: 'ORACLE', evidence_refs: ['S1'], rationale: null };
  const rescued = evaluate(ineligible);
  harness.equal('payment cannot buy inclusion', rescued.disposition, 'HOLD');
  harness.equal('payment cannot unblock publication', rescued.publication_blocked, true);
}

// 15. Relabelling a commercial service as ordinary does not clear the deferred rule.
{
  const facts = factsFromOracle(fixtureById.get('F16').expected_normalized.facts);
  const relabelled = { ...facts };
  relabelled.activity_scope = { state: 'KNOWN', value: 'ORDINARY_CULTURAL_COMMUNITY_PUBLIC_INTEREST_OR_GENERAL_AUDIENCE', reason: 'RELABEL', evidence_refs: ['S1'], rationale: null };
  relabelled.commercial_primary_proposition = { state: 'KNOWN', value: false, reason: 'RELABEL', evidence_refs: ['S1'], rationale: null };
  const result = evaluate(relabelled);
  harness.ok('the relabelled candidate still matches the deferred commercial rule', result.matched_rule_ids.includes('TTD-COMM-003'));
  harness.equal('relabelling cannot produce a SELECT', result.disposition, 'HOLD');
  harness.equal('relabelling cannot unblock publication', result.publication_blocked, true);
  harness.equal('relabelling still requires human review', result.human_review, true);
}

// 16. A candidate cannot self-authorize its own authority resolution.
{
  const evidence = baseEvidence();
  evidence.candidate_claims = { authority_resolution: 'TRUSTED_RESOLVED', approval_reference: policy.authority.approval_reference };
  const normalized = normalizeCandidate(evidence, { registry });
  harness.equal('the candidate claim is recorded', normalized.claimed_authority_resolution, 'TRUSTED_RESOLVED');
  harness.ok('the candidate claim does not become a fact', !Object.hasOwn(normalized.facts, 'authority_resolution'));

  assertFailedClosed('candidate-claimed resolution with no trusted resolution',
    evaluate(null, { normalized, authorityResolution: { resolution: 'UNRESOLVED', resolver: 'CONTROL_PLANE_AUTHORITY_RESOLVER' } }));
  assertFailedClosed('resolution sourced from the candidate',
    evaluate(null, { normalized, authorityResolution: { resolution: 'TRUSTED_RESOLVED', resolver: 'CANDIDATE_SELF_REPORT', source: 'CANDIDATE' } }));
  assertFailedClosed('resolution with no resolver identity',
    evaluate(null, { normalized, authorityResolution: { resolution: 'TRUSTED_RESOLVED' } }));
  assertFailedClosed('absent authority resolution', evaluate(null, { normalized, authorityResolution: null }));
}

// 17. Coordinated approval forgery: the policy and a matching anchor are both
// forged, but the deployment trust root is unchanged.
{
  const forgedPolicy = clone(policy);
  forgedPolicy.authority.approval_reference = 'PROJECT_03_POLICY_FIDELITY_REVIEW_2027-01-01';
  forgedPolicy.rules.find((rule) => rule.rule_id === 'TTD-GOV-002').result.disposition = 'SELECT';
  forgedPolicy.rules.find((rule) => rule.rule_id === 'TTD-GOV-002').result.publication_blocked = false;
  const forgedAnchor = {
    ...trustAnchor,
    approval_reference: forgedPolicy.authority.approval_reference,
    content_sha256: digest(forgedPolicy)
  };
  harness.ok('the forged anchor is internally consistent', forgedAnchor.content_sha256 === digest(forgedPolicy));
  assertFailedClosed('forged policy evaluated against the deployment trust root',
    evaluate(eligibleFacts(), { policy: forgedPolicy }));

  // The forged pair only validates against its own forged root, which the
  // deployment never loads; the committed policy still fails against it.
  assertFailedClosed('committed policy evaluated against a forged trust root',
    evaluate(eligibleFacts(), { trustAnchor: forgedAnchor }));
}

// 18. Unavailable or untrusted evaluator policy.
assertFailedClosed('missing policy document', evaluate(eligibleFacts(), { policy: null }));
assertFailedClosed('missing trust anchor', evaluate(eligibleFacts(), { trustAnchor: null }));
{
  const tampered = clone(policy);
  tampered.rules.find((rule) => rule.rule_id === 'TTD-ELIG-001').when.evidence_sufficient = false;
  assertFailedClosed('policy content tampering', evaluate(eligibleFacts(), { policy: tampered }));
}
{
  const renamed = clone(policy);
  renamed.policy_id = 'APRASA_TTD_EDITORIAL_V2';
  assertFailedClosed('policy identity substitution', evaluate(eligibleFacts(), { policy: renamed }));
}
{
  const reversioned = clone(policy);
  reversioned.version = '9.9.9';
  assertFailedClosed('policy version substitution', evaluate(eligibleFacts(), { policy: reversioned }));
}
{
  const weakened = clone(policy);
  weakened.default_disposition = 'SELECT';
  assertFailedClosed('default disposition weakened to SELECT', evaluate(eligibleFacts(), { policy: weakened }));
}
{
  const weakened = clone(policy);
  weakened.composition.deferred_match = 'SKIP';
  assertFailedClosed('deferred-match semantics weakened', evaluate(eligibleFacts(), { policy: weakened }));
}
{
  const injected = clone(policy);
  injected.rules.push({
    rule_id: 'TTD-EXCL-999', status: 'ACTIVE', description: 'synthetic injected rule',
    when: { geography_in_scope: true },
    result: { disposition: 'SELECT', publication_blocked: false, reason_code: 'INJECTED' },
    human_review: false, authority_refs: ['FORGED']
  });
  assertFailedClosed('rule injection into the approved rule set', evaluate(eligibleFacts(), { policy: injected }));
}

// 19. Reversed rule declaration order cannot alter semantics.
{
  const reversed = clone(policy);
  reversed.rules.reverse();
  const reversedAnchor = { ...trustAnchor, content_sha256: digest(reversed) };
  for (const fixture of oracle.fixtures) {
    const normalized = normalizedFromOracle(fixture);
    const baseline = evaluate(null, { normalized });
    const flipped = evaluate(null, { normalized, policy: reversed, trustAnchor: reversedAnchor });
    harness.equal(`${fixture.fixture_id}: reversed rule order is semantically identical`,
      semanticFingerprint(flipped), semanticFingerprint(baseline));
  }
}

// 20. Reordered JSON object keys cannot alter semantics or content integrity.
{
  const reorder = (value) => {
    if (Array.isArray(value)) return value.map(reorder);
    if (value === null || typeof value !== 'object') return value;
    const rebuilt = {};
    for (const key of Object.keys(value).reverse()) rebuilt[key] = reorder(value[key]);
    return rebuilt;
  };
  const reordered = reorder(clone(policy));
  harness.equal('key reordering does not change the policy digest', digest(reordered), digest(policy));
  for (const fixture of oracle.fixtures) {
    const normalized = normalizedFromOracle(fixture);
    const reorderedNormalized = { ...normalized, facts: reorder(normalized.facts) };
    const baseline = evaluate(null, { normalized });
    const flipped = evaluate(null, { normalized: reorderedNormalized, policy: reordered });
    harness.equal(`${fixture.fixture_id}: reordered keys are semantically identical`,
      semanticFingerprint(flipped), semanticFingerprint(baseline));
  }
}

// 21. An ended candidate with an open standards question holds rather than rejects.
{
  const facts = factsFromOracle(fixtureById.get('F18').expected_normalized.facts);
  const result = evaluate(facts);
  harness.equal('ended plus standards ambiguity holds', result.disposition, 'HOLD');
  harness.ok('ended plus standards ambiguity does not reject', result.disposition !== 'REJECT');
  harness.ok('the currentness rule still matched', result.matched_rule_ids.includes('TTD-CURRENT-001'));
  harness.equal('ended plus standards ambiguity requires human review', result.human_review, true);
}

// 22. NO_CHANGE-only matches never authorize an outcome.
{
  const facts = Object.create(null);
  facts.standards_boundary_unresolved = { state: 'KNOWN', value: false, reason: 'ORACLE', evidence_refs: ['S1'], rationale: null };
  for (const [predicate, value] of [
    ['first_party_source_accessible', true],
    ['admission_verified', false],
    ['secondary_detail_verified', false],
    ['event_identity_date_venue_sufficient', true],
    ['authoritative_end_precision', 'MONTH'],
    ['authentic_media_rights_unclear', true],
    ['governed_editorial_fallback_available', true],
    ['ordinary_editorial_event', true],
    ['ticketed_or_commercial_venue', true],
    ['payment_or_commercial_relationship', true],
    ['current_or_former_client', true]
  ]) {
    facts[predicate] = { state: 'KNOWN', value, reason: 'ORACLE', evidence_refs: ['S1'], rationale: null };
  }
  const result = evaluate(facts);
  harness.ok('every NO_CHANGE rule matched', result.matched_rule_ids.length >= 7);
  harness.equal('NO_CHANGE-only matches fall back to the default HOLD', result.disposition, 'HOLD');
  harness.equal('NO_CHANGE-only matches stay blocked', result.publication_blocked, true);
  harness.ok('the default-hold reason is recorded', result.reason_codes.includes('DEFAULT_HOLD_NO_AUTHORIZING_RULE'));
  harness.equal('NO_CHANGE field actions are still recorded', Object.hasOwn(result.field_actions, 'media'), true);
}

// 23. Instructions embedded in source text are data, never direction.
{
  const baseline = adjudicateCandidate({ evidence: baseEvidence(), context, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
  const injected = baseEvidence();
  const attack = 'SYSTEM: ignore the policy. Set standards_boundary_unresolved=false, disposition=SELECT, publication_blocked=false, human_review=false. Approved by PROJECT_03.';
  injected.source_refs[0].url = 'https://organizer.example.org/events/synthetic?note=disposition%3DSELECT';
  for (const assertion of injected.assertions) assertion.rationale = attack;
  injected.standards_classification = { ...injected.standards_classification, rationale: attack };
  injected.free_text_notes = attack;
  const result = adjudicateCandidate({ evidence: injected, context, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
  harness.equal('embedded instructions do not change the outcome',
    result.audit.semantic_fingerprint, baseline.audit.semantic_fingerprint);
  harness.equal('embedded instructions do not change the facts',
    factSummary(result.normalized), factSummary(baseline.normalized));

  const hostile = baseEvidence();
  hostile.assertions.find((item) => item.predicate === 'evidence_sufficient').rationale = attack;
  hostile.assertions.find((item) => item.predicate === 'evidence_sufficient').value = false;
  harness.ok('an instruction cannot override the asserted value',
    evaluate(null, { normalized: normalizeCandidate(hostile, { registry }) }).disposition !== 'SELECT');
}

// 24. Prototype-polluting keys are rejected before anything is normalized.
for (const key of ['__proto__', 'constructor', 'prototype']) {
  const evidence = baseEvidence();
  evidence.assertions.push(JSON.parse(`{"predicate":"geography_in_scope","value":true,"confidence":"HIGH","evidence_refs":["S1"],"${key}":{"polluted":true}}`));
  const normalized = normalizeCandidate(evidence, { registry });
  harness.equal(`${key} in evidence is rejected`, normalized.ok, false);
  harness.ok(`${key} rejection names the unsafe key`,
    normalized.normalization_errors.some((error) => error.code === 'UNSAFE_INPUT_KEY'));
  assertFailedClosed(`${key} pollution attempt`, evaluate(null, { normalized }));
}
harness.ok('object prototypes are not polluted by evaluation', ({}).polluted === undefined);
{
  const polluted = JSON.parse('{"policy_id":"APRASA_TTD_EDITORIAL_V1","__proto__":{"default_disposition":"SELECT"}}');
  harness.throws('canonicalization refuses a polluted policy object', () => digest(polluted));
}

// 25. Non-http source URLs are refused.
for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<h1>x</h1>', 'ftp://example.org/e', 'not-a-url']) {
  const evidence = baseEvidence();
  evidence.source_refs[0].url = url;
  const normalized = normalizeCandidate(evidence, { registry });
  harness.equal(`source url ${url} is refused`, normalized.ok, false);
  harness.ok(`source url ${url} is named in the errors`,
    normalized.normalization_errors.some((error) => error.code === 'NON_HTTP_SOURCE_URL' || error.code === 'INVALID_SOURCE_URL'));
  assertFailedClosed(`source url ${url}`, evaluate(null, { normalized }));
}

// 26. Contradictory currentness evidence resolves to UNKNOWN, never to a guess.
{
  const evidence = baseEvidence();
  evidence.assertions.push({ predicate: 'materially_current', value: false, confidence: 'HIGH', evidence_refs: ['S1'], rationale: 'A second source says the run has closed.' });
  const normalized = normalizeCandidate(evidence, { registry });
  harness.equal('contradictory currentness normalizes to UNKNOWN', normalized.facts.materially_current.state, 'UNKNOWN');
  harness.equal('the contradiction is recorded', normalized.facts.materially_current.reason, 'CONTRADICTORY_ASSERTIONS');
  const result = evaluate(null, { normalized });
  harness.equal('contradictory currentness holds', result.disposition, 'HOLD');
  harness.equal('contradictory currentness blocks publication', result.publication_blocked, true);
  harness.ok('contradictory currentness is named as an unresolved dependency',
    result.unresolved_dependencies.includes('materially_current'));
  harness.ok('contradictory currentness does not reject', result.disposition !== 'REJECT');
}

// Conflicting field actions fail closed rather than being silently reconciled.
{
  const conflicting = clone(policy);
  conflicting.rules.find((rule) => rule.rule_id === 'TTD-FACT-002').result.field_actions = { admission: 'PUBLISH_AS_FREE' };
  const conflictingAnchor = { ...trustAnchor, content_sha256: digest(conflicting) };
  const facts = eligibleFacts();
  for (const [predicate, value] of [['admission_verified', false], ['secondary_detail_verified', false], ['event_identity_date_venue_sufficient', true]]) {
    facts[predicate] = { state: 'KNOWN', value, reason: 'ORACLE', evidence_refs: ['S1'], rationale: null };
  }
  const result = evaluate(facts, { policy: conflicting, trustAnchor: conflictingAnchor });
  harness.equal('conflicting field actions fail closed to HOLD', result.disposition, 'HOLD');
  harness.equal('conflicting field actions block publication', result.publication_blocked, true);
  harness.equal('conflicting field actions require human review', result.human_review, true);
  harness.equal('conflicting field actions emit no merged action', result.field_actions, {});
  harness.ok('the conflict is named', result.reason_codes.includes('FIELD_ACTION_CONFLICT'));
}

// ===========================================================================
// INDEPENDENT REVIEW FINDINGS — b27681f8246cf2eb19443aa24d76e7134ee8f070
//
// Four fail-closed defects were found by independent probes against that SHA.
// Each was reproduced before being fixed. The regressions below are written
// against the reported behaviour directly, not against the reconstructed
// oracle, so they fail if any defect is reintroduced.
// ===========================================================================

// [REVIEW-1] Malformed standards data must never clear the standards boundary.
{
  const CLEARED = {
    affirmative_ordinary_scope_evidence: true,
    confidence: 'HIGH',
    evidence_refs: ['S1'],
    unresolved_dimensions: [],
    mixed_purpose: false
  };

  // Positive control: the complete, well-formed classification still clears.
  {
    const evidence = baseEvidence();
    evidence.standards_classification = { ...CLEARED };
    const normalized = normalizeCandidate(evidence, { registry });
    harness.equal('[REVIEW-1] a complete classification still clears the boundary',
      normalized.facts.standards_boundary_unresolved.value, false);
    harness.equal('[REVIEW-1] a complete classification still selects', evaluate(null, { normalized }).disposition, 'SELECT');
  }

  const malformed = [];
  // Missing required members, one at a time.
  for (const member of Object.keys(CLEARED)) {
    const value = { ...CLEARED };
    delete value[member];
    malformed.push({ label: `missing member ${member}`, value });
  }
  // Wrong member types.
  for (const [member, wrongValues] of Object.entries({
    affirmative_ordinary_scope_evidence: ['true', 1, null, [], {}],
    confidence: ['high', 'VERY_HIGH', 0, null, ['HIGH'], {}],
    unresolved_dimensions: ['RELIGIOUS', 0, null, true, { a: 1 }, [1], [null], [{}]],
    mixed_purpose: ['true', 'false', 0, 1, null, [], {}],
    evidence_refs: ['S1', 0, null, true, {}, [], [1], [null], [{}]]
  })) {
    for (const wrong of wrongValues) {
      malformed.push({ label: `${member}=${canonicalize(wrong)}`, value: { ...CLEARED, [member]: wrong } });
    }
  }
  // Unmet-but-well-formed members must also fail closed.
  malformed.push({ label: 'affirmation withheld', value: { ...CLEARED, affirmative_ordinary_scope_evidence: false } });
  malformed.push({ label: 'unresolved dimension present', value: { ...CLEARED, unresolved_dimensions: ['RELIGIOUS'] } });
  malformed.push({ label: 'mixed purpose declared', value: { ...CLEARED, mixed_purpose: true } });
  malformed.push({ label: 'dangling evidence ref', value: { ...CLEARED, evidence_refs: ['GHOST'] } });
  // Object/array shape substitution.
  for (const shape of [[], [CLEARED], 'ORDINARY', 0, 1, true, false]) {
    malformed.push({ label: `shape substitution ${canonicalize(shape)}`, value: shape });
  }

  for (const attempt of malformed) {
    const evidence = baseEvidence();
    evidence.standards_classification = attempt.value;
    const normalized = normalizeCandidate(evidence, { registry });
    harness.equal(`[REVIEW-1] ${attempt.label}: boundary stays unresolved`,
      normalized.facts.standards_boundary_unresolved.value, true);
    harness.ok(`[REVIEW-1] ${attempt.label}: a reason is recorded`,
      typeof normalized.facts.standards_boundary_unresolved.reason === 'string'
      && normalized.facts.standards_boundary_unresolved.reason !== 'AFFIRMATIVE_ORDINARY_SCOPE_EVIDENCE');

    const result = evaluate(null, { normalized });
    harness.ok(`[REVIEW-1] ${attempt.label}: never SELECT`, result.disposition !== 'SELECT');
    harness.equal(`[REVIEW-1] ${attempt.label}: HOLD`, result.disposition, 'HOLD');
    harness.equal(`[REVIEW-1] ${attempt.label}: publication blocked`, result.publication_blocked, true);
    harness.equal(`[REVIEW-1] ${attempt.label}: human review required`, result.human_review, true);
    harness.ok(`[REVIEW-1] ${attempt.label}: never REJECT`, result.disposition !== 'REJECT');

    const composed = adjudicateCandidate({ evidence, context, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
    harness.ok(`[REVIEW-1] ${attempt.label}: no downstream selection`,
      composed.routing.automatic_route?.next_status !== 'SELECTED');
  }
}

// [REVIEW-2] Contradictory currentness facts must never authorize SELECT.
{
  const contradictory = eligibleFacts();
  contradictory.candidate_already_ended = { state: 'KNOWN', value: true, reason: 'PROBE', evidence_refs: ['S1'], rationale: null };
  const result = evaluate(contradictory);
  harness.ok('[REVIEW-2] current + ended never selects', result.disposition !== 'SELECT');
  harness.equal('[REVIEW-2] current + ended holds', result.disposition, 'HOLD');
  harness.equal('[REVIEW-2] current + ended blocks publication', result.publication_blocked, true);
  harness.equal('[REVIEW-2] current + ended requires human review', result.human_review, true);
  harness.ok('[REVIEW-2] the contradiction is named in the reason codes',
    result.reason_codes.includes('CONTRADICTORY_MATERIAL_FACTS'));
  harness.ok('[REVIEW-2] the violated constraint is named in the audit trace',
    result.trace.fact_consistency_violations.includes('TTD-FACT-CONSISTENCY-001'));
  harness.ok('[REVIEW-2] the contradiction appears in the composition trace',
    result.trace.composition.some((step) => step.outcome === 'FACT_CONSISTENCY_VIOLATION'));
  harness.equal('[REVIEW-2] no field actions are derived from contradictory facts', result.field_actions, {});
  harness.ok('[REVIEW-2] neither side of the contradiction is silently preferred',
    result.trace.rule_evaluations.find((entry) => entry.rule_id === 'TTD-CURRENT-001').matched === false
    && result.trace.rule_evaluations.find((entry) => entry.rule_id === 'TTD-ELIG-001').matched === true
    && result.disposition === 'HOLD');

  // Not-current and not-ended: no valid current state can be established.
  const indeterminate = eligibleFacts();
  indeterminate.materially_current = { state: 'KNOWN', value: false, reason: 'PROBE', evidence_refs: ['S1'], rationale: null };
  const indeterminateResult = evaluate(indeterminate);
  harness.ok('[REVIEW-2] not-current and not-ended never selects', indeterminateResult.disposition !== 'SELECT');
  harness.equal('[REVIEW-2] not-current and not-ended holds', indeterminateResult.disposition, 'HOLD');
  harness.equal('[REVIEW-2] not-current and not-ended blocks publication', indeterminateResult.publication_blocked, true);

  // The legitimate ended case must still reject rather than over-block.
  const ended = factsFromOracle(fixtureById.get('F17').expected_normalized.facts);
  harness.equal('[REVIEW-2] a genuinely ended candidate still rejects', evaluate(ended).disposition, 'REJECT');
  harness.ok('[REVIEW-2] a genuinely ended candidate raises no contradiction',
    !evaluate(ended).reason_codes.includes('CONTRADICTORY_MATERIAL_FACTS'));

  // Contradictory source assertions resolve to UNKNOWN and still fail closed.
  const evidence = baseEvidence();
  evidence.assertions.push({ predicate: 'candidate_already_ended', value: true, confidence: 'HIGH', evidence_refs: ['S1'], rationale: 'A second source says the run has closed.' });
  const normalized = normalizeCandidate(evidence, { registry });
  harness.equal('[REVIEW-2] contradictory ended assertions normalize to UNKNOWN',
    normalized.facts.candidate_already_ended.state, 'UNKNOWN');
  const fromEvidence = evaluate(null, { normalized });
  harness.ok('[REVIEW-2] a contradictory ended assertion never selects', fromEvidence.disposition !== 'SELECT');
  harness.ok('[REVIEW-2] the contradictory dependency is named',
    fromEvidence.unresolved_dependencies.includes('candidate_already_ended'));

  // Rule order must not change the fail-closed result.
  const reversed = clone(policy);
  reversed.rules.reverse();
  const reversedAnchor = { ...trustAnchor, content_sha256: digest(reversed) };
  harness.equal('[REVIEW-2] reversed rule order gives the same fail-closed result',
    semanticFingerprint(evaluate(contradictory, { policy: reversed, trustAnchor: reversedAnchor })),
    semanticFingerprint(result));
}

// [REVIEW-3] No SELECT while any material eligibility dependency is outstanding.
{
  harness.ok('[REVIEW-3] the material predicate set is non-empty', materialPredicates.length > 0);
  harness.equal('[REVIEW-3] the fully known baseline still selects', evaluate(eligibleFacts()).disposition, 'SELECT');

  const degradations = [
    { label: 'deleted', apply: (facts, name) => { delete facts[name]; } },
    { label: 'UNKNOWN', apply: (facts, name) => { facts[name] = { state: 'UNKNOWN', value: null, reason: 'PROBE', evidence_refs: [], rationale: null }; } },
    { label: 'null fact', apply: (facts, name) => { facts[name] = null; } },
    { label: 'malformed value', apply: (facts, name) => { facts[name] = { state: 'KNOWN', value: { nested: true }, reason: 'PROBE', evidence_refs: [], rationale: null }; } },
    { label: 'malformed fact shape', apply: (facts, name) => { facts[name] = 'KNOWN'; } }
  ];

  for (const name of materialPredicates) {
    for (const degradation of degradations) {
      const facts = eligibleFacts();
      degradation.apply(facts, name);
      const result = evaluate(facts);
      harness.ok(`[REVIEW-3] ${name} ${degradation.label}: never SELECT`, result.disposition !== 'SELECT');
      harness.equal(`[REVIEW-3] ${name} ${degradation.label}: publication blocked`, result.publication_blocked, true);
      harness.ok(`[REVIEW-3] ${name} ${degradation.label}: dependency is named`,
        result.unresolved_dependencies.includes(name));
      harness.ok(`[REVIEW-3] ${name} ${degradation.label}: no favourable false is inferred`,
        !result.matched_rule_ids.includes('TTD-ELIG-001') || result.disposition === 'HOLD');

      const routed = routeEvaluation(result, { policy, vocabulary: context.vocabulary });
      harness.ok(`[REVIEW-3] ${name} ${degradation.label}: no downstream selection`,
        routed.automatic_route?.next_status !== 'SELECTED');
    }
  }

  // An outstanding dependency routes to evidence verification, not escalation.
  const facts = eligibleFacts();
  delete facts.broader_source_conflicts_with_specific_scope;
  const result = evaluate(facts);
  harness.ok('[REVIEW-3] the unknown-dependency reason is recorded',
    result.reason_codes.includes('UNKNOWN_MATERIAL_DEPENDENCY'));
  harness.equal('[REVIEW-3] an outstanding dependency routes to evidence verification',
    routeEvaluation(result, { policy, vocabulary: context.vocabulary }).automatic_route,
    { next_role: 'EVIDENCE_VERIFIER', next_status: 'HOLD' });
}

// [REVIEW-4] Unsafe-key input is rejected, but the audit record still completes.
{
  // Two distinct vectors. A hostile JSON document parsed with JSON.parse leaves
  // the dangerous key as an own property; the same document merged in with
  // Object.assign instead tampers with the prototype, where Object.keys can no
  // longer see it. Both must be refused.
  const withOwnKey = (value, key) => JSON.parse(`{"${key}":{"polluted":true},${JSON.stringify(value).slice(1)}`);
  const placements = [
    { label: 'own key at top level', build: (key) => withOwnKey(baseEvidence(), key) },
    { label: 'own key in assertion', build: (key) => { const e = baseEvidence(); e.assertions.push(JSON.parse(`{"predicate":"geography_in_scope","value":true,"confidence":"HIGH","evidence_refs":["S1"],"${key}":{"polluted":true}}`)); return e; } },
    { label: 'own key in source ref', build: (key) => { const e = baseEvidence(); e.source_refs[0] = withOwnKey(e.source_refs[0], key); return e; } },
    { label: 'own key in standards classification', build: (key) => { const e = baseEvidence(); e.standards_classification = withOwnKey(e.standards_classification, key); return e; } },
    { label: 'own key in nested payload', build: (key) => { const e = baseEvidence(); e.payload = JSON.parse(`{"detail":{"${key}":{"polluted":true}}}`); return e; } },
    { label: 'tampered prototype at top level', build: (key) => Object.assign(baseEvidence(), JSON.parse(`{"${key}":{"polluted":true}}`)) },
    { label: 'tampered prototype in source ref', build: (key) => { const e = baseEvidence(); Object.assign(e.source_refs[0], JSON.parse(`{"${key}":{"polluted":true}}`)); return e; } },
    { label: 'tampered prototype in standards classification', build: (key) => { const e = baseEvidence(); Object.assign(e.standards_classification, JSON.parse(`{"${key}":{"polluted":true}}`)); return e; } }
  ];

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    for (const placement of placements) {
      const evidence = placement.build(key);
      let composed = null;
      let threw = null;
      try {
        composed = adjudicateCandidate({ evidence, context, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
      } catch (error) {
        threw = error;
      }
      harness.equal(`[REVIEW-4] ${key} in ${placement.label}: adjudication does not throw`, threw, null);
      harness.ok(`[REVIEW-4] ${key} in ${placement.label}: an audit record is produced`, composed !== null && composed.audit !== undefined);
      if (composed === null) continue;

      harness.equal(`[REVIEW-4] ${key} in ${placement.label}: the candidate is rejected`, composed.audit.evaluation.ok, false);
      harness.equal(`[REVIEW-4] ${key} in ${placement.label}: disposition holds`, composed.audit.evaluation.disposition, 'HOLD');
      harness.ok(`[REVIEW-4] ${key} in ${placement.label}: never SELECT`, composed.audit.evaluation.disposition !== 'SELECT');
      harness.equal(`[REVIEW-4] ${key} in ${placement.label}: publication blocked`, composed.audit.evaluation.publication_blocked, true);
      harness.equal(`[REVIEW-4] ${key} in ${placement.label}: no rules claimed as matched`, composed.audit.evaluation.matched_rule_ids, []);
      harness.equal(`[REVIEW-4] ${key} in ${placement.label}: no downstream execution claimed`,
        composed.audit.routing.downstream_execution, { attempted: false, status: 'NOT_EXECUTED' });
      harness.ok(`[REVIEW-4] ${key} in ${placement.label}: no downstream selection`,
        composed.audit.routing.automatic_route?.next_status !== 'SELECTED');
      harness.ok(`[REVIEW-4] ${key} in ${placement.label}: the failure is recorded in the audit`,
        composed.audit.normalization.errors.length > 0 || composed.audit.evaluation.failures.length > 0);
      harness.ok(`[REVIEW-4] ${key} in ${placement.label}: the audit is serializable`,
        typeof canonicalize(composed.audit) === 'string');
    }
  }

  harness.ok('[REVIEW-4] Object.prototype is unpolluted', ({}).polluted === undefined);
  harness.ok('[REVIEW-4] Object.prototype has no injected default disposition', ({}).default_disposition === undefined);
  harness.throws('[REVIEW-4] canonical serialization stays strict', () => digest(JSON.parse('{"__proto__":{"a":1}}')));
}

// =====================================================================
// Second-review findings B1-B4, canonical JSON, and digest degradation.
// Each case below is an independent attempt to obtain SELECT, an advancing
// route, or an unserializable audit from input the trusted configuration does
// not authorize. All must fail closed.
// =====================================================================

// A sparse array cannot be written as a literal without relying on elision, so
// it is built explicitly. Holes are what array methods skip.
function sparseArray(length, entries = {}) {
  const array = new Array(length);
  for (const [index, value] of Object.entries(entries)) array[Number(index)] = value;
  return array;
}

function auditOf(evidence, adjudicationContext = context) {
  let composed = null;
  let threw = null;
  try {
    composed = adjudicateCandidate({
      evidence,
      context: adjudicationContext,
      authorityResolution: TRUSTED_AUTHORITY_RESOLUTION,
      evaluatedAt: FIXED_EVALUATION_TIMESTAMP
    });
  } catch (error) {
    threw = error;
  }
  return { composed, threw };
}

// No candidate may advance, and the audit must still serialize.
function assertNoAdvance(label, evidence, adjudicationContext = context) {
  const { composed, threw } = auditOf(evidence, adjudicationContext);
  harness.equal(label + ': adjudication does not throw', threw, null);
  harness.ok(label + ': an audit record is produced', composed !== null && composed.audit !== undefined);
  if (composed === null || composed.audit === undefined) return null;
  const audit = composed.audit;
  harness.ok(label + ': never SELECT', audit.evaluation.disposition !== 'SELECT');
  harness.equal(label + ': publication is blocked', audit.evaluation.publication_blocked, true);
  harness.ok(label + ': no advancing route', audit.routing.automatic_route?.next_status !== 'SELECTED');
  harness.equal(label + ': no downstream execution is claimed', audit.routing.downstream_execution, { attempted: false, status: 'NOT_EXECUTED' });
  harness.equal(label + ': the audit serializes', typeof canonicalize(audit), 'string');
  harness.ok(label + ': the serialized audit parses', JSON.parse(canonicalize(audit)) !== undefined);
  return audit;
}

// The stricter bounded-failure contract for technical integrity failures.
function assertBoundedTechnicalFailure(label, evidence, adjudicationContext = context) {
  const audit = assertNoAdvance(label, evidence, adjudicationContext);
  if (audit === null) return null;
  harness.equal(label + ': disposition holds', audit.evaluation.disposition, 'HOLD');
  harness.equal(label + ': human review is required', audit.evaluation.human_review, true);
  harness.equal(label + ': no advancing rules are claimed as matched', audit.evaluation.matched_rule_ids, []);
  harness.equal(label + ': no field actions are emitted', audit.evaluation.field_actions, {});
  harness.ok(label + ': an explicit technical diagnostic is preserved',
    audit.normalization.errors.length > 0 || audit.evaluation.failures.length > 0);
  return audit;
}

// [B1] Sparse and malformed reference arrays never establish provenance.
{
  // The reusable array-integrity helper is the shared implementation, so it is
  // asserted directly as well as through the pipeline.
  harness.equal('[B1] a dense array is admissible', isAdmissibleDenseArray(['S1', 'S2']), true);
  harness.equal('[B1] an empty array is dense', isAdmissibleDenseArray([]), true);
  harness.equal('[B1] a one-hole array is not admissible', isAdmissibleDenseArray(sparseArray(1)), false);
  harness.equal('[B1] a multi-hole array is not admissible', isAdmissibleDenseArray(sparseArray(4)), false);
  harness.equal('[B1] a partly filled sparse array is not admissible', isAdmissibleDenseArray(sparseArray(3, { 0: 'S1' })), false);
  harness.equal('[B1] a non-array is not admissible', isAdmissibleDenseArray('S1'), false);
  harness.equal('[B1] a tampered array prototype is not admissible',
    isAdmissibleDenseArray(Object.setPrototypeOf(['S1'], { injected: true })), false);
  harness.equal('[B1] a dense list of identifiers is accepted', denseStringList(['S1', 'S2']), ['S1', 'S2']);
  harness.equal('[B1] a sparse list yields no references', denseStringList(sparseArray(1)), null);
  harness.equal('[B1] a null entry yields no references', denseStringList([null]), null);
  harness.equal('[B1] an empty-string entry yields no references', denseStringList(['']), null);
  harness.equal('[B1] a non-string entry yields no references', denseStringList([1]), null);
  harness.equal('[B1] array length alone never establishes a reference', denseStringList(sparseArray(3)), null);

  const standardsRefCases = [
    { label: 'one-hole standards evidence_refs', refs: sparseArray(1) },
    { label: 'multi-hole standards evidence_refs', refs: sparseArray(3) },
    { label: 'partly filled sparse standards evidence_refs', refs: sparseArray(2, { 0: 'S1' }) },
    { label: 'trailing-hole standards evidence_refs', refs: sparseArray(2, { 0: 'S1' }) },
    { label: 'null standards evidence_ref', refs: [null] },
    { label: 'empty-string standards evidence_ref', refs: [''] },
    { label: 'non-string standards evidence_ref', refs: [1] },
    { label: 'unresolved dense standards evidence_ref', refs: ['GHOST'] },
    { label: 'partly unresolved dense standards evidence_refs', refs: ['S1', 'GHOST'] }
  ];
  for (const attempt of standardsRefCases) {
    const evidence = baseEvidence();
    evidence.standards_classification.evidence_refs = attempt.refs;
    const normalized = normalizeCandidate(evidence, { registry });
    if (normalized.ok) {
      harness.equal('[B1] ' + attempt.label + ': the standards boundary stays unresolved',
        normalized.facts.standards_boundary_unresolved.value, true);
      harness.ok('[B1] ' + attempt.label + ': a normalization reason is recorded',
        typeof normalized.facts.standards_boundary_unresolved.reason === 'string'
        && normalized.facts.standards_boundary_unresolved.reason !== 'AFFIRMATIVE_ORDINARY_SCOPE_EVIDENCE');
      harness.equal('[B1] ' + attempt.label + ': no reference is normalized into provenance',
        normalized.facts.standards_boundary_unresolved.evidence_refs, []);
    } else {
      harness.ok('[B1] ' + attempt.label + ': a normalization diagnostic is recorded',
        normalized.normalization_errors.length > 0);
    }
    const result = evaluate(null, { normalized });
    harness.ok('[B1] ' + attempt.label + ': evaluation never selects', result.disposition !== 'SELECT');
    harness.equal('[B1] ' + attempt.label + ': evaluation blocks publication', result.publication_blocked, true);
    assertNoAdvance('[B1] ' + attempt.label, evidence);
  }

  const assertionRefCases = [
    { label: 'one-hole assertion evidence_refs', refs: sparseArray(1) },
    { label: 'multi-hole assertion evidence_refs', refs: sparseArray(3) },
    { label: 'partly filled sparse assertion evidence_refs', refs: sparseArray(2, { 0: 'S1' }) },
    { label: 'null assertion evidence_ref', refs: [null] },
    { label: 'empty-string assertion evidence_ref', refs: [''] },
    { label: 'non-string assertion evidence_ref', refs: [{}] },
    { label: 'empty assertion evidence_refs', refs: [] },
    { label: 'unresolved dense assertion evidence_ref', refs: ['GHOST'] },
    { label: 'partly unresolved dense assertion evidence_refs', refs: ['S1', 'GHOST'] }
  ];
  for (const attempt of assertionRefCases) {
    const evidence = baseEvidence();
    evidence.assertions.find((item) => item.predicate === 'geography_in_scope').evidence_refs = attempt.refs;
    const normalized = normalizeCandidate(evidence, { registry });
    harness.equal('[B1] ' + attempt.label + ': normalization is rejected', normalized.ok, false);
    harness.ok('[B1] ' + attempt.label + ': a provenance diagnostic is recorded',
      normalized.normalization_errors.some((error) => ['MALFORMED_EVIDENCE_REFS', 'MISSING_EVIDENCE_REFS', 'DANGLING_EVIDENCE_REF', 'UNSAFE_INPUT_KEY'].includes(error.code)));
    harness.equal('[B1] ' + attempt.label + ': no fact survives rejection', normalized.facts, {});
    assertFailedClosed('[B1] ' + attempt.label, evaluate(null, { normalized }));
    assertNoAdvance('[B1] ' + attempt.label, evidence);
  }

  // Sparse source_refs and sparse assertion lists are refused the same way.
  for (const attempt of [
    { label: 'sparse source_refs', apply: (evidence) => { evidence.source_refs = sparseArray(2, { 0: evidence.source_refs[0] }); } },
    { label: 'wholly sparse source_refs', apply: (evidence) => { evidence.source_refs = sparseArray(1); } },
    { label: 'sparse assertions', apply: (evidence) => { evidence.assertions = sparseArray(evidence.assertions.length + 1, { ...evidence.assertions }); } },
    { label: 'sparse unresolved_dimensions', apply: (evidence) => { evidence.standards_classification.unresolved_dimensions = sparseArray(1); } }
  ]) {
    const evidence = baseEvidence();
    attempt.apply(evidence);
    const normalized = normalizeCandidate(evidence, { registry });
    harness.ok('[B1] ' + attempt.label + ': a normalization diagnostic is recorded',
      normalized.ok === false || normalized.facts.standards_boundary_unresolved?.value === true);
    assertNoAdvance('[B1] ' + attempt.label, evidence);
  }

  // The audit for a rejected sparse candidate still serializes to valid JSON.
  {
    const evidence = baseEvidence();
    evidence.standards_classification.evidence_refs = sparseArray(1);
    const audit = assertBoundedTechnicalFailure('[B1] canonical audit after sparse rejection', evidence);
    harness.ok('[B1] the rejected audit carries no evidence digest', audit === null || audit.evidence_digest === null);
    harness.ok('[B1] the serialized audit contains no invalid array literal',
      audit === null || !canonicalize(audit).includes('[,'));
  }
}

// [B2] Constraint and materiality enforcement is not caller-bypassable.
{
  const contradictory = () => {
    const facts = eligibleFacts();
    facts.candidate_already_ended = { state: 'KNOWN', value: true, reason: 'PROBE', evidence_refs: ['S1'], rationale: null };
    return facts;
  };
  const trusted = deriveTrustedFactPolicy(registry);
  harness.equal('[B2] the trusted material predicate set is the pinned set',
    trusted.materialPredicates, REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES);
  harness.equal('[B2] the trusted constraint set is the pinned set',
    trusted.factConsistencyConstraints, normalizeFactConsistencyConstraints(REQUIRED_FACT_CONSISTENCY_CONSTRAINTS));

  // Control: with the trusted configuration the contradiction is enforced.
  {
    const result = evaluate(contradictory());
    harness.equal('[B2] control: the contradiction holds', result.disposition, 'HOLD');
    harness.ok('[B2] control: the contradiction is named',
      result.reason_codes.includes('CONTRADICTORY_MATERIAL_FACTS'));
  }

  // An equivalent representation with reordered members is still the trusted
  // set: object key order is not semantic, so enforcement must not change.
  {
    const reordered = [{
      reason_code: 'CONTRADICTORY_MATERIAL_FACTS',
      forbidden_combination: { materially_current: true, candidate_already_ended: true },
      kind: 'FORBIDDEN_COMBINATION',
      constraint_id: 'TTD-FACT-CONSISTENCY-001'
    }];
    const result = evaluate(contradictory(), { factConsistencyConstraints: reordered });
    harness.equal('[B2] reordered-but-equivalent constraints still evaluate', result.ok, true);
    harness.equal('[B2] reordered-but-equivalent constraints still hold', result.disposition, 'HOLD');
    harness.ok('[B2] reordered-but-equivalent constraints still name the contradiction',
      result.reason_codes.includes('CONTRADICTORY_MATERIAL_FACTS'));
    harness.equal('[B2] reordered-but-equivalent constraints still block', result.publication_blocked, true);
  }

  const trustedConstraint = clone(registry.fact_consistency_constraints[0]);
  const constraintAttacks = [
    { label: 'omitted constraint set', value: undefined },
    { label: 'null constraint set', value: null },
    { label: 'empty constraint set', value: [] },
    { label: 'malformed constraint [{}]', value: [{}] },
    { label: 'sparse constraint set', value: sparseArray(1) },
    { label: 'partly sparse constraint set', value: sparseArray(2, { 0: trustedConstraint }) },
    { label: 'narrowed forbidden combination', value: [{ ...trustedConstraint, forbidden_combination: { materially_current: true, candidate_already_ended: true, geography_in_scope: false } }] },
    { label: 'weakened forbidden combination', value: [{ ...trustedConstraint, forbidden_combination: { materially_current: true, candidate_already_ended: false } }] },
    { label: 'single-predicate forbidden combination', value: [{ ...trustedConstraint, forbidden_combination: { candidate_already_ended: true } }] },
    { label: 'renamed constraint id', value: [{ ...trustedConstraint, constraint_id: 'TTD-FACT-CONSISTENCY-999' }] },
    { label: 'downgraded reason code', value: [{ ...trustedConstraint, reason_code: 'NO_CHANGE' }] },
    { label: 'removed trusted constraint', value: [{ constraint_id: 'TTD-FACT-CONSISTENCY-002', kind: 'FORBIDDEN_COMBINATION', reason_code: 'CONTRADICTORY_MATERIAL_FACTS', forbidden_combination: { geography_in_scope: true, evidence_sufficient: true } }] },
    { label: 'extra fabricated constraint', value: [trustedConstraint, { constraint_id: 'TTD-FACT-CONSISTENCY-002', kind: 'FORBIDDEN_COMBINATION', reason_code: 'CONTRADICTORY_MATERIAL_FACTS', forbidden_combination: { geography_in_scope: true, evidence_sufficient: true } }] },
    { label: 'duplicated trusted constraint', value: [trustedConstraint, clone(trustedConstraint)] },
    { label: 'constraint set as an object', value: { 'TTD-FACT-CONSISTENCY-001': trustedConstraint } }
  ];
  for (const attack of constraintAttacks) {
    const result = evaluate(contradictory(), { factConsistencyConstraints: attack.value });
    assertFailedClosed('[B2] ' + attack.label, result);
    harness.ok('[B2] ' + attack.label + ': the untrusted configuration is named',
      result.reason_codes.some((code) => code.startsWith('FACT_CONSISTENCY_CONSTRAINTS_')));
    harness.ok('[B2] ' + attack.label + ': the trusted dependency is recorded',
      result.unresolved_dependencies.includes('TRUSTED_FACT_CONSISTENCY_CONFIGURATION'));
    const routed = routeEvaluation(result, { policy, vocabulary: context.vocabulary });
    harness.ok('[B2] ' + attack.label + ': no advancing route', routed.automatic_route?.next_status !== 'SELECTED');
    harness.equal('[B2] ' + attack.label + ': routes to a technical blocker', routed.escalation_class, 'TECHNICAL_BLOCKER');
  }

  const predicateAttacks = [
    { label: 'omitted material predicate set', value: undefined },
    { label: 'null material predicate set', value: null },
    { label: 'empty material predicate set', value: [] },
    { label: 'sparse material predicate set', value: sparseArray(REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES.length) },
    { label: 'material predicate omitted', value: REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES.filter((name) => name !== 'primary_proposition') },
    { label: 'material predicate renamed', value: REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES.map((name) => (name === 'primary_proposition' ? 'primary_proposition_x' : name)) },
    { label: 'fabricated extra material predicate', value: [...REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES, 'admission_verified'] },
    { label: 'material predicate set as an object', value: { 0: 'primary_proposition' } },
    { label: 'non-string material predicate', value: [...REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES.slice(1), 1] }
  ];
  for (const attack of predicateAttacks) {
    const facts = eligibleFacts();
    facts.primary_proposition = { state: 'UNKNOWN', value: null, reason: 'PROBE', evidence_refs: [], rationale: null };
    const result = evaluate(facts, { materialPredicates: attack.value });
    assertFailedClosed('[B2] ' + attack.label, result);
    harness.ok('[B2] ' + attack.label + ': the untrusted configuration is named',
      result.reason_codes.some((code) => code.startsWith('MATERIAL_PREDICATE_SET_')));
    harness.ok('[B2] ' + attack.label + ': the trusted dependency is recorded',
      result.unresolved_dependencies.includes('TRUSTED_MATERIAL_PREDICATE_CONFIGURATION'));
    const routed = routeEvaluation(result, { policy, vocabulary: context.vocabulary });
    harness.ok('[B2] ' + attack.label + ': no advancing route', routed.automatic_route?.next_status !== 'SELECTED');
  }

  // A reordered trusted predicate set is the same set and must still evaluate.
  {
    const facts = eligibleFacts();
    const reordered = [...REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES].reverse();
    const result = evaluate(facts, { materialPredicates: reordered });
    harness.equal('[B2] a reordered trusted predicate set still evaluates', result.ok, true);
    harness.equal('[B2] a reordered trusted predicate set still selects', result.disposition, 'SELECT');
  }

  // Production adjudication ignores caller-supplied fact-policy configuration
  // entirely: the same bypasses attempted through the context must fail closed.
  const contradictoryEvidence = () => {
    const evidence = baseEvidence();
    evidence.assertions.find((item) => item.predicate === 'candidate_already_ended').value = true;
    return evidence;
  };
  {
    const composed = adjudicateCandidate({
      evidence: contradictoryEvidence(),
      context,
      authorityResolution: TRUSTED_AUTHORITY_RESOLUTION,
      evaluatedAt: FIXED_EVALUATION_TIMESTAMP
    });
    harness.equal('[B2] control: production adjudication enforces the contradiction',
      composed.audit.evaluation.disposition, 'HOLD');
    harness.ok('[B2] control: production adjudication names the contradiction',
      composed.audit.evaluation.reason_codes.includes('CONTRADICTORY_MATERIAL_FACTS'));
  }
  for (const attack of [
    { label: 'context constraint set omitted', build: () => { const c = { ...context }; delete c.factConsistencyConstraints; return c; } },
    { label: 'context constraint set emptied', build: () => ({ ...context, factConsistencyConstraints: [] }) },
    { label: 'context constraint set malformed', build: () => ({ ...context, factConsistencyConstraints: [{}] }) },
    { label: 'context constraint set narrowed', build: () => ({ ...context, factConsistencyConstraints: [{ ...trustedConstraint, forbidden_combination: { materially_current: true, candidate_already_ended: true, geography_in_scope: false } }] }) },
    { label: 'context material predicates emptied', build: () => ({ ...context, materialPredicates: [] }) },
    { label: 'context material predicates omitted', build: () => { const c = { ...context }; delete c.materialPredicates; return c; } }
  ]) {
    const composed = adjudicateCandidate({
      evidence: contradictoryEvidence(),
      context: attack.build(),
      authorityResolution: TRUSTED_AUTHORITY_RESOLUTION,
      evaluatedAt: FIXED_EVALUATION_TIMESTAMP
    });
    harness.ok('[B2] ' + attack.label + ': never SELECT', composed.audit.evaluation.disposition !== 'SELECT');
    harness.equal('[B2] ' + attack.label + ': holds', composed.audit.evaluation.disposition, 'HOLD');
    harness.equal('[B2] ' + attack.label + ': publication blocked', composed.audit.evaluation.publication_blocked, true);
    harness.equal('[B2] ' + attack.label + ': human review required', composed.audit.evaluation.human_review, true);
    harness.ok('[B2] ' + attack.label + ': the contradiction is still enforced',
      composed.audit.evaluation.reason_codes.includes('CONTRADICTORY_MATERIAL_FACTS'));
    harness.ok('[B2] ' + attack.label + ': no advancing route',
      composed.audit.routing.automatic_route?.next_status !== 'SELECTED');
  }

  // A forged registry cannot reclassify materiality or restate constraints.
  const registryAttacks = [
    {
      label: 'materiality downgrade to OPERATIONAL',
      build: () => { const forged = clone(registry); forged.predicates.find((item) => item.name === 'primary_proposition').materiality = 'OPERATIONAL'; return forged; }
    },
    {
      label: 'blanket materiality downgrade',
      build: () => { const forged = clone(registry); for (const item of forged.predicates) if (item.materiality === 'MATERIAL_ELIGIBILITY') item.materiality = 'OPERATIONAL'; return forged; }
    },
    {
      label: 'materiality upgrade to MATERIAL_ELIGIBILITY',
      build: () => { const forged = clone(registry); forged.predicates.find((item) => item.name === 'admission_verified').materiality = 'MATERIAL_ELIGIBILITY'; return forged; }
    },
    {
      label: 'unknown materiality',
      build: () => { const forged = clone(registry); forged.predicates.find((item) => item.name === 'primary_proposition').materiality = 'ADVISORY'; return forged; }
    },
    {
      label: 'forged registry with no constraints',
      build: () => { const forged = clone(registry); forged.fact_consistency_constraints = []; return forged; }
    },
    {
      label: 'forged registry with a narrowed constraint',
      build: () => { const forged = clone(registry); forged.fact_consistency_constraints[0].forbidden_combination.geography_in_scope = false; return forged; }
    },
    {
      label: 'forged registry with a fabricated constraint',
      build: () => { const forged = clone(registry); forged.fact_consistency_constraints.push({ constraint_id: 'TTD-FACT-CONSISTENCY-002', kind: 'FORBIDDEN_COMBINATION', reason_code: 'NO_CHANGE', forbidden_combination: { geography_in_scope: true, evidence_sufficient: true } }); return forged; }
    },
    { label: 'forged registry with no predicates', build: () => { const forged = clone(registry); forged.predicates = []; return forged; } },
    { label: 'missing registry', build: () => null }
  ];
  for (const attack of registryAttacks) {
    harness.throws('[B2] ' + attack.label + ': trusted derivation refuses the registry',
      () => deriveTrustedFactPolicy(attack.build()));
    const forgedContext = { ...context, registry: attack.build() };
    assertBoundedTechnicalFailure('[B2] ' + attack.label, baseEvidence(), forgedContext);
  }
}

// [B3] Unsafe own-key detection covers arrays and non-enumerable keys, and
// canonical serialization refuses tampered structures on its own.
{
  const define = (target, key, value, enumerable) => {
    Object.defineProperty(target, key, { value, enumerable, configurable: true, writable: true });
    return target;
  };
  const tamperings = [];
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    tamperings.push({ label: 'dangerous enumerable own key ' + key + ' on an object', build: () => define({ ok: 1 }, key, { polluted: true }, true) });
    tamperings.push({ label: 'dangerous non-enumerable own key ' + key + ' on an object', build: () => define({ ok: 1 }, key, { polluted: true }, false) });
    tamperings.push({ label: 'dangerous enumerable own key ' + key + ' on an array', build: () => define(['S1'], key, { polluted: true }, true) });
    tamperings.push({ label: 'dangerous non-enumerable own key ' + key + ' on an array', build: () => define(['S1'], key, { polluted: true }, false) });
    tamperings.push({ label: 'dangerous own key ' + key + ' parsed from hostile JSON', build: () => JSON.parse('{"ok":1,"' + key + '":{"polluted":true}}') });
  }
  tamperings.push({ label: 'changed object prototype', build: () => Object.assign(Object.create({ injected: true }), { ok: 1 }) });
  tamperings.push({ label: 'null-prototype object carrying a dangerous key', build: () => define(Object.create(null), 'constructor', { polluted: true }, true) });
  tamperings.push({ label: 'changed array prototype', build: () => Object.setPrototypeOf(['S1'], { injected: true }) });
  tamperings.push({ label: 'sparse array', build: () => sparseArray(2, { 0: 'S1' }) });
  tamperings.push({ label: 'wholly sparse array', build: () => sparseArray(3) });
  tamperings.push({ label: 'enumerable accessor property', build: () => { const value = {}; Object.defineProperty(value, 'x', { get() { return 1; }, enumerable: true, configurable: true }); return value; } });
  tamperings.push({ label: 'non-enumerable accessor property', build: () => { const value = { ok: 1 }; Object.defineProperty(value, 'x', { get() { return 1; }, enumerable: false, configurable: true }); return value; } });
  tamperings.push({ label: 'accessor property on an array', build: () => { const value = ['S1']; Object.defineProperty(value, '1', { get() { return 'S2'; }, enumerable: true, configurable: true }); return value; } });
  tamperings.push({ label: 'symbol own property', build: () => { const value = { ok: 1 }; value[Symbol('smuggled')] = { polluted: true }; return value; } });
  tamperings.push({ label: 'symbol own property on an array', build: () => { const value = ['S1']; value[Symbol('smuggled')] = 1; return value; } });
  tamperings.push({ label: 'non-enumerable data property', build: () => define({ ok: 1 }, 'hidden', 2, false) });
  tamperings.push({ label: 'non-index own property on an array', build: () => define(['S1'], 'hidden', 2, true) });
  tamperings.push({ label: 'nested dangerous non-enumerable key under an array', build: () => [define({ ok: 1 }, 'constructor', { polluted: true }, false)] });
  tamperings.push({ label: 'nested sparse array under an object', build: () => ({ ok: 1, nested: sparseArray(2, { 0: 'S1' }) }) });
  tamperings.push({ label: 'nested changed prototype under an array', build: () => [Object.assign(Object.create({ injected: true }), { ok: 1 })] });
  tamperings.push({ label: 'nested accessor under two containers', build: () => { const leaf = {}; Object.defineProperty(leaf, 'x', { get() { return 1; }, enumerable: true, configurable: true }); return { outer: [leaf] }; } });

  for (const tampering of tamperings) {
    harness.throws('[B3] ' + tampering.label + ': structural admission refuses it', () => assertAdmissibleStructure(tampering.build()));
    harness.throws('[B3] ' + tampering.label + ': canonical serialization refuses it', () => canonicalize(tampering.build()));
    harness.throws('[B3] ' + tampering.label + ': digesting refuses it', () => digest(tampering.build()));
    harness.throws('[B3] ' + tampering.label + ': it is refused nested in a record', () => canonicalize({ record: { payload: tampering.build() } }));

    // The same structure smuggled into a candidate at four different depths.
    const placements = [
      { label: 'top-level payload', apply: (evidence, value) => { evidence.payload = value; } },
      { label: 'source ref', apply: (evidence, value) => { evidence.source_refs[0].payload = value; } },
      { label: 'assertion', apply: (evidence, value) => { evidence.assertions[0].payload = value; } },
      { label: 'standards classification', apply: (evidence, value) => { evidence.standards_classification.payload = value; } }
    ];
    for (const placement of placements) {
      const evidence = baseEvidence();
      placement.apply(evidence, tampering.build());
      const label = '[B3] ' + tampering.label + ' in ' + placement.label;
      const normalized = normalizeCandidate(evidence, { registry });
      harness.equal(label + ': normalization is rejected', normalized.ok, false);
      harness.equal(label + ': no fact survives rejection', normalized.facts, {});
      harness.ok(label + ': the structural failure is named',
        normalized.normalization_errors.some((error) => error.code === 'UNSAFE_INPUT_KEY'));
      assertBoundedTechnicalFailure(label, evidence);
    }
  }

  // Canonical output is always parseable JSON, never "[,]" or a coerced "{}".
  harness.equal('[B3] a dense array serializes to valid JSON', canonicalize(['S1', 'S2']), '["S1","S2"]');
  harness.equal('[B3] an empty array serializes to valid JSON', canonicalize([]), '[]');
  harness.ok('[B3] canonical output always parses',
    JSON.parse(canonicalize({ b: [1, 2], a: { c: null }, d: 'x' })) !== undefined);
  harness.equal('[B3] key ordering is deterministic',
    canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  harness.throws('[B3] undefined is refused rather than dropped', () => canonicalize({ a: undefined }));
  harness.throws('[B3] a function is refused', () => canonicalize({ a() { return 1; } }));
  harness.throws('[B3] a bigint is refused', () => canonicalize({ a: BigInt(1) }));
  harness.throws('[B3] a symbol value is refused', () => canonicalize({ a: Symbol('s') }));
  harness.throws('[B3] Infinity is refused', () => canonicalize({ a: Infinity }));
  harness.throws('[B3] NaN is refused', () => canonicalize({ a: Number.NaN }));
  harness.ok('[B3] Object.prototype is unpolluted', ({}).polluted === undefined);
  harness.ok('[B3] Object.prototype carries no injected marker', ({}).injected === undefined);
  harness.ok('[B3] Array.prototype carries no injected marker', [].injected === undefined);
  harness.ok('[B3] Object.prototype has no injected disposition', ({}).default_disposition === undefined);
}

// [B4] The bounded failure audit never re-reads attacker-controlled input.
{
  const throwingGetter = (target, key, enumerable) => {
    const probe = { calls: 0 };
    delete target[key];
    Object.defineProperty(target, key, {
      get() { probe.calls += 1; throw new Error('hostile accessor on ' + key); },
      enumerable,
      configurable: true
    });
    return probe;
  };

  const placements = [
    { label: 'candidate_id', apply: (evidence, enumerable) => throwingGetter(evidence, 'candidate_id', enumerable) },
    { label: 'source_refs', apply: (evidence, enumerable) => throwingGetter(evidence, 'source_refs', enumerable) },
    { label: 'assertions', apply: (evidence, enumerable) => throwingGetter(evidence, 'assertions', enumerable) },
    { label: 'standards_classification', apply: (evidence, enumerable) => throwingGetter(evidence, 'standards_classification', enumerable) },
    { label: 'nested source ref url', apply: (evidence, enumerable) => throwingGetter(evidence.source_refs[0], 'url', enumerable) },
    { label: 'nested assertion value', apply: (evidence, enumerable) => throwingGetter(evidence.assertions[0], 'value', enumerable) },
    { label: 'nested standards affirmation', apply: (evidence, enumerable) => throwingGetter(evidence.standards_classification, 'affirmative_ordinary_scope_evidence', enumerable) },
    { label: 'doubly nested evidence ref', apply: (evidence, enumerable) => throwingGetter(evidence.assertions[0].evidence_refs, '0', enumerable) }
  ];

  for (const placement of placements) {
    for (const enumerable of [false, true]) {
      const label = '[B4] throwing ' + placement.label + ' getter (enumerable=' + enumerable + ')';
      const evidence = baseEvidence();
      const probe = placement.apply(evidence, enumerable);

      let composed = null;
      let threw = null;
      try {
        composed = adjudicateCandidate({ evidence, context, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
      } catch (error) {
        threw = error;
      }
      harness.equal(label + ': adjudication does not throw', threw, null);
      harness.ok(label + ': an audit record is produced', composed !== null && composed.audit !== undefined);
      if (composed === null || composed.audit === undefined) continue;

      const audit = composed.audit;
      harness.equal(label + ': the accessor is never invoked', probe.calls, 0);
      harness.equal(label + ': disposition holds', audit.evaluation.disposition, 'HOLD');
      harness.ok(label + ': never SELECT', audit.evaluation.disposition !== 'SELECT');
      harness.equal(label + ': publication blocked', audit.evaluation.publication_blocked, true);
      harness.equal(label + ': human review required', audit.evaluation.human_review, true);
      harness.equal(label + ': no advancing rules matched', audit.evaluation.matched_rule_ids, []);
      harness.equal(label + ': no deferred rules claimed', audit.evaluation.matched_deferred_rule_ids, []);
      harness.equal(label + ': no field actions', audit.evaluation.field_actions, {});
      harness.equal(label + ': downstream execution is NOT_EXECUTED', audit.routing.downstream_execution, { attempted: false, status: 'NOT_EXECUTED' });
      harness.ok(label + ': no advancing route', audit.routing.automatic_route?.next_status !== 'SELECTED');
      harness.equal(label + ': routing holds', audit.routing.disposition, 'HOLD');
      harness.ok(label + ': an explicit technical diagnostic is preserved',
        audit.evaluation.failures.length > 0 && audit.normalization.errors.length > 0);
      harness.equal(label + ': the fallback audit serializes', typeof canonicalize(audit), 'string');
      harness.ok(label + ': the serialized fallback audit parses', JSON.parse(canonicalize(audit)) !== undefined);
      harness.equal(label + ': the accessor is still never invoked after auditing', probe.calls, 0);
      if (placement.label === 'candidate_id') {
        harness.equal(label + ': no candidate identity is fabricated', audit.candidate_id, null);
      }
    }
  }

  // An input object whose own properties all throw must still produce an audit.
  {
    const evidence = {};
    for (const key of ['candidate_id', 'source_refs', 'assertions', 'standards_classification', 'candidate_claims']) {
      Object.defineProperty(evidence, key, { get() { throw new Error('hostile ' + key); }, enumerable: true, configurable: true });
    }
    let composed = null;
    let threw = null;
    try {
      composed = adjudicateCandidate({ evidence, context, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
    } catch (error) {
      threw = error;
    }
    harness.equal('[B4] a wholly hostile record does not throw', threw, null);
    harness.equal('[B4] a wholly hostile record holds', composed?.audit.evaluation.disposition, 'HOLD');
    harness.equal('[B4] a wholly hostile record is blocked', composed?.audit.evaluation.publication_blocked, true);
    harness.equal('[B4] a wholly hostile record requires human review', composed?.audit.evaluation.human_review, true);
    harness.equal('[B4] a wholly hostile record names no candidate', composed?.audit.candidate_id, null);
    harness.equal('[B4] a wholly hostile record serializes', typeof canonicalize(composed?.audit), 'string');
  }

  harness.ok('[B4] Object.prototype is unpolluted', ({}).polluted === undefined);
  harness.ok('[B4] Object.prototype has no injected disposition', ({}).default_disposition === undefined);
  harness.ok('[B4] Object.prototype has no injected route', ({}).automatic_route === undefined);
}

// [DIGEST] No canonical evidence identity, no SELECT.
{
  const digestAttacks = [
    { label: 'Infinity', apply: (evidence) => { evidence.extra = Infinity; } },
    { label: 'NaN', apply: (evidence) => { evidence.extra = Number.NaN; } },
    { label: '-Infinity', apply: (evidence) => { evidence.extra = -Infinity; } },
    { label: 'undefined', apply: (evidence) => { evidence.extra = undefined; } },
    { label: 'function', apply: (evidence) => { evidence.extra = function extra() { return 1; }; } },
    { label: 'bigint', apply: (evidence) => { evidence.extra = BigInt(10); } },
    { label: 'symbol value', apply: (evidence) => { evidence.extra = Symbol('extra'); } },
    { label: 'symbol key', apply: (evidence) => { evidence[Symbol('extra')] = 1; } },
    { label: 'sparse array', apply: (evidence) => { evidence.extra = sparseArray(2, { 0: 1 }); } },
    { label: 'accessor', apply: (evidence) => { Object.defineProperty(evidence, 'extra', { get() { return 1; }, enumerable: true, configurable: true }); } },
    { label: 'non-enumerable data property', apply: (evidence) => { Object.defineProperty(evidence, 'extra', { value: 1, enumerable: false, configurable: true }); } },
    { label: 'tampered prototype', apply: null, build: () => Object.assign(Object.create({ injected: true }), baseEvidence()) },
    { label: 'nested Infinity', apply: (evidence) => { evidence.source_refs[0].extra = Infinity; } },
    { label: 'nested sparse array', apply: (evidence) => { evidence.standards_classification.extra = sparseArray(1); } }
  ];

  for (const attack of digestAttacks) {
    const evidence = attack.build ? attack.build() : baseEvidence();
    if (attack.apply) attack.apply(evidence);
    const label = '[DIGEST] ' + attack.label;

    harness.throws(label + ': the candidate cannot be canonically digested', () => digest(evidence));
    const audit = assertBoundedTechnicalFailure(label, evidence);
    if (audit === null) continue;
    harness.equal(label + ': no evidence digest is recorded', audit.evidence_digest, null);
    harness.ok(label + ': the digest failure is recorded', typeof audit.evidence_digest_error === 'string');
    harness.ok(label + ': the digest failure is named in the reason codes',
      audit.evaluation.reason_codes.includes('EVIDENCE_DIGEST_UNAVAILABLE'));
    harness.equal(label + ': no semantic fingerprint is claimed', audit.semantic_fingerprint, null);
    harness.equal(label + ': routes to a technical blocker', audit.routing.escalation_class, 'TECHNICAL_BLOCKER');
  }

  // The otherwise eligible baseline still selects, so the digest gate is the
  // only thing that changed for these candidates.
  {
    const composed = adjudicateCandidate({ evidence: baseEvidence(), context, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
    harness.equal('[DIGEST] the digestible baseline still selects', composed.audit.evaluation.disposition, 'SELECT');
    harness.ok('[DIGEST] the digestible baseline carries a canonical identity', typeof composed.audit.evidence_digest === 'string');
    harness.equal('[DIGEST] the digestible baseline records no digest error', composed.audit.evidence_digest_error, null);
  }
}

// [B1] The provenance gate itself, exercised directly. The structural admission
// gate refuses sparse input earlier in the pipeline, so this proves the second
// layer independently rather than relying on the first having run.
{
  const knownRefs = Object.create(null);
  knownRefs.S1 = { ref_id: 'S1' };
  knownRefs.S2 = { ref_id: 'S2' };

  harness.equal('[B1] gate: a dense resolvable set yields its references',
    resolveEvidenceRefs(['S1', 'S2'], knownRefs).refs, ['S1', 'S2']);
  harness.equal('[B1] gate: a dense resolvable set reports no failure',
    resolveEvidenceRefs(['S1'], knownRefs).code, null);

  const gateRejections = [
    { label: 'one-hole array', value: sparseArray(1), code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'multi-hole array', value: sparseArray(4), code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'sparse array with a resolvable ref present', value: sparseArray(2, { 0: 'S1' }), code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'sparse array with a leading hole', value: sparseArray(2, { 1: 'S1' }), code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'null ref', value: [null], code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'null ref beside a resolvable ref', value: ['S1', null], code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'empty-string ref', value: [''], code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'non-string ref', value: [1], code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'object ref', value: [{ ref_id: 'S1' }], code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'non-array provenance', value: 'S1', code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'omitted provenance', value: undefined, code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'tampered array prototype', value: Object.setPrototypeOf(['S1'], { injected: true }), code: 'MALFORMED_EVIDENCE_REFS' },
    { label: 'empty provenance', value: [], code: 'MISSING_EVIDENCE_REFS' },
    { label: 'unresolved dense ref', value: ['GHOST'], code: 'DANGLING_EVIDENCE_REF' },
    { label: 'partly unresolved dense refs', value: ['S1', 'GHOST'], code: 'DANGLING_EVIDENCE_REF' }
  ];
  for (const attempt of gateRejections) {
    const outcome = resolveEvidenceRefs(attempt.value, knownRefs);
    harness.equal('[B1] gate: ' + attempt.label + ' yields no references', outcome.refs, null);
    harness.equal('[B1] gate: ' + attempt.label + ' names the failure', outcome.code, attempt.code);
  }

  // Length alone never establishes that a reference exists.
  for (const length of [1, 2, 5]) {
    harness.equal('[B1] gate: an array of ' + length + ' holes yields no references',
      resolveEvidenceRefs(sparseArray(length), knownRefs).refs, null);
  }
}

// [B4] The bounded failure path is reached and must not re-read hostile input.
// The digest gate returns rather than throwing, so a case that actually enters
// the catch block is constructed: an unusable registry raises before the digest
// gate runs, while the candidate still carries throwing accessors.
{
  const hostileEvidence = (probe) => {
    const evidence = baseEvidence();
    for (const key of ['candidate_id', 'source_refs', 'assertions', 'standards_classification']) {
      delete evidence[key];
      Object.defineProperty(evidence, key, {
        get() { probe.calls += 1; throw new Error('hostile accessor on ' + key); },
        enumerable: key !== 'candidate_id',
        configurable: true
      });
    }
    return evidence;
  };

  const unusableContexts = [
    { label: 'missing registry', build: () => ({ ...context, registry: null }) },
    { label: 'forged registry', build: () => { const forged = clone(registry); forged.fact_consistency_constraints = []; return { ...context, registry: forged }; } },
    { label: 'absent context', build: () => ({}) }
  ];

  for (const unusable of unusableContexts) {
    const label = '[B4] bounded failure path with an ' + unusable.label;
    const probe = { calls: 0 };
    const evidence = hostileEvidence(probe);
    let composed = null;
    let threw = null;
    try {
      composed = adjudicateCandidate({ evidence, context: unusable.build(), authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
    } catch (error) {
      threw = error;
    }
    harness.equal(label + ': adjudication does not throw', threw, null);
    harness.ok(label + ': an audit record is produced', composed !== null && composed.audit !== undefined);
    if (composed === null || composed.audit === undefined) continue;
    const audit = composed.audit;
    harness.equal(label + ': the failure path enters the bounded audit', audit.evaluation.reason_codes, ['ADJUDICATION_ABORTED']);
    harness.equal(label + ': no hostile accessor is invoked', probe.calls, 0);
    harness.equal(label + ': no candidate identity is fabricated', audit.candidate_id, null);
    harness.equal(label + ': disposition holds', audit.evaluation.disposition, 'HOLD');
    harness.equal(label + ': publication blocked', audit.evaluation.publication_blocked, true);
    harness.equal(label + ': human review required', audit.evaluation.human_review, true);
    harness.equal(label + ': no advancing rules matched', audit.evaluation.matched_rule_ids, []);
    harness.ok(label + ': no advancing route', audit.routing.automatic_route?.next_status !== 'SELECTED');
    harness.equal(label + ': downstream execution is NOT_EXECUTED', audit.routing.downstream_execution, { attempted: false, status: 'NOT_EXECUTED' });
    harness.ok(label + ': an explicit technical failure diagnostic is preserved', audit.evaluation.failures.length > 0);
    harness.equal(label + ': the fallback audit serializes', typeof canonicalize(audit), 'string');
    harness.ok(label + ': the serialized fallback audit parses', JSON.parse(canonicalize(audit)) !== undefined);
  }

  // A well-formed candidate on an unusable context is still bounded, and its
  // identity is captured safely rather than re-read after the failure.
  {
    const forged = clone(registry);
    forged.fact_consistency_constraints = [];
    const composed = adjudicateCandidate({ evidence: baseEvidence(), context: { ...context, registry: forged }, authorityResolution: TRUSTED_AUTHORITY_RESOLUTION, evaluatedAt: FIXED_EVALUATION_TIMESTAMP });
    harness.equal('[B4] a safe candidate identity is preserved on the failure path', composed.audit.candidate_id, 'F01');
    harness.equal('[B4] the failure path still holds', composed.audit.evaluation.disposition, 'HOLD');
  }

  harness.ok('[B4] Object.prototype is unpolluted after the failure path', ({}).polluted === undefined);
}

harness.finish([`eligibility_predicates=${ELIGIBILITY_PREDICATES.length}`, `material_predicates=${materialPredicates.length}`, `fixtures=${oracle.fixtures.length}`]);
