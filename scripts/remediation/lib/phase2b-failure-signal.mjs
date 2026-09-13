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
  // Per-commit artifact-state marker. Records the disposition observed for a
  // commit so a later run can tell an UPGRADE from a repeat — see
  // ARTIFACT_STATE_ORDER and decideFailureSignal().
  stateMarkerPrefix: 'phase2b-failure-state',

  // The two disposition tokens, defined ONCE. Everything that classifies,
  // detects or resolves disposition reads them from here: a rename must not be
  // able to turn an artifact-disposition token into a failure-class key, which
  // is exactly what a separately re-typed literal would allow.
  noWriteMarker: 'PHASE2B_NO_WRITE_PERFORMED',
  postCommitMarker: 'PHASE2B_POST_COMMIT_RECOVERY',
  unclassified: 'PHASE2B_UNCLASSIFIED_FAILURE',
  // Comments are NOT read through `gh issue list --json comments`: that nests an
  // unpaginated comments(first: N) connection whose page size is gh's to choose,
  // and mirroring that N as a local constant fails in the UNSAFE direction — if
  // gh's page size ever shrinks below ours, a truncated read stops looking
  // truncated and dedupe markers silently vanish. Completeness cannot be derived
  // from the payload either, since gh drops totalCount.
  //
  // So comments are fetched through an explicitly paginated API path instead.
  // commentsPerPage is a value WE send as per_page, not an assumed server cap,
  // and completeness is proven by a terminating short page rather than assumed:
  // a full page always means "ask for another". commentPageCap only stops a
  // runaway loop, and reaching it fails closed.
  commentsPerPage: 100,
  commentPageCap: 50,
});

const SHA_PATTERN = /^[a-f0-9]{40}$/;

/**
 * The failure class is the adapter's own fail-closed error code. Classifying on
 * the first PHASE2B_* token in the captured log keeps the issue keyed to the
 * refusal reason rather than to an incidental line of stack trace, so the same
 * defect recurring is recognised as the same defect.
 */
// Markers that describe the ARTIFACT DISPOSITION, not the failure. They can
// appear anywhere in the log — and, since the exit handler flushes before the
// uncaught-exception report, often FIRST — so classifying on them would key
// dedupe on the disposition and collapse every distinct refusal into one issue.
const DISPOSITION_MARKERS = Object.freeze([FAILURE_SIGNAL.postCommitMarker, FAILURE_SIGNAL.noWriteMarker]);

export function classifyFailure(log) {
  if (typeof log !== 'string') return FAILURE_SIGNAL.unclassified;
  for (const match of log.matchAll(/PHASE2B_[A-Z0-9_]+/g)) {
    if (!DISPOSITION_MARKERS.includes(match[0])) return match[0];
  }
  return FAILURE_SIGNAL.unclassified;
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
export const ARTIFACT_POST_COMMIT = 'POST_COMMIT';
export const ARTIFACT_NO_WRITE = 'NO_WRITE';
export const ARTIFACT_UNKNOWN = 'UNKNOWN';

/**
 * What exists on the remote after this failure — and, crucially, what we can
 * PROVE exists.
 *
 * Both definite answers require a terminal statement the adapter can only make
 * if it survived long enough to make it:
 *
 *   POST_COMMIT  PHASE2B_POST_COMMIT_RECOVERY is present. A candidate branch
 *                and commit may be published.
 *   NO_WRITE     PHASE2B_NO_WRITE_PERFORMED is present. The adapter reached its
 *                own exit path with nothing committed, so the clean-no-op
 *                wording is earned rather than inferred.
 *   UNKNOWN      neither. The log is empty, truncated, or the process died
 *                before it could say — a SIGKILL from OOM or the job timeout
 *                after `git push` succeeded but before `gh pr create` returned
 *                looks exactly like this. Absence of the recovery marker is NOT
 *                proof that no branch exists, so this state must never claim it.
 *
 * This asymmetry is the whole point: silence can only ever mean UNKNOWN.
 */
export function resolveArtifactState(log) {
  if (detectPostCommitRecovery(log) !== null) return ARTIFACT_POST_COMMIT;
  if (typeof log === 'string' && log.includes(FAILURE_SIGNAL.noWriteMarker)) return ARTIFACT_NO_WRITE;
  return ARTIFACT_UNKNOWN;
}

export function detectPostCommitRecovery(log) {
  if (typeof log !== 'string') return null;
  const match = log.match(new RegExp(`${FAILURE_SIGNAL.postCommitMarker}:\\s*(.+)`));
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

// Artifact state is MONOTONIC: a later run on the same commit can only ever
// learn that MORE exists, never less. NO_WRITE is the weakest claim, UNKNOWN
// admits a candidate may exist, POST_COMMIT proves one may. Ranking them makes
// "is this news?" a comparison rather than a special case, which is what the
// previous POST_COMMIT-only rule got wrong: a commit recorded NO_WRITE whose
// later run died as UNKNOWN stayed suppressed behind the reassuring wording.
export const ARTIFACT_STATE_ORDER = Object.freeze({
  [ARTIFACT_NO_WRITE]: 0,
  [ARTIFACT_UNKNOWN]: 1,
  [ARTIFACT_POST_COMMIT]: 2,
});

export function artifactStateRank(state) {
  const rank = ARTIFACT_STATE_ORDER[state];
  if (rank === undefined) throw new Error(`PHASE2B_FAILURE_ARTIFACT_STATE_UNKNOWN: ${String(state)}`);
  return rank;
}

/**
 * Durable per-commit disposition metadata.
 *
 * The issue itself stays keyed to the FAILURE CLASS; this records, per commit,
 * which artifact state has already been reported, so a later run can tell an
 * upgrade from a repeat without re-reading the original log.
 */
export function stateMarker(sha, state) {
  if (!SHA_PATTERN.test(sha ?? '')) throw new Error('PHASE2B_FAILURE_COMMIT_UNREADABLE');
  artifactStateRank(state);
  return `<!-- ${FAILURE_SIGNAL.stateMarkerPrefix}: ${sha} ${state} -->`;
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
  if (limit !== null && parsed.length >= limit) {
    throw new Error(`PHASE2B_FAILURE_SIGNAL_PROBE_TRUNCATED: ${parsed.length} open labelled issues reached the probe limit of ${limit}`);
  }

  // Every record is validated before any is matched. A record whose body cannot
  // be read is not evidence that it lacks the marker — it is evidence that this
  // probe cannot answer the question, and silently filtering it out would read
  // an unreadable issue as "not the signal issue" and open a duplicate.
  for (const record of parsed) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('PHASE2B_FAILURE_SIGNAL_PROBE_UNREADABLE: malformed issue record');
    }
    if (typeof record.body !== 'string') {
      throw new Error(`PHASE2B_FAILURE_SIGNAL_PROBE_UNREADABLE: issue #${record.number ?? '?'} has no readable body`);
    }
  }

  const marker = keyMarker(key);
  const matching = parsed.filter((record) => record.body.includes(marker));
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
  // Comments deliberately absent here. They are fetched separately and
  // provably completely — see parseCommentPage()/assertCommentSetComplete() —
  // and attached with withComments() before any dedupe decision is taken.
  return Object.freeze({ number: record.number, url: record.url, body: record.body, comments: null });
}

/**
 * One page of an explicitly paginated comments read. Fails closed on a failed
 * command, non-JSON, a non-array page, or any comment whose body is unreadable:
 * a page we cannot parse is not an empty page.
 */
export function parseCommentPage(probe, { page = 1 } = {}) {
  if (!Number.isInteger(page) || page < 1) throw new Error('PHASE2B_FAILURE_SIGNAL_COMMENT_PAGE_INVALID');
  if (!probe || probe.status !== 0) {
    const detail = [probe?.stderr, probe?.stdout].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim();
    throw new Error(`PHASE2B_FAILURE_SIGNAL_COMMENT_PROBE_FAILED: page ${page} exit ${probe?.status ?? 'unknown'}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  if (typeof probe.stdout !== 'string') throw new Error(`PHASE2B_FAILURE_SIGNAL_COMMENT_PAGE_UNREADABLE: page ${page} produced no output`);
  let parsed;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    throw new Error(`PHASE2B_FAILURE_SIGNAL_COMMENT_PAGE_UNREADABLE: page ${page} did not return JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`PHASE2B_FAILURE_SIGNAL_COMMENT_PAGE_UNREADABLE: page ${page} is not a JSON array`);
  return parsed.map((comment, index) => {
    if (!comment || typeof comment !== 'object' || Array.isArray(comment) || typeof comment.body !== 'string') {
      throw new Error(`PHASE2B_FAILURE_SIGNAL_COMMENT_PAGE_UNREADABLE: page ${page} comment ${index} has no readable body`);
    }
    return comment.body;
  });
}

/**
 * Completeness is PROVEN, not assumed: the last page fetched must be shorter
 * than the per_page we asked for, which is the only observation that can mean
 * "there is no next page". A run that exhausts the page cap has not proven it,
 * so it fails closed rather than deduping against a partial comment set.
 */
export function assertCommentSetComplete({ pageSizes = [], perPage, pageCap } = {}) {
  if (!Number.isInteger(perPage) || perPage < 1) throw new Error('PHASE2B_FAILURE_SIGNAL_COMMENT_PER_PAGE_INVALID');
  if (!Number.isInteger(pageCap) || pageCap < 1) throw new Error('PHASE2B_FAILURE_SIGNAL_COMMENT_PAGE_CAP_INVALID');
  if (!pageSizes.length) throw new Error('PHASE2B_FAILURE_SIGNAL_COMMENTS_UNREAD: no comment page was read');
  if (pageSizes.length > pageCap) {
    throw new Error(`PHASE2B_FAILURE_SIGNAL_COMMENTS_UNBOUNDED: exceeded the ${pageCap}-page cap`);
  }
  for (const [index, size] of pageSizes.entries()) {
    if (!Number.isInteger(size) || size < 0 || size > perPage) {
      throw new Error(`PHASE2B_FAILURE_SIGNAL_COMMENT_PAGE_UNREADABLE: page ${index + 1} returned ${size} of at most ${perPage}`);
    }
  }
  if (pageSizes[pageSizes.length - 1] === perPage) {
    throw new Error(`PHASE2B_FAILURE_SIGNAL_COMMENTS_INCOMPLETE: page ${pageSizes.length} was full, so a further page may exist`);
  }
  return true;
}

/** Attach a provably complete comment set to a probed issue. */
export function withComments(issue, comments) {
  if (!issue) throw new Error('PHASE2B_FAILURE_SIGNAL_ISSUE_REQUIRED');
  if (!Array.isArray(comments) || comments.some((body) => typeof body !== 'string')) {
    throw new Error('PHASE2B_FAILURE_SIGNAL_COMMENTS_UNREADABLE');
  }
  return Object.freeze({ ...issue, comments: [...comments] });
}

function markedCommits(issue, prefix) {
  if (!issue) return [];
  // `comments: null` means the set was never attached, which is not the same as
  // "no comments". Reading it as empty would hide recorded markers and re-add a
  // recurrence or correction on every run, so an unattached set fails closed.
  if (!Array.isArray(issue.comments)) throw new Error('PHASE2B_FAILURE_SIGNAL_COMMENTS_UNATTACHED');
  if (typeof issue.body !== 'string') throw new Error('PHASE2B_FAILURE_SIGNAL_BODY_UNREADABLE');
  const pattern = new RegExp(`<!--\\s*${prefix}:\\s*([a-f0-9]{40})\\s*-->`, 'g');
  const haystack = [issue.body, ...issue.comments].join('\n');
  return [...new Set([...haystack.matchAll(pattern)].map((match) => match[1]))].sort();
}

/** Commits already recorded on an open signal issue, body and comments alike. */
export function recordedCommits(issue) {
  return markedCommits(issue, FAILURE_SIGNAL.commitMarkerPrefix);
}

/**
 * The highest artifact state already recorded for each commit on this issue.
 *
 * Highest rather than latest, so an out-of-order or duplicated marker cannot
 * walk a commit's recorded disposition back down — monotonicity is enforced when
 * reading, not merely when writing.
 */
export function recordedCommitStates(issue) {
  if (!issue) return new Map();
  if (!Array.isArray(issue.comments)) throw new Error('PHASE2B_FAILURE_SIGNAL_COMMENTS_UNATTACHED');
  if (typeof issue.body !== 'string') throw new Error('PHASE2B_FAILURE_SIGNAL_BODY_UNREADABLE');
  const pattern = new RegExp(`<!--\\s*${FAILURE_SIGNAL.stateMarkerPrefix}:\\s*([a-f0-9]{40})\\s+([A-Z_]+)\\s*-->`, 'g');
  const haystack = [issue.body, ...issue.comments].join('\n');
  const states = new Map();
  for (const match of haystack.matchAll(pattern)) {
    const [, sha, state] = match;
    if (ARTIFACT_STATE_ORDER[state] === undefined) {
      throw new Error(`PHASE2B_FAILURE_ARTIFACT_STATE_UNKNOWN: ${state} recorded for ${sha}`);
    }
    const current = states.get(sha);
    if (current === undefined || artifactStateRank(state) > artifactStateRank(current)) states.set(sha, state);
  }
  return states;
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
  const artifactState = resolveArtifactState(context?.log ?? '');
  const disposition = artifactState === ARTIFACT_POST_COMMIT
    ? [
      'Artifact state: **POST_COMMIT**. The remediation adapter failed AFTER',
      'committing its candidate, so this is NOT a clean no-op: a candidate branch',
      'and commit may already exist on the remote. Do not rerun the repair before',
      'inspecting that state. `main` was not modified and nothing was deployed.',
      '',
      `> ${recovery}`,
    ]
    : artifactState === ARTIFACT_NO_WRITE
      ? [
        'Artifact state: **NO_WRITE**. THIS RUN reached its own exit path without',
        'committing or publishing a candidate: it created no new branch, no new',
        'commit and no new pull request, `main` was not modified, and nothing was',
        'deployed.',
        '',
        'That is a statement about THIS EXECUTION only. It is NOT a claim that no',
        'repair branch, commit or draft pull request exists — several refusals that',
        'produce this state mean the opposite, because what they refused was a',
        'duplicate: `PHASE2B_DUPLICATE_STATE_REFUSED` (including',
        '`ORPHAN_REMOTE_REPAIR_BRANCH`) and the concurrent-repair refusals fire',
        'precisely because a candidate was already found on the remote. Read the',
        'failure class below before concluding anything about remote state.',
      ]
      : [
        'Artifact state: **UNKNOWN**. The run left no terminal statement about what',
        'it had written — the log is empty or truncated, or the process was killed',
        '(out of memory, or the job timeout) before it could report. A push may have',
        'succeeded before it died, so this issue does NOT claim that no branch or',
        'commit exists.',
        '',
        'Inspect the remote branch and pull-request state for this commit BEFORE',
        'rerunning the repair. `main` is never modified by this adapter and nothing',
        'is deployed by it, but a candidate branch may be published.',
      ];
  return [
    keyMarker(key ?? failureSignalKey(resolved.failureClass)),
    commitMarker(resolved.commit),
    stateMarker(resolved.commit, artifactState),
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
  const artifactState = resolveArtifactState(context?.log ?? '');
  return [
    commitMarker(resolved.commit),
    stateMarker(resolved.commit, artifactState),
    '',
    escalation
      ? `CORRECTION for a commit already recorded above: a later run on this same commit reached a HIGHER artifact state (**${artifactState}**), so the earlier note understates what may exist.`
      : 'Same failure class reproduced on a further commit.',
    `Artifact state: **${artifactState}**.`,
    ...(recovery
      ? ['', 'A candidate branch and commit may exist on the remote. Inspect before', 'rerunning. `main` was not modified and nothing was deployed.', '', `> ${recovery}`]
      : artifactState === ARTIFACT_UNKNOWN
        ? ['', 'This run left no terminal statement about what it had written, so a', 'candidate branch may be published. Inspect before rerunning.']
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
  const artifactState = resolveArtifactState(context?.log ?? '');
  // The issue stays keyed to the FAILURE CLASS. Artifact state is per-commit
  // disposition metadata and never part of the dedupe key, so a state change
  // corrects an existing issue rather than opening a second one for the same
  // failure.
  const base = { key, failureClass: resolved.failureClass, artifactState };
  if (!issue) {
    return Object.freeze({ action: 'CREATE', ...base, issue: null, escalation: false, reason: 'NO_OPEN_SIGNAL' });
  }
  const recorded = recordedCommitStates(issue).get(resolved.commit);
  if (recorded === undefined) {
    return Object.freeze({ action: 'COMMENT', ...base, issue, escalation: false, reason: 'NEW_COMMIT' });
  }
  // Already recorded, so only NEWS is reported — and because artifact state is
  // monotonic, news can only ever be an UPGRADE. A repeat at the same state adds
  // nothing, and a weaker observation from a later run must not walk the recorded
  // disposition back down to a more reassuring one. The ceiling per commit is
  // therefore its initial record plus at most two upward corrections
  // (NO_WRITE -> UNKNOWN -> POST_COMMIT), and it cannot oscillate.
  const rank = artifactStateRank(artifactState);
  const recordedRank = artifactStateRank(recorded);
  if (rank > recordedRank) {
    return Object.freeze({
      action: 'COMMENT', ...base, issue, escalation: true, reason: 'ARTIFACT_STATE_ESCALATED', recordedState: recorded,
    });
  }
  return Object.freeze({
    action: 'NONE',
    ...base,
    issue,
    escalation: false,
    reason: rank < recordedRank ? 'LOWER_STATE_IGNORED' : 'ALREADY_RECORDED',
    recordedState: recorded,
  });
}
