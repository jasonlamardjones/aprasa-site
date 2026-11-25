// Event lifecycle expiry — pure planning and gating logic.
//
// Project 04, Tranche A1. This module decides WHICH approved, published,
// finite events have crossed their expiry boundary and what a lifecycle
// transition is allowed to write. It performs no I/O against git, GitHub or
// the network, and it never edits canonical event data: expiry is derived from
// the verified end date, not recorded by changing `publication_state`.
//
// It adds NO currentness rule. Eligibility, expiry and Home-preview membership
// all come from the incumbent resolvers; the bounded write-set, Home-region
// containment, idempotence and no-regression gates are the Phase 2B ones,
// imported unchanged. What is new here is only the authorization source (the
// canonical data and the Cape Verde clock, not a QA artifact) and the stricter
// fail-closed checks a no-human-in-the-loop transition needs.
//
// --- Boundary semantics (PROVISIONAL, pending Project 03) -----------------
//
// A day-precision record is current THROUGH its verified end_date and expires
// at 00:00:00 Atlantic/Cape_Verde on the following day. This is exactly the
// incumbent `end_date < asOf` rule. `end_datetime` is deliberately not
// consulted: using it would remove a card mid-day and make the generator and
// any visitor-side guard instant-based, which is a policy change, not a
// mechanic. Month-precision, open-ended and recurring records never expire
// here; month precision surfaces as REVIEW_DUE for a human, as before.

import { currentnessState, EXPIRED, ISO_DAY_PATTERN } from '../../lib/things-to-do-currentness.mjs';
import {
  assertHomeRegionChangeBounded,
  assertIdempotentChanges,
  assertValidatorResults,
  capeVerdeDate,
  expectedWriteSetForTransition,
  homeRegionAuthorizedIds,
  resolvePreviewTransition,
} from '../../remediation/lib/things-to-do-currentness-remediation.mjs';

import fs from 'node:fs';
import path from 'node:path';

export const LIFECYCLE_MODES = Object.freeze(['dry-run']);
export const CURRENTNESS_FILE = 'data/things-to-do-currentness.json';
export const HOME_SURFACES = Object.freeze(['index.html', 'pt/index.html']);

export function lifecycleError(code, detail) {
  return new Error(detail ? `${code}: ${detail}` : code);
}

// Resolve a path through symlinks even when it does not exist yet, by
// resolving its nearest existing ancestor and re-attaching the remainder.
function resolveThroughExisting(target) {
  const absolute = path.resolve(target);
  const rest = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if (parent === current || error.code !== 'ENOENT') throw error;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

const sameOrInside = (candidate, container) => {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const relative = path.relative(norm(container), norm(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * The controller's output must never land inside the repository it reads, or
 * in a directory that contains it: a dry run must not be able to dirty the
 * tracked tree, and an output directory that is an ancestor of the repository
 * would be written around (or over) it. Symlinks are resolved first so a link
 * cannot smuggle an in-repo location past the check. Returns the resolved path.
 */
export function assertSafeOutputDir(outDir, root) {
  if (typeof outDir !== 'string' || !outDir) throw lifecycleError('LIFECYCLE_UNSAFE_OUTPUT_LOCATION', 'empty output path');
  const realRoot = resolveThroughExisting(root);
  const realOut = resolveThroughExisting(outDir);
  if (sameOrInside(realOut, realRoot)) {
    throw lifecycleError('LIFECYCLE_UNSAFE_OUTPUT_LOCATION', `${outDir} is inside the input repository ${root}`);
  }
  if (sameOrInside(realRoot, realOut)) {
    throw lifecycleError('LIFECYCLE_UNSAFE_OUTPUT_LOCATION', `${outDir} contains the input repository ${root}`);
  }
  return realOut;
}

/**
 * The directory under which temporary output and the staging copy are
 * allocated must not be the repository or inside it. Checked BEFORE any
 * mkdtemp, so a TMPDIR pointing into the repository cannot get a directory
 * created there ahead of the containment check. A base that merely CONTAINS the
 * repository is fine: its children are siblings of the repository, not inside it.
 */
export function assertTempBaseOutsideRepo(base, root) {
  if (typeof base !== 'string' || !base) throw lifecycleError('LIFECYCLE_UNSAFE_OUTPUT_LOCATION', 'empty temporary base');
  if (sameOrInside(resolveThroughExisting(base), resolveThroughExisting(root))) {
    throw lifecycleError('LIFECYCLE_UNSAFE_OUTPUT_LOCATION', `temporary base ${base} is inside the input repository ${root}`);
  }
}

/**
 * An explicit output path must not exist AT ALL — not as a directory, a file, a
 * symlink or a dangling link. lstat does not follow links, so a link standing
 * where the output should be is seen as existing. The caller then creates it
 * with a non-recursive mkdir, which fails if anything appears in between.
 */
export function assertFreshOutputPath(outDir) {
  try {
    fs.lstatSync(outDir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw lifecycleError('LIFECYCLE_OUTPUT_EXISTS', `${outDir} already exists; an explicit --out must not`);
}

/** True only for a real calendar day in YYYY-MM-DD form. */
export function isValidIsoDay(value) {
  if (typeof value !== 'string' || !ISO_DAY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Today's calendar date in Atlantic/Cape_Verde (fixed UTC-01:00, no DST). */
export function capeVerdeToday(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) throw lifecycleError('LIFECYCLE_INVALID_NOW');
  return capeVerdeDate(instant.toISOString());
}

/**
 * The instant a day-precision record expires: 00:00:00 Cape Verde on the day
 * after end_date, as a UTC ISO string. Null when the record has no verified
 * day-precision end (month precision, open-ended, recurring).
 */
export function scheduledExpiryInstant(record) {
  if ((record?.end_precision ?? 'day') !== 'day') return null;
  const end = record?.end_date;
  if (end === undefined || end === null || end === '') return null;
  if (!isValidIsoDay(end)) throw lifecycleError('LIFECYCLE_MALFORMED_END_DATE', `${record?.id}: ${JSON.stringify(end)}`);
  const next = new Date(`${end}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  // 00:00 at UTC-01:00 is 01:00 UTC.
  next.setUTCHours(1, 0, 0, 0);
  return next.toISOString();
}

/** Tracked ledger and clock must both be real days, and the clock must not run backwards. */
export function assertClock({ trackedAsOf, today }) {
  if (!isValidIsoDay(trackedAsOf)) throw lifecycleError('LIFECYCLE_TRACKED_AS_OF_UNREADABLE', JSON.stringify(trackedAsOf));
  if (!isValidIsoDay(today)) throw lifecycleError('LIFECYCLE_TODAY_UNREADABLE', JSON.stringify(today));
  if (today < trackedAsOf) {
    throw lifecycleError('LIFECYCLE_AS_OF_REGRESSION', `tracked ${trackedAsOf} is ahead of ${today}`);
  }
}

/**
 * Plan one lifecycle run. Returns NOOP (nothing crossed; no write of any kind)
 * or DUE with the exact transition and the write set it may produce.
 *
 * Fail-closed refusals: unreadable clock, regression, a malformed end_date on
 * ANY record that carries one, and any record that would cross into EXPIRED
 * without being a published dated-event with a conventional detail route.
 */
export function planLifecycleTransition({ records, trackedAsOf, today }) {
  if (!Array.isArray(records) || !records.length) throw lifecycleError('LIFECYCLE_RECORDS_UNREADABLE');
  assertClock({ trackedAsOf, today });

  // Surface malformed dates everywhere, not only on records that happen to cross.
  for (const record of records) scheduledExpiryInstant(record);

  const transition = resolvePreviewTransition({ records, fromAsOf: trackedAsOf, toAsOf: today });
  const byId = new Map(records.map((record) => [record.id, record]));

  const crossing = records
    .filter((record) => currentnessState(record, trackedAsOf) !== EXPIRED && currentnessState(record, today) === EXPIRED)
    .map((record) => record.id)
    .sort();

  for (const id of crossing) {
    const record = byId.get(id);
    if (record.kind !== 'dated-event') throw lifecycleError('LIFECYCLE_NOT_A_DATED_EVENT', id);
    if (record.publication_state !== 'published') throw lifecycleError('LIFECYCLE_UNPUBLISHED_RECORD_CROSSING', id);
    if (record.detail_page !== `things-to-do/${id}/`) throw lifecycleError('LIFECYCLE_DETAIL_ROUTE_AMBIGUOUS', id);
  }

  // Explicit editorial expiry is not a time transition and is never ours.
  const unexplained = transition.detailRenderingChangedIds.filter((id) => !crossing.includes(id));
  if (unexplained.length) throw lifecycleError('LIFECYCLE_UNEXPLAINED_RENDERING_CHANGE', unexplained.join(', '));

  if (!crossing.length) {
    return Object.freeze({ status: 'NOOP', fromAsOf: trackedAsOf, toAsOf: today, dueIds: [] });
  }

  const allowedWriteSet = expectedWriteSetForTransition({
    driftIds: crossing,
    previewBefore: transition.previewBefore,
    previewAfter: transition.previewAfter,
    detailRenderingChangedIds: transition.detailRenderingChangedIds,
  });
  const homeRegionIds = homeRegionAuthorizedIds({
    driftIds: crossing,
    previewBefore: transition.previewBefore,
    previewAfter: transition.previewAfter,
  });

  return Object.freeze({
    status: 'DUE',
    fromAsOf: trackedAsOf,
    toAsOf: today,
    dueIds: crossing,
    previewBefore: transition.previewBefore,
    previewAfter: transition.previewAfter,
    stateChangedIds: transition.stateChangedIds,
    allowedWriteSet,
    homeRegionIds,
    requiredFiles: [
      CURRENTNESS_FILE,
      ...crossing.flatMap((id) => [`things-to-do/${id}/index.html`, `pt/things-to-do/${id}/index.html`]),
    ].sort(),
  });
}

/**
 * The generated diff must stay inside the transition's allowlist AND must
 * contain what the transition requires: the advanced ledger and both locales'
 * detail page for every due event. Home files are optional here (a due record
 * outside the preview may not move Home) but, when present, are bounded at
 * region level separately.
 */
export function assertLifecycleWriteSet(changedFiles, plan) {
  const actual = [...new Set(changedFiles)].sort();
  if (!actual.length) throw lifecycleError('LIFECYCLE_EMPTY_DIFF');
  const allowed = new Set(plan.allowedWriteSet);
  const unexpected = actual.filter((file) => !allowed.has(file));
  if (unexpected.length) throw lifecycleError('LIFECYCLE_UNEXPECTED_FILE_CHANGE', unexpected.join(', '));
  const missing = plan.requiredFiles.filter((file) => !actual.includes(file));
  if (missing.length) throw lifecycleError('LIFECYCLE_REQUIRED_FILE_UNCHANGED', missing.join(', '));
  return actual;
}

export function assertHomeBounded(homeBefore, homeAfter, plan) {
  for (const file of HOME_SURFACES) {
    assertHomeRegionChangeBounded(homeBefore.get(file), homeAfter.get(file), plan.homeRegionIds, file);
  }
}

export { assertIdempotentChanges };

// validate-things-to-do-currentness.mjs exits 3 (not 1) when the ONLY finding is
// REVIEW_DUE: a month-precision record whose month has begun. That is a human
// reverification prompt, not drift — the record correctly stays public — and it
// persists for the whole month. Phase 2B's assertValidatorResults() treats every
// non-zero exit as failure, which from 1 Nov would block every automatic expiry
// behind an advisory the controller must never act on. So exit 3 is tolerated
// for THAT validator alone, and surfaced in the audit as an advisory. Exit 1
// (real drift) and every other validator's non-zero exit still fail closed.
export const REVIEW_DUE_EXIT = 3;
const CURRENTNESS_STEP = /^scripts\/validate-things-to-do-currentness\.mjs(\s|$)/;

export function assertLifecycleValidatorResults(results) {
  const advisories = [];
  const failed = results.filter((item) => {
    if (item.status === 0) return false;
    if (item.status === REVIEW_DUE_EXIT && CURRENTNESS_STEP.test(item.step)) {
      advisories.push('REVIEW_DUE');
      return false;
    }
    return true;
  });
  if (failed.length) {
    throw lifecycleError(
      'LIFECYCLE_INCUMBENT_VALIDATOR_FAILED',
      failed.map((item) => `${item.step} (exit ${item.status})`).join('; '),
    );
  }
  return [...new Set(advisories)];
}

export function parseMode(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw lifecycleError('LIFECYCLE_MODE_UNREADABLE');
  }
  if (!parsed || typeof parsed.mode !== 'string' || !LIFECYCLE_MODES.includes(parsed.mode)) {
    throw lifecycleError('LIFECYCLE_MODE_NOT_ALLOWED', JSON.stringify(parsed?.mode));
  }
  return parsed.mode;
}

/** Audit record. Carries ids, times, states and hashes only — no source/provenance text. */
export function buildAuditRecord({
  mode, plan, records, now, baseSha, changedFiles = [], fileHashes = {}, validators = [], advisories = [],
}) {
  const stateOf = (record, asOf) => currentnessState(record, asOf);
  const byId = new Map(records.map((record) => [record.id, record]));
  return {
    schema: 'aprasa-event-lifecycle-audit',
    version: 1,
    mode,
    status: plan.status,
    actual_time: now.toISOString(),
    base_sha: baseSha ?? null,
    from_as_of: plan.fromAsOf,
    to_as_of: plan.toAsOf,
    events: plan.dueIds.map((id) => ({
      id,
      scheduled_expiry: scheduledExpiryInstant(byId.get(id)),
      state_before: stateOf(byId.get(id), plan.fromAsOf),
      state_after: stateOf(byId.get(id), plan.toAsOf),
    })),
    home_preview_before: plan.previewBefore ?? [],
    home_preview_after: plan.previewAfter ?? [],
    changed_files: changedFiles,
    file_hashes: fileHashes,
    validators,
    advisories,
    build_sha: null,
    deployment_id: null,
    retries: 0,
    published: false,
  };
}
