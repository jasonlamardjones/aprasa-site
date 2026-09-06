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
import { types } from 'node:util';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

function describe(value, key, at, options = {}) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error(`unreadable property descriptor ${String(key)} at ${at}`);
  }
  if (descriptor === undefined) throw new Error(`unreadable property descriptor ${String(key)} at ${at}`);
  if (!Object.hasOwn(descriptor, 'value')) throw new Error(`accessor property ${String(key)} at ${at}`);
  if (descriptor.enumerable !== true && options.allowNonEnumerable !== true) {
    throw new Error(`non-enumerable own property ${String(key)} at ${at}`);
  }
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

// Single-read admission boundary.
//
// Descriptor inspection alone is not sufficient against a hostile view: a Proxy
// may answer ownKeys, getOwnPropertyDescriptor and get differently on each
// call, so validating a property and then reading it again through value[key]
// leaves a time-of-check/time-of-use split in which the digested state and the
// evaluated state differ. admitSnapshot closes that split. Every own key is
// enumerated once, every descriptor is taken once, and the value used is the
// one carried in that descriptor -- there is no second read, and no `get` trap
// is ever consulted. The result is a fresh, deeply frozen, plain-data tree that
// no longer references the original object, so identity and semantics are
// necessarily computed from the same state.
function admitSnapshotValue(value, at, seen) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${at}`);
    return value;
  }
  if (type !== 'object') throw new Error(`unsupported value type ${type} at ${at}`);
  // A Proxy is a view, not data. Its traps may answer differently on every
  // consultation, so even a single-read traversal is reading something that was
  // never a fixed document. Candidate input has no legitimate reason to be an
  // exotic object, so a view is refused before any trap beyond this check runs.
  if (types.isProxy(value)) throw new Error(`exotic object view at ${at}`);
  if (seen.has(value)) throw new Error(`cyclic reference at ${at}`);
  seen.add(value);

  let snapshot;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`tampered array prototype at ${at}`);
    // ownKeys and each descriptor are consulted exactly once. length is read
    // from its own descriptor rather than through value.length, so a get trap
    // cannot report one length here and another one later.
    const keys = ownKeysOnce(value, at);
    const lengthDescriptor = describe(value, 'length', at, { allowNonEnumerable: true });
    const length = lengthDescriptor.value;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
      throw new Error(`malformed array length at ${at}`);
    }
    const items = new Array(length);
    const filled = new Set();
    for (const key of keys) {
      if (key === 'length') continue;
      if (DANGEROUS_KEYS.has(key)) throw new Error(`unsafe object key ${key} at ${at}`);
      if (!ARRAY_INDEX.test(key)) throw new Error(`unsupported own array property ${key} at ${at}`);
      const index = Number(key);
      if (index >= length) throw new Error(`out-of-range own array property ${key} at ${at}`);
      if (filled.has(index)) throw new Error(`duplicated own array property ${key} at ${at}`);
      filled.add(index);
      const descriptor = describe(value, key, at);
      items[index] = admitSnapshotValue(descriptor.value, `${at}[${index}]`, seen);
    }
    if (filled.size !== length) throw new Error(`sparse array at ${at}`);
    snapshot = items;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`tampered object prototype at ${at}`);
    const keys = ownKeysOnce(value, at);
    snapshot = {};
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`unsafe object key ${key} at ${at}`);
      const descriptor = describe(value, key, at);
      snapshot[key] = admitSnapshotValue(descriptor.value, `${at}.${key}`, seen);
    }
  }

  seen.delete(value);
  return Object.freeze(snapshot);
}

// Reflect.ownKeys is consulted once and the returned list is copied, so a Proxy
// cannot answer a later enumeration differently. Symbol keys are refused here
// rather than silently dropped.
function ownKeysOnce(value, at) {
  let keys;
  try {
    keys = [...Reflect.ownKeys(value)];
  } catch {
    throw new Error(`unreadable own keys at ${at}`);
  }
  for (const key of keys) {
    if (typeof key === 'symbol') throw new Error(`symbol own property at ${at}`);
  }
  return keys;
}

export function admitSnapshot(value, at = '$') {
  return admitSnapshotValue(value, at, new Set());
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
