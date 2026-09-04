// Canonical JSON serialization and digesting for Things-to-Do adjudication.
//
// Object key order must never alter semantic evaluation or content integrity.
// Arrays are order-significant; objects are not. Non-finite numbers and
// prototype-polluting keys are rejected rather than silently normalized.

import { createHash } from 'node:crypto';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Rejects both pollution vectors: a dangerous own key (what JSON.parse of
// hostile input produces) and a tampered prototype (what merging that input
// into an object with Object.assign produces, where the key disappears from
// Object.keys but the inherited properties remain readable).
export function assertNoDangerousKeys(value, at = '$') {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`tampered array prototype at ${at}`);
    value.forEach((item, index) => assertNoDangerousKeys(item, `${at}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`tampered object prototype at ${at}`);
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) throw new Error(`unsafe object key ${key} at ${at}`);
    assertNoDangerousKeys(value[key], `${at}.${key}`);
  }
}

export function canonicalize(value, at = '$') {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${at}`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${at}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`unsafe object key ${key} at ${at}`);
      if (value[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalize(value[key], `${at}.${key}`)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new Error(`unsupported value type ${typeof value} at ${at}`);
}

export function digest(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

export function deepEqual(left, right) {
  return canonicalize(left) === canonicalize(right);
}

export function emptyMap() {
  return Object.create(null);
}
