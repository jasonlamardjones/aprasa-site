# Control-plane task results

This directory is a **documentation placeholder**, not where real task
results land. It exists so `automation/control-plane/results/<result_id>.json`
is a real, browsable path in this tree, and to hold this README.

Real, persisted `NEEDS_EVIDENCE_VERIFICATION`, `NEEDS_PROJECT_03_DECISION`,
`TECHNICAL_VALIDATION_FAILED`, `REVIEW_PASSED`, and `REVIEW_FAILED` records
written by `scripts/write-control-plane-result.mjs` are **never committed
here**. They are committed onto a separate git ref
(`refs/heads/control-plane-task-results` by default), using the same
relative path (`automation/control-plane/results/<result_id>.json`) inside
that ref's own tree. This is deliberate: a `REVIEW_PASSED`/`REVIEW_FAILED`
record binds to an exact `repository.sha`, and committing it onto the branch
it reviews would change that branch's SHA the moment the review was
persisted — invalidating it by its own rule. Persisting on a separate ref
means writing a review never moves the candidate it describes.

Read results with `scripts/validate-control-plane-result.mjs` (no
`--result` flag reads every result on the ref) or
`scripts/lib/control-plane-result.mjs`'s `readPersistedResult` /
`listPersistedResults`, not by looking in this directory on disk.

See `automation/control-plane/README.md` ("Persistence: a separate ref,
never the candidate's own branch") for the full lifecycle, and
`automation/control-plane/task-result.schema.json` for the record shape.

Synthetic examples used for schema and regression testing are committed
normally, as ordinary files, in
`automation/control-plane/fixtures/task-result-examples/` — those are
illustrative fixtures, not live review evidence about this candidate's own
SHA, so the self-invalidation concern above does not apply to them.

A result never grants publication, merge, or deploy authority
(`grants_publication_authority` is a schema `const: false` on every record).
Whether and when the results ref is pushed to a remote is an operational
decision outside this layer.
