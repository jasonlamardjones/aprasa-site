---
name: A PRASA
description: An independent digital public square for Cabo Verde — curated opportunities, culture, and community, source-led and calm.
colors:
  forest-green: "#1E3D2E"
  ochre: "#C0872E"
  ochre-text: "#8F5F1C"
  ink: "#111111"
  paper-cream: "#F6F0E2"
  white: "#FFFFFF"
typography:
  display:
    fontFamily: "Libre Baskerville, Georgia, 'Times New Roman', serif"
    fontSize: "clamp(1.3rem, 4.1vw, 1.75rem)"
    fontWeight: 400
    fontStyle: "italic"
    lineHeight: 1.16
  headline:
    fontFamily: "Libre Baskerville, Georgia, 'Times New Roman', serif"
    fontSize: "clamp(1.55rem, 5vw, 2.45rem)"
    fontWeight: 400
    lineHeight: 1.18
  title:
    fontFamily: "Work Sans, 'Segoe UI', Arial, sans-serif"
    fontSize: "1.08rem"
    fontWeight: 500
    lineHeight: 1.28
  body:
    fontFamily: "Work Sans, 'Segoe UI', Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Work Sans, 'Segoe UI', Arial, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 400
    letterSpacing: "0.11em"
rounded:
  card: "10px"
  dialog: "12px"
  dialog-media: "6px"
  pill: "999px"
components:
  resource-card:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "1rem"
  details-button:
    backgroundColor: "{colors.white}"
    textColor: "{colors.forest-green}"
    rounded: "{rounded.pill}"
    padding: "0.5rem 0.8rem"
  primary-cta:
    backgroundColor: "{colors.forest-green}"
    textColor: "{colors.white}"
    rounded: "{rounded.pill}"
    padding: "0.55rem 0.9rem"
  action-tag:
    backgroundColor: "rgba(30,61,46,.035)"
    textColor: "{colors.forest-green}"
    rounded: "{rounded.pill}"
    padding: "0.25rem 0.55rem"
  details-dialog:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
  site-footer:
    backgroundColor: "{colors.forest-green}"
    textColor: "{colors.paper-cream}"
---

<!-- Documented from branch feature/aug14-home-meaning-submission-about at commit f1ee9df66b641b34b2bbaa8c1e67a32d5bf98129 (PR #24 candidate) — not from main. Re-run /impeccable document once this candidate is promoted, to confirm it still matches what ships. -->

# Design System: A PRASA

## Overview

**Creative North Star: "The Editorial Praça"**

A PRASA reads like a civic notice-board crossed with a broadsheet: calm authority, structured columns, and a form of restraint that is disciplined rather than empty. It is not a flat, ornament-free system — it uses real photography, functional gradients, compact pill-shaped actions, and one genuine floating dialog — but every one of those devices is used for a specific, load-bearing reason, never as decoration for its own sake. The system is built to be read, trusted, and acted on, not to perform excitement.

The pairing of a serif display face (Libre Baskerville, reserved for h1/h2) against a plain, humanist sans (Work Sans, everything else including h3) signals editorial authorship rather than a template. Deep forest green carries the institutional, trustworthy weight of the system; ochre appears as a restrained accent in exactly two current roles (a kicker underline mark, and the submission-note callout), with a separate, deliberately darker `ochre-text` token reserved for inline word-level emphasis where the full `--ochre` would not hold enough contrast as text. Real environmental and place photography — illustrated Mindelo praça scenes, event posters, a provider map — carries the system's imagery language; it is bounded into specific editorial roles (hero, section dividers, card thumbnails, dialog media) and always feathered into the cream page via functional edge gradients, never treated as decorative hero marketing imagery. The anti-references are stock-travel-blog/influencer photography, government-portal coldness, dark/neon tech-dashboard styling, decorative SaaS gradients or oversized pill buttons, icon clutter, and gratuitous motion — not photography, gradients, or pills themselves, all three of which the system already uses with intent.

**Key Characteristics:**
- Flat at rest, with real elevation reserved for the one genuine floating component (the details dialog)
- Serif headlines (Libre Baskerville) for h1/h2 only; Work Sans for everything else, including h3
- Ochre used in two restrained roles today; `ochre-text` reserved for inline text emphasis, distinct from decorative `ochre`
- Real environmental/place and provider photography, always in a bounded editorial role, feathered into cream via functional gradients
- Compact pill shapes (999px) for actions, tags, and the dialog close control — interactive pills at 44px touch targets, non-interactive tags at their incumbent 30px minimum height
- Quietly confident and warm: understated enough to be trusted, warm enough not to read as bureaucratic

## Colors

The palette is small and deliberate: one deep, grounded primary; a two-role ochre accent system; ink, cream, and white doing the structural work.

### Primary
- **Deep Forest Green** (`#1E3D2E`): headlines, links, kicker labels, `card-status` text, the footer surface, focus outlines, button/card borders, and hairline dividers (used at low opacity, e.g. `rgba(30,61,46,.14–.32)`). Grounded, trustworthy, institutional-but-warm.

### Secondary
- **Sun-Baked Ochre** (`#C0872E`): the system's decorative accent. Decorative ochre is currently used in two restrained roles — the 2px underline rule beneath `.preview-label`/`.section-kicker`, and the left border + faint background tint (`rgba(192,135,46,.08)`) on `.submission-note` — not as a button fill, icon color, or general-purpose background.
- **Ochre Text** (`#8F5F1C`): a separately-tuned, darker value used only for inline word-level emphasis in running copy (currently the `moves` accent word in the hero closing line), where the lighter decorative `--ochre` would not carry enough contrast as text. Distinct token, distinct purpose — never used interchangeably with `--ochre`.

### Neutral
- **Paper Cream** (`#F6F0E2`): page background — the "paper" the praça is printed on, and the color every image-edge gradient fades toward.
- **Ink** (`#111111`): body text and dialog backdrop tint (`rgba(17,17,17,.52)`).
- **White** (`#FFFFFF`): card, dialog, and skip-link surfaces, set against cream to read as a distinct layer.

### Named Rules
**The Two-Role Ochre Rule.** Decorative `--ochre` and text-safe `--ochre-text` are not interchangeable — decorative ochre marks a section-kicker or a callout; ochre-text marks a single emphasized word in prose. A new decorative use should map to one of these two documented roles, or be justified with the same restraint that governs the existing ones — not treated as free real estate for a third use.

**The Rare Accent Rule.** Forest Green carries headlines, links, and structural borders but should never fill more than a small minority of any given screen's area (the footer band is the deliberate exception). Cream and white carry the page.

## Typography

**Serif (headline) Font:** Libre Baskerville (with Georgia, "Times New Roman", serif fallback)
**Sans (body/UI) Font:** Work Sans (with Segoe UI, Arial, sans-serif fallback)

**Character:** A civic-broadsheet serif reserved for the two elements that speak with the most authority — the hero tagline (h1) and section titles (h2) — paired with a plain, legible sans for everything else, including card/resource titles (h3). The serif is a voice, not a general heading treatment; h3 and below stay in Work Sans.

### Hierarchy
- **Hero tagline / h1** (400, `clamp(1.3rem, 4.1vw, 1.75rem)`, italic, 1.16 line-height, Forest Green): the single page h1 (`.hero-tagline`), the system's most editorial line of type.
- **Headline / h2** (400, `clamp(1.55rem, 5vw, 2.45rem)`, 1.18 line-height, Forest Green): section titles ("Things to Do," "Why A PRASA exists," etc.).
- **Title / h3** (500, `1.08rem`, 1.28 line-height, Forest Green, Work Sans — not serif): card and resource titles.
- **Body** (400, `1rem`, 1.55 line-height): running copy.
- **Label** (400, `0.72rem`, uppercase, 0.11em tracking, Forest Green): kickers, provider names, preview label.
- **Card status** (700, `0.82rem`, Forest Green): a bolder label variant used for dates/status lines above card titles — same family and color as Label, heavier weight.
- **Checked** (400, `0.76rem`, Forest Green): the smallest running label, used for source-verification lines.

### Named Rules
**The Serif-For-Voice Rule.** Only the hero tagline (h1) and section headlines (h2) use Libre Baskerville. Every other text element — h3, labels, metadata, body, links, buttons — stays in Work Sans. This is a deliberate, load-bearing distinction confirmed in the code, not an inference: do not extend the serif to h3 or component labels.

## Layout

Content container: `width: min(100% - 2rem, 72rem)`, widening to `min(100% - 3rem, 72rem)` at ≥44rem, centered via `margin-inline: auto`.

The hero (`opening-grid`) is single-column on mobile with a full-bleed edge-to-edge photo; at ≥44rem it becomes a two-column grid (`minmax(0,26rem) 1fr`), widening to `minmax(0,36rem) 1fr` at ≥64rem, with the hero photo occupying the second column and spanning both grid rows. Section dividers between shelves use a full-width photographic strip (`.env-orientation`, 12.5rem tall on mobile, growing to 21rem at ≥44rem and 25rem at ≥64rem) rather than a plain rule.

Resource grids are responsive: `resource-grid`/`things-grid` go to 2 columns at ≥44rem; `training-grid` goes to 3 columns at ≥44rem; `things-grid`/`help-grid` go to 4 columns at ≥64rem. The About section splits into an asymmetric two-column grid (`.95fr`/`1.05fr`) at ≥44rem. Dedicated media-query branches also adjust the hero and narrative background for short-height landscape viewports (mobile landscape, small-tablet landscape), which is a real, deliberate responsive concern in this codebase, not an edge case to ignore.

## Elevation & Depth

The system is flat by default: sections, cards, and dividers are separated by hairline borders and background-color shifts, not shadows. `resource-card` carries one near-invisible exception — `box-shadow: 0 1px 0 rgba(30,61,46,.03)` — which reads as a hairline definition rather than true elevation.

Real elevation is reserved for the one genuine floating component: the native `<dialog class="details-dialog">`, which carries `box-shadow: 0 1.4rem 4rem rgba(17,17,17,.24)` and a blurred backdrop (`::backdrop { background: rgba(17,17,17,.52); backdrop-filter: blur(4px); }`). This is a real, intentional exception to flatness, not an inconsistency.

### Named Rules
**Flat at Rest, Elevated When Floating.** Ordinary structure (cards, sections, dividers) relies on borders and background shifts. Shadow and backdrop blur are reserved for components that genuinely float above the page — currently only the details dialog. A new overlay/modal component may use a comparable restrained shadow; an at-rest component should not.

## Shapes

Two families of corner language coexist deliberately: a **card radius** (`10px`, on `.resource-card`, `.card-media`, `.home-map-preview`; `6px` — `var(--radius) - 4px` — on `.dialog-media`; `12px` on the dialog itself) for containers, and a **pill radius** (`999px`) for compact actions — `.details-button`, `.primary-cta`, `.action-tags span` (tag chips), and `.dialog-close` (the circular close control).

Pill sizing distinguishes interactive from non-interactive use: interactive pill controls (`.details-button`, `.primary-cta`, `.dialog-close`) preserve a 44px minimum touch target with modest padding (e.g. `.5rem .8rem`); non-interactive metadata (`.action-tags span`) retains the incumbent compact 30px minimum-height treatment. Neither uses the oversized SaaS pill-button padding/height common in generic dashboards. Borders throughout are hairline (`1px`) and a low-opacity tint of Forest Green, never pure black or saturated.

## Components

Everything should feel quietly confident and warm: understated enough to be trusted, warm enough (via the serif tagline/headlines and the two-role ochre accent) not to read as cold or bureaucratic.

### Links & Buttons
- **Text link (`resource-link`):** Forest Green, `text-underline-offset: .18em`, `text-decoration-thickness: .08em` (thickens to `.13em` on hover), paired with an `↗` glyph, `aria-hidden`.
- **Secondary pill (`details-button`):** white background, Forest Green border and text, `999px` radius, `.5–.8rem` padding, 44px touch target; opens the details dialog.
- **Primary pill (`primary-cta`):** Forest Green background, white text, `999px` radius, 44px touch target, underline on hover; currently used once, for "Explore Mindelo Essentials."
- **Focus:** `outline: 3px solid` Forest Green, `outline-offset: 3px`, `border-radius: 4px` on links/buttons/`[tabindex]` — always visible, never suppressed.

### Tags / Action Chips (`action-tags`)
- **Style:** pill (`999px`), hairline Forest-Green border (`rgba(30,61,46,.32)`), faint Forest-Green-tinted background (`rgba(30,61,46,.035)`), `.75rem` bold uppercase-weight text, 30px minimum height — the non-interactive counterpart to the 44px interactive pills above.
- **Use:** compact metadata (Free, Online, São Vicente, Certificate of Completion, etc.) at the top of a card, restrained rather than colorful/varied per tag.

### Cards / Containers (`resource-card`)
- **Corner Style:** 10px radius.
- **Background:** White, on the cream page.
- **Shadow:** near-invisible hairline shadow only (see Elevation & Depth) — not true elevation.
- **Border:** 1px solid Forest Green at ~18% opacity.
- **Media (`card-media`):** optional top-bled image (negative margin trick), 4:3 aspect ratio, matching the card's top corners; used for event posters, not for every card.
- **Behavior:** flex column so `card-actions` pins to the bottom regardless of copy length.

### Dialog (`details-dialog`)
- Native `<dialog>` opened via `showModal()`; `12px` radius, real box-shadow, blurred backdrop.
- Closes on the close-button, Escape (native), or a click on the backdrop outside the dialog's bounding box.
- On close, scroll position and focus (to the triggering button) are restored — a real accessibility behavior implemented in `prasa-launch.js`, not incidental.
- Internal content (`dialog-record`) reuses the same typography/label system as cards (h2 for the record title, h3 sub-headings at `1rem`/700 weight, `detail-list` as a two-column `dl` at ≥44rem).

### Imagery
- **Hero (`hero-visual`):** full-bleed illustrated praça scene on mobile; on desktop, occupies the grid's photo column with a left-edge `mask-image` blend into the layout (not a crop or filter effect — a functional edge treatment).
- **Section dividers (`env-orientation` figures):** one full-width photographic strip per shelf ("Things to Do," "Trainings," "Ways to Help," "Mindelo Essentials"), each with its own `object-position` tuned per scene, edge-feathered into cream via `.image-fade::before/::after` linear-gradient overlays — functional cropping/blending, not decorative surface gradients.
- **Card/dialog media:** real event posters and provider images (`assets/events/`), shown at native aspect ratio.
- **Map preview:** an attributed OpenStreetMap/Leaflet static render (`assets/mindelo/`), explicitly captioned as example points only, not the canonical directory.
- **"Why A PRASA exists" background:** a distinct, deliberate one-off treatment — a low-opacity (`.68`) illustrated aerial sketch as a `background-image` layer behind the narrative copy, vignetted back to cream via a `radial-gradient`. This reads as atmosphere behind text, not a discrete photograph, and is not a pattern to replicate on other sections without the same reasoning.

### Navigation & Identity
- **Header/footer nav:** plain text links (`site-nav`, `page-nav`), 44px minimum height, no serif, no pills.
- **Wordmark/identity assets:** the "A PRASA Identity v2.0" system — `Symbol`, `Wordmark`, and `Lockup` (Horizontal and Stacked), each shipped as fixed Primary-Green and Reversed-Cream SVGs under `assets/brand/`. These are locked brand artwork, used verbatim in the header, hero, and footer. They are a separate system from page typography (Libre Baskerville/Work Sans) and must never be approximated or redrawn with CSS text — the SVG is the only correct source.

## Do's and Don'ts

### Do:
- **Do** reserve Libre Baskerville for the hero tagline (h1) and section headlines (h2) only; keep h3 and everything else in Work Sans.
- **Do** treat decorative `--ochre` and text-safe `--ochre-text` as distinct tokens with distinct roles; don't use one where the other's role is meant.
- **Do** size interactive pill controls (buttons, close icon) to a 44px touch target, and non-interactive tags to their incumbent 30px minimum height — never the oversized SaaS pill-button treatment for either.
- **Do** keep gradients functional — edge fades and vignettes that blend photography into the cream page — never a decorative surface gradient.
- **Do** keep elevation flat at rest; reserve real shadow + backdrop blur for genuine floating overlays like the details dialog.
- **Do** use real environmental/place and provider photography, bounded to a specific editorial role (hero, divider, card, dialog, map).
- **Do** restore focus and scroll position when a dialog closes, and support Escape and backdrop-click dismissal, as the current implementation does.

### Don't:
- **Don't** reach for stock-travel-blog or influencer-style photography — the imagery language is illustrated/environmental and provider-sourced, not marketing hero shots.
- **Don't** let the civic/editorial framing tip into government-portal coldness.
- **Don't** adopt dark-mode or neon tech-dashboard styling.
- **Don't** add decorative icon clutter or gratuitous motion.
- **Don't** invent a spacing token scale or a serif treatment for h3 — neither exists in the current implementation.
- **Don't** treat the "Why A PRASA" aerial-sketch background as a general section pattern; it is a one-off atmospheric treatment for that section specifically.
