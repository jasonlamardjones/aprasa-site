#!/usr/bin/env node
// One bounded GitHub REST request, executed as a short-lived child process.
//
// Why a child process at all
// --------------------------
// The guarded publication path is synchronous by construction: every step it
// takes (`git`, the incumbent validators, the promotion/rollback bookkeeping)
// is a `spawnSync` call inside one straight-line try/catch, and its recovery
// semantics depend on that. `fetch` is asynchronous, so calling it inline would
// force `finalizeRealWriteCandidate` and its callers to become async — a change
// to the control path's shape, not to its transport. Running the request in a
// child process keeps the transport swap confined to the transport: the call
// sites stay exactly as synchronous as they were when they shelled out to `gh`.
//
// Credential handling
// -------------------
// The token arrives on stdin, never in argv and never in this process's
// environment, so it cannot be observed in a process listing. It is written to
// exactly one place — the Authorization header of the single outbound request —
// and never to stdout, stderr, or disk. The response envelope this worker emits
// carries only a status and a response body.
//
// Egress
// ------
// The request is pinned to the GitHub API origin and refuses redirects, so no
// response can move the call to another host. Node's built-in `fetch` ignores
// HTTPS_PROXY unless told otherwise; the caller sets NODE_USE_ENV_PROXY so an
// environment whose outbound HTTPS is brokered by a proxy is honoured rather
// than silently bypassed.
//
// Protocol:
//   stdin  <- {"url","method","token","body","userAgent","timeoutMs"}
//   stdout -> {"ok":true,"status":<int>,"body":"<text>"}
//          |  {"ok":false,"error":"<reason>"}

import fs from 'node:fs';

const ALLOWED_ORIGIN = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const ALLOWED_METHODS = new Set(['GET', 'POST']);

function emit(envelope) {
  process.stdout.write(JSON.stringify(envelope));
}

let request;
try {
  request = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (error) {
  emit({ ok: false, error: `unreadable request envelope: ${error?.message ?? error}` });
  process.exit(0);
}

const method = String(request?.method ?? 'GET').toUpperCase();
const url = String(request?.url ?? '');
const timeoutMs = Number.isFinite(request?.timeoutMs) ? request.timeoutMs : DEFAULT_TIMEOUT_MS;

if (!ALLOWED_METHODS.has(method)) {
  emit({ ok: false, error: `refusing method ${method}; this worker issues ${[...ALLOWED_METHODS].join('/')} only` });
  process.exit(0);
}

// Origin is checked before the request exists, not after a response comes back.
let origin = null;
try {
  origin = new URL(url).origin;
} catch {
  origin = null;
}
if (origin !== ALLOWED_ORIGIN) {
  emit({ ok: false, error: `refusing ${origin ?? 'an unresolvable origin'}; publication automation only contacts ${ALLOWED_ORIGIN}` });
  process.exit(0);
}

const headers = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': String(request?.userAgent ?? 'aprasa-publication-automation/1.0')
};
if (request?.token) headers.authorization = `Bearer ${request.token}`;
if (typeof request?.body === 'string') headers['content-type'] = 'application/json';

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
try {
  const response = await fetch(url, {
    method,
    headers,
    body: typeof request?.body === 'string' ? request.body : undefined,
    redirect: 'error',
    signal: controller.signal
  });
  const text = await response.text();
  emit({ ok: true, status: response.status, body: text.slice(0, MAX_RESPONSE_BYTES) });
} catch (error) {
  const reason = error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error);
  emit({ ok: false, error: reason });
} finally {
  clearTimeout(timer);
}
