// Shared fact-key derivation for Things-to-Do event records, used by both
// scripts/generate-things-to-do.mjs (to look up the governed presentation
// for a fact) and scripts/validate-pt-home-events.mjs (to independently
// re-derive the same expected values for regression checking). Extracted
// here specifically so the validator can't drift from the generator's own
// logic — duplicating this in two places was exactly the kind of gap that
// let a generated-content regression slip past validation before.

import { hasKey } from './locale.mjs';

export function slugifyFactLabel(label) {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function factKeyBase(recordId, fact) {
  const stripped = slugifyFactLabel(fact.label.replace(/\([^)]*\)/g, ''));
  const full = slugifyFactLabel(fact.label);
  for (const candidate of [stripped, full]) {
    if (hasKey(`event.${recordId}.detail.fact.${candidate}.label`)) return candidate;
  }
  throw new Error(`${recordId}: no governed locale key found for fact label "${fact.label}"`);
}

// Paragraph structure of a governed detail body, shared by
// scripts/generate-things-to-do.mjs (which renders it) and
// scripts/validate-pt-home-events.mjs (which independently re-derives the
// expected PT strings to look for), for the same anti-drift reason the fact
// keys above live here.
//
// A BLANK LINE is the paragraph separator, and the only one. A single newline
// inside a body is NOT a paragraph break: governed copy may wrap a line
// without intending a new paragraph, and silently promoting that to a <p>
// would change approved presentation without approval.
//
// A body with no blank line returns THE ORIGINAL STRING, unmodified and
// untrimmed, in a one-element array. That is deliberate: every incumbent
// event body is single-paragraph, so this guarantees their rendered output is
// byte-identical to what it was before paragraph support existed — the
// multi-paragraph path cannot reach them at all.
export function bodyParagraphs(body) {
  const text = body ?? '';
  if (!/\n\s*\n/.test(text)) return [text];
  return text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}
