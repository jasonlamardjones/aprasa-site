# A PRASA lightweight publishing and media convention

Status: internal technical convention for the current manual publishing workflow.

## Purpose

Keep weekly content refreshes consistent without introducing a CMS or ad platform. This convention supports the authorized Things-to-Do media foundation and preserves Project 03 policy boundaries.

## Things-to-Do media precedence

Every Things-to-Do card renders a media region. Choose media in this order:

1. Organizer/provider artwork supplied directly to A PRASA.
2. Verified provider-owned media from an official or provider-controlled source.
3. Standardized A PRASA editorial fallback.

Never use arbitrary search-result imagery or stock imagery as evidence for a specific event. Never use generated or generic imagery in a way that implies it depicts the actual event or activity.

## Lightweight record fields

For each Things-to-Do record, keep these fields in the weekly publishing packet or code review notes as applicable:

- title
- provider / organizer
- source URL or source reference
- checked date
- media type: `provider-supplied`, `provider-owned`, or `editorial-fallback`
- media source / provenance note
- media checked date
- alt text when authentic event media is used
- expiry / re-check date when relevant

These fields do not require a CMS. They may remain in the bounded weekly publishing packet and the repository change where appropriate.

## Fallback behavior

If a Things-to-Do card has no authentic media, the shared front-end foundation inserts the standardized A PRASA editorial fallback media region. The fallback is intentionally generic, identifies the content area, and carries no alt-text claim about the specific event.

The same fallback is used in the details dialog when the source record has no authentic media.

## Weekly workflow

Sunday: review expiring records, verify sources, prepare additions/updates/removals, classify policy questions, prepare authentic media where available, and produce one bounded packet.

Monday: apply the approved packet from fresh `main` on a bounded branch; run responsive/link/accessibility QA; obtain exact-SHA independent review; verify the rendered preview; stop for founder/Project 03 merge approval.

## Commercial boundary

This convention does not activate Local Spotlight or Sponsored Spotlight, does not reclassify existing records, and does not imply a Sponsored Spotlight price. Later promotional products must use separately approved technical and public-copy requirements.