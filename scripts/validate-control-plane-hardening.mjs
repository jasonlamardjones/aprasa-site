#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');

const policyPath = path.join(root, 'automation/control-plane/policies/things-to-do-v1.json');
const taskPath = path.join(root, 'automation/control-plane/fixtures/things-to-do-candidate.json');
const orchestrationPath = path.join(root, 'automation/control-plane/fixtures/orchestration-plan.json');

const APPROVAL_REFERENCE = 'PROJECT_03_POLICY_FIDELITY_REVIEW_2026-09-04';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectDangerousKeys(value, at = '$', errors = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectDangerousKeys(item, `${at}[${index}]`, errors));
    return errors;
  }
  if (!value || typeof value !== 'object') return errors;
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) errors.push(`${at}: dangerous key ${key} is forbidden`);
    collectDangerousKeys(value[key], `${at}.${key}`, errors);
  }
  return errors;
}

const approvedRules = {
  'TTD-ELIG-001': ['ACTIVE', 'SELECT', false, false, {
    activity_scope: 'ORDINARY_CULTURAL_COMMUNITY_PUBLIC_INTEREST_OR_GENERAL_AUDIENCE',
    geography_in_scope: true,
    materially_current: true,
    evidence_sufficient: true,
    material_source_conflict: false,
    required_authority_missing: false,
    standards_boundary_unresolved: false,
    commercial_primary_proposition: false
  }],
  'TTD-EVID-001': ['ACTIVE', 'HOLD', true, false, { material_source_conflict: true, conflict_resolved: false }],
  'TTD-EVID-002': ['ACTIVE', 'NO_CHANGE', false, false, { first_party_source_accessible: true }],
  'TTD-FACT-001': ['ACTIVE', 'NO_CHANGE', false, false, { admission_verified: false }],
  'TTD-FACT-002': ['ACTIVE', 'NO_CHANGE', false, false, { secondary_detail_verified: false, event_identity_date_venue_sufficient: true }],
  'TTD-DATE-001': ['ACTIVE', 'NO_CHANGE', false, false, { authoritative_end_precision: 'MONTH' }],
  'TTD-MEDIA-001': ['ACTIVE', 'NO_CHANGE', false, false, { authentic_media_rights_unclear: true, governed_editorial_fallback_available: true }],
  'TTD-SOURCE-001': ['ACTIVE', 'HOLD', true, false, { broader_source_conflicts_with_specific_scope: true }],
  'TTD-COPY-001': ['ACTIVE', 'HOLD', true, false, { proposed_copy_strengthens_unknown_fact: true }],
  'TTD-COMM-001': ['ACTIVE', 'NO_CHANGE', false, false, { ordinary_editorial_event: true, ticketed_or_commercial_venue: true }],
  'TTD-COMM-002': ['ACTIVE', 'NO_CHANGE', false, false, { payment_or_commercial_relationship: true }],
  'TTD-COMM-003': ['DEFERRED', 'HOLD', true, true, { primary_proposition: 'ONGOING_COMMERCIAL_TOUR_EXCURSION_CLASS_EXPERIENCE_PACKAGE_OR_SERVICE' }],
  'TTD-COMM-004': ['ACTIVE', 'NO_CHANGE', false, false, { current_or_former_client: true }],
  'TTD-CURRENT-001': ['ACTIVE', 'REJECT', true, false, { materially_current: false, candidate_already_ended: true }],
  'TTD-GOV-001': ['ACTIVE', 'HOLD', true, false, { required_authority_missing: true }],
  'TTD-GOV-002': ['ACTIVE', 'HOLD', true, true, { standards_boundary_unresolved: true }]
};

const approvedIds = Object.keys(approvedRules).sort();
const mandatoryTaskProhibitions = ['INVENT_FACTS', 'INVENT_POLICY', 'MERGE', 'DEPLOY', 'DELETE_BRANCH', 'PUBLISH_EXTERNAL_MESSAGE', 'CHANGE_GOVERNANCE'];

function validateHardening(policy, task, orchestration) {
  const errors = [];
  collectDangerousKeys(policy, '$policy', errors);
  collectDangerousKeys(task, '$task', errors);
  collectDangerousKeys(orchestration, '$orchestration', errors);

  if (policy.authority?.approval_reference !== APPROVAL_REFERENCE) {
    errors.push(`policy approval_reference must be ${APPROVAL_REFERENCE}`);
  }

  const actualIds = (policy.rules || []).map((rule) => rule.rule_id).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(approvedIds)) errors.push('rule-id set drifted');

  for (const rule of policy.rules || []) {
    const expected = approvedRules[rule.rule_id];
    if (!expected) continue;
    const [status, disposition, publicationBlocked, humanReview, when] = expected;
    if (rule.status !== status) errors.push(`${rule.rule_id}: status must be ${status}`);
    if (rule.result?.disposition !== disposition) errors.push(`${rule.rule_id}: disposition must be ${disposition}`);
    if (rule.result?.publication_blocked !== publicationBlocked) errors.push(`${rule.rule_id}: publication_blocked must be ${publicationBlocked}`);
    if (rule.human_review !== humanReview) errors.push(`${rule.rule_id}: human_review must be ${humanReview}`);
    if (JSON.stringify(rule.when) !== JSON.stringify(when)) errors.push(`${rule.rule_id}: approved predicate semantics drifted`);
    if (!Array.isArray(rule.authority_refs) || rule.authority_refs.length === 0) errors.push(`${rule.rule_id}: authority_refs required`);
    for (const ref of rule.authority_refs || []) {
      if (ref !== APPROVAL_REFERENCE) errors.push(`${rule.rule_id}: authority_ref must equal approved reference`);
    }
    if (disposition === 'SELECT' && publicationBlocked !== false) errors.push(`${rule.rule_id}: SELECT cannot be publication-blocked`);
  }

  for (const url of task.source?.urls || []) {
    let parsed;
    try { parsed = new URL(url); } catch { errors.push(`invalid source URL ${url}`); continue; }
    if (!['http:', 'https:'].includes(parsed.protocol)) errors.push(`source URL must use http(s): ${url}`);
  }

  for (const token of mandatoryTaskProhibitions) {
    if (!task.prohibited_actions?.includes(token)) errors.push(`task fixture must prohibit ${token}`);
  }

  if (orchestration.worker_resolution?.resolver !== 'ROLE_REGISTRY') errors.push('orchestration must resolve workers through ROLE_REGISTRY');
  if (orchestration.worker_resolution?.provider_binding_ref !== null) errors.push('synthetic orchestration fixture must remain provider-neutral');
  if (orchestration.retry_policy?.max_attempts > 5) errors.push('retry max_attempts exceeds safety ceiling');

  const authorityPrereq = (orchestration.prerequisites || []).find((item) => item.kind === 'AUTHORITY');
  if (!authorityPrereq) errors.push('orchestration must include an AUTHORITY prerequisite');
  if (authorityPrereq && authorityPrereq.ref !== 'APRASA_TTD_EDITORIAL_V1@1.0.0') errors.push('authority prerequisite must reference APRASA_TTD_EDITORIAL_V1@1.0.0');
  if (authorityPrereq && authorityPrereq.required_state !== 'TRUSTED_RESOLVED') errors.push('authority prerequisite must be TRUSTED_RESOLVED');

  const failureStatus = orchestration.callbacks?.on_failure?.next_status;
  const blockedStatus = orchestration.callbacks?.on_blocked?.next_status;
  const exception = orchestration.callbacks?.on_exception;
  if (!['BLOCKED', 'HOLD', 'ESCALATED', 'REJECTED'].includes(failureStatus)) errors.push('failure callback must remain non-advancing');
  if (!['BLOCKED', 'HOLD', 'ESCALATED'].includes(blockedStatus)) errors.push('blocked callback must remain non-advancing');
  if (!['ESCALATED', 'BLOCKED', 'HOLD'].includes(exception?.next_status)) errors.push('exception callback must remain non-advancing');
  if (exception?.next_role !== 'HUMAN_ESCALATION') errors.push('exception callback must route to HUMAN_ESCALATION');
  if (exception?.next_task_type !== 'HUMAN_ESCALATION') errors.push('exception callback must route to HUMAN_ESCALATION task type');

  const capabilities = orchestration.worker_resolution?.capabilities || [];
  if (orchestration.worker_resolution?.worker_role !== 'PUBLICATION_WRITER' && capabilities.some((cap) => ['CODE_WRITE', 'REPOSITORY_WRITE'].includes(cap))) {
    errors.push('non-writer worker role cannot receive write capabilities');
  }

  if (!['PROJECT_04_CONTROL_TOWER', 'OWNING_GOVERNANCE_AUTHORITY', 'FOUNDER_APPROVAL_GATE'].includes(orchestration.escalation_policy?.default_target)) {
    errors.push('escalation target is outside approved control targets');
  }

  return errors;
}

for (const file of [policyPath, taskPath, orchestrationPath]) {
  if (!fs.existsSync(file)) {
    console.error(`CONTROL_PLANE_HARDENING_FAILED: missing required file ${path.relative(root, file)}`);
    process.exit(1);
  }
}

const policy = readJson(policyPath);
const task = readJson(taskPath);
const orchestration = readJson(orchestrationPath);
const baselineErrors = validateHardening(policy, task, orchestration);
if (baselineErrors.length) {
  baselineErrors.forEach((error) => console.error(`CONTROL_PLANE_HARDENING_FAILED: ${error}`));
  process.exit(1);
}

function expectNegative(name, mutator) {
  const p = deepClone(policy);
  const t = deepClone(task);
  const o = deepClone(orchestration);
  mutator(p, t, o);
  const errors = validateHardening(p, t, o);
  if (errors.length === 0) {
    console.error(`CONTROL_PLANE_HARDENING_FAILED: negative regression unexpectedly passed: ${name}`);
    process.exit(1);
  }
}

expectNegative('rogue rule id', (p) => {
  p.rules.push({ rule_id: 'TTD-ROGUE-001', status: 'ACTIVE', description: 'rogue', when: { anything: true }, result: { disposition: 'SELECT', publication_blocked: false, reason_code: 'ROGUE' }, human_review: false, authority_refs: [APPROVAL_REFERENCE] });
});
expectNegative('coordinated approval forge', (p) => {
  p.authority.approval_reference = 'FORGED_APPROVAL_2099';
  p.rules.forEach((rule) => { rule.authority_refs = ['FORGED_APPROVAL_2099']; });
});
expectNegative('eligibility predicate value drift', (p) => { p.rules.find((r) => r.rule_id === 'TTD-ELIG-001').when.geography_in_scope = false; });
expectNegative('currentness predicate drift', (p) => { p.rules.find((r) => r.rule_id === 'TTD-CURRENT-001').when = { decoy: true }; });
expectNegative('failure advances to published', (_p, _t, o) => { o.callbacks.on_failure.next_status = 'PUBLISHED'; });
expectNegative('blocked advances to selected', (_p, _t, o) => { o.callbacks.on_blocked.next_status = 'SELECTED'; });
expectNegative('authority prerequisite removed', (_p, _t, o) => { o.prerequisites = []; });
expectNegative('authority prerequisite unresolved', (_p, _t, o) => { o.prerequisites[0].required_state = 'UNRESOLVED'; });
expectNegative('non-writer receives repository write', (_p, _t, o) => { o.worker_resolution.capabilities.push('REPOSITORY_WRITE'); });
expectNegative('provider binding introduced', (_p, _t, o) => { o.worker_resolution.provider_binding_ref = 'CLAUDE_CODE'; });
expectNegative('exception launders to publication', (_p, _t, o) => { o.callbacks.on_exception.next_status = 'PUBLISHED'; o.callbacks.on_exception.next_task_type = 'PUBLICATION_PREPARATION'; });
expectNegative('invalid escalation target', (_p, _t, o) => { o.escalation_policy.default_target = 'EVIDENCE_VERIFIER'; });

console.log('CONTROL_PLANE_HARDENING_OK');
console.log(`approved_rules=${approvedIds.length}`);
console.log('hardening_regressions=12/12 rejected');
