// Canonical JSON serialization and digesting for Things-to-Do adjudication.
//
// Object key order must never alter semantic evaluation or content integrity.
// Arrays are order-significant; objects are not. Non-finite numbers, sparse
// arrays, accessors, tampered prototypes and prototype-polluting keys are
// rejected rather than silently normalized or coerced.
//
// Every inspection here is descriptor-based. Reflect.ownKeys sees the symbol
// and non-enumerable own keys that Object.keys hides, and reading a property
// descriptor never invokes a getter, so a hostile candidate can neither smuggle
// a key past the traversal nor run code during it.

import { createHash } from 'node:crypto';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

function describe(value, key, at) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error(`unreadable property descriptor ${String(key)} at ${at}`);
  }
  if (descriptor === undefined) throw new Error(`unreadable property descriptor ${String(key)} at ${at}`);
  if (!Object.hasOwn(descriptor, 'value')) throw new Error(`accessor property ${String(key)} at ${at}`);
  if (descriptor.enumerable !== true) throw new Error(`non-enumerable own property ${String(key)} at ${at}`);
  return descriptor;
}

// All own string keys of a plain object, dangerous keys refused whether or not
// they are enumerable. Symbols are refused outright: they carry no JSON meaning
// and must never be silently dropped from an audited structure.
function ownDataKeys(value, at) {
  const keys = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new Error(`symbol own property at ${at}`);
    if (DANGEROUS_KEYS.has(key)) throw new Error(`unsafe object key ${key} at ${at}`);
    describe(value, key, at);
    keys.push(key);
  }
  return keys;
}

function assertPlainObject(value, at) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`tampered object prototype at ${at}`);
}

// An admitted array is a real, untampered, dense Array carrying nothing but its
// own indexed elements. Holes are the bypass vector: .some(), .filter() and
// .every() all skip them, so an array of holes can pass a per-element check
// that never runs, and length alone can never stand in for a present element.
function assertDenseArray(value, at) {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`tampered array prototype at ${at}`);
  let indexed = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new Error(`symbol own property at ${at}`);
    if (key === 'length') continue;
    if (DANGEROUS_KEYS.has(key)) throw new Error(`unsafe object key ${key} at ${at}`);
    if (!ARRAY_INDEX.test(key)) throw new Error(`unsupported own array property ${key} at ${at}`);
    describe(value, key, at);
    indexed += 1;
  }
  if (indexed !== value.length) throw new Error(`sparse array at ${at}`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) throw new Error(`sparse array at ${at}`);
  }
}

// The single admission contract for anything that may enter the audited tree:
// plain JSON-compatible objects, dense arrays, finite numbers, strings,
// booleans and null. undefined, functions, symbols, bigints, accessors,
// non-enumerable own properties, tampered prototypes and dangerous own keys are
// all refused, at any depth.
export function assertAdmissibleStructure(value, at = '$') {
  if (value === null) return;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${at}`);
    return;
  }
  if (type !== 'object') throw new Error(`unsupported value type ${type} at ${at}`);
  if (Array.isArray(value)) {
    assertDenseArray(value, at);
    for (let index = 0; index < value.length; index += 1) assertAdmissibleStructure(value[index], `${at}[${index}]`);
    return;
  }
  assertPlainObject(value, at);
  for (const key of ownDataKeys(value, at)) assertAdmissibleStructure(value[key], `${at}.${key}`);
}

// Retained name for the gates that refuse hostile input before it is used.
// Both pollution vectors remain refused: a dangerous own key (what JSON.parse
// of hostile input produces, enumerable or not) and a tampered prototype (what
// merging that input in with Object.assign produces, where the key disappears
// from Object.keys but the inherited properties remain readable).
export const assertNoDangerousKeys = assertAdmissibleStructure;

// Canonical serialization validates as it emits. It never depends on an earlier
// normalization pass having rejected a tampered structure, and it never coerces
// one into valid-looking JSON: a sparse array must not become "[,]", a changed
// prototype must not become "{}", and an accessor must not be invoked.
export function canonicalize(value, at = '$') {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${at}`);
    return JSON.stringify(value);
  }
  if (type === 'string') return JSON.stringify(value);
  if (type !== 'object') throw new Error(`unsupported value type ${type} at ${at}`);
  if (Array.isArray(value)) {
    assertDenseArray(value, at);
    const items = [];
    for (let index = 0; index < value.length; index += 1) items.push(canonicalize(value[index], `${at}[${index}]`));
    return `[${items.join(',')}]`;
  }
  assertPlainObject(value, at);
  const parts = [];
  for (const key of ownDataKeys(value, at).sort()) {
    parts.push(`${JSON.stringify(key)}:${canonicalize(value[key], `${at}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
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

// Bounded array-integrity helper. Reusable wherever a security- or
// authority-relevant list is read, so no call site has to remember that array
// methods skip holes.
export function isAdmissibleDenseArray(value) {
  if (!Array.isArray(value)) return false;
  try {
    assertDenseArray(value, '$');
  } catch {
    return false;
  }
  return true;
}

// A dense list of non-empty string identifiers, or null. Returning null rather
// than a filtered list keeps malformed provenance from being normalized into a
// shorter but apparently valid reference set.
export function denseStringList(value) {
  if (!isAdmissibleDenseArray(value)) return null;
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || item.length === 0) return null;
    items.push(item);
  }
  return items;
}

// Bounded identity extraction for the failure path. Never invokes an accessor,
// never traverses a prototype chain, and tolerates a malformed or unreadable
// descriptor. Used where attacker-controlled input must be read after an
// unexpected exception has already been raised by it.
export function readOwnDataProperty(target, key) {
  if (target === null || typeof target !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}
