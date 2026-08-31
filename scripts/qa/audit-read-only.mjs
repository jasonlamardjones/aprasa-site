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
    needle: "await install('page-fetch-interception', () => session.send('Fetch.enable'",
    why: 'browser interception is installed, so page code cannot bypass the rule',
  },
  {
    file: 'scripts/qa/lib/qa-browser-guard.mjs',
    needle: 'export const REQUIRED_GUARD_COMPONENTS = Object.freeze([',
    why: 'required guard components are enumerated rather than assumed',
  },
  {
    file: 'scripts/qa/lib/qa-browser-guard.mjs',
    needle: 'installed: missing.length === 0,',
    why: 'the guard reports itself installed only when every required component is',
  },
  {
    file: 'scripts/qa/lib/qa-browser.mjs',
    needle: 'installGuard = installReadOnlyGuard',
    why: 'the browser QA path installs the real guard by default',
  },
  {
    file: 'scripts/qa/lib/qa-browser.mjs',
    needle: 'if (!guard.installed) {',
    why: 'an incomplete guard blocks navigation instead of degrading to a note',
  },
  {
    file: 'scripts/qa/lib/qa-browser.mjs',
    needle: '} finally {\n    await browser.close();\n  }',
    why: 'Chrome is torn down unconditionally, including on the blocked-navigation path',
  },
  // Negative invariants: things whose *return* would reopen a closed finding.
  {
    file: 'scripts/qa/run-post-publication-qa.mjs',
    absent: true,
    needle: 'if (corroborated === true) {',
    why: 'Home-byte corroboration never terminates the grace window for other routes',
  },
];

/**
 * Ordering invariants: the guard gate must come before the only navigation, and
 * there must be exactly one navigation to come before. A gate placed after the
 * request it is meant to prevent is not a gate.
 */
const ORDERED_INVARIANTS = [
  {
    file: 'scripts/qa/lib/qa-browser.mjs',
    before: 'if (!guard.installed) {',
    after: "session.send('Page.navigate'",
    occurrences: 1,
    why: 'the guard gate is evaluated before the browser navigates, and nothing else navigates',
  },
];

export function auditOrdering(root = ROOT, invariants = ORDERED_INVARIANTS) {
  const failures = [];
  for (const invariant of invariants) {
    const absolute = path.join(root, invariant.file);
    const text = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
    const gate = text.indexOf(invariant.before);
    const navigate = text.indexOf(invariant.after);
    const count = text.split(invariant.after).length - 1;
    if (gate === -1 || navigate === -1 || gate > navigate || count !== invariant.occurrences) {
      failures.push(`${invariant.file}: lost the guarantee that ${invariant.why}`);
    }
  }
  return failures;
}

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
    const present = text.includes(invariant.needle);
    // `absent: true` pins a guarantee that a construct stays *gone*. A closed
    // review finding that can silently reappear is not really closed.
    if (invariant.absent ? present : !present) {
      failures.push(`${invariant.file}: lost the guarantee that ${invariant.why}`);
    }
  }
  return failures;
}

export function auditReadOnly(root = ROOT) {
  return [...auditWorkflowPermissions(root), ...auditPinnedInvariants(root), ...auditOrdering(root)];
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const failures = auditReadOnly();
  if (failures.length) {
    console.error('Phase 2A read-only audit FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    `Phase 2A read-only audit passed: ${QA_WORKFLOWS.length} workflows read-only, `
    + `${PINNED_INVARIANTS.length} invariants intact, ${ORDERED_INVARIANTS.length} ordering rule(s) held.`
  );
}
