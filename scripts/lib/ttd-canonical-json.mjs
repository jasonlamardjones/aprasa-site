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

// --- Container admission boundary -------------------------------------------
//
// admitSnapshot admits a whole DOCUMENT: it copies a deep tree of plain data.
// That is the right boundary for evidence and for the registry, but it is the
// wrong one for a CALL: an invocation object legitimately carries large trusted
// in-process values (the policy, the trust anchor, the routing vocabulary)
// whose own admission already happened where they were loaded and pinned.
//
// admitDataContainer is the boundary for those: it admits the container itself,
// once, and hands back the values it carried. What it guarantees is exactly
// what the pre-admission descriptor reads it replaces could not:
//
//   * no caller code runs. An exotic view is refused BEFORE any operation that
//     could trigger a trap, so a getOwnPropertyDescriptor, ownKeys or get trap
//     never executes -- and therefore can never mutate process-local state
//     between one read and the next.
//   * every own key is enumerated once and every descriptor is taken once, so
//     the container cannot answer differently on a later consultation.
//   * an accessor, a setter, a non-enumerable own property, a symbol key, a
//     dangerous key, a tampered prototype or (when an allowlist is given) an
//     unexpected key fails the whole admission. None of them is read, and none
//     is silently ignored.
//
// The result is a Map of PRESENT entries. Absence is represented by the key
// simply not being in the map, which is what makes ABSENT distinguishable from
// PRESENT-but-invalid: an invalid descriptor never becomes an absent entry,
// it fails the admission outright.
export const ABSENT_ENTRY = Object.freeze({ present: false, value: undefined });

export function isExoticView(value) {
  return value !== null && typeof value === 'object' && types.isProxy(value);
}

// Refuses an exotic view wherever one has no legitimate reason to appear.
export function assertNotExoticView(value, at) {
  if (isExoticView(value)) throw new Error(`exotic object view at ${at}`);
}

export function admitDataContainer(target, at = '$', { allowedKeys = null } = {}) {
  if (target === null || typeof target !== 'object') {
    throw new Error(`non-object container at ${at}`);
  }
  if (Array.isArray(target)) throw new Error(`array container at ${at}`);
  // FIRST, before Object.getPrototypeOf, Reflect.ownKeys or any descriptor
  // read. Each of those is a trap on a Proxy, so the order here is the whole
  // point: the view is refused before it can run anything.
  assertNotExoticView(target, at);

  const prototype = Object.getPrototypeOf(target);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`tampered object prototype at ${at}`);
  }

  const keys = ownKeysOnce(target, at);
  const entries = new Map();
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) throw new Error(`unsafe object key ${key} at ${at}`);
    if (allowedKeys !== null && !allowedKeys.includes(key)) {
      throw new Error(`unsupported own property ${key} at ${at}`);
    }
    // describe() refuses an accessor, a setter-only property, a non-enumerable
    // own property and an unreadable descriptor. Any of those fails the
    // container rather than being read or collapsed into absence.
    const descriptor = describe(target, key, at);
    entries.set(key, Object.freeze({ present: true, value: descriptor.value }));
  }
  return entries;
}

// The tagged read. Three states, never one `undefined` standing for several:
//   { present: false }                 the property is ABSENT
//   { present: true, value }           the property is PRESENT and valid
//   (no entry is ever produced)        PRESENT-but-invalid; admitDataContainer
//                                      already refused the whole container
export function containerEntry(entries, key) {
  const entry = entries.get(key);
  return entry === undefined ? ABSENT_ENTRY : entry;
}

// Bounded identity extraction from an ALREADY STRUCTURALLY ADMITTED container.
//
// This is the only identity read the failure path is allowed to make, and it is
// deliberately not a general property read: the container must be a real,
// non-exotic, untampered plain object, and the property must be an enumerable
// own DATA property holding a non-empty string. Every other shape -- an
// accessor, a setter, a non-enumerable property, a hostile view, a tampered
// prototype, an unreadable descriptor, a non-string value -- yields null, the
// fixed safe fallback identity. No caller code can run, so an audit record can
// never be the reason a hostile getter executed.
export function readAdmittedIdentity(container, key) {
  if (container === null || typeof container !== 'object' || Array.isArray(container)) return null;
  if (isExoticView(container)) return null;
  const prototype = Object.getPrototypeOf(container);
  if (prototype !== Object.prototype && prototype !== null) return null;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(container, key);
  } catch {
    return null;
  }
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null;
  if (descriptor.enumerable !== true) return null;
  const value = descriptor.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// readOwnDataProperty used to live here: a bounded single-property read that
// returned `undefined` for an absent property, for an accessor, and for an
// unreadable descriptor alike. It is deliberately gone rather than merely
// unused. Both repaired findings came from it: reading the invocation field by
// field with it ran a hostile view's traps before any validation, and its one
// `undefined` return silently rewrote a present-but-invalid control property
// into an omitted one. Anything that needs a property off externally supplied
// data now goes through admitDataContainer (which admits the container once and
// fails closed) or readAdmittedIdentity (which reads one identity and can only
// ever return a string or the fixed safe fallback).
