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
- `task-result.schema.json` — schema for the provider-neutral, content-addressed task-result records described below.
- `results/` — documentation placeholder only; real records are committed onto a separate `control-plane-task-results` ref, never here; see `results/README.md`.
- `fixtures/task-result-examples/` — one committed synthetic example per result_type, kept in sync by `scripts/test-control-plane-result.mjs`.
- `scripts/lib/control-plane-result-producers.mjs` — the wiring layer that turns real workflow outcomes into records on the contract above; see "Producers" below.

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

## Task results: persisting exceptions and reviews

Several outcomes currently stop autonomous progression but leave no durable
record: an unresolved evidence dependency, an unresolved Project 03 standards
question, a failed technical validator, and the independent exact-head review
that gates every guarded-write candidate. `scripts/lib/control-plane-result.mjs`
persists exactly five such outcomes as schema-validated, content-addressed
records — `NEEDS_EVIDENCE_VERIFICATION`, `NEEDS_PROJECT_03_DECISION`,
`TECHNICAL_VALIDATION_FAILED`, `REVIEW_PASSED`, `REVIEW_FAILED` — governed by
`task-result.schema.json`.

A task result is provider-neutral: it names a worker role and a governance
owner drawn from the same vocabulary as the task envelope and orchestration
contract, never a vendor. `grants_publication_authority` is a schema `const:
false` on every record — a task result can report that a review passed, but
it cannot itself authorize merge, deploy, or publication.

The mapping from `result_type` to `status`, `owner`, and `resume_point` is
fixed and cannot vary per instance (`scripts/lib/control-plane-result.mjs`'s
`RESULT_TYPE_INVARIANTS`), because the repository's hand-rolled schema
validator does not implement `if`/`then`/`else` or `allOf`; the schema fixes
shape only, and `validateResult` enforces the per-type invariant as a
semantic check, the same split `scripts/validate-control-plane-contracts.mjs`
already uses for the Things-to-Do policy document. `REVIEW_PASSED` carries a
`resume_point` of `null` rather than an automatic route: merge/deploy remains
founder-only, and a `null` route means exactly what it means throughout this
control plane — no automatic downstream route exists for that outcome.

### Identity vs. occurrence: what result_id means

`result_id` is the SHA-256 digest of the record with `result_id` **and
`created_at`** both removed. `created_at` is retained on every record as
useful occurrence data, but excluding it from identity is deliberate: a retry
of the same logical event — a CLI rerun after a transient failure, replaying
an unchanged adjudication outcome — must not mint a second result merely
because wall-clock time advanced. Two records are the same logical event
exactly when every other field agrees; if anything governance-relevant
differs (`reason`, `evidence_digest`, `reviewer`, `upstream_refs`, ...), that
is genuinely a new event and correctly gets a new identity.

This does mean `created_at` alone is not tamper-evident by the JSON content
digest. The fields that actually gate a governance decision —
`repository.sha`, `evidence_digest` — remain digest-protected; `created_at`
does not, and no consumer should treat it as an authoritative timestamp on
its own. The persisting git commit's own committer timestamp (see below)
supplies an independent, git-object-level occurrence record that is
tamper-evident in the way the JSON field alone is not.

### Persistence: a separate ref, never the candidate's own branch

A `REVIEW_PASSED`/`REVIEW_FAILED` record binds to an exact `repository.sha`.
If that record were committed onto the very branch it reviews, the commit
would create a new SHA, and the review would be stale by its own rule the
instant it was persisted. To avoid that, every result — all five types, for
uniformity — is persisted onto a dedicated git ref,
`refs/heads/control-plane-task-results` by default, using plumbing only
(`hash-object`, `read-tree`/`write-tree` against a throwaway index,
`commit-tree`, `update-ref` with compare-and-swap). The working tree, the
real index, and HEAD of whatever branch happens to be checked out are never
touched, so writing a result can never move the candidate branch it
describes.

The local-only lifecycle (`writeResult`, no network):

```
candidate branch at SHA A
        |  (no commit; the reviewer inspects A as it stands)
        v
independent exact-head review of A
        |  buildResult({ resultType: REVIEW_PASSED, repositorySha: A, ... })
        v
writeResult(root, record)              -- plumbing only, targets
        |                                  refs/heads/control-plane-task-results
        v
control-plane-task-results ref advances to a NEW commit B
        |                                  (candidate branch is still at A)
```

`B` and `A` are commits on two different refs; persisting `B` never rewrites
or moves `A`. The regression suite proves this directly: it builds a
candidate commit, persists a `REVIEW_PASSED` result for it, then re-reads the
candidate branch's own SHA and asserts it is byte-identical to what it was
before the write — and separately proves the review does, correctly, go
stale once the candidate branch receives *its own* later, unrelated commit.

`writeResult` alone is durable only inside the checkout that produced it —
an ephemeral CI/worker environment loses it when the environment ends. See
"Remote durability" below for the layer that fixes that.

Reading is symmetric: `readPersistedResult`/`listPersistedResults` use `git
show <ref>:<path>` and `git ls-tree`, so a checkout that has never fetched
the results ref simply reports no results, and one that has can validate
every result on it without checking it out.

### Remote durability

A local-only result vanishes with its checkout. GitHub is the authoritative
technical source for this project (see "Source-of-truth boundaries" above),
so `publishResult` treats the *remote's* current tip of the results ref as
ground truth on every call, and only ever advances the remote with an
ordinary fast-forward push. No custom locking is invented: git and GitHub
already refuse a non-fast-forward update to a branch ref, and that refusal
*is* the concurrency control this layer relies on. `--force` is never used
anywhere in this module.

The full lifecycle:

```
candidate SHA A
        v
independent review of A (no commit on A's own branch)
        v
buildResult({ resultType: REVIEW_PASSED, repositorySha: A, ... })
        v
publishResult(root, record)
        |  1. resolveAuthoritativeRemoteTip  -- ls-remote the results ref;
        |                                        null only means "never
        |                                        published", never
        |                                        "unreachable" (that throws)
        |  2. sync the local staging ref to exactly that remote tip
        |     (or delete it, if the remote has none yet)
        |  3. writeResult (unchanged) builds on top of it -- a same-identity
        |     replay is a no-op here already, before any network write
        |  4. git push <remote> <new-commit>:refs/heads/<ref>  -- plain,
        |     never forced
        |  5a. push succeeds -> ls-remote again to verify the remote now
        |      reports exactly the commit just pushed
        |  5b. push rejected (non-fast-forward) -> re-resolve the remote tip;
        |      if it moved, a concurrent writer won -- rebuild on the new
        |      tip and retry (bounded); if it did not move, this was not a
        |      race and the failure is surfaced, never retried blindly
        v
control-plane-task-results ref on GitHub advances to commit B
        |                                  (candidate branch is still at A)
        v
a later worker: fetchResultsRef(root)  -- explicit; validate never fetches
        |                                  implicitly
        v
validate-control-plane-result.mjs --candidate-sha=A
        |                                  reads the record from B, compares
        |                                  record.repository.sha (A) to A -> current
        v
founder merge gate                     -- unaffected; still manual, still
                                           outside this layer's authority
```

**Why `refs/heads/control-plane-task-results` and not a custom namespace.**
This stays a normal branch ref rather than moving to `refs/notes/*` or a
bespoke `refs/task-results/*` namespace, specifically for GitHub
compatibility: `refs/heads/*` is the only namespace GitHub's web UI renders
specially (branch dropdown, file browser, compare view), the only one a
plain `git fetch <remote> <name>` or `actions/checkout` with `ref:` reaches
without extra configuration, and the only one every git tool assumes by
default. A custom namespace would be invisible in GitHub's own UI and would
need bespoke fetch/checkout configuration everywhere it was read — worse on
exactly the discoverability and tool-compatibility grounds this choice is
made on. The cost is that it appears as an ordinary-looking branch that is
never meant to be merged; that is an already-familiar, well-precedented git
pattern (`gh-pages`, changelog branches), not a new one.

**Concurrency, precisely.** Two writers resolving the same remote tip and
building on it concurrently is not prevented — it is *detected*, by the
plain git push each performs. Whichever push reaches GitHub first wins; the
second is rejected as non-fast-forward (proven in the sandbox test below by
fabricating exactly that race and confirming the rejected push changes
nothing on the remote). `publishResult`'s own retry loop reacts to that by
re-resolving the remote and rebuilding, which is what turns a rejection into
forward progress for a real writer without ever forcing past someone else's
work; the raw git-level protection holds even if a caller bypasses the retry
loop entirely.

### Exact-SHA binding

`REVIEW_PASSED` and `REVIEW_FAILED` records carry the exact `repository.sha`
they were produced against and are invalid once the candidate's head SHA
moves. `scripts/validate-control-plane-result.mjs --candidate-sha=<sha>`
enforces this: a mismatch fails closed with `STALE_REVIEW_RESULT`, and no
other check in that run is treated as sufficient to paper over it.
Non-review result types carry `repository.sha` for provenance only and are
not invalidated by SHA drift, since they describe a dependency or a
validator failure rather than a verdict on a specific commit.

### Writing and reading a result

```sh
# Local only -- durable inside this checkout.
node scripts/write-control-plane-result.mjs --draft=<path-to-draft.json> [--ref=<name>] [--root=<repo>]

# Durable across workers/checkouts: reconciles against the remote first,
# pushes only refs/heads/<ref>, never forces, retries against a moved remote.
node scripts/write-control-plane-result.mjs --draft=<path-to-draft.json> --publish [--remote=<name>]

# A later worker: fetch, then validate against the exact candidate SHA.
node scripts/validate-control-plane-result.mjs --fetch                           # fetch, default remote/ref
node scripts/validate-control-plane-result.mjs --fetch=<remote>                  # a non-default remote
node scripts/validate-control-plane-result.mjs                                   # validates every result on the (local) ref
node scripts/validate-control-plane-result.mjs --ref=<name>                      # a non-default results ref
node scripts/validate-control-plane-result.mjs --result=<path>                   # validates one local file
node scripts/validate-control-plane-result.mjs --result=<path> --candidate-sha=<sha>
```

The draft file supplies only what varies per instance — `resultType`,
`taskId`/`candidateId`, `repositorySha`, `reason`, `requiredInput`,
`evidenceDigest`, `reviewer` (required for the two review types, forbidden
otherwise), and `upstreamRefs` (at least one, tracing back to whatever
produced this result — an adjudication audit record, a publication run
artifact, a reviewed commit SHA). Neither script ever commits onto,
pushes, or moves a candidate branch, and neither merges or deploys.
`validate-control-plane-result.mjs` never touches the network unless
`--fetch` is passed explicitly.

### Producers: which real workflow outcomes emit a result

`scripts/lib/control-plane-result-producers.mjs` is the wiring layer between
real workflow outcomes and the contract above. It owns nothing the result layer
already owns: no second schema, no second identity function, no second
persistence mechanism. It builds the per-instance inputs `buildResult` already
accepts and hands the record to `writeResult`/`publishResult` on the dedicated
results ref.

Two producers are wired. Both are fail-closed: a required result that cannot be
persisted raises `TASK_RESULT_PERSISTENCE_FAILED`, which the callers report
alongside the original failure. Nothing here continues without a record.

**1. Guarded event publication → `TECHNICAL_VALIDATION_FAILED`.**
`scripts/write-event-publication.mjs` already failed closed on a refused
real-write; that refusal was simply not durable, so on an ephemeral worker it
vanished and the founder relayed the state by hand. It now emits one durable
record instead.

The ownership gate is structural rather than textual. Before any guarded work
runs, the approved packet is put through the same `validatePacket` preflight
`prepareRealWriteCandidate` performs, purely to decide ownership. That validator
stamps an owner on every issue it raises, and those owners include Project 03,
Project 09, the owning media project, and the founder. A failure at or before
that gate is therefore **not** emitted as a technical validation failure: the
run reports `task_result.reason: NOT_TECHNICALLY_OWNED` with the gate that
stopped it, and creates nothing. Project 04 must not relabel a governance
refusal as a technical one. Once that gate passes, the packet is
governance-approved and every remaining failure is repository/automation
mechanics, which Project 04 does own.

The record is published to the remote results ref by default, because
durability across workers is the point. `--no-publish-result` keeps it local to
the checkout and `--no-task-result` skips it; both downgrades are reported in
the command's output rather than applied silently.

```sh
node scripts/write-event-publication.mjs --packet=<approved-real-write-packet.json> \
  [--no-publish-result] [--no-task-result] [--result-ref=<name>] [--result-remote=<name>]
```

**2. Independent exact-SHA review → `REVIEW_PASSED` / `REVIEW_FAILED`.**
`scripts/record-independent-review.mjs` is a structured-input adapter, not an
in-process call, and that distinction is the whole point. The worker that
produced a candidate can physically call the result writer — same repository,
same library — so independence cannot be inferred from the running process. The
adapter therefore **never derives the reviewer**: it reads no git config, no
commit author, no CI actor, no environment variable. `--reviewer-identity` must
be supplied explicitly, and identities naming the writing process or the
control-plane automation are refused outright. `--candidate-sha` is required in
full 40-character form and must resolve to a real commit in this repository; a
reviewer on a fresh clone fetches the candidate first.

```sh
node scripts/record-independent-review.mjs \
  --outcome=PASSED|FAILED \
  --candidate-sha=<40-char lowercase hex> \
  --reviewer-identity='<who reviewed it>' \
  --reason='<the finding>' \
  --required-input='<what is needed next>' \
  (--evidence=<path> | --evidence-digest=<64-char lowercase hex>) \
  [--candidate-id=<id>] [--task-id=<ID>] [--candidate-ref=<ref>] \
  [--reviewer-role=INDEPENDENT_REVIEWER|HUMAN_ESCALATION] \
  [--upstream-ref=<KIND>:<ref> ...] [--publish] [--remote=<name>] [--ref=<name>] [--root=<repo>]
```

A recorded review is evidence and nothing else. `grants_publication_authority`
stays the schema `const false`, `REVIEW_PASSED` keeps its `null` resume point
because merge and deploy remain founder-only, and neither command merges,
deploys, pushes a candidate branch, or moves any ref but the results ref.

#### Producer identity and results-ref isolation

The task-result schema is `additionalProperties: false` and has no producer
field, and this tranche does not change the schema. Producer identity therefore
travels in `upstream_refs` under the existing `AUDIT_RECORD` kind with a stable
`control-plane-producer:` prefix.

`assertResultsRefIsolated` refuses to persist onto the branch being reported on,
the checked-out branch, or `main`/`master`. The merged persistence layer already
writes by plumbing only and never touches HEAD, the index, or the working tree,
but it writes to whatever ref name it is given; pointing that at a candidate
would make persisting evidence an act that moves the thing the evidence is
about. That is refused rather than relied on not to happen.

#### Replay identity: normalizing run-scoped noise

`result_id` excludes `created_at`, so two records are the same logical event
exactly when every other field agrees. Raw guarded-write failure text breaks
that guarantee on its own: the path runs inside `mkdtemp` staging, proof, and
backup roots whose names end in six random characters, and it shells out through
an absolute `process.execPath`. Two identical failures would mint two different
result ids purely because a temporary directory was named differently.

`normalizeFailureDetail` rewrites exactly three enumerated classes of run-scoped
token — the repository root, temp roots (including `mkdtemp` suffixes), and the
node executable path — to stable placeholders before anything is digested, and
bounds the detail deterministically. It is a narrow, enumerated normalization,
not a general sanitizer: every other byte is preserved, so a genuinely different
failure still produces a genuinely different record. `reason_code` is likewise a
syntactic read of the leading `CODE:` token the failing code already emitted; a
failure carrying no such token omits `reason_code` rather than inventing one.

#### Producers deliberately not wired in this tranche

`NEEDS_EVIDENCE_VERIFICATION` and `NEEDS_PROJECT_03_DECISION` remain unwired.

`routeEvaluation` does deterministically emit
`{EVIDENCE_VERIFIER, HOLD}`, which is exactly the
`NEEDS_EVIDENCE_VERIFICATION` resume point — but `adjudicateCandidate` has no
production caller in this repository. Wiring that producer would mean building
the adjudication runner that would invoke it, which is new orchestration, not
wiring of an existing workflow outcome.

One narrower gap is deliberate too. A handful of packet-preflight issues are
stamped `Project 04` by the validator itself — a missing local media asset, a
colliding canonical event id, an approved media SHA-256 that does not match the
supplied bytes. Those are genuinely technical, but they are raised at the same
gate that raises Project 03, Project 09, media-rights and founder issues, and
this tranche's ownership test is structural ("did the whole gate pass?") rather
than per-issue. The gate therefore under-emits rather than risking a
misclassification: a technical preflight refusal is reported as
`NOT_TECHNICALLY_OWNED` and creates no record. Reading the validator's own
per-issue `owner` field would close that gap without inference and is the
natural next increment; it is not done here.

`NEEDS_PROJECT_03_DECISION` additionally fails the authority test. Routing's
escalation path reports `authority_target: OWNING_GOVERNANCE_AUTHORITY`, which
is deliberately abstract, across escalation classes that include media-rights
and commercial-policy questions. Deciding that a given escalation class is
Project 03's is a governance determination Project 04 must not make, and the
control plane does not currently record it anywhere a producer could read.

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

### Reference provenance

Every cited reference set is read densely and by index through one shared gate. Array methods such as `.some()`, `.filter()` and `.every()` skip holes, so a sparse array can pass a per-element check that never runs; array length alone can therefore never establish that a reference exists. A reference set that is not a real, untampered, dense array of non-empty identifiers, or that cites an identifier `source_refs` does not resolve, yields no references at all rather than a shorter apparently valid set. Holes, `undefined` and `null` are never normalized into evidence provenance.

### Trusted registry identity

The whole fact registry is bound by one canonical content digest, pinned as `REQUIRED_FACT_REGISTRY_SHA256` in `scripts/lib/ttd-policy-evaluator.mjs`. Every registry property the normalizer or evaluator consults is decision-relevant — `admissible_confidence` and `allowed_url_schemes` gate evidence and source admission, `source_classes` and `confidence_levels` gate the vocabularies, predicate declarations gate interpretation — so the document is bound in full rather than by a list of the fields noticed so far. Any supplied registry must be semantically identical to the committed one before it may influence adjudication; production adjudication then reads the admitted snapshot the identity check returned, never the caller's object.

Canonical digesting is key-order independent, so reformatting is not drift, while any change to a value, an array's order, or the set of keys is. A legitimate registry change therefore fails closed everywhere until the pinned identity is deliberately updated and independently reviewed, exactly as a policy change fails closed until the trust anchor is updated. `scripts/validate-ttd-trust-anchor.mjs` reports the registry digest and fails on any mismatch.

### Trusted fact-policy configuration

The material eligibility predicate set and the declared fact-consistency constraints are trusted configuration, not caller input. `adjudicateCandidate` is the production entrypoint and derives both from the validated fact registry on every adjudication; any constraint set or material predicate set present on the caller-supplied context is ignored. There is no empty default: a missing, empty, malformed, narrowed, reordered-into-a-different-set, or fabricated configuration fails closed rather than degrading to `[]`.

`evaluateNormalizedFacts` keeps both as parameters so the adversarial suites can probe them directly, but a supplied set is never trusted on its own. It must be semantically identical to the configuration pinned in `scripts/lib/ttd-policy-evaluator.mjs` (`REQUIRED_MATERIAL_ELIGIBILITY_PREDICATES`, `REQUIRED_FACT_CONSISTENCY_CONSTRAINTS`, alongside `REQUIRED_COMPOSITION`), and the pinned normalized form is what enforcement then uses. Object key order inside a forbidden combination is not semantic; a changed predicate, value, reason code, or constraint identity is. A registry that reclassifies a predicate's materiality, restates a constraint, or drops one cannot be used to adjudicate anything: context construction and adjudication both refuse it, and `scripts/validate-ttd-trust-anchor.mjs` fails in CI.

### Single-read admission boundary

Descriptor inspection alone is not sufficient against a hostile view. A Proxy may answer `ownKeys`, `getOwnPropertyDescriptor` and `get` differently on each call, so validating a property and then reading it again through `value[key]` leaves a time-of-check/time-of-use split in which the digested state and the evaluated state differ.

Adjudication therefore admits its input once: `INPUT -> admitted snapshot -> digest(snapshot) -> normalize(snapshot) -> evaluate(normalized snapshot)`. Every own key is enumerated once, every descriptor is taken once, and the value used is the one carried in that descriptor — there is no second read and no `get` trap is ever consulted. The result is a fresh, deeply frozen, plain-data tree that no longer references the original object, so identity and semantics are necessarily computed from the same state, and mutating the caller's object after admission cannot change either. Cyclic input is refused rather than exhausting the stack, and a Proxy is refused outright: a view is not a fixed document, and candidate input has no legitimate reason to be an exotic object. Authority-resolution evidence and the fact registry are admitted through the same boundary.

### Canonical JSON contract

Canonical serialization validates as it emits. It never depends on an earlier normalization pass having rejected a tampered structure, and it never coerces one into valid-looking JSON. Admitted values are plain JSON-compatible objects, dense arrays, finite numbers, strings, booleans and `null`, with deterministic key ordering; output always parses with `JSON.parse`. Refused at any depth: sparse arrays (never `[,]`), tampered object or array prototypes (never a coerced `{}` or `[]`), accessor properties, non-enumerable own properties, symbol keys and values, `undefined`, functions, bigints, and non-finite numbers. Own-key inspection uses `Reflect.ownKeys` and property descriptors, so dangerous own keys (`__proto__`, `constructor`, `prototype`) are refused on objects and arrays alike whether or not they are enumerable, and no getter is ever invoked during the traversal.

### Evidence identity

If a canonical evidence digest cannot be produced for the admitted candidate input, the candidate does not advance. A `SELECT` without a stable canonical evidence identity cannot participate in the auditable provenance model, so digest failure yields `HOLD`, publication blocked, no advancing route, and an explicit technical diagnostic. This is a technical integrity requirement, not an editorial rule.

### Adjudication-control input

Externally supplied control values that are copied into the audit are admitted before any advancing disposition can be returned. `evaluatedAt` keeps its incumbent representation — a non-empty timestamp string, or `null` when no evaluation time is supplied — and is never parsed, formatted, or compared against a clock; no date semantics are introduced. Anything else is inadmissible and fails closed.

Behind that, a final defensive invariant: an adjudication result must itself be canonically representable before it may leave `adjudicateCandidate`. If the assembled audit cannot be canonicalized for any reason, the result is downgraded to `HOLD`, publication blocked, human review required, no advancing route, `downstream_execution: NOT_EXECUTED`, with an explicit technical-integrity diagnostic. This guard is defense in depth; it does not replace admitting each control input.

### Input safety and audit completion

Refusal rejects the candidate but never aborts the pipeline. Candidate identity is captured before adjudication using accessor-free descriptor reads, so the bounded failure path never re-reads attacker-controlled input that has already thrown, and a hostile getter is never invoked at all. On any refusal or unexpected input exception the evidence digest is `null` with the error recorded, and a bounded audit record is still produced showing the failure, `HOLD`, publication blocked, human review required, no matched rules, no advancing route, and `downstream_execution: NOT_EXECUTED`. The bounded audit is always canonically serializable. No downstream progression is ever fabricated.

### Trust and authority

Before any rule may match, the evaluator verifies the policy identity, version, domain, approval reference, approving owner, rule set, canonical content digest, and fail-closed composition constants against `trust/things-to-do-v1.trust-anchor.json`, and requires authority-resolution evidence supplied by a trusted resolver. Candidate-supplied claims are recorded for audit and are never authorizing. On any integrity or authority failure the evaluator emits no SELECT, claims no matched rules, blocks progression, and returns an authority-resolution or validation result.

`scripts/validate-ttd-trust-anchor.mjs` is the drift gate: a policy edit not accompanied by a separately reviewed anchor update fails CI and makes the evaluator fail closed at runtime.

### Tests

Run:

```
node scripts/validate-control-plane-contracts.mjs
node scripts/validate-control-plane-hardening.mjs
node scripts/validate-orchestration-contract.mjs
node scripts/validate-ttd-trust-anchor.mjs
node scripts/test-ttd-normalization.mjs
node scripts/test-ttd-policy-evaluator.mjs
node scripts/test-ttd-adjudication-composition.mjs
node scripts/test-ttd-adversarial-regressions.mjs
node scripts/test-control-plane-result.mjs
```

The three stages are tested separately against `fixtures/ttd-adjudication-oracle.json`. Stage B consumes the oracle's hand-authored normalized facts rather than normalizer output, and stage C consumes the oracle's expected evaluation rather than evaluator output, so no suite generates its own expected results from the production implementation.

All oracle records are synthetic. None describes a real event and none may be published.

## Next implementation tranche

After this tranche passes exact-SHA independent review, the next tranche should reconcile the oracle against the Project 03 standards owner's own test specification, then connect only governed `SELECTED` records to the existing event-publication preparation machinery. Existing publication validators and exact-SHA review gates remain controlling. No autonomous merge, deploy, publication, or governance authority is created here.

The task-result layer above persists exceptions and reviews; it does not yet wire any producer to call `write-control-plane-result.mjs` automatically. A future tranche could have the guarded-write path (`scripts/lib/event-publication-write.mjs`) emit a `TECHNICAL_VALIDATION_FAILED` result on validator failure, and have independent review conclude with a `REVIEW_PASSED`/`REVIEW_FAILED` result instead of prose in a PR body — but that wiring is deliberately out of scope here and remains for governance and implementation review to authorize separately.
