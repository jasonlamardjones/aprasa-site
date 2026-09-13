// Failure visibility for the Phase 2B bounded currentness remediation.
//
// Until this module existed, a Phase 2B run that refused to produce a repair
// was operationally silent: the adapter fails closed (which is correct), no
// draft PR appears (also correct), and the only trace is a red Actions run
// nobody is required to look at. The incumbent Phase 2A/2B surface has no
// notification pattern to reuse — the delayed-recheck reconciler keeps all of
// its state in the artifact store and notifies nothing — so this is the
// smallest durable GitHub-native signal that closes that gap.
//
// Shape: ONE open GitHub issue per (workflow, failure class), carrying run and
// commit context, updated rather than duplicated.
//
//   * A green run calls none of this, so it creates nothing.
//   * A repeat of the same failure class on a commit already recorded on the
//     open issue does nothing at all — no second issue, no further comment.
//   * A repeat of the same failure class on a NEW commit adds exactly one
//     comment. Growth is therefore bounded by distinct failing commits, not by
//     firings, and a burst of identical retries cannot spam the issue.
//   * One exception to that suppression, because commit identity alone is not
//     the whole disposition: if a commit was first recorded as a PRE-commit
//     refusal and a later run on that same commit reaches POST-commit recovery,
//     the recorded text understates what exists — it still says no branch or
//     commit was created while a candidate may now be pushed. That escalation
//     adds one corrective comment. It is one-directional (pre -> post, never
//     back) and recorded per commit, so the ceiling stays at two comments per
//     commit and cannot oscillate.
//
// It never mutates public content: no generated surface, no canonical record,
// no branch, no pull request. Issue text only.
//
// Dedupe authority is fail-closed for the same reason the branch and
// pull-request probes are: a probe that did not demonstrably succeed must
// never be read as "no issue exists", because that reading is what creates
// duplicates. See parseOpenFailureIssueProbe below.

import crypto from 'node:crypto';

export const FAILURE_SIGNAL = Object.freeze({
  workflow: 'phase-2b-things-to-do-currentness',
  label: 'phase-2b-remediation-failure',
  keyMarkerPrefix: 'phase2b-failure-signal',
  commitMarkerPrefix: 'phase2b-failure-commit',
  recoveryMarkerPrefix: 'phase2b-failure-recovery',
  unclassified: 'PHASE2B_UNCLASSIFIED_FAILURE',
});

const SHA_PATTERN = /^[a-f0-9]{40}$/;

/**
 * The failure class is the adapter's own fail-closed error code. Classifying on
 * the first PHASE2B_* token in the captured log keeps the issue keyed to the
 * refusal reason rather than to an incidental line of stack trace, so the same
 * defect recurring is recognised as the same defect.
 */
export function classifyFailure(log) {
  if (typeof log !== 'string') return FAILURE_SIGNAL.unclassified;
  const match = log.match(/PHASE2B_[A-Z0-9_]+/);
  if (!match) return FAILURE_SIGNAL.unclassified;
  // POST_COMMIT_RECOVERY is guidance appended to another error, never the
  // failure class itself.
  if (match[0] === 'PHASE2B_POST_COMMIT_RECOVERY') {
    const real = log.match(/PHASE2B_(?!POST_COMMIT_RECOVERY)[A-Z0-9_]+/);
    return real ? real[0] : FAILURE_SIGNAL.unclassified;
  }
  return match[0];
}

/**
 * Whether the adapter failed AFTER committing the repair.
 *
 * The adapter's own recovery path raises PHASE2B_POST_COMMIT_RECOVERY when a
 * failure lands past the commit — for example the push succeeded but creating
 * the draft pull request did not. A candidate branch and commit may then exist
 * remotely, so the issue must not tell an investigator that nothing was
 * created: that reading invites a rerun on top of a live candidate.
 */
export function detectPostCommitRecovery(log) {
  if (typeof log !== 'string') return null;
  const match = log.match(/PHASE2B_POST_COMMIT_RECOVERY:\s*(.+)/);
  return match ? match[1].trim().slice(0, 400) : null;
}

/** Stable dedupe key for one (workflow, failure class) pair. */
export function failureSignalKey(failureClass) {
  if (typeof failureClass !== 'string' || !/^[A-Z0-9_]+$/.test(failureClass)) {
    throw new Error('PHASE2B_FAILURE_CLASS_UNREADABLE');
  }
  return crypto.createHash('sha256')
    .update(`${FAILURE_SIGNAL.keyMarkerPrefix}:${FAILURE_SIGNAL.workflow}:${failureClass}`)
    .digest('hex')
    .slice(0, 16);
}

export function keyMarker(key) {
  return `<!-- ${FAILURE_SIGNAL.keyMarkerPrefix}: ${key} -->`;
}

export function commitMarker(sha) {
  if (!SHA_PATTERN.test(sha ?? '')) throw new Error('PHASE2B_FAILURE_COMMIT_UNREADABLE');
  return `<!-- ${FAILURE_SIGNAL.commitMarkerPrefix}: ${sha} -->`;
}

/**
 * Records that this commit's failure landed AFTER the commit, so the escalation
 * is not re-reported on every later firing. Absent on pre-commit refusals.
 */
export function recoveryMarker(sha) {
  if (!SHA_PATTERN.test(sha ?? '')) throw new Error('PHASE2B_FAILURE_COMMIT_UNREADABLE');
  return `<!-- ${FAILURE_SIGNAL.recoveryMarkerPrefix}: ${sha} -->`;
}

function requireContext(context) {
  const failureClass = classifyFailure(context?.log ?? context?.failureClass ?? '');
  const commit = context?.commit;
  if (!SHA_PATTERN.test(commit ?? '')) throw new Error('PHASE2B_FAILURE_COMMIT_UNREADABLE');
  const runId = context?.runId;
  const runAttempt = context?.runAttempt;
  if (!runId) throw new Error('PHASE2B_FAILURE_RUN_CONTEXT_UNREADABLE');
  if (!runAttempt) throw new Error('PHASE2B_FAILURE_RUN_CONTEXT_UNREADABLE');
  return { failureClass, commit, runId: String(runId), runAttempt: String(runAttempt) };
}

/**
 * Fail-closed reader for the open-issue probe. Mirrors
 * parseRemoteBranchProbe/parseOpenPrProbe: only a successful command with a
 * well-formed result may report "no open signal issue".
 */
export function parseOpenFailureIssueProbe(probe, { key, limit = null } = {}) {
  if (typeof key !== 'string' || !key) throw new Error('PHASE2B_FAILURE_SIGNAL_KEY_REQUIRED');
  if (!probe || probe.status !== 0) {
    const detail = [probe?.stderr, probe?.stdout].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim();
    throw new Error(`PHASE2B_FAILURE_SIGNAL_PROBE_FAILED: exit ${probe?.status ?? 'unknown'}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  if (typeof probe.stdout !== 'string') throw new Error('PHASE2B_FAILURE_SIGNAL_PROBE_UNREADABLE: no probe output');
  let parsed;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    throw new Error('PHASE2B_FAILURE_SIGNAL_PROBE_UNREADABLE: probe did not return JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('PHASE2B_FAILURE_SIGNAL_PROBE_UNREADABLE: expected a JSON array');
  // `gh issue list --limit N` caps how many issues are FETCHED, so a full page
  // is not evidence that nothing further matches: an older issue carrying this
  // marker could sit just outside it, and reading that as proven absence is
  // exactly how a duplicate gets created. A result that reaches the limit is
  // therefore refused rather than trusted.
  if (limit !== null && parsed.length >= limit) {
    throw new Error(`PHASE2B_FAILURE_SIGNAL_PROBE_TRUNCATED: ${parsed.length} open labelled issues reached the probe limit of ${limit}`);
  }
  const marker = keyMarker(key);
  const matching = parsed.filter((record) => typeof record?.body === 'string' && record.body.includes(marker));
  if (!matching.length) return null;
  if (matching.length > 1) {
    throw new Error(`PHASE2B_FAILURE_SIGNAL_AMBIGUOUS: ${matching.length} open issues carry ${marker}`);
  }
  const record = matching[0];
  if (!Number.isInteger(record.number) || record.number <= 0) {
    throw new Error('PHASE2B_FAILURE_SIGNAL_PROBE_UNREADABLE: missing issue number');
  }
  if (typeof record.url !== 'string' || !record.url) {
    throw new Error('PHASE2B_FAILURE_SIGNAL_PROBE_UNREADABLE: missing issue url');
  }
  const comments = Array.isArray(record.comments) ? record.comments : [];
  for (const comment of comments) {
    if (!comment || typeof comment.body !== 'string') {
      throw new Error('PHASE2B_FAILURE_SIGNAL_PROBE_UNREADABLE: malformed comment record');
    }
  }
  return Object.freeze({
    number: record.number,
    url: record.url,
    body: record.body,
    comments: comments.map((comment) => comment.body),
  });
}

/** Commits already recorded on an open signal issue, body and comments alike. */
function markedCommits(issue, prefix) {
  if (!issue) return [];
  const pattern = new RegExp(`<!--\\s*${prefix}:\\s*([a-f0-9]{40})\\s*-->`, 'g');
  const haystack = [issue.body ?? '', ...(issue.comments ?? [])].join('\n');
  return [...new Set([...haystack.matchAll(pattern)].map((match) => match[1]))].sort();
}

export function recordedCommits(issue) {
  return markedCommits(issue, FAILURE_SIGNAL.commitMarkerPrefix);
}

/** Commits already recorded as having failed AFTER the repair commit. */
export function recordedRecoveryCommits(issue) {
  return markedCommits(issue, FAILURE_SIGNAL.recoveryMarkerPrefix);
}

export function failureIssueTitle(failureClass) {
  return `Phase 2B remediation failed: ${failureClass}`;
}

function contextLines({ failureClass, commit, runId, runAttempt }, repository) {
  const runUrl = repository ? `https://github.com/${repository}/actions/runs/${runId}` : null;
  return [
    `- Failure class: \`${failureClass}\``,
    `- Workflow: \`${FAILURE_SIGNAL.workflow}\``,
    `- Commit: \`${commit}\``,
    `- Run: ${runUrl ? `${runUrl} (attempt ${runAttempt})` : `\`${runId}\` attempt \`${runAttempt}\``}`,
  ];
}

export function buildIssueBody(context, { repository = null, key } = {}) {
  const resolved = requireContext(context);
  const recovery = detectPostCommitRecovery(context?.log ?? '');
  // Only a pre-commit refusal may claim nothing was created. Past the commit a
  // candidate branch may already be pushed, and saying otherwise would send an
  // investigator to rerun the repair on top of it.
  const disposition = recovery
    ? [
      'The remediation adapter failed AFTER committing its candidate, so this is',
      'NOT a clean no-op: a candidate branch and commit may already exist on the',
      'remote. Do not rerun the repair before inspecting that state. `main` was',
      'not modified and nothing was deployed.',
      '',
      `> ${recovery}`,
    ]
    : [
      'The remediation adapter refused to produce a repair before committing',
      'anything. It fails closed by design, so no branch, no commit and no draft',
      'pull request were created and no published surface changed.',
    ];
  return [
    keyMarker(key ?? failureSignalKey(resolved.failureClass)),
    commitMarker(resolved.commit),
    ...(recovery ? [recoveryMarker(resolved.commit)] : []),
    '',
    '## Phase 2B bounded currentness remediation failed',
    '',
    ...disposition,
    '',
    'This issue exists so the failure is visible without anyone having to notice',
    'a red Actions run.',
    '',
    ...contextLines(resolved, repository),
    '',
    'Investigate the linked run. Resolve and close this issue once the failure',
    'class no longer reproduces; a new open issue is raised only for a failure',
    'class that has none.',
    '',
    'This issue carries no merge, deployment or content authority.',
    '',
  ].join('\n');
}

export function buildRecurrenceComment(context, { repository = null, escalation = false } = {}) {
  const resolved = requireContext(context);
  const recovery = detectPostCommitRecovery(context?.log ?? '');
  return [
    commitMarker(resolved.commit),
    ...(recovery ? [recoveryMarker(resolved.commit)] : []),
    '',
    escalation
      ? 'CORRECTION for a commit already recorded above: a later run on this same'
        + ' commit failed AFTER committing, so the earlier note understates what exists.'
      : 'Same failure class reproduced on a further commit.',
    ...(recovery
      ? ['', 'A candidate branch and commit may exist on the remote. Inspect before', 'rerunning. `main` was not modified and nothing was deployed.', '', `> ${recovery}`]
      : []),
    '',
    ...contextLines(resolved, repository),
    '',
  ].join('\n');
}

/**
 * The whole notification decision, as one pure function so the behaviour is
 * testable without touching GitHub.
 */
export function decideFailureSignal({ issue = null, context } = {}) {
  const resolved = requireContext(context);
  const key = failureSignalKey(resolved.failureClass);
  const recovery = detectPostCommitRecovery(context?.log ?? '') !== null;
  if (!issue) {
    return Object.freeze({ action: 'CREATE', key, failureClass: resolved.failureClass, issue: null, escalation: false, reason: 'NO_OPEN_SIGNAL' });
  }
  if (recordedCommits(issue).includes(resolved.commit)) {
    // Commit identity alone is not the whole disposition. A commit first
    // recorded as a pre-commit refusal whose later run reaches post-commit
    // recovery has left the recorded text understating what exists, so that
    // one transition escalates rather than being suppressed.
    if (recovery && !recordedRecoveryCommits(issue).includes(resolved.commit)) {
      return Object.freeze({ action: 'COMMENT', key, failureClass: resolved.failureClass, issue, escalation: true, reason: 'RECOVERY_STATE_CHANGED' });
    }
    return Object.freeze({ action: 'NONE', key, failureClass: resolved.failureClass, issue, escalation: false, reason: 'ALREADY_RECORDED' });
  }
  return Object.freeze({ action: 'COMMENT', key, failureClass: resolved.failureClass, issue, escalation: false, reason: 'NEW_COMMIT' });
}
