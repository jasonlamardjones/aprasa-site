// P04-RH-A synthetic projection transformer.
//
// Pure and deterministic: no clock, no randomness, no I/O, no input mutation.
// Output keys follow the contract allowlist order; batch results are ordered
// by code-unit comparison of the Resource ID, then input position.

import * as C from './projection-contract.mjs';
import { buildEnv, validateRecord, validateProjectionOutput } from './projection-validator.mjs';

function buildProjection(record, env) {
  const claims = new Map(record.approved_claims.map((c) => [c.field, c]));
  const checkedAt = [...new Set(record.approved_claims.flatMap((c) => c.evidence_refs))]
    .map((id) => env.evidence.get(id).checked_at)
    .sort()[0]; // conservative: the oldest check among contributing evidence
  const source = {
    stable_resource_id: record.stable_resource_id,
    site_slug: record.site_slug,
    provider: env.providers.get(record.primary_provider_id).public_name,
    record_family: record.record_family,
    currentness: record.currentness_condition,
    checked_at: checkedAt,
  };
  for (const field of C.CLAIM_FIELDS) if (claims.has(field)) source[field] = claims.get(field).value;
  // Unsupported optional fields are omitted, never emitted empty.
  const out = {};
  for (const field of C.PUBLIC_OUTPUT_FIELDS) if (source[field] !== undefined) out[field] = source[field];
  return out;
}

function result(record, env, status, errors, projection) {
  const id = typeof record?.stable_resource_id === 'string' ? record.stable_resource_id : null;
  const gatesPassed = status === C.OUTCOME.ACCEPT;
  // Directory selection is an explicit, separate input; a valid ACCEPT alone
  // never makes a record directory eligible.
  const directory = gatesPassed && id !== null && env.directorySelectedIds.has(id);
  const requested = id !== null && env.homeFeatureIds.has(id);
  return {
    stable_resource_id: id,
    status,
    errors,
    projection,
    // Canonical identity is retained for suppressed/review records; never deleted.
    identity_retained: id !== null && (status !== C.OUTCOME.ACCEPT && status !== C.OUTCOME.REJECT),
    // Three distinct concepts: gates passed (status), directory eligibility,
    // and Home selection. Home selection never overrides a gate.
    selection: {
      ordinary_directory_eligibility: directory,
      home_feature_requested: requested,
      home_feature_selection: gatesPassed && requested,
    },
  };
}

function projectWithEnv(record, env) {
  const errors = validateRecord(record, env);
  if (errors.length > 0) return result(record, env, C.OUTCOME.REJECT, errors, null);

  switch (record.currentness_condition) {
    case C.CURRENTNESS.CLOSED:
      return result(record, env, C.OUTCOME.SUPPRESS, [], null);
    case C.CURRENTNESS.REVALIDATION_DUE:
      return result(record, env, C.OUTCOME.REVIEW_REQUIRED, [], null);
    case C.CURRENTNESS.UNKNOWN:
      // No public projection without a separately approved non-actionable treatment.
      return result(record, env, C.OUTCOME.NO_ACTIONABLE_CLAIM, [], null);
    default:
      break;
  }

  const projection = buildProjection(record, env);
  const outputErrors = validateProjectionOutput(projection);
  if (outputErrors.length > 0) return result(record, env, C.OUTCOME.REJECT, outputErrors, null);

  return result(record, env, C.OUTCOME.ACCEPT, [], projection);
}

export function projectRecord(record, ctx) {
  return projectWithEnv(record, buildEnv(ctx, [record]));
}

export function projectBatch(records, ctx) {
  const list = Array.isArray(records) ? records : [];
  const env = buildEnv(ctx, list);
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return list
    .map((record, index) => ({ index, out: projectWithEnv(record, env) }))
    .sort((a, b) => compare(a.out.stable_resource_id ?? '', b.out.stable_resource_id ?? '') || a.index - b.index)
    .map(({ out }) => out);
}
