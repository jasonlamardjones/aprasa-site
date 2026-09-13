// Durable failure signal for the Phase 2B remediation workflow.
//
// Invoked ONLY from the workflow's `if: failure()` step, so a green run never
// reaches it and nothing is created. All decision logic lives in
// lib/phase2b-failure-signal.mjs and is unit tested without GitHub; this file
// is the thin GitHub boundary.
//
// Authority: GitHub issue text only. It never writes a branch, a commit, a pull
// request, a generated surface or a canonical record.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FAILURE_SIGNAL,
  buildIssueBody,
  buildRecurrenceComment,
  classifyFailure,
  decideFailureSignal,
  failureIssueTitle,
  parseOpenFailureIssueProbe,
} from './lib/phase2b-failure-signal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function gh(args, { allowFailure = false } = {}) {
  const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8', env: process.env });
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`gh ${args.join(' ')} failed (${result.status})${detail ? `:\n${detail}` : ''}`);
  }
  return result;
}

const repository = arg('repository');
const runId = arg('run-id');
const runAttempt = arg('run-attempt', '1');
const commit = arg('commit');
const logPath = arg('log');
if (!repository) throw new Error('PHASE2B_FAILURE_REPOSITORY_REQUIRED');

// A missing or unreadable log is itself a failure worth signalling — the run may
// have died before the adapter wrote anything — so classify it rather than
// aborting the signal.
let log = '';
if (logPath) {
  const resolved = path.resolve(root, logPath);
  if (fs.existsSync(resolved)) log = fs.readFileSync(resolved, 'utf8');
}
const failureClass = classifyFailure(log);
const context = { failureClass, commit, runId, runAttempt };

// Dedupe is read by label, not by the search index: label listing is immediately
// consistent, whereas `--search ... in:body` can lag behind a just-created issue
// and hand back "nothing exists" — precisely the reading that produces
// duplicates. The label is created idempotently; an "already exists" result is
// the expected steady state, not an error.
gh(['label', 'create', FAILURE_SIGNAL.label,
  '--repo', repository,
  '--color', 'B60205',
  '--description', 'Phase 2B bounded remediation refused to produce a repair',
], { allowFailure: true });

const probe = gh(['issue', 'list',
  '--repo', repository,
  '--label', FAILURE_SIGNAL.label,
  '--state', 'open',
  '--limit', '100',
  '--json', 'number,url,body,comments',
], { allowFailure: true });

const decision = decideFailureSignal({ context, issue: null });
const issue = parseOpenFailureIssueProbe(probe, { key: decision.key });
const resolvedDecision = decideFailureSignal({ context, issue });

if (resolvedDecision.action === 'NONE') {
  console.log(JSON.stringify({
    status: 'FAILURE_SIGNAL_ALREADY_RECORDED',
    failure_class: resolvedDecision.failureClass,
    issue_url: issue.url,
    commit,
  }, null, 2));
  process.exit(0);
}

if (resolvedDecision.action === 'COMMENT') {
  gh(['issue', 'comment', String(issue.number),
    '--repo', repository,
    '--body', buildRecurrenceComment(context, { repository }),
  ]);
  console.log(JSON.stringify({
    status: 'FAILURE_SIGNAL_RECURRENCE_RECORDED',
    failure_class: resolvedDecision.failureClass,
    issue_url: issue.url,
    commit,
  }, null, 2));
  process.exit(0);
}

const created = gh(['issue', 'create',
  '--repo', repository,
  '--label', FAILURE_SIGNAL.label,
  '--title', failureIssueTitle(resolvedDecision.failureClass),
  '--body', buildIssueBody(context, { repository, key: resolvedDecision.key }),
]).stdout.trim();

console.log(JSON.stringify({
  status: 'FAILURE_SIGNAL_CREATED',
  failure_class: resolvedDecision.failureClass,
  issue_url: created,
  commit,
}, null, 2));
