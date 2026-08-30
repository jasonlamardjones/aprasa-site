# Things-to-Do publication automation

Phase 1B converts an already-approved event packet into a guarded draft-PR
candidate. It does not research, approve, merge, deploy, or invent content.

## Authorization modes

Dry-run packets retain `dry_run: true`, do not set `real_write: true`, and
cannot authorize commits or PR creation.

Real-write packets must set all of the following explicitly:

- `dry_run: false`
- `real_write: true`
- `expected_main_sha` to the reviewed 40-character main SHA
- `allow_branch`, `allow_commit`, and `allow_pr` to `true`
- `merge_allowed: false`

They must also contain the complete Project 09-approved additive locale
package and the complete approved media-manifest record. The workflow copies
those values; it does not synthesize governed wording or provenance.

## Required trusted two-stage run

From a clean fresh `feature/*` branch whose HEAD and `origin/main` both match
`expected_main_sha`:

```sh
node scripts/write-event-publication.mjs \
  --packet=path/to/approved-packet.json
```

The real-write command queries the authoritative remote `refs/heads/main`, then
executes the Phase 1 dry run itself. Its proof is created in a controlled
temporary directory and consumed in the same process; a caller-supplied proof
cannot authorize a production write. The proof is checked against the exact
packet SHA-256, event id, branch HEAD, authoritative main SHA, currentness date,
changed-file inventory, and required deterministic stage list.

New media bytes must first be placed beneath
`.git/aprasa-media-intake/`. Destinations are restricted to canonical
`assets/events/<event-id>.<avif|jpg|jpeg|png|webp>` paths. Existing approved
assets may be reused only as regular files with the exact approved SHA-256.

## Transaction and stop gate

Real-write preparation runs in an isolated staging copy. It applies only the
approved event, media-manifest record, locale package, optional verified media
asset, and currentness input; regenerates incumbent EN/PT surfaces and sitemap;
runs all incumbent validators; checks exact scope, `git diff --check`, and
idempotence; and creates JSON plus Markdown run artifacts.

Only a passing candidate is copied to the clean feature branch. The CLI stages
the exact reported files, rechecks the staged scope and diff, commits, pushes,
and opens a draft PR. It never merges, deploys, or deletes the branch.

Promotion keeps a private backup journal until commit succeeds. Copy, staging,
or commit failure restores the exact clean baseline. A later push or PR failure
preserves the commit and reports its SHA, verified remote/PR state, and the
deterministic resume action rather than silently rewriting history.
