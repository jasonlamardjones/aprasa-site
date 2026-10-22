#!/usr/bin/env node
// Event lifecycle expiry controller — DRY-RUN ONLY (Project 04, Tranche A1).
//
// Usage: node scripts/lifecycle/run-event-expiry.mjs [--root=DIR] [--out=DIR] [--now=ISO]
//
// Output goes to a fresh temporary directory outside --root unless --out is
// given. An explicit --out must NOT already exist (it is created exclusively,
// so no existing file, directory or symlink is ever reused or written through)
// and must not be inside or contain --root. The temporary base is validated
// before any directory is allocated, and a run that fails removes the output
// it created. The location of a successful run is printed as LIFECYCLE_OUTPUT.
//
// Recomputes, from canonical data and the Atlantic/Cape_Verde clock, whether
// any approved published event has crossed its expiry boundary. If so it
// rebuilds the site in a STAGING COPY, proves the result stays inside the
// transition's bounded write set, passes every incumbent validator and is
// idempotent, then records what would be published.
//
// It never writes to --root, never commits, pushes, opens a PR, or deploys,
// and holds no credential. Any mode other than "dry-run" is refused: the
// publish path is deliberately not implemented in this tranche.
//
// Exit codes: 0 NOOP or successful dry run; 1 fail-closed refusal.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CURRENTNESS_FILE,
  HOME_SURFACES,
  assertHomeBounded,
  assertIdempotentChanges,
  assertLifecycleWriteSet,
  assertLifecycleValidatorResults,
  assertFreshOutputPath,
  assertSafeOutputDir,
  assertTempBaseOutsideRepo,
  buildAuditRecord,
  capeVerdeToday,
  lifecycleError,
  parseMode,
  planLifecycleTransition,
} from './lib/event-expiry.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.txt', '.xml', '.yaml', '.yml']);

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function run(cwd, executable, args, { allowFailure = false } = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env: process.env });
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${executable} ${args.join(' ')} failed (${result.status})${detail ? `:\n${detail}` : ''}`);
  }
  return result;
}

// Same line-ending-normalised content hash the Phase 2B adapter uses, so the
// two controllers agree on what "changed" means.
function inventory(dir) {
  const map = new Map();
  (function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const rel = path.relative(dir, full).split(path.sep).join('/');
        const bytes = fs.readFileSync(full);
        const normalized = TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
          ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'))
          : bytes;
        map.set(rel, crypto.createHash('sha256').update(normalized).digest('hex'));
      }
    }
  })(dir);
  return map;
}

function changedFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name)).sort();
}

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function build(stage, asOf) {
  const doc = readJson(stage, CURRENTNESS_FILE);
  doc.as_of = asOf;
  fs.writeFileSync(path.join(stage, CURRENTNESS_FILE), `${JSON.stringify(doc, null, 2)}\n`);
  try {
    run(stage, process.execPath, ['scripts/build-all.mjs', `--as-of=${asOf}`]);
  } catch (error) {
    throw lifecycleError('LIFECYCLE_CANONICAL_GENERATION_FAILED', error.message);
  }
}

function runIncumbentValidators(stage, asOf) {
  const steps = [
    ['scripts/validate-things-to-do-events.mjs'],
    ['scripts/validate-things-to-do-currentness.mjs', `--as-of=${asOf}`],
    ['scripts/validate-things-to-do-surface-equivalence.mjs', `--as-of=${asOf}`],
    ['scripts/validate-things-to-do-sitemap.mjs'],
    ['scripts/validate-card-media.mjs'],
    ['scripts/validate-locale-contract.mjs', '--html', 'pt'],
    ['scripts/validate-pt-home-events.mjs'],
    ['scripts/validate-training-opportunities-currentness.mjs', `--as-of=${asOf}`, '--home=index.html', '--home=pt/index.html'],
  ];
  const results = steps.map(([script, ...args]) => {
    const result = run(stage, process.execPath, [script, ...args], { allowFailure: true });
    return { step: [script, ...args].join(' '), status: result.status };
  });
  const advisories = assertLifecycleValidatorResults(results);
  return { results, advisories };
}

function headSha(root) {
  const result = run(root, 'git', ['rev-parse', 'HEAD'], { allowFailure: true });
  const sha = result.status === 0 ? result.stdout.trim() : '';
  return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

function main() {
  const root = path.resolve(arg('root', path.resolve(scriptDir, '..', '..')));
  // Every location check happens before anything is allocated. The temporary
  // base is checked unconditionally: the staging copy and the default output
  // both live under it.
  assertTempBaseOutsideRepo(os.tmpdir(), root);
  const explicitOut = arg('out');
  if (explicitOut !== null) {
    assertSafeOutputDir(explicitOut, root);
    assertFreshOutputPath(explicitOut);
  }
  const nowArg = arg('now');
  const now = nowArg ? new Date(nowArg) : new Date();

  const mode = parseMode(fs.readFileSync(path.join(root, 'automation', 'lifecycle', 'mode.json'), 'utf8'));

  const records = readJson(root, 'data/things-to-do-events.json').records;
  const trackedAsOf = readJson(root, CURRENTNESS_FILE).as_of;
  const today = capeVerdeToday(now);
  const plan = planLifecycleTransition({ records, trackedAsOf, today });
  const baseSha = headSha(root);

  const outDir = createOutputDir(explicitOut);
  // Re-checked now that it exists and can be resolved: a parent swapped for a
  // link between the check and the creation must not leave output in the repo.
  assertSafeOutputDir(outDir, root);
  const writeAudit = (audit) => fs.writeFileSync(path.join(outDir, 'lifecycle-audit.json'), `${JSON.stringify(audit, null, 2)}\n`, { flag: 'wx' });

  if (plan.status === 'NOOP') {
    writeAudit(buildAuditRecord({ mode, plan, records, now, baseSha }));
    console.log(`LIFECYCLE_NOOP: no approved event crossed its boundary between ${trackedAsOf} and ${today}. Nothing written.`);
    return outDir;
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-lifecycle-stage-'));
  try {
    fs.cpSync(root, stage, {
      recursive: true,
      filter: (src) => path.basename(src) !== '.git',
    });

    const before = inventory(stage);
    const homeBefore = new Map(HOME_SURFACES.map((file) => [file, fs.readFileSync(path.join(stage, file), 'utf8')]));

    build(stage, today);
    const afterFirst = inventory(stage);
    const changed = assertLifecycleWriteSet(changedFiles(before, afterFirst), plan);
    const homeAfter = new Map(HOME_SURFACES.map((file) => [file, fs.readFileSync(path.join(stage, file), 'utf8')]));
    assertHomeBounded(homeBefore, homeAfter, plan);
    const { results: validators, advisories } = runIncumbentValidators(stage, today);

    // A second generation must change nothing, and the staged tree must now
    // plan as NOOP: together they prove re-running the same effective date is
    // inert.
    build(stage, today);
    assertIdempotentChanges(changedFiles(afterFirst, inventory(stage)));
    const replan = planLifecycleTransition({
      records: readJson(stage, 'data/things-to-do-events.json').records,
      trackedAsOf: readJson(stage, CURRENTNESS_FILE).as_of,
      today,
    });
    if (replan.status !== 'NOOP') throw lifecycleError('LIFECYCLE_NOT_CONVERGED', replan.dueIds.join(', '));

    const after = inventory(stage);
    const fileHashes = Object.fromEntries(changed.map((file) => [file, { before: before.get(file) ?? null, after: after.get(file) }]));
    // The output directory is exclusively ours and empty, so this is created,
    // never cleared, and nothing is overwritten.
    const filesDir = path.join(outDir, 'would-publish');
    fs.mkdirSync(filesDir);
    for (const file of changed) {
      fs.mkdirSync(path.dirname(path.join(filesDir, file)), { recursive: true });
      fs.copyFileSync(path.join(stage, file), path.join(filesDir, file), fs.constants.COPYFILE_EXCL);
    }
    writeAudit(buildAuditRecord({ mode, plan, records, now, baseSha, changedFiles: changed, fileHashes, validators, advisories }));
    console.log(`LIFECYCLE_DRY_RUN_OK: ${plan.dueIds.join(', ')} would expire (${trackedAsOf} -> ${today}); ${changed.length} file(s); nothing published.`);
    return outDir;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Set only once this process has itself created the output directory, so a
// failed run removes exactly what it allocated and never a pre-existing path.
let createdOut = null;

function createOutputDir(explicitOut) {
  let created;
  if (explicitOut !== null) {
    created = path.resolve(explicitOut);
    try {
      // Non-recursive: the parent must exist, and mkdir fails if the path does.
      fs.mkdirSync(created);
    } catch (error) {
      if (error.code === 'EEXIST') throw lifecycleError('LIFECYCLE_OUTPUT_EXISTS', created);
      if (error.code === 'ENOENT') throw lifecycleError('LIFECYCLE_OUTPUT_PARENT_MISSING', created);
      throw error;
    }
  } else {
    created = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-lifecycle-out-'));
  }
  createdOut = created;
  return created;
}

try {
  const reported = main();
  console.log(`LIFECYCLE_OUTPUT: ${reported}`);
} catch (error) {
  if (createdOut) fs.rmSync(createdOut, { recursive: true, force: true });
  console.error(error.message);
  process.exit(1);
}
