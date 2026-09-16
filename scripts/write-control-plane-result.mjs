#!/usr/bin/env node
// Builds and persists one provider-neutral control-plane task-result record.
//
// Usage:
//   node scripts/write-control-plane-result.mjs --draft=<path-to-draft.json> \
//     [--ref=<results-ref>] [--root=<repo-root>] [--publish] [--remote=<name>]
//
// --root defaults to this script's own checkout, matching every other
// scripts/*.mjs entrypoint in this repository, which resolve relative to
// their own file location rather than process.cwd(). Pass --root explicitly
// to target a different repository (an isolated test sandbox, a worktree,
// or a different checkout) instead of this one.
//
// The draft file supplies exactly the fields that vary per instance
// (resultType, taskId/candidateId, repositorySha, reason, requiredInput,
// evidenceDigest, reviewer, upstreamRefs, ...). status/owner/resume_point are
// always derived from the fixed result_type mapping in
// scripts/lib/control-plane-result.mjs; a draft cannot override them.
//
// Persistence is a dedicated git ref (default refs/heads/control-plane-task-
// results), written via plumbing only — no commit lands on whatever branch
// happens to be checked out, so persisting a REVIEW_PASSED/REVIEW_FAILED
// record can never change the exact repository.sha it is evidence about.
// This never pushes the candidate branch, merges, deploys, or grants any
// authority.
//
// Without --publish, the result is committed only to the local ref — durable
// inside this checkout, not across it. With --publish, the result is also
// pushed to the named remote (default origin) via publishResult: it
// reconciles against the remote's current tip first, and only ever advances
// it with a fast-forward push, never a forced one, retrying against a moved
// remote rather than clobbering it.
//
// Retrying the same logical draft — the same content, at a later instant —
// is a no-op either way: result_id excludes created_at, so identity is
// stable across retries and a rerun reports ALREADY_PRESENT rather than
// minting a second record.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildResult, publishResult, writeResult } from './lib/control-plane-result.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const draftArg = process.argv.find((arg) => arg.startsWith('--draft='));
const refArg = process.argv.find((arg) => arg.startsWith('--ref='));
const rootArg = process.argv.find((arg) => arg.startsWith('--root='));
const remoteArg = process.argv.find((arg) => arg.startsWith('--remote='));
const publish = process.argv.includes('--publish');
const ROOT = rootArg ? path.resolve(rootArg.slice('--root='.length)) : DEFAULT_ROOT;

if (!draftArg) {
  console.error('Usage: node scripts/write-control-plane-result.mjs --draft=<path-to-draft.json> [--ref=<results-ref>] [--root=<repo-root>] [--publish] [--remote=<name>]');
  process.exit(2);
}

try {
  const draftPath = path.resolve(ROOT, draftArg.slice('--draft='.length));
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  const record = buildResult(draft);
  const options = {
    ...(refArg ? { ref: refArg.slice('--ref='.length) } : {}),
    ...(remoteArg ? { remote: remoteArg.slice('--remote='.length) } : {})
  };
  const outcome = publish ? publishResult(ROOT, record, options) : writeResult(ROOT, record, options);
  console.log(JSON.stringify({
    status: outcome.written
      ? (publish ? 'PUBLISHED' : 'WRITTEN')
      : (publish ? 'REMOTE_ALREADY_PRESENT' : 'ALREADY_PRESENT'),
    result_id: record.result_id,
    result_type: record.result_type,
    ref: outcome.ref,
    commit: outcome.commit,
    path: outcome.path,
    ...(publish ? { remote: outcome.remote, remote_tip: outcome.remote_tip, published: outcome.published } : {}),
    grants_publication_authority: record.grants_publication_authority
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'TASK_RESULT_WRITE_FAILED', reason: error.message }, null, 2));
  process.exit(1);
}
