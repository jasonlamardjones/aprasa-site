import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertClock,
  assertLifecycleValidatorResults,
  assertLifecycleWriteSet,
  assertFreshOutputPath,
  assertSafeOutputDir,
  assertTempBaseOutsideRepo,
  buildAuditRecord,
  capeVerdeToday,
  isValidIsoDay,
  parseMode,
  planLifecycleTransition,
  scheduledExpiryInstant,
} from './lib/event-expiry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = path.join(root, 'scripts', 'lifecycle', 'run-event-expiry.mjs');

// ---------------------------------------------------------------- clock ----
assert.equal(isValidIsoDay('2028-02-29'), true);
assert.equal(isValidIsoDay('2027-02-29'), false);
assert.equal(isValidIsoDay('2026-02-30'), false);
assert.equal(isValidIsoDay('2026-13-01'), false);
assert.equal(isValidIsoDay('2026-1-1'), false);
assert.equal(isValidIsoDay(null), false);

// Midnight boundary in Atlantic/Cape_Verde (UTC-01:00): 00:00 local is 01:00Z.
assert.equal(capeVerdeToday(new Date('2026-11-16T00:59:59Z')), '2026-11-15');
assert.equal(capeVerdeToday(new Date('2026-11-16T01:00:00Z')), '2026-11-16');
assert.equal(capeVerdeToday(new Date('2027-01-01T00:59:59Z')), '2026-12-31'); // year rollover
assert.equal(capeVerdeToday(new Date('2027-01-01T01:00:00Z')), '2027-01-01');
assert.equal(capeVerdeToday(new Date('2028-03-01T00:59:59Z')), '2028-02-29'); // leap day
assert.equal(capeVerdeToday(new Date('2028-03-01T01:00:00Z')), '2028-03-01');
assert.throws(() => capeVerdeToday(new Date('nope')), /LIFECYCLE_INVALID_NOW/);

assert.equal(scheduledExpiryInstant({ id: 'a', end_date: '2026-11-15' }), '2026-11-16T01:00:00.000Z');
assert.equal(scheduledExpiryInstant({ id: 'a', end_date: '2026-12-31' }), '2027-01-01T01:00:00.000Z');
assert.equal(scheduledExpiryInstant({ id: 'a', end_date: '2028-02-29' }), '2028-03-01T01:00:00.000Z');
assert.equal(scheduledExpiryInstant({ id: 'a', end_precision: 'month', end_month: '2026-11', end_date: null }), null);
assert.equal(scheduledExpiryInstant({ id: 'a' }), null);
assert.equal(scheduledExpiryInstant({ id: 'a', end_date: '' }), null);
// end_datetime is provisionally NOT consulted (day-based incumbent semantics).
assert.equal(
  scheduledExpiryInstant({ id: 'a', end_date: '2026-08-29', end_datetime: '2026-08-29T12:00:00-01:00' }),
  '2026-08-30T01:00:00.000Z',
);
assert.throws(() => scheduledExpiryInstant({ id: 'a', end_date: '2026-02-30' }), /LIFECYCLE_MALFORMED_END_DATE/);
assert.throws(() => scheduledExpiryInstant({ id: 'a', end_date: 'soon' }), /LIFECYCLE_MALFORMED_END_DATE/);

assert.doesNotThrow(() => assertClock({ trackedAsOf: '2026-10-12', today: '2026-10-12' }));
assert.throws(() => assertClock({ trackedAsOf: '2026-10-13', today: '2026-10-12' }), /LIFECYCLE_AS_OF_REGRESSION/);
assert.throws(() => assertClock({ trackedAsOf: 'x', today: '2026-10-12' }), /LIFECYCLE_TRACKED_AS_OF_UNREADABLE/);
assert.throws(() => assertClock({ trackedAsOf: '2026-10-12', today: undefined }), /LIFECYCLE_TODAY_UNREADABLE/);

// ------------------------------------------------------------- planning ----
const dated = (id, over = {}) => ({
  id, kind: 'dated-event', publication_state: 'published', detail_page: `things-to-do/${id}/`, end_date: '2026-11-15', ...over,
});
const base = [
  dated('alpha'),
  dated('beta', { end_date: '2026-12-31' }),
  dated('gamma', { end_precision: 'month', end_month: '2026-11', end_date: null }),
  { id: 'venue', kind: 'recurring-venue', publication_state: 'published' },
];

// At the boundary instant's day-before: nothing. On the day after: alpha only.
assert.equal(planLifecycleTransition({ records: base, trackedAsOf: '2026-10-12', today: '2026-11-15' }).status, 'NOOP');
const due = planLifecycleTransition({ records: base, trackedAsOf: '2026-10-12', today: '2026-11-16' });
assert.equal(due.status, 'DUE');
assert.deepEqual(due.dueIds, ['alpha']);
assert.ok(due.allowedWriteSet.includes('things-to-do/alpha/index.html'));
assert.ok(due.allowedWriteSet.includes('pt/things-to-do/alpha/index.html'));
assert.ok(due.allowedWriteSet.includes('data/things-to-do-currentness.json'));
assert.ok(!due.allowedWriteSet.includes('sitemap.xml'), 'sitemap is never in the write set');
assert.ok(!due.allowedWriteSet.some((file) => file.includes('beta')), 'unrelated records are never admitted');
assert.ok(!due.allowedWriteSet.some((file) => file.includes('gamma')));

// Month precision never expires, however late the run.
assert.deepEqual(planLifecycleTransition({ records: base, trackedAsOf: '2026-10-12', today: '2030-01-01' }).dueIds, ['alpha', 'beta']);
assert.equal(planLifecycleTransition({ records: [base[2], base[3]], trackedAsOf: '2026-10-12', today: '2030-01-01' }).status, 'NOOP');
// Recurring / open-ended records never expire.
assert.equal(planLifecycleTransition({ records: [base[3]], trackedAsOf: '2026-10-12', today: '2030-01-01' }).status, 'NOOP');
// Late run (3-day gap, multi-week gap) reconciles to the same due set.
assert.deepEqual(planLifecycleTransition({ records: base, trackedAsOf: '2026-10-12', today: '2026-11-19' }).dueIds, ['alpha']);
// Already-applied ledger is a NOOP for the same effective date (idempotence).
assert.equal(planLifecycleTransition({ records: base, trackedAsOf: '2026-11-16', today: '2026-11-16' }).status, 'NOOP');
// A record already expired at the tracked date crosses nothing.
assert.equal(
  planLifecycleTransition({ records: [dated('old', { end_date: '2026-09-01' })], trackedAsOf: '2026-10-12', today: '2026-11-16' }).status,
  'NOOP',
);
// Explicit editorial expiry is not a time transition and is never ours.
assert.equal(
  planLifecycleTransition({ records: [dated('edit', { publication_state: 'expired', end_date: '2026-11-15' })], trackedAsOf: '2026-10-12', today: '2026-11-16' }).status,
  'NOOP',
);
// Fail closed.
assert.throws(() => planLifecycleTransition({ records: base, trackedAsOf: '2026-11-16', today: '2026-11-15' }), /LIFECYCLE_AS_OF_REGRESSION/);
assert.throws(() => planLifecycleTransition({ records: [], trackedAsOf: '2026-10-12', today: '2026-11-16' }), /LIFECYCLE_RECORDS_UNREADABLE/);
assert.throws(() => planLifecycleTransition({ records: [dated('x', { end_date: '2026-02-30' })], trackedAsOf: '2026-10-12', today: '2026-11-16' }), /LIFECYCLE_MALFORMED_END_DATE/);
// Malformed date on a record that does NOT cross is still surfaced.
assert.throws(() => planLifecycleTransition({ records: [dated('x', { end_date: 'soon' }), dated('y')], trackedAsOf: '2026-10-12', today: '2026-11-16' }), /LIFECYCLE_MALFORMED_END_DATE/);
for (const state of ['withdrawn', 'draft']) {
  assert.throws(
    () => planLifecycleTransition({ records: [dated('w', { publication_state: state })], trackedAsOf: '2026-10-12', today: '2026-11-16' }),
    /LIFECYCLE_UNPUBLISHED_RECORD_CROSSING/,
  );
}
assert.throws(
  () => planLifecycleTransition({ records: [dated('w', { kind: 'recurring-venue' })], trackedAsOf: '2026-10-12', today: '2026-11-16' }),
  /LIFECYCLE_NOT_A_DATED_EVENT/,
);
assert.throws(
  () => planLifecycleTransition({ records: [dated('w', { detail_page: 'elsewhere/' })], trackedAsOf: '2026-10-12', today: '2026-11-16' }),
  /LIFECYCLE_DETAIL_ROUTE_AMBIGUOUS/,
);

// ------------------------------------------------------------ write set ----
const ok = ['data/things-to-do-currentness.json', 'things-to-do/alpha/index.html', 'pt/things-to-do/alpha/index.html'];
assert.deepEqual(assertLifecycleWriteSet(ok, due), [...ok].sort());
assert.doesNotThrow(() => assertLifecycleWriteSet([...ok, 'index.html', 'pt/index.html'], due));
assert.throws(() => assertLifecycleWriteSet([], due), /LIFECYCLE_EMPTY_DIFF/);
assert.throws(() => assertLifecycleWriteSet([...ok, 'sitemap.xml'], due), /LIFECYCLE_UNEXPECTED_FILE_CHANGE: sitemap\.xml/);
assert.throws(() => assertLifecycleWriteSet([...ok, 'things-to-do/beta/index.html'], due), /LIFECYCLE_UNEXPECTED_FILE_CHANGE/);
assert.throws(() => assertLifecycleWriteSet([...ok, 'data/things-to-do-events.json'], due), /LIFECYCLE_UNEXPECTED_FILE_CHANGE/);
assert.throws(() => assertLifecycleWriteSet([...ok, 'assets/hero.jpg'], due), /LIFECYCLE_UNEXPECTED_FILE_CHANGE/);
// EN-only or PT-only output is refused: both locales must move together.
assert.throws(() => assertLifecycleWriteSet(ok.slice(0, 2), due), /LIFECYCLE_REQUIRED_FILE_UNCHANGED/);
assert.throws(() => assertLifecycleWriteSet(['things-to-do/alpha/index.html', 'pt/things-to-do/alpha/index.html'], due), /LIFECYCLE_REQUIRED_FILE_UNCHANGED/);

// -------------------------------------------------------- validator exit ----
const step = (name, status) => ({ step: name, status });
assert.deepEqual(assertLifecycleValidatorResults([step('scripts/a.mjs', 0)]), []);
assert.deepEqual(
  assertLifecycleValidatorResults([step('scripts/validate-things-to-do-currentness.mjs --as-of=2026-11-16', 3), step('scripts/a.mjs', 0)]),
  ['REVIEW_DUE'],
);
assert.throws(() => assertLifecycleValidatorResults([step('scripts/validate-things-to-do-currentness.mjs --as-of=2026-11-16', 1)]), /LIFECYCLE_INCUMBENT_VALIDATOR_FAILED/);
assert.throws(() => assertLifecycleValidatorResults([step('scripts/validate-card-media.mjs', 3)]), /LIFECYCLE_INCUMBENT_VALIDATOR_FAILED/);
assert.throws(() => assertLifecycleValidatorResults([step('scripts/validate-things-to-do-sitemap.mjs', 1)]), /LIFECYCLE_INCUMBENT_VALIDATOR_FAILED/);

// ------------------------------------------------------------------ mode ----
assert.equal(parseMode('{"mode":"dry-run"}'), 'dry-run');
for (const bad of ['{"mode":"enabled"}', '{"mode":"publish"}', '{}', '{"mode":1}', 'null', 'nope']) {
  assert.throws(() => parseMode(bad), /LIFECYCLE_MODE_(NOT_ALLOWED|UNREADABLE)/, bad);
}

// ------------------------------------------------------- output location ----
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-lifecycle-outunit-'));
  try {
    const repo = path.join(sandbox, 'repo');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    const sibling = path.join(sandbox, 'elsewhere', 'out');
    assert.equal(fs.existsSync(path.dirname(sibling)), false);
    assert.ok(assertSafeOutputDir(sibling, repo), 'a sibling location that does not exist yet is accepted');
    assert.ok(assertSafeOutputDir(path.join(sandbox, 'repo-out'), repo), 'a name sharing the repo prefix is not inside it');
    for (const bad of [repo, path.join(repo, 'out'), path.join(repo, 'sub', 'deeper', 'out'), path.join(repo, 'sub', '..', 'out'), sandbox, path.dirname(sandbox)]) {
      assert.throws(() => assertSafeOutputDir(bad, repo), /LIFECYCLE_UNSAFE_OUTPUT_LOCATION/, bad);
    }
    assert.throws(() => assertSafeOutputDir('', repo), /LIFECYCLE_UNSAFE_OUTPUT_LOCATION/);
    assert.throws(() => assertSafeOutputDir(undefined, repo), /LIFECYCLE_UNSAFE_OUTPUT_LOCATION/);
    // A symlink or junction that points back into the repository cannot launder an in-repo path.
    const link = path.join(sandbox, 'link');
    let linked = true;
    try { fs.symlinkSync(path.join(repo, 'sub'), link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { linked = false; }
    if (linked) assert.throws(() => assertSafeOutputDir(path.join(link, 'out'), repo), /LIFECYCLE_UNSAFE_OUTPUT_LOCATION/);
    else console.log('NOTE: symlink case skipped (cannot create links here)');

    // The temporary base is checked BEFORE anything is allocated under it. Inside or equal to
    // the repository is refused; a base that merely contains the repository is fine (its
    // children are siblings of the repository, not inside it).
    assert.doesNotThrow(() => assertTempBaseOutsideRepo(sandbox, repo), 'a base containing the repo is acceptable');
    assert.doesNotThrow(() => assertTempBaseOutsideRepo(path.join(sandbox, 'elsewhere'), repo));
    for (const bad of [repo, path.join(repo, 'sub'), path.join(repo, 'not', 'yet', 'there')]) {
      assert.throws(() => assertTempBaseOutsideRepo(bad, repo), /LIFECYCLE_UNSAFE_OUTPUT_LOCATION/, bad);
    }
    assert.throws(() => assertTempBaseOutsideRepo('', repo), /LIFECYCLE_UNSAFE_OUTPUT_LOCATION/);
    if (linked) assert.throws(() => assertTempBaseOutsideRepo(link, repo), /LIFECYCLE_UNSAFE_OUTPUT_LOCATION/, 'a link into the repo');

    // An explicit output path must not exist at all: directory, file, link or dangling link.
    assert.doesNotThrow(() => assertFreshOutputPath(path.join(sandbox, 'fresh-out')));
    const existingDir = path.join(sandbox, 'existing-dir');
    fs.mkdirSync(existingDir);
    const existingFile = path.join(sandbox, 'existing-file');
    fs.writeFileSync(existingFile, 'x');
    for (const bad of [existingDir, existingFile, sandbox]) {
      assert.throws(() => assertFreshOutputPath(bad), /LIFECYCLE_OUTPUT_EXISTS/, bad);
    }
    if (linked) assert.throws(() => assertFreshOutputPath(link), /LIFECYCLE_OUTPUT_EXISTS/, 'an existing link');
    const dangling = path.join(sandbox, 'dangling');
    let danglingMade = true;
    try { fs.symlinkSync(path.join(sandbox, 'no-such-target'), dangling, process.platform === 'win32' ? 'junction' : 'dir'); } catch { danglingMade = false; }
    if (danglingMade) assert.throws(() => assertFreshOutputPath(dangling), /LIFECYCLE_OUTPUT_EXISTS/, 'a dangling link');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------- audit ----
const audit = buildAuditRecord({
  mode: 'dry-run', plan: due, records: base, now: new Date('2026-11-16T05:00:00Z'), baseSha: 'a'.repeat(40),
});
assert.deepEqual(audit.events, [{ id: 'alpha', scheduled_expiry: '2026-11-16T01:00:00.000Z', state_before: 'current', state_after: 'expired' }]);
assert.equal(audit.published, false);
assert.equal(audit.deployment_id, null);
// Validator names are kept together with their exit statuses, in order.
const withValidators = buildAuditRecord({
  mode: 'dry-run', plan: due, records: base, now: new Date('2026-11-16T05:00:00Z'), baseSha: null,
  validators: [{ step: 'scripts/a.mjs', status: 0 }, { step: 'scripts/validate-things-to-do-currentness.mjs --as-of=2026-11-16', status: 3 }],
  advisories: ['REVIEW_DUE'],
});
assert.deepEqual(withValidators.validators, [
  { step: 'scripts/a.mjs', status: 0 },
  { step: 'scripts/validate-things-to-do-currentness.mjs --as-of=2026-11-16', status: 3 },
]);
assert.deepEqual(withValidators.advisories, ['REVIEW_DUE']);
assert.deepEqual(
  Object.keys(audit).sort(),
  ['actual_time', 'advisories', 'base_sha', 'build_sha', 'changed_files', 'deployment_id', 'events', 'file_hashes', 'from_as_of',
    'home_preview_after', 'home_preview_before', 'mode', 'published', 'retries', 'schema', 'status', 'to_as_of', 'validators', 'version'],
  'audit carries ids, times, states and hashes only — no source or provenance text',
);

// ============================================== integration (real repo) ====
const TEXT = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.txt', '.xml']);
function inventory(dir) {
  const map = new Map();
  (function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        let bytes = fs.readFileSync(full);
        if (TEXT.has(path.extname(entry.name).toLowerCase())) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
        map.set(path.relative(dir, full).split(path.sep).join('/'), crypto.createHash('sha256').update(bytes).digest('hex'));
      }
    }
  })(dir);
  return map;
}
const diff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-lifecycle-test-'));
function copyRepo(name) {
  const dest = path.join(tmp, name);
  fs.cpSync(root, dest, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
  return dest;
}
function runner_(rootDir, now, outName) {
  const out = path.join(tmp, outName);
  const result = spawnSync(process.execPath, [runner, `--root=${rootDir}`, `--out=${out}`, `--now=${now}`], { encoding: 'utf8' });
  const auditFile = path.join(out, 'lifecycle-audit.json');
  return { ...result, out, audit: fs.existsSync(auditFile) ? JSON.parse(fs.readFileSync(auditFile, 'utf8')) : null };
}

try {
  const pristine = copyRepo('pristine');
  const pristineBefore = inventory(pristine);

  // 1. No due event: NOOP, exit 0, tracked site untouched.
  const noop = runner_(pristine, '2026-10-21T12:00:00Z', 'out-noop');
  assert.equal(noop.status, 0, noop.stderr);
  assert.match(noop.stdout, /LIFECYCLE_NOOP/);
  assert.equal(noop.audit.status, 'NOOP');
  assert.deepEqual(diff(pristineBefore, inventory(pristine)), [], 'NOOP wrote to the tracked tree');

  // 2. One second before the boundary (Cape Verde 23:59:59 on the end date): still NOOP.
  const before = runner_(pristine, '2026-11-16T00:59:59Z', 'out-before');
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.audit.status, 'NOOP');

  // 3. At the boundary: cartinha-dholanda-mindelo-2026 (a Home-preview member) is due.
  const at = runner_(pristine, '2026-11-16T01:00:00Z', 'out-due');
  assert.equal(at.status, 0, at.stderr + at.stdout);
  assert.match(at.stdout, /LIFECYCLE_DRY_RUN_OK/);
  assert.equal(at.audit.status, 'DUE');
  assert.equal(at.audit.published, false);
  assert.equal(at.audit.deployment_id, null);
  assert.deepEqual(at.audit.events.map((e) => [e.id, e.state_before, e.state_after]), [['cartinha-dholanda-mindelo-2026', 'current', 'expired']]);
  assert.deepEqual(at.audit.advisories, ['REVIEW_DUE'], 'month-precision records are an advisory, not a failure');
  assert.ok(at.audit.home_preview_before.includes('cartinha-dholanda-mindelo-2026'));
  assert.ok(!at.audit.home_preview_after.includes('cartinha-dholanda-mindelo-2026'));
  // Every validator is recorded with its exit status. Only the currentness validator may be
  // non-zero, and only with the documented review-due status 3.
  assert.ok(at.audit.validators.length >= 8);
  for (const validator of at.audit.validators) {
    assert.deepEqual(Object.keys(validator).sort(), ['status', 'step']);
    assert.equal(typeof validator.step, 'string');
    assert.ok(Number.isInteger(validator.status));
    const isCurrentness = /^scripts\/validate-things-to-do-currentness\.mjs /.test(validator.step);
    assert.equal(validator.status, isCurrentness ? 3 : 0, validator.step);
  }
  assert.equal(at.audit.validators.filter((v) => v.status !== 0).length, 1);
  // EN/PT parity and bounded write set: only these may change.
  assert.deepEqual(at.audit.changed_files, [
    'data/things-to-do-currentness.json',
    'index.html',
    'pt/index.html',
    'pt/things-to-do/cartinha-dholanda-mindelo-2026/index.html',
    'things-to-do/cartinha-dholanda-mindelo-2026/index.html',
  ]);
  // Dry run: the staged output exists only under --out; the repo copy is untouched.
  assert.deepEqual(diff(pristineBefore, inventory(pristine)), [], 'dry run wrote to the tracked tree');
  // Historical detail routes are retained in both locales, and the sitemap is unmoved.
  for (const file of ['things-to-do/cartinha-dholanda-mindelo-2026/index.html', 'pt/things-to-do/cartinha-dholanda-mindelo-2026/index.html']) {
    assert.ok(fs.existsSync(path.join(at.out, 'would-publish', file)), `${file} retained`);
  }
  assert.ok(!fs.existsSync(path.join(at.out, 'would-publish', 'sitemap.xml')));
  const sitemap = fs.readFileSync(path.join(pristine, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /things-to-do\/cartinha-dholanda-mindelo-2026\//);
  assert.match(sitemap, /pt\/things-to-do\/cartinha-dholanda-mindelo-2026\//);
  // The expired card is gone from both Home surfaces; the other Home cards are byte-identical.
  const enHome = fs.readFileSync(path.join(at.out, 'would-publish', 'index.html'), 'utf8');
  const ptHome = fs.readFileSync(path.join(at.out, 'would-publish', 'pt', 'index.html'), 'utf8');
  const region = (html, id) => html.match(new RegExp(`<!-- BEGIN GENERATED EVENT: ${id} -->[\\s\\S]*?<!-- END GENERATED EVENT: ${id} -->`))?.[0];
  for (const html of [enHome, ptHome]) {
    assert.ok(!/<article/.test(region(html, 'cartinha-dholanda-mindelo-2026') ?? ''), 'expired card removed from Home');
    for (const id of ['sinergia-da-materia', 'taverna-live-music', 'nautilus-live-music']) {
      assert.match(region(html, id), /<article/, `${id} stays on Home`);
    }
  }
  for (const id of ['sinergia-da-materia', 'taverna-live-music', 'nautilus-live-music']) {
    const origEn = region(fs.readFileSync(path.join(pristine, 'index.html'), 'utf8'), id);
    assert.equal(region(enHome, id), origEn, `${id} EN Home region unchanged`);
  }

  // 4. Late run reconciles to the same file set (3-day gap).
  const late = runner_(pristine, '2026-11-19T09:00:00Z', 'out-late');
  assert.equal(late.status, 0, late.stderr + late.stdout);
  assert.deepEqual(late.audit.changed_files, at.audit.changed_files);
  assert.deepEqual(late.audit.events.map((e) => e.id), ['cartinha-dholanda-mindelo-2026']);

  // 5. Apply the would-publish files, then re-run: two consecutive runs are inert.
  const applied = copyRepo('applied');
  for (const file of at.audit.changed_files) fs.copyFileSync(path.join(at.out, 'would-publish', file), path.join(applied, file));
  const appliedBefore = inventory(applied);
  const rerun1 = runner_(applied, '2026-11-16T01:00:00Z', 'out-rerun1');
  const rerun2 = runner_(applied, '2026-11-16T05:00:00Z', 'out-rerun2');
  for (const run of [rerun1, rerun2]) {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.audit.status, 'NOOP');
  }
  assert.deepEqual(diff(appliedBefore, inventory(applied)), []);
  // Running the same effective date later in the day is also a NOOP.
  assert.equal(runner_(applied, '2026-11-17T00:30:00Z', 'out-rerun3').audit.status, 'NOOP');

  // 6. Fail closed on unrelated drift: a tampered derived page the build would rewrite.
  const drift = copyRepo('drift');
  const tampered = path.join(drift, 'pt', 'about', 'index.html');
  fs.appendFileSync(tampered, '\n<!-- unauthorized edit -->\n');
  const refused = runner_(drift, '2026-11-16T01:00:00Z', 'out-drift');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /LIFECYCLE_UNEXPECTED_FILE_CHANGE: .*pt\/about\/index\.html/);
  assert.equal(refused.audit, null, 'a refused run leaves no would-publish record');
  assert.equal(fs.existsSync(refused.out), false, 'a refused run removes the output it created');

  // 7. Fail closed on editorial/data drift: an unapproved record change that alters canonical copy.
  const editorial = copyRepo('editorial');
  const eventsFile = path.join(editorial, 'data', 'things-to-do-events.json');
  const eventsDoc = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
  const taverna = eventsDoc.records.find((r) => r.id === 'taverna-live-music');
  taverna.summary = `${taverna.summary} (unreviewed edit)`;
  fs.writeFileSync(eventsFile, `${JSON.stringify(eventsDoc, null, 2)}\n`);
  const editorialRun = runner_(editorial, '2026-11-16T01:00:00Z', 'out-editorial');
  assert.equal(editorialRun.status, 1, 'unreviewed editorial change must not ride along with an expiry');
  assert.match(editorialRun.stderr, /LIFECYCLE_UNEXPECTED_FILE_CHANGE: .*things-to-do\/taverna-live-music\/index\.html/);

  // 8. Only dry-run mode is accepted; the publish path does not exist in this tranche.
  const enabled = copyRepo('enabled');
  fs.writeFileSync(path.join(enabled, 'automation', 'lifecycle', 'mode.json'), '{"mode":"enabled"}\n');
  const enabledRun = runner_(enabled, '2026-11-16T01:00:00Z', 'out-enabled');
  assert.equal(enabledRun.status, 1);
  assert.match(enabledRun.stderr, /LIFECYCLE_MODE_NOT_ALLOWED/);

  // 8b. Output location. With no --out the controller writes to a fresh directory OUTSIDE the
  // input repository; an explicit --out inside (or containing) it is refused before any write.
  const outRepo = copyRepo('outloc');
  const outBefore = inventory(outRepo);
  const defaultRun = spawnSync(process.execPath, [runner, `--root=${outRepo}`, '--now=2026-11-16T01:00:00Z'], { encoding: 'utf8' });
  assert.equal(defaultRun.status, 0, defaultRun.stderr + defaultRun.stdout);
  const located = defaultRun.stdout.match(/^LIFECYCLE_OUTPUT: (.+)$/m);
  assert.ok(located, 'the chosen output location is reported');
  const defaultOut = located[1].trim();
  try {
    assert.ok(path.isAbsolute(defaultOut));
    assert.ok(path.relative(outRepo, defaultOut).startsWith('..'), 'default output is outside the input repository');
    assert.ok(fs.existsSync(path.join(defaultOut, 'lifecycle-audit.json')));
    assert.deepEqual(diff(outBefore, inventory(outRepo)), [], 'default output must not dirty the input repository');
    assert.equal(fs.existsSync(path.join(outRepo, 'lifecycle-artifacts')), false, 'no in-repo default directory');
  } finally {
    fs.rmSync(defaultOut, { recursive: true, force: true });
  }
  // The default is also exercised for a NOOP run, which creates no site changes either.
  const defaultNoop = spawnSync(process.execPath, [runner, `--root=${outRepo}`, '--now=2026-10-21T12:00:00Z'], { encoding: 'utf8' });
  assert.equal(defaultNoop.status, 0, defaultNoop.stderr);
  fs.rmSync(defaultNoop.stdout.match(/^LIFECYCLE_OUTPUT: (.+)$/m)[1].trim(), { recursive: true, force: true });
  assert.deepEqual(diff(outBefore, inventory(outRepo)), []);
  for (const unsafe of [path.join(outRepo, 'out'), outRepo, path.join(outRepo, 'data', 'x'), path.dirname(outRepo)]) {
    const refusedOut = spawnSync(process.execPath, [runner, `--root=${outRepo}`, `--out=${unsafe}`, '--now=2026-11-16T01:00:00Z'], { encoding: 'utf8' });
    assert.equal(refusedOut.status, 1, unsafe);
    assert.match(refusedOut.stderr, /LIFECYCLE_UNSAFE_OUTPUT_LOCATION/, unsafe);
    assert.doesNotMatch(refusedOut.stdout, /LIFECYCLE_OUTPUT/, 'nothing is created for a refused location');
  }
  assert.deepEqual(diff(outBefore, inventory(outRepo)), [], 'a refused --out left the repository untouched');
  assert.equal(fs.existsSync(path.join(outRepo, 'out')), false);

  // 8c. P1-1: a temporary base inside the repository is refused BEFORE any directory is
  // allocated under it — nothing is created in the repository, by the default output or by
  // the staging copy, for a NOOP run, a DUE run, or a run with an explicit safe --out.
  const dirsOf = (dir) => {
    const found = [];
    (function visit(current) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const full = path.join(current, entry.name);
        found.push(path.relative(dir, full).split(path.sep).join('/') + (entry.isDirectory() ? '/' : ''));
        if (entry.isDirectory()) visit(full);
      }
    })(dir);
    return found.sort();
  };
  const inRepoTmpRepo = copyRepo('tmp-in-repo');
  fs.mkdirSync(path.join(inRepoTmpRepo, 'inrepo-tmp'));
  const entriesBefore = dirsOf(inRepoTmpRepo);
  const safeOut = path.join(tmp, 'tmp-in-repo-explicit-out');
  const tmpEnv = { ...process.env, TMP: path.join(inRepoTmpRepo, 'inrepo-tmp'), TEMP: path.join(inRepoTmpRepo, 'inrepo-tmp'), TMPDIR: path.join(inRepoTmpRepo, 'inrepo-tmp') };
  for (const [label, args] of [
    ['default output, NOOP', ['--now=2026-10-21T12:00:00Z']],
    ['default output, DUE', ['--now=2026-11-16T01:00:00Z']],
    ['explicit safe output, DUE', ['--now=2026-11-16T01:00:00Z', `--out=${safeOut}`]],
  ]) {
    const res = spawnSync(process.execPath, [runner, `--root=${inRepoTmpRepo}`, ...args], { encoding: 'utf8', env: tmpEnv });
    assert.equal(res.status, 1, label);
    assert.match(res.stderr, /LIFECYCLE_UNSAFE_OUTPUT_LOCATION: temporary base/, label);
    assert.doesNotMatch(res.stdout, /LIFECYCLE_OUTPUT/, label);
    assert.deepEqual(dirsOf(inRepoTmpRepo), entriesBefore, `${label}: nothing may be allocated inside the repository`);
    assert.equal(fs.existsSync(safeOut), false, `${label}: no explicit output was created`);
  }

  // 8d. P1-1 (cleanup): a run refused AFTER it allocated output removes that output. Uses a
  // dedicated temporary base so any leftover aprasa-lifecycle-* directory is visible.
  const sandboxTmp = fs.mkdtempSync(path.join(tmp, 'sandbox-tmp-'));
  const sandboxEnv = { ...process.env, TMP: sandboxTmp, TEMP: sandboxTmp, TMPDIR: sandboxTmp };
  const driftAgain = copyRepo('drift-default-out');
  fs.appendFileSync(path.join(driftAgain, 'pt', 'about', 'index.html'), '\n<!-- unauthorized edit -->\n');
  const refusedDefault = spawnSync(process.execPath, [runner, `--root=${driftAgain}`, '--now=2026-11-16T01:00:00Z'], { encoding: 'utf8', env: sandboxEnv });
  assert.equal(refusedDefault.status, 1);
  assert.match(refusedDefault.stderr, /LIFECYCLE_UNEXPECTED_FILE_CHANGE/);
  assert.deepEqual(fs.readdirSync(sandboxTmp), [], 'a refused default-output run leaves no output or staging directory behind');
  // ...and a successful default-output run leaves exactly one directory: the output.
  const okDefault = spawnSync(process.execPath, [runner, `--root=${pristine}`, '--now=2026-11-16T01:00:00Z'], { encoding: 'utf8', env: sandboxEnv });
  assert.equal(okDefault.status, 0, okDefault.stderr);
  const leftovers = fs.readdirSync(sandboxTmp);
  assert.equal(leftovers.length, 1);
  assert.match(leftovers[0], /^aprasa-lifecycle-out-/);

  // 8e. P1-2: an explicit --out must not pre-exist. Nothing existing is reused, cleared or
  // written through — not a directory, a directory holding a would-publish child, a file, or
  // a link (including one pointing at a victim directory).
  const victim = path.join(tmp, 'victim');
  fs.mkdirSync(path.join(victim, 'keep'), { recursive: true });
  fs.writeFileSync(path.join(victim, 'keep', 'sentinel.txt'), 'must survive');
  const victimBefore = dirsOf(victim);
  const existingOut = path.join(tmp, 'existing-out');
  fs.mkdirSync(path.join(existingOut, 'would-publish'), { recursive: true });
  fs.writeFileSync(path.join(existingOut, 'would-publish', 'sentinel.txt'), 'must survive');
  fs.writeFileSync(path.join(existingOut, 'lifecycle-audit.json'), 'must survive');
  const outCases = [['existing directory with a would-publish child', existingOut]];
  const existingFileOut = path.join(tmp, 'existing-file-out');
  fs.writeFileSync(existingFileOut, 'must survive');
  outCases.push(['existing file', existingFileOut]);
  const linkOut = path.join(tmp, 'link-out');
  const childLinkOut = path.join(tmp, 'child-link-out');
  try {
    fs.symlinkSync(victim, linkOut, process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(childLinkOut);
    fs.symlinkSync(victim, path.join(childLinkOut, 'would-publish'), process.platform === 'win32' ? 'junction' : 'dir');
    outCases.push(['link to a victim directory', linkOut], ['directory whose would-publish child is a link to a victim', childLinkOut]);
  } catch {
    console.log('NOTE: link cases for an explicit --out skipped (cannot create links here)');
  }
  for (const [label, target] of outCases) {
    for (const when of ['2026-10-21T12:00:00Z', '2026-11-16T01:00:00Z']) {
      const res = spawnSync(process.execPath, [runner, `--root=${pristine}`, `--out=${target}`, `--now=${when}`], { encoding: 'utf8' });
      assert.equal(res.status, 1, `${label} @ ${when}`);
      assert.match(res.stderr, /LIFECYCLE_OUTPUT_EXISTS/, `${label} @ ${when}`);
      assert.doesNotMatch(res.stdout, /LIFECYCLE_OUTPUT/);
    }
  }
  assert.equal(fs.readFileSync(path.join(existingOut, 'would-publish', 'sentinel.txt'), 'utf8'), 'must survive', 'existing would-publish content was deleted');
  assert.equal(fs.readFileSync(path.join(existingOut, 'lifecycle-audit.json'), 'utf8'), 'must survive', 'existing audit file was overwritten');
  assert.equal(fs.readFileSync(existingFileOut, 'utf8'), 'must survive');
  assert.deepEqual(dirsOf(victim), victimBefore, 'nothing was written through a link into the victim directory');
  assert.equal(fs.readFileSync(path.join(victim, 'keep', 'sentinel.txt'), 'utf8'), 'must survive');
  // A missing parent is refused rather than created, so no directory chain is built implicitly.
  const noParent = path.join(tmp, 'no-such-parent', 'out');
  const missingParent = spawnSync(process.execPath, [runner, `--root=${pristine}`, `--out=${noParent}`, '--now=2026-11-16T01:00:00Z'], { encoding: 'utf8' });
  assert.equal(missingParent.status, 1);
  assert.match(missingParent.stderr, /LIFECYCLE_OUTPUT_PARENT_MISSING/);
  assert.equal(fs.existsSync(path.dirname(noParent)), false);
  // A fresh explicit --out is created exclusively and works.
  const freshOut = path.join(tmp, 'fresh-explicit-out');
  const freshRun = spawnSync(process.execPath, [runner, `--root=${pristine}`, `--out=${freshOut}`, '--now=2026-11-16T01:00:00Z'], { encoding: 'utf8' });
  assert.equal(freshRun.status, 0, freshRun.stderr);
  assert.ok(fs.existsSync(path.join(freshOut, 'lifecycle-audit.json')));
  assert.ok(fs.existsSync(path.join(freshOut, 'would-publish', 'index.html')));
  // Re-running into the same path is refused: nothing is ever overwritten.
  const reuse = spawnSync(process.execPath, [runner, `--root=${pristine}`, `--out=${freshOut}`, '--now=2026-11-16T01:00:00Z'], { encoding: 'utf8' });
  assert.equal(reuse.status, 1);
  assert.match(reuse.stderr, /LIFECYCLE_OUTPUT_EXISTS/);
  assert.ok(fs.existsSync(path.join(freshOut, 'lifecycle-audit.json')), 'the earlier output was preserved');

  // 9. A clock earlier than the tracked ledger is refused, never applied.
  const regression = runner_(pristine, '2026-10-01T12:00:00Z', 'out-regress');
  assert.equal(regression.status, 1);
  assert.match(regression.stderr, /LIFECYCLE_AS_OF_REGRESSION/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('Event lifecycle expiry tests passed.');
