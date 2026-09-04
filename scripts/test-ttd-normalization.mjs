#!/usr/bin/env node
// Stage A acceptance: source evidence -> normalized facts.
//
// Expected facts come from the committed oracle. This suite never compares the
// normalizer against itself and never derives an expectation from evaluation.

import fs from 'node:fs';
import { createHarness } from './lib/ttd-test-harness.mjs';
import { loadFactRegistry, normalizeCandidate, factSummary } from './lib/ttd-normalizer.mjs';

const harness = createHarness('TTD_NORMALIZATION');
const oracle = JSON.parse(fs.readFileSync('automation/control-plane/fixtures/ttd-adjudication-oracle.json', 'utf8'));
const registry = loadFactRegistry();
const assertableByName = new Map(registry.predicates.map((predicate) => [predicate.name, predicate.directly_assertable === true]));

harness.equal('oracle declares its fixture count accurately', oracle.fixtures.length, oracle.fixture_count);
harness.ok('oracle carries at least the 25 core fixtures plus variants', oracle.fixtures.length >= 27);

const seen = new Set();
for (const fixture of oracle.fixtures) {
  const id = fixture.fixture_id;
  harness.ok(`${id}: fixture id is unique`, !seen.has(id));
  seen.add(id);

  const normalized = normalizeCandidate(fixture.evidence, { registry });
  harness.equal(`${id}: normalization succeeds`, normalized.ok, fixture.expected_normalized.ok);
  harness.equal(`${id}: candidate id is preserved`, normalized.candidate_id, id);
  harness.equal(`${id}: registry version is recorded`, normalized.registry_version, registry.version);
  harness.equal(`${id}: normalized fact states match the oracle`, factSummary(normalized), fixture.expected_normalized.facts);

  for (const name of Object.keys(normalized.facts)) {
    const fact = normalized.facts[name];
    harness.ok(`${id}: fact ${name} declares an explicit state`, fact.state === 'KNOWN' || fact.state === 'UNKNOWN');
    harness.ok(`${id}: fact ${name} records a transformation rationale code`, typeof fact.reason === 'string' && fact.reason.length > 0);
    if (fact.state === 'KNOWN' && assertableByName.get(name) === true) {
      harness.ok(`${id}: known asserted fact ${name} carries evidence provenance`, fact.evidence_refs.length > 0);
    }
  }

  // The standards boundary is derived, never asserted, and is always present.
  harness.ok(`${id}: standards boundary is always normalized`, Object.hasOwn(normalized.facts, 'standards_boundary_unresolved'));
  harness.equal(
    `${id}: standards boundary matches the oracle`,
    { state: normalized.facts.standards_boundary_unresolved.state, value: normalized.facts.standards_boundary_unresolved.value },
    { state: 'KNOWN', value: fixture.expected_normalized.facts.standards_boundary_unresolved.value }
  );

  // Candidate claims are recorded but never promoted into the fact set.
  harness.ok(`${id}: no authority claim leaks into facts`, !Object.hasOwn(normalized.facts, 'authority_resolution'));
}

harness.finish([`fixtures=${oracle.fixtures.length}`]);
