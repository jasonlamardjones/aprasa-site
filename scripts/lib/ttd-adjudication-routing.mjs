// Stage C: composed evaluation -> next-worker routing decision.
//
// Routing reads only the final composed evaluation result. It never inspects
// individual rule matches, candidate payloads, or source text, and it never
// reports downstream execution that did not occur.
//
// Emitted roles and statuses are checked against the committed task-envelope
// vocabulary; an unroutable outcome yields no automatic route rather than an
// invented one.

import fs from 'node:fs';
import path from 'node:path';

const ENVELOPE_SCHEMA_PATH = path.join('automation', 'control-plane', 'task-envelope.schema.json');

export function loadRoutingVocabulary(root = process.cwd()) {
  const schema = JSON.parse(fs.readFileSync(path.join(root, ENVELOPE_SCHEMA_PATH), 'utf8'));
  return {
    worker_roles: schema.$defs.worker_role.enum,
    statuses: schema.$defs.status.enum
  };
}

// Escalation classes are declared by the policy; TECHNICAL_BLOCKER belongs to
// the orchestration contract vocabulary and is reserved for control-plane
// integrity failures, never for editorial questions.
const GOVERNANCE_ESCALATION_CLASS_BY_REASON = {
  STANDARDS_AUTHORITY_REQUIRED: 'NOVEL_POLICY_QUESTION',
  COMMERCIAL_TREATMENT_REQUIRED: 'COMMERCIAL_POLICY_UNRESOLVED',
  MEDIA_FALLBACK_UNAVAILABLE: 'MEDIA_RIGHTS_UNRESOLVED'
};

const HOLD_REMEDIATION_ROUTE_BY_REASON = {
  UNRESOLVED_SOURCE_CONFLICT: { next_role: 'EVIDENCE_VERIFIER', next_status: 'HOLD' },
  SPECIFIC_SCOPE_CONFLICT: { next_role: 'EVIDENCE_VERIFIER', next_status: 'HOLD' },
  COPY_OVERSTATES_EVIDENCE: { next_role: 'PUBLICATION_WRITER', next_status: 'HOLD' }
};

const CONTROL_PLANE_FAILURE_REASONS = new Set([
  'FIELD_ACTION_CONFLICT',
  'SELECT_BLOCKED_INVARIANT_VIOLATION'
]);

function governingReasonCode(result, policy) {
  if (result.governing_rule_id === null) return null;
  const rule = policy.rules.find((item) => item.rule_id === result.governing_rule_id);
  return rule ? rule.result.reason_code : null;
}

function assertRoutable(route, vocabulary) {
  if (route === null) return null;
  if (!vocabulary.worker_roles.includes(route.next_role)) {
    throw new Error(`routing produced unknown worker role ${route.next_role}`);
  }
  if (!vocabulary.statuses.includes(route.next_status)) {
    throw new Error(`routing produced unknown status ${route.next_status}`);
  }
  return route;
}

export function routeEvaluation(result, options = {}) {
  const policy = options.policy;
  const vocabulary = options.vocabulary ?? loadRoutingVocabulary(options.root);

  const decide = () => {
    if (result.ok !== true) {
      return {
        automatic_route: { next_role: 'HUMAN_ESCALATION', next_status: 'BLOCKED' },
        authority_target: 'PROJECT_04_CONTROL_TOWER',
        escalation_class: 'TECHNICAL_BLOCKER',
        rationale: `control-plane ${result.result_type} blocked progression before adjudication`
      };
    }

    if (result.reason_codes.some((code) => CONTROL_PLANE_FAILURE_REASONS.has(code))) {
      return {
        automatic_route: { next_role: 'HUMAN_ESCALATION', next_status: 'BLOCKED' },
        authority_target: 'PROJECT_04_CONTROL_TOWER',
        escalation_class: 'TECHNICAL_BLOCKER',
        rationale: 'composition failed closed and cannot produce a governed outcome'
      };
    }

    const reason = governingReasonCode(result, policy);

    if (result.human_review === true) {
      return {
        automatic_route: { next_role: 'HUMAN_ESCALATION', next_status: 'ESCALATED' },
        authority_target: 'OWNING_GOVERNANCE_AUTHORITY',
        escalation_class: GOVERNANCE_ESCALATION_CLASS_BY_REASON[reason] ?? 'AUTHORITY_CONFLICT',
        rationale: 'human_review stops autonomous progression and routes to the declared authority'
      };
    }

    if (result.disposition === 'SELECT') {
      return {
        automatic_route: { next_role: 'LOCALIZATION_WORKER', next_status: 'SELECTED' },
        authority_target: null,
        escalation_class: null,
        rationale: 'policy authorized ordinary editorial selection'
      };
    }

    if (result.disposition === 'REJECT') {
      return {
        automatic_route: { next_role: 'LIFECYCLE_MONITOR', next_status: 'REJECTED' },
        authority_target: null,
        escalation_class: null,
        rationale: 'policy rejected the candidate as no longer current'
      };
    }

    const remediation = reason === null ? undefined : HOLD_REMEDIATION_ROUTE_BY_REASON[reason];
    if (remediation !== undefined) {
      return {
        automatic_route: remediation,
        authority_target: null,
        escalation_class: null,
        rationale: `HOLD routes to the remediating worker for ${reason}`
      };
    }

    return {
      automatic_route: null,
      authority_target: 'OWNING_GOVERNANCE_AUTHORITY',
      escalation_class: null,
      rationale: reason === 'MISSING_GOVERNING_AUTHORITY'
        ? 'required governing authority is missing; no automatic downstream route'
        : 'no rule authorized an outcome; default HOLD has no automatic downstream route'
    };
  };

  const decision = decide();
  return {
    automatic_route: assertRoutable(decision.automatic_route, vocabulary),
    authority_target: decision.authority_target,
    escalation_class: decision.escalation_class,
    publication_blocked: result.publication_blocked,
    human_review: result.human_review,
    disposition: result.disposition,
    unresolved_dependencies: [...result.unresolved_dependencies].sort(),
    rationale: decision.rationale,
    downstream_execution: { attempted: false, status: 'NOT_EXECUTED' }
  };
}
