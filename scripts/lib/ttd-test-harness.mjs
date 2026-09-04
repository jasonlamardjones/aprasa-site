// Minimal assertion harness shared by the Things-to-Do adjudication suites.
// Deliberately dependency-free: these tests must run on a bare Node runtime.

import { canonicalize } from './ttd-canonical-json.mjs';

export function createHarness(suiteName) {
  const failures = [];
  let checks = 0;

  const equal = (label, actual, expected) => {
    checks += 1;
    const actualText = canonicalize(actual === undefined ? null : actual);
    const expectedText = canonicalize(expected === undefined ? null : expected);
    if (actualText !== expectedText) {
      failures.push(`${label}\n    expected: ${expectedText}\n    actual:   ${actualText}`);
    }
  };

  const ok = (label, condition) => {
    checks += 1;
    if (condition !== true) failures.push(`${label}\n    expected condition to hold`);
  };

  const throws = (label, fn) => {
    checks += 1;
    try {
      fn();
      failures.push(`${label}\n    expected the call to throw`);
    } catch {
      // expected
    }
  };

  const finish = (extra = []) => {
    if (failures.length > 0) {
      console.error(`${suiteName}_FAILED`);
      for (const failure of failures) console.error(`  - ${failure}`);
      console.error(`checks=${checks} failures=${failures.length}`);
      process.exit(1);
    }
    console.log(`${suiteName}_OK`);
    console.log(`checks=${checks}`);
    for (const line of extra) console.log(line);
  };

  return { equal, ok, throws, finish, get checks() { return checks; } };
}

export function factsFromOracle(expectedFacts) {
  const facts = Object.create(null);
  for (const name of Object.keys(expectedFacts)) {
    const entry = expectedFacts[name];
    facts[name] = entry.state === 'KNOWN'
      ? { state: 'KNOWN', value: entry.value, reason: 'ORACLE_FACT', evidence_refs: ['ORACLE'], rationale: null }
      : { state: 'UNKNOWN', value: null, reason: 'ORACLE_FACT_UNKNOWN', evidence_refs: [], rationale: null };
  }
  return facts;
}

export function normalizedFromOracle(fixture) {
  return {
    ok: true,
    candidate_id: fixture.fixture_id,
    registry_version: '1.0.0',
    facts: factsFromOracle(fixture.expected_normalized.facts),
    source_refs: [],
    claimed_authority_resolution: null,
    normalization_errors: []
  };
}

export function evaluationFromOracle(fixture) {
  const expected = fixture.expected_evaluation;
  return {
    ok: true,
    result_type: expected.result_type,
    disposition: expected.disposition,
    publication_blocked: expected.publication_blocked,
    human_review: expected.human_review,
    governing_rule_id: expected.governing_rule_id,
    matched_rule_ids: expected.matched_rule_ids,
    reason_codes: expected.reason_codes,
    field_actions: expected.field_actions,
    unresolved_dependencies: expected.unresolved_dependencies
  };
}

export const TRUSTED_AUTHORITY_RESOLUTION = {
  resolution: 'TRUSTED_RESOLVED',
  resolver: 'CONTROL_PLANE_AUTHORITY_RESOLVER',
  source: 'TRUSTED_RESOLVER',
  resolved_at: '2026-09-04T00:00:00-01:00',
  evidence_ref: 'PROJECT_03_POLICY_FIDELITY_REVIEW_2026-09-04'
};

export const FIXED_EVALUATION_TIMESTAMP = '2026-09-04T00:00:00-01:00';
