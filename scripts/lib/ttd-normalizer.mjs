// Stage A: source evidence -> normalized Things-to-Do candidate facts.
//
// The normalizer never invents a favorable default. A predicate is KNOWN only
// when an admissible, provenance-backed assertion establishes it. Everything
// else is UNKNOWN and is preserved as UNKNOWN.
//
// The single conservative absent-value rule is standards_boundary_unresolved,
// which is derived from an explicit standards classification and fails closed
// to true (HOLD under TTD-GOV-002) on omission, ambiguity, low confidence, or
// any unresolved standards dimension.
//
// Free text (rationale, notes, titles) is carried as audit data only. It is
// never parsed for meaning and can never create, clear, or alter a fact.

import fs from 'node:fs';
import path from 'node:path';
import { assertAdmissibleStructure, canonicalize, denseStringList, emptyMap, isAdmissibleDenseArray } from './ttd-canonical-json.mjs';

const REGISTRY_PATH = path.join('automation', 'control-plane', 'normalization', 'ttd-fact-registry.json');

export function loadFactRegistry(root = process.cwd()) {
  const registry = JSON.parse(fs.readFileSync(path.join(root, REGISTRY_PATH), 'utf8'));
  assertAdmissibleStructure(registry, '$registry');
  return registry;
}

function indexPredicates(registry) {
  const byName = emptyMap();
  for (const predicate of registry.predicates) byName[predicate.name] = predicate;
  return byName;
}

function unknownFact(reason, detail) {
  return { state: 'UNKNOWN', value: null, reason, evidence_refs: [], rationale: detail ?? null };
}

function knownFact(value, evidenceRefs, rationale, reason) {
  return { state: 'KNOWN', value, reason: reason ?? 'ADMISSIBLE_ASSERTION', evidence_refs: [...evidenceRefs].sort(), rationale: rationale ?? null };
}

function validateSourceRefs(evidence, registry, errors) {
  const refs = emptyMap();
  if (!isAdmissibleDenseArray(evidence.source_refs)) {
    errors.push({ code: 'MALFORMED_SOURCE_REFS', detail: 'source_refs must be a dense array' });
    return refs;
  }
  const list = evidence.source_refs;
  for (const [index, ref] of list.entries()) {
    const at = `source_refs[${index}]`;
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
      errors.push({ code: 'MALFORMED_SOURCE_REF', detail: at });
      continue;
    }
    if (typeof ref.ref_id !== 'string' || ref.ref_id.length === 0) {
      errors.push({ code: 'MALFORMED_SOURCE_REF', detail: `${at}.ref_id must be a non-empty string` });
      continue;
    }
    if (Object.hasOwn(refs, ref.ref_id)) {
      errors.push({ code: 'DUPLICATE_SOURCE_REF_ID', detail: ref.ref_id });
      continue;
    }
    if (typeof ref.url !== 'string') {
      errors.push({ code: 'MALFORMED_SOURCE_REF', detail: `${at}.url must be a string` });
      continue;
    }
    let parsed = null;
    try {
      parsed = new URL(ref.url);
    } catch {
      errors.push({ code: 'INVALID_SOURCE_URL', detail: `${at}.url is not a valid URL` });
      continue;
    }
    if (!registry.allowed_url_schemes.includes(parsed.protocol)) {
      errors.push({ code: 'NON_HTTP_SOURCE_URL', detail: `${at}.url scheme ${parsed.protocol} is not permitted` });
      continue;
    }
    if (!registry.source_classes.includes(ref.source_class)) {
      errors.push({ code: 'UNKNOWN_SOURCE_CLASS', detail: `${at}.source_class ${String(ref.source_class)}` });
      continue;
    }
    refs[ref.ref_id] = { ref_id: ref.ref_id, url: ref.url, source_class: ref.source_class, retrieved_at: ref.retrieved_at ?? null };
  }
  return refs;
}

// The single provenance gate for every cited reference set. Exported so the
// dense-array requirement can be regression-tested directly, independently of
// the structural admission gate that also refuses sparse input earlier in the
// pipeline: array length must never stand in for a present reference, and a
// hole, a null, an empty identifier or an unresolved identifier must all yield
// no references at all rather than a shorter apparently valid set.
export function resolveEvidenceRefs(value, sourceRefs) {
  const refs = denseStringList(value);
  if (refs === null) return { refs: null, code: 'MALFORMED_EVIDENCE_REFS', dangling: [] };
  if (refs.length === 0) return { refs: null, code: 'MISSING_EVIDENCE_REFS', dangling: [] };
  const dangling = refs.filter((ref) => !Object.hasOwn(sourceRefs, ref));
  if (dangling.length > 0) return { refs: null, code: 'DANGLING_EVIDENCE_REF', dangling };
  return { refs, code: null, dangling: [] };
}

function valueTypeValid(predicate, value) {
  if (predicate.type === 'boolean') return typeof value === 'boolean';
  if (predicate.type === 'enum') return typeof value === 'string' && predicate.enum.includes(value);
  return false;
}

function collectAssertions(evidence, predicatesByName, registry, sourceRefs, errors) {
  const grouped = emptyMap();
  if (!isAdmissibleDenseArray(evidence.assertions)) {
    errors.push({ code: 'MALFORMED_ASSERTIONS', detail: 'assertions must be a dense array' });
    return grouped;
  }
  const list = evidence.assertions;
  for (const [index, assertion] of list.entries()) {
    const at = `assertions[${index}]`;
    if (assertion === null || typeof assertion !== 'object' || Array.isArray(assertion)) {
      errors.push({ code: 'MALFORMED_ASSERTION', detail: at });
      continue;
    }
    const name = assertion.predicate;
    if (typeof name !== 'string' || !Object.hasOwn(predicatesByName, name)) {
      errors.push({ code: 'UNSUPPORTED_PREDICATE', detail: `${at}.predicate ${String(name)}` });
      continue;
    }
    const predicate = predicatesByName[name];
    if (predicate.directly_assertable !== true) {
      errors.push({ code: 'PREDICATE_NOT_DIRECTLY_ASSERTABLE', detail: `${at}.predicate ${name} is derived, not asserted` });
      continue;
    }
    if (!valueTypeValid(predicate, assertion.value)) {
      errors.push({ code: 'INVALID_ASSERTION_VALUE', detail: `${at}.value ${canonicalize(assertion.value ?? null)} is not a valid ${predicate.type} for ${name}` });
      continue;
    }
    if (!registry.confidence_levels.includes(assertion.confidence)) {
      errors.push({ code: 'INVALID_CONFIDENCE', detail: `${at}.confidence ${String(assertion.confidence)}` });
      continue;
    }
    const provenance = resolveEvidenceRefs(assertion.evidence_refs, sourceRefs);
    if (provenance.code === 'MALFORMED_EVIDENCE_REFS') {
      errors.push({ code: 'MALFORMED_EVIDENCE_REFS', detail: `${at}.evidence_refs must be a dense array of non-empty reference identifiers` });
      continue;
    }
    if (provenance.code === 'MISSING_EVIDENCE_REFS') {
      errors.push({ code: 'MISSING_EVIDENCE_REFS', detail: `${at} must cite at least one source ref` });
      continue;
    }
    if (provenance.code === 'DANGLING_EVIDENCE_REF') {
      errors.push({ code: 'DANGLING_EVIDENCE_REF', detail: `${at} cites unresolved refs ${canonicalize(provenance.dangling)}` });
      continue;
    }
    const refs = provenance.refs;
    if (!Object.hasOwn(grouped, name)) grouped[name] = [];
    grouped[name].push({
      value: assertion.value,
      confidence: assertion.confidence,
      evidence_refs: refs,
      rationale: typeof assertion.rationale === 'string' ? assertion.rationale : null
    });
  }
  return grouped;
}

function reduceAssertions(grouped, registry) {
  const facts = emptyMap();
  for (const name of Object.keys(grouped)) {
    const entries = grouped[name];
    const distinct = new Set(entries.map((entry) => canonicalize(entry.value)));
    if (distinct.size > 1) {
      facts[name] = unknownFact('CONTRADICTORY_ASSERTIONS', `${entries.length} assertions disagree on ${name}`);
      continue;
    }
    const admissible = entries.filter((entry) => registry.admissible_confidence.includes(entry.confidence));
    if (admissible.length === 0) {
      facts[name] = unknownFact('LOW_CONFIDENCE_CLASSIFICATION', `no HIGH-confidence assertion for ${name}`);
      continue;
    }
    const evidenceRefs = new Set();
    for (const entry of admissible) for (const ref of entry.evidence_refs) evidenceRefs.add(ref);
    facts[name] = knownFact(admissible[0].value, evidenceRefs, admissible[0].rationale);
  }
  return facts;
}

// TTD-GOV-002 boundary. Only an explicit, HIGH-confidence, provenance-backed
// classification asserting affirmative ordinary-scope evidence with no
// unresolved dimension and no mixed purpose may clear the standards boundary.
//
// Every declared member must be present and of the exact declared type. A
// missing, malformed, wrong-typed, or shape-substituted member is not evidence
// of ordinary scope, so it fails closed to true rather than being ignored.
const STANDARDS_MEMBER_CONTRACT = [
  {
    member: 'affirmative_ordinary_scope_evidence',
    valid: (value) => typeof value === 'boolean',
    cleared: (value) => value === true,
    malformed_reason: 'MALFORMED_STANDARDS_AFFIRMATION',
    unmet_reason: 'NO_AFFIRMATIVE_ORDINARY_SCOPE_EVIDENCE'
  },
  {
    member: 'confidence',
    valid: (value) => typeof value === 'string',
    cleared: (value) => value === 'HIGH',
    malformed_reason: 'MALFORMED_STANDARDS_CONFIDENCE',
    unmet_reason: 'LOW_CONFIDENCE_STANDARDS_CLASSIFICATION'
  },
  {
    member: 'unresolved_dimensions',
    valid: (value) => isAdmissibleDenseArray(value) && value.every((item) => typeof item === 'string'),
    cleared: (value) => value.length === 0,
    malformed_reason: 'MALFORMED_STANDARDS_DIMENSIONS',
    unmet_reason: 'UNRESOLVED_STANDARDS_DIMENSION'
  },
  {
    member: 'mixed_purpose',
    valid: (value) => typeof value === 'boolean',
    cleared: (value) => value === false,
    malformed_reason: 'MALFORMED_STANDARDS_MIXED_PURPOSE',
    unmet_reason: 'MIXED_PURPOSE_CANDIDATE'
  }
];

function deriveStandardsBoundary(evidence, sourceRefs) {
  const classification = evidence.standards_classification;
  if (classification === undefined || classification === null) {
    return knownFact(true, [], null, 'STANDARDS_CLASSIFICATION_OMITTED');
  }
  if (typeof classification !== 'object' || Array.isArray(classification)) {
    return knownFact(true, [], null, 'STANDARDS_CLASSIFICATION_MALFORMED');
  }

  for (const rule of STANDARDS_MEMBER_CONTRACT) {
    if (!Object.hasOwn(classification, rule.member)) {
      return knownFact(true, [], null, 'INCOMPLETE_STANDARDS_CLASSIFICATION');
    }
    const value = classification[rule.member];
    if (!rule.valid(value)) return knownFact(true, [], null, rule.malformed_reason);
    if (!rule.cleared(value)) return knownFact(true, [], null, rule.unmet_reason);
  }

  // Provenance must be an array of resolvable source-ref identifiers.
  if (!Object.hasOwn(classification, 'evidence_refs')) {
    return knownFact(true, [], null, 'INCOMPLETE_STANDARDS_CLASSIFICATION');
  }
  const provenance = resolveEvidenceRefs(classification.evidence_refs, sourceRefs);
  if (provenance.code === 'DANGLING_EVIDENCE_REF') {
    return knownFact(true, [], null, 'UNSUPPORTED_STANDARDS_CLASSIFICATION');
  }
  if (provenance.code !== null) {
    return knownFact(true, [], null, 'MALFORMED_STANDARDS_EVIDENCE_REFS');
  }
  const refs = provenance.refs;

  return knownFact(false, refs, typeof classification.rationale === 'string' ? classification.rationale : null, 'AFFIRMATIVE_ORDINARY_SCOPE_EVIDENCE');
}

export function normalizeCandidate(evidence, options = {}) {
  const registry = options.registry ?? loadFactRegistry(options.root);
  const errors = [];

  const rejected = (code, detail) => ({
    ok: false,
    candidate_id: null,
    registry_version: registry.version,
    facts: emptyMap(),
    source_refs: [],
    claimed_authority_resolution: null,
    normalization_errors: [{ code, detail }]
  });

  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return rejected('MALFORMED_EVIDENCE_RECORD', 'evidence record must be an object');
  }

  // Structural admission gate. Dangerous own keys (enumerable or not), tampered
  // prototypes, accessors, symbols, sparse arrays and unsupported value types
  // are refused here, before any property of the record is read for meaning.
  try {
    assertAdmissibleStructure(evidence, '$evidence');
  } catch (error) {
    return rejected('UNSAFE_INPUT_KEY', error.message);
  }

  const candidateId = typeof evidence.candidate_id === 'string' && evidence.candidate_id.length > 0 ? evidence.candidate_id : null;
  if (candidateId === null) errors.push({ code: 'MISSING_CANDIDATE_ID', detail: 'candidate_id must be a non-empty string' });

  const predicatesByName = indexPredicates(registry);
  const sourceRefs = validateSourceRefs(evidence, registry, errors);
  const grouped = collectAssertions(evidence, predicatesByName, registry, sourceRefs, errors);
  const facts = reduceAssertions(grouped, registry);

  facts.standards_boundary_unresolved = deriveStandardsBoundary(evidence, sourceRefs);

  // Candidate-supplied authority claims are recorded for audit only. They are
  // never authorizing and are never promoted into the evaluated fact set.
  const claims = evidence.candidate_claims;
  const claimedResolution = claims !== null && typeof claims === 'object' && !Array.isArray(claims) && typeof claims.authority_resolution === 'string'
    ? claims.authority_resolution
    : null;

  const ok = errors.length === 0;
  return {
    ok,
    candidate_id: candidateId,
    registry_version: registry.version,
    facts: ok ? facts : emptyMap(),
    source_refs: Object.keys(sourceRefs).sort().map((key) => sourceRefs[key]),
    claimed_authority_resolution: claimedResolution,
    normalization_errors: errors
  };
}

export function factSummary(normalized) {
  const summary = {};
  for (const name of Object.keys(normalized.facts).sort()) {
    const fact = normalized.facts[name];
    summary[name] = fact.state === 'KNOWN' ? { state: 'KNOWN', value: fact.value } : { state: 'UNKNOWN' };
  }
  return summary;
}
