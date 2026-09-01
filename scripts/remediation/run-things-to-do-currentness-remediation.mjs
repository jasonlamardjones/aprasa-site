import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSchema, validateAgainstSchema } from '../qa/lib/qa-schema.mjs';
import {
  assessDuplicateState,
  assertBoundedWriteSet,
  assertIdempotentChanges,
  assertSchemaValidation,
  assertValidatorResults,
  assertWorkflowArtifactProvenance,
  assertDriftShapeUnchanged,
  authorizeReport,
  expectedWriteSetForIds,
  parseOpenPrProbe,
  parseRemoteBranchProbe,
  parseValidatorDriftIds,
} from './lib/things-to-do-currentness-remediation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.txt', '.xml', '.yaml', '.yml']);

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function command(cwd, executable, args, { allowFailure = false } = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env: process.env });
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${executable} ${args.join(' ')} failed (${result.status})${detail ? `:\n${detail}` : ''}`);
  }
  return result;
}

function git(cwd, args, options) { return command(cwd, 'git', args, options); }
function node(cwd, script, args = [], options) { return command(cwd, process.execPath, [script, ...args], options); }

function remoteMainSha() {
  const output = git(root, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).stdout.trim();
  const [sha, ref, ...extra] = output.split(/\s+/);
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || ref !== 'refs/heads/main' || extra.length) {
    throw new Error('PHASE2B_REMOTE_MAIN_UNAVAILABLE');
  }
  return sha;
}

function inventory(dir) {
  const map = new Map();
  function visit(current) {
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
  }
  visit(dir);
  return map;
}

function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

function writeCurrentnessAsOf(dir, asOf) {
  const file = path.join(dir, 'data', 'things-to-do-currentness.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.as_of = asOf;
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

function runCanonicalGeneration(dir, asOf, ids) {
  writeCurrentnessAsOf(dir, asOf);
  for (const id of ids) {
    node(dir, 'scripts/generate-things-to-do.mjs', [`--as-of=${asOf}`, `--id=${id}`, '--locale=en', '--write']);
    node(dir, 'scripts/generate-things-to-do.mjs', [`--as-of=${asOf}`, `--id=${id}`, '--locale=pt', '--home=pt/index.html', '--write']);
  }
}

function runIncumbentValidators(dir, asOf) {
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
    const step = [script, ...args].join(' ');
    const result = node(dir, script, args, { allowFailure: true });
    return { step, status: result.status };
  });
  assertValidatorResults(results);
  return results.map((item) => item.step);
}

function assertGeneratorOwnsIds(ids) {
  const records = JSON.parse(fs.readFileSync(path.join(root, 'data', 'things-to-do-events.json'), 'utf8')).records;
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const id of ids) {
    const record = byId.get(id);
    if (!record || record.kind !== 'dated-event') throw new Error(`PHASE2B_GENERATOR_OWNERSHIP_UNPROVEN: ${id}`);
    if (record.detail_page !== `things-to-do/${id}/`) throw new Error(`PHASE2B_GENERATOR_ROUTE_AMBIGUOUS: ${id}`);
  }
}

function inspectDuplicate(repository, branch) {
  // Both probes are captured with allowFailure so the parsers can raise a
  // fail-closed Phase 2B error instead of a generic command failure; neither
  // may degrade into an unproven "no branch"/"no pull request" reading.
  const branchProbe = git(root, ['ls-remote', 'origin', `refs/heads/${branch}`], { allowFailure: true });
  const remoteBranchSha = parseRemoteBranchProbe(branchProbe, branch);
  const prProbe = command(root, 'gh', [
    'pr', 'list', '--repo', repository, '--head', branch, '--state', 'open',
    '--json', 'url,isDraft,headRefOid',
  ], { allowFailure: true });
  const draftPr = parseOpenPrProbe(prProbe, { repository, branch });
  return { remoteBranchSha, draftPr, state: assessDuplicateState({ remoteBranchSha, draftPr }) };
}

function rollbackFiles(backups) {
  for (const item of [...backups].reverse()) {
    if (item.existed) fs.copyFileSync(item.backup, item.target);
    else if (fs.existsSync(item.target)) fs.rmSync(item.target, { force: true });
  }
}

function promoteFiles(stagingRoot, files) {
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-phase2b-backup-'));
  const backups = [];
  try {
    for (const relative of files) {
      const source = path.join(stagingRoot, relative);
      const target = path.join(root, relative);
      const backup = path.join(backupRoot, relative);
      const existed = fs.existsSync(target);
      if (existed) {
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(target, backup);
      }
      backups.push({ target, backup, existed });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    return { backupRoot, backups };
  } catch (error) {
    rollbackFiles(backups);
    fs.rmSync(backupRoot, { recursive: true, force: true });
    throw error;
  }
}

function restorePromotion(promotion) {
  rollbackFiles(promotion.backups);
  fs.rmSync(promotion.backupRoot, { recursive: true, force: true });
}

function acceptPromotion(promotion) {
  fs.rmSync(promotion.backupRoot, { recursive: true, force: true });
}

function reportBody(auth, changed, validations, candidateSha) {
  return [
    '## Phase 2B bounded currentness repair',
    '',
    `- Authorization: \`SOURCE_CURRENTNESS_DRIFT + ${auth.finding.validator_id}\``,
    `- QA run: \`${auth.reportRunId ?? 'unknown'}\` attempt \`${auth.reportRunAttempt ?? 'unknown'}\``,
    `- Report completed: \`${auth.completedAt}\``,
    `- Currentness as-of: \`${auth.asOf}\``,
    `- Base main: \`${auth.expectedMain}\``,
    `- Repair identity: \`${auth.repairIdentity}\``,
    `- Candidate: \`${candidateSha}\``,
    `- Revalidated drift IDs: ${auth.reportedIds.map((id) => `\`${id}\``).join(', ')}`,
    '- Canonical generator: `scripts/generate-things-to-do.mjs`',
    '- Idempotence: passed',
    '- Merge authority: **none**',
    '- Deployment authority: **none**',
    '',
    '### Changed files',
    '',
    ...changed.map((file) => `- \`${file}\``),
    '',
    '### Incumbent validators',
    '',
    ...validations.map((step) => `- \`${step}\``),
    '',
    'Exact-SHA independent review is required before any merge.',
    '',
  ].join('\n');
}

const reportPathArg = arg('report');
const repository = arg('repository', 'jasonlamardjones/aprasa-site');
const workflowRunId = arg('workflow-run-id');
const workflowRunAttempt = arg('workflow-run-attempt');
const workflowHeadSha = arg('workflow-head-sha');
if (!reportPathArg) throw new Error('PHASE2B_REPORT_PATH_REQUIRED');
const reportPath = path.resolve(root, reportPathArg);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const schema = loadSchema(path.join(root, 'scripts', 'qa', 'qa-report.schema.json'));
const schemaErrors = validateAgainstSchema(report, schema);
assertSchemaValidation(schemaErrors);

const firstMain = remoteMainSha();
const auth = authorizeReport(report, { remoteMainSha: firstMain });
if (auth.status === 'NO_AUTHORIZED_FINDING') {
  console.log('PHASE2B_SKIP: no authorized finding in this report.');
  process.exit(0);
}
assertWorkflowArtifactProvenance(auth, { runId: workflowRunId, runAttempt: workflowRunAttempt, headSha: workflowHeadSha });

const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
const status = git(root, ['status', '--porcelain']).stdout.trim();
if (head !== auth.expectedMain) throw new Error('PHASE2B_CHECKOUT_NOT_AUTHORIZED_MAIN');
if (status) throw new Error('PHASE2B_DIRTY_WORKTREE_REFUSED');

const duplicate = inspectDuplicate(repository, auth.branch);
if (duplicate.state === 'EQUIVALENT_DRAFT_PR_EXISTS') {
  console.log(`PHASE2B_SUPPRESSED_DUPLICATE: ${duplicate.draftPr.url}`);
  process.exit(0);
}
if (duplicate.state !== 'CLEAR') throw new Error(`PHASE2B_DUPLICATE_STATE_REFUSED: ${duplicate.state}`);

const currentness = node(root, 'scripts/validate-things-to-do-currentness.mjs', [`--as-of=${auth.asOf}`], { allowFailure: true });
if (currentness.status === 0) throw new Error('PHASE2B_DRIFT_DISAPPEARED');
if (currentness.status !== 1) throw new Error(`PHASE2B_CURRENTNESS_REVALIDATION_ERROR: exit ${currentness.status}`);
const currentIds = parseValidatorDriftIds(currentness.stderr);
assertDriftShapeUnchanged(auth.reportedIds, currentIds);
assertGeneratorOwnsIds(currentIds);

const allowedWriteSet = expectedWriteSetForIds(currentIds);
const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-phase2b-stage-'));
let promotion = null;
let committed = false;
let candidateSha = null;
try {
  fs.cpSync(root, stagingRoot, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
  git(stagingRoot, ['init', '-q', '-b', 'staging']);
  git(stagingRoot, ['config', 'user.name', 'A PRASA Phase 2B Automation']);
  git(stagingRoot, ['config', 'user.email', 'automation@aprasa.org']);
  git(stagingRoot, ['add', '.']);
  git(stagingRoot, ['commit', '-q', '-m', 'staging baseline']);

  const before = inventory(stagingRoot);
  runCanonicalGeneration(stagingRoot, auth.asOf, currentIds);
  const changed = assertBoundedWriteSet(changedFiles(before, inventory(stagingRoot)), allowedWriteSet);
  const validations = runIncumbentValidators(stagingRoot, auth.asOf);

  const idempotenceBefore = inventory(stagingRoot);
  runCanonicalGeneration(stagingRoot, auth.asOf, currentIds);
  const idempotenceChanges = changedFiles(idempotenceBefore, inventory(stagingRoot));
  assertIdempotentChanges(idempotenceChanges);
  git(stagingRoot, ['add', '-N', '.']);
  git(stagingRoot, ['diff', '--check']);

  if (remoteMainSha() !== auth.expectedMain) throw new Error('PHASE2B_MAIN_MOVED_BEFORE_WRITE');
  const duplicateBeforeWrite = inspectDuplicate(repository, auth.branch);
  if (duplicateBeforeWrite.state !== 'CLEAR') throw new Error(`PHASE2B_CONCURRENT_REPAIR_REFUSED: ${duplicateBeforeWrite.state}`);

  git(root, ['switch', '-c', auth.branch]);
  promotion = promoteFiles(stagingRoot, changed);
  git(root, ['add', '--', ...changed]);
  git(root, ['diff', '--cached', '--check']);
  const staged = git(root, ['diff', '--cached', '--name-only']).stdout.trim().split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(staged) !== JSON.stringify(changed)) throw new Error(`PHASE2B_STAGED_SCOPE_MISMATCH: ${staged.join(', ')}`);

  git(root, ['commit', '-m', `Automated repair: Things-to-Do currentness ${auth.asOf}`]);
  committed = true;
  candidateSha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  acceptPromotion(promotion);
  promotion = null;

  if (remoteMainSha() !== auth.expectedMain) throw new Error('PHASE2B_MAIN_MOVED_BEFORE_PUSH');
  const duplicateBeforePush = inspectDuplicate(repository, auth.branch);
  if (duplicateBeforePush.state !== 'CLEAR') throw new Error(`PHASE2B_CONCURRENT_REPAIR_BEFORE_PUSH: ${duplicateBeforePush.state}`);

  git(root, ['push', '--set-upstream', 'origin', auth.branch]);
  const bodyFile = path.join(os.tmpdir(), `phase2b-pr-${candidateSha}.md`);
  fs.writeFileSync(bodyFile, reportBody(auth, changed, validations, candidateSha));
  const prUrl = command(root, 'gh', [
    'pr', 'create', '--repo', repository, '--draft', '--base', 'main', '--head', auth.branch,
    '--title', `Automated repair: Things-to-Do currentness (${auth.asOf})`,
    '--body-file', bodyFile,
  ]).stdout.trim();
  fs.rmSync(bodyFile, { force: true });

  console.log(JSON.stringify({
    status: 'DRAFT_PR_CREATED',
    candidate_sha: candidateSha,
    branch: auth.branch,
    pr_url: prUrl,
    repair_identity: auth.repairIdentity,
    changed_files: changed,
    validations,
    idempotent: true,
    merge_allowed: false,
    deploy_allowed: false,
  }, null, 2));
} catch (error) {
  if (!committed && promotion) {
    git(root, ['reset', '--quiet', 'HEAD', '--'], { allowFailure: true });
    restorePromotion(promotion);
    git(root, ['switch', '--detach', auth.expectedMain], { allowFailure: true });
  }
  if (committed) {
    const remote = git(root, ['ls-remote', 'origin', `refs/heads/${auth.branch}`], { allowFailure: true }).stdout.trim();
    const remoteSha = remote ? remote.split(/\s+/)[0] : null;
    const recovery = remoteSha === candidateSha
      ? `Candidate ${candidateSha} is already pushed on ${auth.branch}; create/inspect one draft PR only. Do not rebuild or amend it.`
      : `Candidate ${candidateSha} was committed locally but not safely published. Do not infer success; inspect the failed workflow and rerun only after reauthorization from a fresh QA report.`;
    throw new Error(`${error.message}\nPHASE2B_POST_COMMIT_RECOVERY: ${recovery}`);
  }
  throw error;
} finally {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}
