import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  dryRunValidationCommands,
  expectedChangedFiles,
  expectedDryRunChangedFiles,
  validatePacket
} from './event-publication-contract.mjs';

const TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.txt', '.xml',
  '.yaml', '.yml'
]);
const promotionStates = new WeakMap();

function command(cwd, executable, args, { allowFailure = false } = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env: process.env });
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${executable} ${args.join(' ')} failed (${result.status})${detail ? `:\n${detail}` : ''}`);
  }
  return result;
}

function git(root, args, options) {
  return command(root, 'git', args, options);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function normalizeTextEol(root) {
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const text = fs.readFileSync(full, 'utf8');
        const normalized = text.replace(/\r\n/g, '\n');
        if (text !== normalized) fs.writeFileSync(full, normalized);
      }
    }
  }
  visit(root);
}

function inventory(root) {
  const result = new Map();
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        const bytes = fs.readFileSync(full);
        const content = TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
          ? bytes.toString('utf8').replace(/\r\n/g, '\n')
          : bytes;
        result.set(rel, crypto.createHash('sha256').update(content).digest('hex'));
      }
    }
  }
  visit(root);
  return result;
}

function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

function insertHomeMarkers(root, relativeFile, id) {
  const file = path.join(root, relativeFile);
  let html = fs.readFileSync(file, 'utf8');
  const begin = `<!-- BEGIN GENERATED EVENT: ${id} -->`;
  const end = `<!-- END GENERATED EVENT: ${id} -->`;
  if (html.includes(begin) || html.includes(end)) throw new Error(`${relativeFile} already contains ${id}`);
  const matches = [...html.matchAll(/<!-- END GENERATED EVENT: [a-z0-9]+(?:-[a-z0-9]+)* -->/g)];
  if (!matches.length) throw new Error(`${relativeFile} has no incumbent event markers`);
  const last = matches.at(-1);
  const at = last.index + last[0].length;
  html = `${html.slice(0, at)}\n        ${begin}\n        ${end}${html.slice(at)}`;
  fs.writeFileSync(file, html);
}

function runNode(root, script, args = []) {
  return command(root, process.execPath, [script, ...args]).stdout.trim();
}

function buildCandidate(root, packet) {
  runNode(root, 'scripts/build-locale-data.mjs');
  runNode(root, 'scripts/generate-things-to-do.mjs', [`--as-of=${packet.control.as_of}`, '--locale=en', '--write']);
  runNode(root, 'scripts/build-static-pages.mjs', ['--write']);
  runNode(root, 'scripts/generate-things-to-do.mjs', [`--as-of=${packet.control.as_of}`, '--locale=pt', '--home=pt/index.html', '--write']);
  runNode(root, 'scripts/build-sitemap.mjs', ['--write']);
}

function validateCandidate(root, packet) {
  const steps = [
    ['scripts/validate-things-to-do-events.mjs'],
    ['scripts/validate-things-to-do-currentness.mjs', `--as-of=${packet.control.as_of}`],
    ['scripts/validate-things-to-do-surface-equivalence.mjs', `--as-of=${packet.control.as_of}`],
    ['scripts/validate-things-to-do-sitemap.mjs'],
    ['scripts/validate-card-media.mjs'],
    ['scripts/validate-locale-contract.mjs', '--html', 'pt'],
    ['scripts/validate-pt-home-events.mjs'],
    ['scripts/validate-training-opportunities-currentness.mjs', `--as-of=${packet.control.as_of}`, '--home=index.html', '--home=pt/index.html']
  ];
  return steps.map(([script, ...args]) => ({ step: [script, ...args].join(' '), output: runNode(root, script, args) }));
}

function initializeStagingGit(root) {
  git(root, ['init', '-q', '-b', 'staging']);
  git(root, ['config', 'user.name', 'A PRASA Publication Automation']);
  git(root, ['config', 'user.email', 'automation@aprasa.org']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'staging baseline']);
}

export function assertDryRunProof(root, packet, packetPath, proof, head, authoritativeMain) {
  if (proof?.artifact_version !== 1 || proof.artifact_type !== 'things-to-do-publication-dry-run-proof' || proof.status !== 'REVIEW_READY') {
    throw new Error('DRY_RUN_PROOF_REQUIRED: proof is missing or unsuccessful');
  }
  if (proof.event_id !== packet.event.id || proof.packet_sha256 !== sha256File(packetPath)) {
    throw new Error('DRY_RUN_PROOF_MISMATCH: proof does not match this packet');
  }
  if (proof.base_head_sha !== head
    || proof.expected_main_sha !== packet.control.expected_main_sha
    || proof.expected_main_sha !== authoritativeMain
    || proof.as_of !== packet.control.as_of) {
    throw new Error('DRY_RUN_PROOF_STALE: proof was created from a different baseline');
  }
  const requiredSteps = dryRunValidationCommands(packet).map((items) => items.join(' '));
  if (JSON.stringify(proof.validation_steps) !== JSON.stringify(requiredSteps)) {
    throw new Error('DRY_RUN_PROOF_INCOMPLETE: deterministic validation evidence is incomplete');
  }
  const expectedFiles = expectedDryRunChangedFiles(packet, { root });
  if (JSON.stringify(proof.changed_files) !== JSON.stringify(expectedFiles)) {
    throw new Error('DRY_RUN_PROOF_SCOPE_MISMATCH: dry-run changed-file evidence is not exact');
  }
}

function remoteMainSha(root) {
  const output = git(root, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).stdout.trim();
  const [sha, ref, ...extra] = output.split(/\s+/);
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || ref !== 'refs/heads/main' || extra.length) {
    throw new Error('REMOTE_MAIN_UNAVAILABLE: could not resolve exactly one authoritative refs/heads/main');
  }
  return sha;
}

export function assertRealWriteSafety(root, packet) {
  const branch = git(root, ['branch', '--show-current']).stdout.trim();
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const status = git(root, ['status', '--porcelain']).stdout.trim();
  if (!branch || ['main', 'master'].includes(branch) || !branch.startsWith('feature/')) {
    throw new Error(`DIRECT_MAIN_WRITE_REFUSED: ${branch || 'detached HEAD'}`);
  }
  if (status) throw new Error('DIRTY_WORKTREE_REFUSED: real-write mode requires a clean feature branch');
  if (head !== packet.control.expected_main_sha) throw new Error('STALE_BRANCH_REFUSED: feature branch is not at expected main');
  const authoritativeMain = remoteMainSha(root);
  if (authoritativeMain !== packet.control.expected_main_sha) {
    throw new Error('STALE_MAIN_REFUSED: authoritative remote main differs from packet authorization');
  }
  return { branch, head, authoritativeMain };
}

export function runTrustedDryRun(root, packet, packetPath, safety) {
  const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-trusted-proof-'));
  const proofPath = path.join(proofRoot, 'proof.json');
  try {
    runNode(root, 'scripts/prepare-event-publication.mjs', [`--packet=${packetPath}`, `--proof=${proofPath}`]);
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    assertDryRunProof(root, packet, packetPath, proof, safety.head, safety.authoritativeMain);
    return Object.freeze(proof);
  } finally {
    fs.rmSync(proofRoot, { recursive: true, force: true });
  }
}

function applyApprovedInputs(root, packet) {
  const eventsPath = path.join(root, 'data', 'things-to-do-events.json');
  const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
  events.records.push(packet.event);
  writeJson(eventsPath, events);

  const manifestPath = path.join(root, 'internal', 'provider-media-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.records.push(packet.media.approved_manifest);
  writeJson(manifestPath, manifest);

  const currentnessPath = path.join(root, 'data', 'things-to-do-currentness.json');
  const currentness = JSON.parse(fs.readFileSync(currentnessPath, 'utf8'));
  currentness.as_of = packet.control.as_of;
  writeJson(currentnessPath, currentness);

  const localePackage = {
    ...packet.localization.approved_package,
    event_id: packet.event.id,
    supplied_rows_approved: packet.localization.approved_package.rows.length,
    review_required: 0,
    blocking_issue: null
  };
  writeJson(path.join(root, 'data', 'locales', `pt-overlay-event-${packet.event.id}.source.json`), localePackage);

  if (packet.media.supplied_asset) {
    const target = path.join(root, packet.media.local_asset);
    if (fs.existsSync(target)) throw new Error(`MEDIA_TARGET_EXISTS: ${packet.media.local_asset}`);
    const source = fs.realpathSync(packet.media.supplied_asset);
    if (sha256File(source) !== packet.media.asset_sha256) throw new Error('MEDIA_HASH_MISMATCH');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    if (sha256File(target) !== packet.media.asset_sha256) throw new Error('MEDIA_WRITTEN_HASH_MISMATCH');
  }

  insertHomeMarkers(root, 'index.html', packet.event.id);
  insertHomeMarkers(root, path.join('pt', 'index.html'), packet.event.id);
}

function reportFor(packet, result) {
  return [
    `# ${packet.event.title}`,
    '',
    '**STATUS: READY FOR FOUNDER APPROVAL**',
    '',
    `- Source: approved packet (SHA-256 \`${result.packet_sha256}\`)`,
    '- Publication authority: approved',
    '- Localization: Project 09-approved additive package; no generated translation',
    '- Media: approved manifest and verified local asset',
    `- Currentness as of: ${packet.control.as_of}`,
    `- Validation: ${result.validations.length} incumbent validators passed`,
    '- Generation: idempotent',
    '- Diff: exact expected file scope only',
    '- Merge allowed: false',
    '',
    '## Changed files',
    '',
    ...result.changed_files.map((file) => `- \`${file}\``),
    '',
    '## Action',
    '',
    'Approve or reject this exact candidate. Do not merge automatically.',
    ''
  ].join('\n');
}

function restorePromotion(root, state) {
  if (state.closed) return;
  git(root, ['reset', '--quiet', 'HEAD', '--', ...state.files], { allowFailure: true });
  for (const entry of [...state.entries].reverse()) {
    if (entry.existed) {
      fs.mkdirSync(path.dirname(entry.target), { recursive: true });
      fs.copyFileSync(entry.backup, entry.target);
    } else if (fs.existsSync(entry.target)) {
      fs.rmSync(entry.target, { force: true });
    }
  }
  for (const dir of [...state.createdDirs].sort((a, b) => b.length - a.length)) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
  state.closed = true;
  fs.rmSync(state.backupRoot, { recursive: true, force: true });
  const remaining = git(root, ['status', '--porcelain']).stdout.trim();
  if (remaining) throw new Error(`PROMOTION_ROLLBACK_INCOMPLETE: ${remaining}`);
}

function promoteWithRecovery(root, stagingRoot, files, testHooks) {
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-promotion-backup-'));
  const state = { backupRoot, entries: [], createdDirs: new Set(), files, closed: false };
  try {
    for (const [index, relative] of files.entries()) {
      const source = path.join(stagingRoot, relative);
      const target = path.join(root, relative);
      const existed = fs.existsSync(target);
      const backup = path.join(backupRoot, relative);
      if (existed) {
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(target, backup);
      }
      state.entries.push({ relative, target, backup, existed });
      for (let dir = path.dirname(target); dir.startsWith(`${root}${path.sep}`) && !fs.existsSync(dir); dir = path.dirname(dir)) {
        state.createdDirs.add(dir);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      if (testHooks.interruptPromotionAfter === index + 1) {
        throw new Error(`INDUCED_PROMOTION_INTERRUPTION: after ${index + 1} file(s)`);
      }
    }
    return state;
  } catch (error) {
    restorePromotion(root, state);
    throw error;
  }
}

export function rollbackRealWriteCandidate(root, result) {
  const state = promotionStates.get(result);
  if (state) restorePromotion(root, state);
}

export function acceptRealWriteCommit(result) {
  const state = promotionStates.get(result);
  if (!state || state.closed) return;
  state.closed = true;
  fs.rmSync(state.backupRoot, { recursive: true, force: true });
}

export function prepareRealWriteCandidate({ root, packet, packetPath, testHooks = {} }) {
  const preflight = validatePacket(packet, { root, checkRepository: true });
  if (!preflight.ok) throw new Error(`${preflight.state}: ${preflight.issues.map((item) => item.reason).join('; ')}`);
  if (packet.control.real_write !== true || packet.control.merge_allowed !== false) throw new Error('REAL_WRITE_AUTHORIZATION_REQUIRED');
  const safety = assertRealWriteSafety(root, packet);
  if (testHooks.failDryRun) throw new Error('DRY_RUN_FAILED: induced before authoritative write');
  const proof = runTrustedDryRun(root, packet, packetPath, safety);

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-real-write-'));
  try {
    fs.cpSync(root, stagingRoot, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
    normalizeTextEol(stagingRoot);
    initializeStagingGit(stagingRoot);
    const before = inventory(stagingRoot);
    applyApprovedInputs(stagingRoot, packet);
    buildCandidate(stagingRoot, packet);

    if (testHooks.induceValidatorFailure) {
      const eventsPath = path.join(stagingRoot, 'data', 'things-to-do-events.json');
      const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
      events.records.at(-1).publication_state = 'induced-invalid-state';
      writeJson(eventsPath, events);
    }
    const validations = validateCandidate(stagingRoot, packet);

    const idempotenceBefore = inventory(stagingRoot);
    buildCandidate(stagingRoot, packet);
    const idempotenceChanges = changedFiles(idempotenceBefore, inventory(stagingRoot));
    if (idempotenceChanges.length) throw new Error(`NON_IDEMPOTENT_GENERATION: ${idempotenceChanges.join(', ')}`);

    if (testHooks.addUnexpectedFile) fs.writeFileSync(path.join(stagingRoot, 'unexpected-phase1b.txt'), 'unexpected\n');

    const artifactPath = `automation/things-to-do/runs/${packet.event.id}.json`;
    const reportPath = `automation/things-to-do/runs/${packet.event.id}.md`;
    const expected = new Set(expectedChangedFiles(packet));
    const allowed = new Set([...expected, 'data/things-to-do-currentness.json']);
    const changedBeforeArtifacts = changedFiles(before, inventory(stagingRoot));
    const unexpected = changedBeforeArtifacts.filter((file) => !allowed.has(file));
    const requiredBeforeArtifacts = [...expected].filter((file) => ![artifactPath, reportPath].includes(file));
    const missing = requiredBeforeArtifacts.filter((file) => !changedBeforeArtifacts.includes(file));
    if (unexpected.length || missing.length) {
      throw new Error(`UNEXPECTED_CHANGED_FILE_SCOPE: unexpected=[${unexpected.join(', ')}] missing=[${missing.join(', ')}]`);
    }

    const finalChanged = [...new Set([...changedBeforeArtifacts, artifactPath, reportPath])].sort();
    const result = {
      artifact_version: 1,
      artifact_type: 'things-to-do-publication-real-write-result',
      status: 'FOUNDER_APPROVAL_REQUIRED',
      event_id: packet.event.id,
      packet_sha256: sha256File(packetPath),
      dry_run_proof_sha256: crypto.createHash('sha256').update(JSON.stringify(proof)).digest('hex'),
      base_main_sha: safety.head,
      branch: safety.branch,
      as_of: packet.control.as_of,
      changed_files: finalChanged,
      validations: validations.map((item) => item.step),
      idempotent: true,
      merge_allowed: false,
      created_at: new Date().toISOString()
    };
    writeJson(path.join(stagingRoot, artifactPath), result);
    fs.mkdirSync(path.dirname(path.join(stagingRoot, reportPath)), { recursive: true });
    fs.writeFileSync(path.join(stagingRoot, reportPath), reportFor(packet, result));

    const actualFinal = changedFiles(before, inventory(stagingRoot));
    if (JSON.stringify(actualFinal) !== JSON.stringify(finalChanged)) {
      throw new Error(`FINAL_CHANGED_FILE_SCOPE_MISMATCH: ${actualFinal.join(', ')}`);
    }
    git(stagingRoot, ['add', '-N', '.']);
    git(stagingRoot, ['diff', '--check']);

    // Re-check the authoritative worktree immediately before the only write.
    const finalSafety = assertRealWriteSafety(root, packet);
    assertDryRunProof(root, packet, packetPath, proof, finalSafety.head, finalSafety.authoritativeMain);
    const promotion = promoteWithRecovery(root, stagingRoot, finalChanged, testHooks);
    promotionStates.set(result, promotion);
    return result;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function inspectRemoteBranch(root, branch) {
  const probe = git(root, ['ls-remote', 'origin', `refs/heads/${branch}`], { allowFailure: true });
  if (probe.status !== 0 || !probe.stdout.trim()) return null;
  return probe.stdout.trim().split(/\s+/)[0] ?? null;
}

function inspectDraftPr(root, repository, branch) {
  if (!repository) return null;
  const probe = command(root, 'gh', [
    'pr', 'list', '--repo', repository, '--head', branch, '--state', 'open',
    '--json', 'url,isDraft,headRefOid'
  ], { allowFailure: true });
  if (probe.status !== 0) return null;
  try {
    return JSON.parse(probe.stdout)[0] ?? null;
  } catch {
    return null;
  }
}

export function finalizeRealWriteCandidate({
  root,
  packet,
  result,
  repository = 'jasonlamardjones/aprasa-site',
  testHooks = {}
}) {
  let committed = false;
  let candidateSha = null;
  try {
    git(root, ['add', '--', ...result.changed_files]);
    if (testHooks.induceStagingFailure) throw new Error('INDUCED_STAGING_FAILURE');
    git(root, ['diff', '--cached', '--check']);
    const staged = git(root, ['diff', '--cached', '--name-only']).stdout.trim().split(/\r?\n/).filter(Boolean).sort();
    if (JSON.stringify(staged) !== JSON.stringify([...result.changed_files].sort())) {
      throw new Error(`STAGED_SCOPE_MISMATCH: ${staged.join(', ')}`);
    }
    if (testHooks.induceCommitFailure) throw new Error('INDUCED_COMMIT_FAILURE');
    git(root, ['commit', '-m', `Prepare approved event publication: ${packet.event.title}`]);
    committed = true;
    candidateSha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
    acceptRealWriteCommit(result);

    if (testHooks.inducePushFailure) throw new Error('INDUCED_PUSH_FAILURE');
    git(root, ['push', '--set-upstream', 'origin', result.branch]);
    if (testHooks.inducePrFailure) throw new Error('INDUCED_PR_CREATION_FAILURE');
    const prUrl = command(root, 'gh', [
      'pr', 'create', '--repo', repository, '--draft', '--base', 'main', '--head', result.branch,
      '--title', `Publish approved event: ${packet.event.title}`,
      '--body-file', `automation/things-to-do/runs/${packet.event.id}.md`
    ]).stdout.trim();
    return { candidateSha, prUrl, pushed: true, prExists: true };
  } catch (error) {
    if (!committed) {
      rollbackRealWriteCandidate(root, result);
      const failure = new Error(error.message);
      failure.recovery = {
        phase: 'PRE_COMMIT',
        worktree_restored: true,
        branch: result.branch,
        head_sha: git(root, ['rev-parse', 'HEAD']).stdout.trim(),
        pushed: false,
        pr_exists: false,
        resume_action: 'Correct the reported failure and rerun the full guarded real-write command from the clean authorized baseline.'
      };
      throw failure;
    }

    acceptRealWriteCommit(result);
    const remoteSha = inspectRemoteBranch(root, result.branch);
    const pr = inspectDraftPr(root, repository, result.branch);
    const pushed = remoteSha === candidateSha;
    const prExists = Boolean(pr?.isDraft && pr?.headRefOid === candidateSha);
    const resumeAction = pushed
      ? (prExists
          ? `Inspect the existing draft PR at ${pr.url}; no new commit or PR is required.`
          : `Create the draft PR for ${result.branch} at commit ${candidateSha}; do not rerun candidate construction.`)
      : `Push ${result.branch} at commit ${candidateSha}, then create its draft PR; do not rebuild or amend the commit.`;
    const failure = new Error(error.message);
    failure.recovery = {
      phase: 'POST_COMMIT',
      worktree_restored: false,
      branch: result.branch,
      head_sha: candidateSha,
      pushed,
      remote_sha: remoteSha,
      pr_exists: prExists,
      pr_url: pr?.url ?? null,
      resume_action: resumeAction
    };
    throw failure;
  }
}
