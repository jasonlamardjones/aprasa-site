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
