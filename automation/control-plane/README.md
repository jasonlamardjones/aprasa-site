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
- `adjudication-policy.schema.json` — schema for versioned machine-readable adjudication policies and composition semantics.
- `policies/things-to-do-v1.json` — conservative Things to Do baseline limited to Project 03-approved machine semantics.
- `fixtures/things-to-do-candidate.json` — non-public synthetic task used for contract validation.
- `normalization/ttd-fact-registry.json` — vocabulary, types, and materiality of normalized Things to Do candidate facts.
- `trust/things-to-do-v1.trust-anchor.json` — deployment trust root binding the approved policy identity, version, approval reference, rule set, and content digest.
- `fixtures/ttd-adjudication-oracle.json` — synthetic acceptance oracle covering normalization, evaluation, and routing.
- `scripts/validate-control-plane-contracts.mjs` — self-contained schema/subset validator, semantic invariant validator, and negative-regression harness.

## Normal state progression

`DISCOVERED -> NORMALIZED -> EVIDENCE_CHECKED -> ADJUDICATED -> SELECTED -> LOCALIZED -> MEDIA_VALIDATED -> PUBLICATION_READY -> IMPLEMENTED -> REVIEWED -> DEPLOYMENT_READY -> PUBLISHED -> PRODUCTION_VERIFIED -> MONITORED`

Alternative terminal or exception states include `HOLD`, `REJECTED`, `BLOCKED`, `ESCALATED`, `EXPIRED`, `WITHDRAWN`, and `SUPERSEDED`.

The state machine is descriptive in v1. No scheduler or cross-provider dispatcher is activated by this tranche.

A `null` route means there is intentionally no automatic downstream route for that outcome. A non-null route must use an existing worker-role and status vocabulary value.

## Authority semantics

Authority strings are references, not self-authorizing claims. Before dispatch, the orchestration layer must resolve the referenced policy/authority against a trusted source. `authority_resolution: TRUSTED_RESOLVED` means that resolution has occurred; `UNRESOLVED` cannot authorize progression that depends on the missing authority.

Any task that is allowed to write repository state (`WRITE_BRANCH`, `COMMIT`, `PUSH`, or `OPEN_DRAFT_PR`) must carry an exact 40-character `expected_main_sha` precondition. The worker must stop if authoritative `main` has moved.

## Human escalation rule

Routine unfamiliarity is not an escalation condition. Escalation is reserved for declared classes such as novel policy questions, unresolved high-quality source conflicts, unresolved commercial policy, media-rights uncertainty that cannot be handled by the governed fallback, legal/reputational risk, authority conflicts, or confidence below a governed threshold.

Where a missing fact or dependency can be resolved by an existing evidence, localization, media, or technical authority, route there first rather than escalating to the founder.

`human_review: true` means autonomous progression stops and the task routes to the declared authority. It does not mean every such case must immediately escalate to the founder.

## Fail-closed policy composition

The Things to Do policy has `default_disposition: HOLD` intentionally. It automates only already-governed cases. Unrepresented cases cannot silently become new A PRASA policy.

Composition rules are explicit:

1. Every declared rule predicate must be present in the candidate state and equal the declared value before that rule matches.
2. Unknown material input that is required for eligibility produces `HOLD`; absence must not be interpreted as a favorable false value.
3. A matching `DEFERRED` rule produces `HOLD` with publication blocked. Deferred rules cannot be silently skipped.
4. `publication_blocked: true` is monotonic within an evaluation. A later rule cannot clear an earlier block.
5. `NO_CHANGE` is non-clearing. It may add omissions, caveats, evidence/media handling, or other field actions, but cannot convert a HOLD/REJECT into SELECT and cannot clear a publication block.
6. When multiple substantive rule outcomes match, precedence is `HOLD > REJECT > SELECT > NO_CHANGE`.
7. A below-threshold confidence signal never authorizes a substantive disposition; it routes to HOLD/authority resolution.

## Current approved Things-to-Do machine boundary

The v1 policy currently encodes only Project 03-approved semantics, including:

- ordinary cultural/community/public-interest/general-audience activities may SELECT only when explicit eligibility predicates are satisfied;
- commercial venue/provider identity alone does not disqualify an otherwise eligible cultural/community/public-interest event;
- unresolved material source conflicts HOLD for verification;
- first-party organizer/venue/provider sources are preferred when accessible, but source preference alone never selects;
- unknown admission is omitted and never inferred as free;
- unsupported secondary details such as an unverified start time may be omitted when core event identity/date/venue evidence is otherwise sufficient;
- supported date precision must be preserved; month-only evidence must not be converted into an invented exact day;
- governed media hierarchy is direct organizer/provider artwork -> verified provider-owned media -> standardized A PRASA editorial fallback;
- broader/general listings must not expand a dedicated event beyond what specific evidence supports;
- public copy must not strengthen unknown facts into verified claims;
- ticketing or a commercial venue alone does not disqualify an otherwise eligible editorial event;
- payment/commercial/client relationships cannot buy editorial inclusion, ranking, verification, endorsement, favorable treatment, or standards exemption;
- an ongoing commercial tour/excursion/class/experience/package/service whose primary proposition is purchase is not eligible for autonomous ordinary Things-to-Do SELECT and remains HOLD until governed commercial treatment applies;
- a candidate that has fully ended before publication must not be introduced as current content;
- missing governing authority produces HOLD;
- unresolved standards-boundary cases produce HOLD rather than a machine-created rejection rule.

Detailed religious, political/advocacy, adult/sexualized, hateful/extremist, unsafe, fraudulent, unlawful, and similar Community & Editorial Standards categories are **not** machine-authorized rejection classes in this v1 policy. They remain HOLD/authority-required until the corresponding standards surface is approved for machine enforcement.

## Security and mutation boundaries

Every autonomous task must declare allowed and prohibited actions. `MERGE`, `DEPLOY`, `DELETE_BRANCH`, `INVENT_FACTS`, `INVENT_POLICY`, `PUBLISH_EXTERNAL_MESSAGE`, and `CHANGE_GOVERNANCE` remain explicit prohibition tokens for this foundation.

This v1 foundation does not itself authorize any of those actions.

## Validation

Run:

`node scripts/validate-control-plane-contracts.mjs`

The validator performs:

- structural validation of the synthetic task against the task-envelope schema;
- structural validation of the Things-to-Do policy against the adjudication-policy schema;
- semantic invariant checks for authority, fail-closed composition, required rules, admission handling, deferred commercial treatment, and write-authority preconditions;
- seven in-memory negative regressions covering invalid task vocabulary/routing, broken governing-authority behavior, empty eligibility predicates, missing approved rules, reintroduced unapproved exclusions, weakened deferred commercial treatment, and duplicate rule IDs.

## Things to Do normalizer and adjudication evaluator

The worker layer is split into three independently testable stages. Nothing in it calls an LLM, a web search, or any external service, and no stage reads the clock: the evaluation timestamp is injected by the caller so identical frozen inputs produce identical output.

1. **Normalization** (`scripts/lib/ttd-normalizer.mjs`) turns a source-evidence record into normalized facts. A fact is `KNOWN` only when a HIGH-confidence, provenance-backed assertion establishes it against a resolvable `http`/`https` source. Everything else stays `UNKNOWN` and is preserved as `UNKNOWN`. Absence never becomes a favourable value.
2. **Evaluation** (`scripts/lib/ttd-policy-evaluator.mjs`) interprets the approved policy document. Dispositions, blocking, human review, reason codes, and field actions all come from the policy; only composition mechanics, typed matching, and trust enforcement live in code.
3. **Routing** (`scripts/lib/ttd-adjudication-routing.mjs`) reads only the final composed result and emits a next-worker decision drawn from the committed task-envelope vocabulary.

`scripts/lib/ttd-adjudication.mjs` composes the three and emits one audit record.

### Standards boundary

`standards_boundary_unresolved` is derived, never asserted. Clearing it requires a complete standards classification: `affirmative_ordinary_scope_evidence` exactly `true`, `confidence` exactly `HIGH`, `unresolved_dimensions` an empty array of strings, `mixed_purpose` exactly `false`, and `evidence_refs` a non-empty array of resolvable source-ref identifiers. Every one of those members must be **present and of the exact declared type**. A missing member, a wrong-typed member, a substituted object or array shape, an unresolved dimension, a mixed purpose, or an unresolvable reference all yield `true`, which HOLDs and blocks under `TTD-GOV-002` with human review. Absence of adverse keywords is not affirmative ordinary-scope evidence, and this tranche introduces no automatic standards REJECT class.

### Fact consistency

`normalization/ttd-fact-registry.json` declares `fact_consistency_constraints`: combinations of normalized facts that cannot hold together. `TTD-FACT-CONSISTENCY-001` forbids `materially_current: true` alongside `candidate_already_ended: true`. A violated constraint fails closed to HOLD with publication blocked and human review required; neither side of the contradiction is silently preferred, and no field actions are derived from contradictory facts. The constraint set is a **required** evaluator input — a caller that omits it gets a validation failure rather than silently losing the check. These constraints enforce internal contradictions only; they create no editorial rule and change no approved policy semantics.

### Evaluator semantics

- Predicate matching is exact and typed. There is no truthiness and no coercion; a missing or `UNKNOWN` value never satisfies a declared `false`.
- Every rule is evaluated, `DEFERRED` rules included. A matching `DEFERRED` rule always HOLDs, blocks, and requires human review.
- Precedence is `HOLD > REJECT > SELECT > NO_CHANGE`. `NO_CHANGE` cannot clear another rule and `SELECT` cannot clear a HOLD.
- Publication blocking and human review are monotonic within one evaluation.
- When no substantive rule authorizes an outcome, the default `HOLD` applies.
- A `SELECT` may stand only when **every** material eligibility dependency in the fact registry is KNOWN and well-formed. A dependency that is missing, `UNKNOWN`, contradictory, or carrying a value the policy could never compare against is named in `unresolved_dependencies` and downgrades the outcome to HOLD with publication blocked, routed to evidence verification. `UNKNOWN` is never converted into a favourable `false`.
- Compatible `field_actions` merge; conflicting ones fail closed to HOLD rather than being silently reconciled.
- Governing-rule selection, matched-rule ordering, and the semantic fingerprint are order-independent, so neither JSON key order nor rule declaration order can change meaning.

### Input safety and audit completion

Canonical serialization refuses both prototype-pollution vectors: a dangerous own key (`__proto__`, `constructor`, `prototype`, as produced by `JSON.parse` of hostile input) and a tampered object or array prototype (as produced by merging that input with `Object.assign`, where the key no longer appears in `Object.keys`). Refusal rejects the candidate but never aborts the pipeline: the evidence digest degrades to `null` with the error recorded, and a bounded audit record is still produced showing the validation failure, `HOLD`, publication blocked, no matched rules, and `downstream_execution: NOT_EXECUTED`. No downstream progression is ever fabricated.

### Trust and authority

Before any rule may match, the evaluator verifies the policy identity, version, domain, approval reference, approving owner, rule set, canonical content digest, and fail-closed composition constants against `trust/things-to-do-v1.trust-anchor.json`, and requires authority-resolution evidence supplied by a trusted resolver. Candidate-supplied claims are recorded for audit and are never authorizing. On any integrity or authority failure the evaluator emits no SELECT, claims no matched rules, blocks progression, and returns an authority-resolution or validation result.

`scripts/validate-ttd-trust-anchor.mjs` is the drift gate: a policy edit not accompanied by a separately reviewed anchor update fails CI and makes the evaluator fail closed at runtime.

### Tests

Run:

```
node scripts/validate-ttd-trust-anchor.mjs
node scripts/test-ttd-normalization.mjs
node scripts/test-ttd-policy-evaluator.mjs
node scripts/test-ttd-adjudication-composition.mjs
node scripts/test-ttd-adversarial-regressions.mjs
```

The three stages are tested separately against `fixtures/ttd-adjudication-oracle.json`. Stage B consumes the oracle's hand-authored normalized facts rather than normalizer output, and stage C consumes the oracle's expected evaluation rather than evaluator output, so no suite generates its own expected results from the production implementation.

All oracle records are synthetic. None describes a real event and none may be published.

## Next implementation tranche

After this tranche passes exact-SHA independent review, the next tranche should reconcile the oracle against the Project 03 standards owner's own test specification, then connect only governed `SELECTED` records to the existing event-publication preparation machinery. Existing publication validators and exact-SHA review gates remain controlling. No autonomous merge, deploy, publication, or governance authority is created here.
