# A PRASA lightweight publishing and media convention

Status: internal technical convention for the current manual publishing workflow.

## Purpose

Keep weekly content refreshes consistent without introducing a CMS or ad platform. This convention supports the authorized card-media foundation and preserves Project 03 policy boundaries.

## Media precedence

Every in-scope public card renders a media region. Choose media in this order:

1. Organizer/provider artwork supplied directly to A PRASA.
2. Verified provider-owned media from an official or provider-controlled source.
3. Approved A PRASA category fallback.
4. Standardized A PRASA section fallback.

Never use arbitrary search-result imagery or stock imagery as evidence for a specific event, opportunity, provider, or organization. Never use generated or generic imagery in a way that implies it depicts the actual event, activity, course, provider, or organization.

Do not hotlink provider images. Authentic provider media must be ingested into the A PRASA repository before publication.

## Required record fields

Each in-scope public card must have a corresponding record in `internal/provider-media-manifest.json` with:

- section
- title
- provider / organizer
- source URL or source reference
- media type: `provider-supplied`, `provider-owned`, or `editorial-fallback`
- media state
- media source / provenance note
- local media asset path when authentic media is present
- fallback category and reason when fallback media is used
- media checked date when the asset is finalized
- alt text when informative authentic media is used
- expiry / re-check date when relevant

These fields do not require a CMS. They may remain in the bounded publishing packet and repository metadata.

## Media states

Use exactly these states:

- `authentic-present` — approved authentic media is locally ingested and implemented.
- `authentic-available-needs-ingestion` — suitable provider-controlled media exists, but local ingestion or final implementation is still outstanding.
- `fallback-temporary` — the fallback is covering unresolved media research or ingestion work.
- `fallback-final` — provider/source media was checked and fallback use is an intentional final disposition.

A card displaying correctly with a fallback does not by itself make the record media-complete.

## Fallback behavior

If a card has no authentic media, the shared front-end foundation inserts the standardized A PRASA editorial fallback media region. The fallback is intentionally generic, identifies the content area, and carries no alt-text claim about the specific record.

The same fallback is used in the details dialog when the source record has no authentic media.

`fallback-temporary` is a visible safety state, not an editorial completion state. When an approved category-level fallback library is available, use the matching category fallback before the section-level fallback.

## Publishing readiness gate

A new or updated card is not publication-ready until content and media disposition are resolved together.

Required sequence:

`SOURCE VERIFIED -> MEDIA RESOLVED -> ASSET INGESTED -> CARD READY -> QA PASSED`

For intentional final fallback:

`SOURCE VERIFIED -> MEDIA RESOLVED AS FALLBACK -> CARD READY -> QA PASSED`

Run:

`node scripts/validate-card-media.mjs`

The validator checks manifest coverage, allowed media states/types, required provenance fields, and the existence of locally declared authentic assets. Exit code `2` means structural validation passed but unresolved media work remains; such a branch is not media-complete for merge. Exit code `1` means structural validation failed.

## Weekly workflow

Sunday: review expiring records, verify sources, prepare additions/updates/removals, classify policy questions, resolve media, prepare authentic media where available, and produce one bounded packet.

Monday: apply the approved packet from fresh `main` on a bounded branch; run the media validator; run responsive/link/accessibility QA; obtain exact-SHA independent review; verify the rendered preview; stop for founder/Project 03 merge approval.

## Commercial boundary

This convention does not activate Sponsored Spotlight, does not establish pricing, and does not reclassify records for commercial purposes. Promotional products must use separately approved technical and public-copy requirements.
