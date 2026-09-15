# Control-plane task results

This directory holds real, content-addressed task-result records written by
`scripts/write-control-plane-result.mjs` — persisted `NEEDS_EVIDENCE_VERIFICATION`,
`NEEDS_PROJECT_03_DECISION`, `TECHNICAL_VALIDATION_FAILED`, `REVIEW_PASSED`, and
`REVIEW_FAILED` outcomes. See `automation/control-plane/README.md` for the full
contract and `automation/control-plane/task-result.schema.json` for the shape.

It is empty by default. Synthetic examples used for schema and regression
testing live separately, in `automation/control-plane/fixtures/task-result-examples/`,
so this directory only ever contains records that describe a real task or
candidate.

A file here never grants publication, merge, or deploy authority
(`grants_publication_authority` is a schema `const: false` on every record).
Whether and when a written file is committed is an operational decision made
by whatever process invoked the writer — this directory's presence does not
imply an automatic commit.
