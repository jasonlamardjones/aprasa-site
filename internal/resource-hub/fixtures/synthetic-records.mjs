// SYNTHETIC FIXTURES ONLY. Every identifier is SYN-* and every value is invented.
// No real Project 05 identifier, evidence, decision or provider appears here.

export const PROVIDERS = Object.freeze([
  { provider_id: 'SYN-PRV-0001', public_name: 'Synthetic Learning Institute' },
  // Deliberately shares a public name with SYN-PRV-0001: matching names must
  // never be treated as a relationship.
  { provider_id: 'SYN-PRV-0002', public_name: 'Synthetic Learning Institute' },
]);

const pad = (n) => String(n).padStart(4, '0');

function defaultClaims(kind, n) {
  const claims = {
    title: `Synthetic ${kind === 'deadline' ? 'Deadline Opportunity' : 'Evergreen Guide'} ${n}`,
    summary: 'A synthetic fixture entry used only to exercise the projection adapter.',
    actionability: kind === 'deadline' ? 'Open' : 'Available',
    location_scope: 'Online (synthetic)',
    delivery_mode: 'Self-paced online',
    cost_status: 'Free',
    eligibility_summary: 'Open to anyone (synthetic)',
    credential_or_support: 'Certificate of completion (synthetic)',
    action_url: `https://example.org/synthetic/${kind}-${n}`,
    source_url: `https://example.org/synthetic/source-${n}`,
    public_caveat: 'Synthetic fixture only.',
  };
  if (kind === 'deadline') {
    claims.start_date = '2026-11-01';
    claims.end_date = '2027-02-28';
    claims.deadline = '2026-12-15';
  }
  return claims;
}

// Builds one internally consistent, valid bundle for resource number `n`.
// Callers mutate the returned fresh object to create a failing variant.
// opts: kind ('evergreen'|'deadline'), currentness, claimOverrides
// ({field: value | null to drop}), home (boolean).
export function build(n, opts = {}) {
  const kind = opts.kind || 'evergreen';
  const rid = `SYN-RES-${pad(n)}`;
  const evidenceId = `SYN-EV-${pad(n)}01`;
  const decisionId = `SYN-DEC-${pad(n)}01`;
  const currentness = opts.currentness || 'Current';

  const values = { ...defaultClaims(kind, n), ...(opts.claimOverrides || {}) };
  const claims = Object.entries(values)
    .filter(([, value]) => value !== null)
    .map(([field, value]) => ({ field, value, evidence_refs: [evidenceId] }));

  return {
    records: [{
      contract_version: 'P05-E2P v0.1-R1',
      export_id: 'SYN-EXP-0001',
      stable_resource_id: rid,
      site_slug: `synthetic-${kind}-${n}`,
      primary_provider_id: 'SYN-PRV-0001',
      provider_relationships: [],
      record_family: kind === 'deadline' ? 'institutional_provider_program_catalog' : 'evergreen_learning_resource',
      evidence_refs: [evidenceId],
      decision_id: decisionId,
      approved_claims: claims,
      publication_readiness: 'Public-Safe Approved',
      currentness_condition: currentness,
      last_verified: '2026-10-01',
      last_reviewed: '2026-10-02',
      next_review_trigger: 'Re-verify on 2027-01-01 (synthetic)',
      project03_disposition: 'non_public_pilot_only',
      locale_status: 'en_source_approved_pt_pending_project09',
      projection_version: 'synthetic-0.1',
    }],
    evidence: [{
      evidence_id: evidenceId,
      record_id: rid,
      claim_scope: claims.map(({ field, value }) => ({ field, value })),
      usable_for_public_claim: true,
      currentness,
      checked_at: '2026-10-01',
    }],
    decisions: [{
      decision_id: decisionId,
      record_id: rid,
      evidence_refs: [evidenceId],
      public_safe_decision: 'Public-Safe Approved',
      approved_claims: claims.map(({ field, value }) => ({ field, value })),
    }],
    providers: PROVIDERS.map((p) => ({ ...p })),
    // Fixed assessment date for deterministic temporal tests (never the wall clock).
    assessment_date: '2026-10-27',
    // Directory selection is explicit: opts.directory === false leaves it unselected.
    directory_selected_ids: opts.directory === false ? [] : [rid],
    home_feature_ids: opts.home ? [rid] : [],
  };
}

export function contextOf(bundle) {
  return {
    providers: bundle.providers,
    evidence: bundle.evidence,
    decisions: bundle.decisions,
    assessment_date: bundle.assessment_date,
    directory_selected_ids: bundle.directory_selected_ids,
    home_feature_ids: bundle.home_feature_ids,
  };
}
