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

## Required two-stage run

From a clean fresh `feature/*` branch whose HEAD and `origin/main` both match
`expected_main_sha`:

```sh
node scripts/prepare-event-publication.mjs \
  --packet=path/to/approved-packet.json \
  --proof=.git/aprasa-publication-dry-run.json

node scripts/write-event-publication.mjs \
  --packet=path/to/approved-packet.json \
  --proof=.git/aprasa-publication-dry-run.json
```

The proof is bound to the packet SHA-256, event id, branch HEAD, approved main
SHA, currentness date, changed-file inventory, and successful deterministic
steps. A missing, mismatched, stale, or incomplete proof is refused before any
authoritative write.

## Transaction and stop gate

Real-write preparation runs in an isolated staging copy. It applies only the
approved event, media-manifest record, locale package, optional verified media
asset, and currentness input; regenerates incumbent EN/PT surfaces and sitemap;
runs all incumbent validators; checks exact scope, `git diff --check`, and
idempotence; and creates JSON plus Markdown run artifacts.

Only a passing candidate is copied to the clean feature branch. The CLI stages
the exact reported files, rechecks the staged scope and diff, commits, pushes,
and opens a draft PR. It never merges, deploys, or deletes the branch.
