#!/usr/bin/env node
// Structural re-audit of the Phase 2A read-only guarantee.
//
// The grep-based mutation guard is cheap and catches the obvious regression,
// but it only reads text. This script asserts the structural facts the
// guarantee actually rests on, and the QA test matrix asserts the behavioural
// ones (a recording fetch proving every GitHub call is a bodyless GET, and a
// fixture server proving a real Chrome running real page code only ever issued
// GET). Three independent checks, none of which substitutes for the others.
//
// Read-only: it reads repository files and prints a verdict.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const QA_WORKFLOWS = [
  '.github/workflows/post-publication-qa.yml',
  '.github/workflows/post-publication-qa-reconcile.yml',
  '.github/workflows/post-publication-qa-tests.yml',
];

// Each entry is a fact the guarantee depends on, expressed as a literal that
// must still be present in the source it belongs to.
const PINNED_INVARIANTS = [
  {
    file: 'scripts/qa/run-post-publication-qa.mjs',
    needle: "const PRODUCTION_BASE_URL = 'https://aprasa.org';",
    why: 'the production target is pinned to exactly https://aprasa.org',
  },
  {
    file: 'scripts/qa/run-post-publication-qa.mjs',
    needle: "const TEST_TARGET_ENV = 'APRASA_QA_ALLOW_TEST_TARGET';",
    why: 'the loopback override is the only non-production target mechanism',
  },
  {
    file: 'scripts/qa/lib/qa-http.mjs',
    needle: "export const READ_ONLY_METHODS = Object.freeze(['GET', 'HEAD']);",
    why: 'the HTTP client can issue only GET and HEAD',
  },
  {
    file: 'scripts/qa/lib/qa-http.mjs',
    needle: 'assertReadOnlyMethod(method);',
    why: 'every HTTP request funnels through the method assertion',
  },
  {
    file: 'scripts/qa/lib/qa-browser-guard.mjs',
    needle: "export const READ_ONLY_METHODS = Object.freeze(['GET', 'HEAD']);",
    why: 'the browser may issue only GET and HEAD',
  },
  {
    file: 'scripts/qa/lib/qa-browser-guard.mjs',
    needle: "await session.send('Fetch.enable'",
    why: 'browser interception is installed, so page code cannot bypass the rule',
  },
  {
    file: 'scripts/qa/lib/qa-browser.mjs',
    needle: 'installReadOnlyGuard(session',
    why: 'the browser QA path actually installs the guard',
  },
];

export function auditWorkflowPermissions(root = ROOT, files = QA_WORKFLOWS) {
  const failures = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) {
      failures.push(`${file}: missing`);
      continue;
    }
    const text = fs.readFileSync(absolute, 'utf8');
    const block = text.match(/^permissions:\n((?:[ \t]+\S.*\n)+)/m);
    if (!block) {
      failures.push(`${file}: no top-level permissions block`);
      continue;
    }
    for (const line of block[1].split('\n').filter((entry) => entry.trim())) {
      const [scope, value] = line.trim().split(/:\s*/);
      if (value !== 'read' && value !== 'none') {
        failures.push(`${file}: ${scope} is "${value}", expected read or none`);
      }
    }
  }
  return failures;
}

export function auditPinnedInvariants(root = ROOT, invariants = PINNED_INVARIANTS) {
  const failures = [];
  for (const invariant of invariants) {
    const absolute = path.join(root, invariant.file);
    const text = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
    if (!text.includes(invariant.needle)) {
      failures.push(`${invariant.file}: lost the guarantee that ${invariant.why}`);
    }
  }
  return failures;
}

export function auditReadOnly(root = ROOT) {
  return [...auditWorkflowPermissions(root), ...auditPinnedInvariants(root)];
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const failures = auditReadOnly();
  if (failures.length) {
    console.error('Phase 2A read-only audit FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Phase 2A read-only audit passed: ${QA_WORKFLOWS.length} workflows read-only, ${PINNED_INVARIANTS.length} invariants intact.`);
}
