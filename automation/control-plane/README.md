# A PRASA Autonomous Content Operations — Control Plane v1

Status: **foundation only**. This directory defines provider-neutral orchestration contracts. It does not grant autonomous merge, deploy, paid-placement, governance, or public-communications authority.

## Purpose

The control plane removes the founder from routine prompt-routing by expressing work as governed tasks with explicit authority, worker role, actions, prohibitions, routing, and audit references.

AI products are replaceable workers. The contracts name roles, not vendors.

## Source-of-truth boundaries

- GitHub `main` is authoritative for live code and deployed technical state.
- Project 03 owns public-content meaning, Community Standards, editorial/commercial policy, and adjudication authority.
- Project 05 owns evidence/provenance/publication-readiness operations where assigned by governance.
- Project 09 owns approved Portuguese localization where required.
- Project 04 owns technical implementation, repository automation, validation, QA, and deployment mechanics. Project 04 must not invent policy, facts, localization, media rights, or commercial treatment.
- Trello remains a thin outcome/state dashboard; it is not the execution queue or GitHub mirror.

## Files

- `task-envelope.schema.json` — provider-neutral task transport contract.
- `adjudication-policy.schema.json` — schema for versioned machine-readable adjudication policies.
- `policies/things-to-do-v1.json` — conservative Things to Do baseline derived only from already-governed standards and precedents.
- `fixtures/things-to-do-candidate.json` — non-public synthetic task used for contract validation.
- `scripts/validate-control-plane-contracts.mjs` — deterministic structural/invariant validator.

## Normal state progression

`DISCOVERED -> NORMALIZED -> EVIDENCE_CHECKED -> ADJUDICATED -> SELECTED -> LOCALIZED -> MEDIA_VALIDATED -> PUBLICATION_READY -> IMPLEMENTED -> REVIEWED -> DEPLOYMENT_READY -> PUBLISHED -> PRODUCTION_VERIFIED -> MONITORED`

Alternative terminal or exception states include `HOLD`, `REJECTED`, `BLOCKED`, `ESCALATED`, `EXPIRED`, `WITHDRAWN`, and `SUPERSEDED`.

The state machine is descriptive in v1. No scheduler or cross-provider dispatcher is activated by this tranche.

## Human escalation rule

Routine unfamiliarity is not an escalation condition. Escalation is reserved for declared classes such as novel policy questions, unresolved high-quality source conflicts, unresolved commercial policy, media-rights uncertainty, legal/reputational risk, authority conflicts, or confidence below a governed threshold.

Where a missing fact or dependency can be resolved by an existing evidence, localization, media, or technical authority, route there first rather than escalating to the founder.

## Editorial fail-closed behavior

The Things to Do policy has `default_disposition: HOLD` intentionally. It automates only already-governed cases. Unrepresented cases cannot silently become new A PRASA policy.

Important current rules include:

- eligibility is activity-based and viewpoint-neutral, not organizer-identity based;
- ordinary cultural/community/public-interest/general-audience activities can be selected when current, sufficiently evidenced, in scope, and not excluded;
- worship/proselytizing, partisan campaign/ideological rally, explicit adult entertainment, hate/extremist, and established unlawful/materially unsafe activities are excluded from ordinary Things to Do;
- unresolved material source conflicts hold for verification;
- missing admission information is omitted and never inferred as free;
- ticketing or a commercial venue alone does not disqualify an otherwise eligible editorial event;
- payment/commercial relationships cannot buy ordinary inclusion, ranking, verification, endorsement, favorable treatment, or standards exemption;
- automated treatment of ongoing commercial experiences/services remains deferred because the complete sponsored/commercial publication workflow is not yet governed for autonomous execution;
- a candidate that has fully ended before publication must not be introduced as current content.

## Security and mutation boundaries

Every autonomous task must declare allowed and prohibited actions. `MERGE`, `DEPLOY`, `DELETE_BRANCH`, `INVENT_FACTS`, `INVENT_POLICY`, `PUBLISH_EXTERNAL_MESSAGE`, and `CHANGE_GOVERNANCE` are available as explicit prohibition tokens.

This v1 foundation does not itself authorize any of those actions.

## Next implementation tranche

The next tranche should add a deterministic adjudication evaluator and candidate normalization layer for Things to Do, then connect only the resulting governed `SELECTED` records to the existing event-publication preparation machinery. Existing publication validators and exact-SHA review gates remain controlling.
