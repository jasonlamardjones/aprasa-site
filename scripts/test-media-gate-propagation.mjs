#!/usr/bin/env node
// Regression coverage for the media-gate exit-code contract and, more
// importantly, for its PROPAGATION into the publication artifacts.
//
// internal/publishing-media-convention.md defines exit 2 from
// scripts/validate-card-media.mjs as a domain state -- structurally valid,
// unresolved media work remains, not media-complete for merge -- while exit 1
// is a real failure. Two defects have already been found against that contract:
//
//   1. the shared subprocess helpers collapsed every non-zero status into a
//      generic "<script> failed (N)", so an open gate crashed the run; and
//   2. once that was recognized internally, the state was still dropped before
//      the proof, the result and the founder report, so a candidate whose
//      media validator exited 2 could be described as fully validated.
//
// The second is the dangerous one: it does not crash, it misreports. These
// tests pin both the classification and the propagation.
//
// Usage: node scripts/test-media-gate-propagation.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  isMediaGateOpen,
  mediaGateStateFrom,
  validationOutcome,
  MEDIA_GATE_SCRIPT,
  MEDIA_GATE_OPEN,
  MEDIA_GATE_PASSED
} from './lib/event-publication-contract.mjs';
import { reportFor } from './lib/event-publication-write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OTHER_SCRIPT = 'scripts/validate-things-to-do-events.mjs';

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS — ${name}`); }
  else { failures.push(`${name}${detail ? `: ${detail}` : ''}`); console.log(`FAIL — ${name}${detail ? `: ${detail}` : ''}`); }
}

// --- 1-6: classification ---------------------------------------------------
check('1. exact validator + numeric exit 2 is the recognized open-gate state',
  isMediaGateOpen(MEDIA_GATE_SCRIPT, 2) === true);

check('2. exact validator + exit 0 is a normal pass, not an open gate',
  isMediaGateOpen(MEDIA_GATE_SCRIPT, 0) === false
  && validationOutcome(MEDIA_GATE_SCRIPT, [], 0).passed === true
  && mediaGateStateFrom([validationOutcome(MEDIA_GATE_SCRIPT, [], 0)]) === MEDIA_GATE_PASSED);

check('3. exact validator + exit 1 is NOT recognized, so it stays fatal to the caller',
  isMediaGateOpen(MEDIA_GATE_SCRIPT, 1) === false);

for (const status of [3, 7, 127, -1]) {
  check(`4. exact validator + unexpected exit ${status} is NOT recognized, so it stays fatal`,
    isMediaGateOpen(MEDIA_GATE_SCRIPT, status) === false);
}

check('5. another script + exit 2 is NOT recognized, so it stays fatal',
  isMediaGateOpen(OTHER_SCRIPT, 2) === false);

// A stringified status must not slip through: "2" == 2 loosely, and a loose
// comparison here would let a coerced exit code bypass a fatal path.
check('6. exact validator + string "2" is NOT treated as the recognized state',
  isMediaGateOpen(MEDIA_GATE_SCRIPT, '2') === false);

// An open gate is never counted as a pass.
check('6b. an open-gate outcome is recorded as not-passed',
  validationOutcome(MEDIA_GATE_SCRIPT, [], 2).passed === false
  && validationOutcome(MEDIA_GATE_SCRIPT, [], 2).media_gate_open === true);

check('6c. one open-gate outcome among passes still resolves the batch to OPEN',
  mediaGateStateFrom([
    validationOutcome(OTHER_SCRIPT, [], 0),
    validationOutcome(MEDIA_GATE_SCRIPT, [], 2)
  ]) === MEDIA_GATE_OPEN);

// --- 7: the dry-run proof carries the state, end to end --------------------
// The real script, the real validators, the real repository state. This is the
// artifact the real write consumes, so if the gate is lost here it is lost
// everywhere downstream.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aprasa-media-gate-'));
  try {
    fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) && path.basename(src) !== '.git' });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@aprasa.org'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Media Gate Test'], { cwd: dir });
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();

    const packet = JSON.parse(fs.readFileSync(path.join(dir, 'automation', 'things-to-do', 'fixtures', 'ready-write.json'), 'utf8'));
    packet.control.as_of = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'things-to-do-currentness.json'), 'utf8')).as_of;
    packet.control.expected_main_sha = head;
    const packetPath = path.join(dir, '.git', 'media-gate-packet.json');
    fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
    const proofPath = path.join(dir, '.git', 'media-gate-proof.json');

    const run = spawnSync('node', ['scripts/prepare-event-publication.mjs', `--packet=${packetPath}`, `--proof=${proofPath}`],
      { cwd: dir, encoding: 'utf8' });
    check('7. dry-run preparation completes rather than crashing on the open gate',
      run.status === 0, `${run.stdout || ''}${run.stderr || ''}`.trim().slice(0, 400));

    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    check('7a. proof records media_gate_open === true', proof.media_gate_open === true, JSON.stringify(proof.media_gate_open));
    check('7b. proof records the OPEN state by name', proof.media_gate === MEDIA_GATE_OPEN, String(proof.media_gate));
    const mediaOutcome = (proof.validation_outcomes ?? []).find((outcome) => outcome.step === MEDIA_GATE_SCRIPT);
    check('7c. proof records the media validator with its real exit status',
      mediaOutcome?.status === 2 && mediaOutcome?.passed === false && mediaOutcome?.media_gate_open === true,
      JSON.stringify(mediaOutcome));

    // 8/9 for the dry-run report.
    check('8. dry-run report states MEDIA GATE: OPEN', /MEDIA GATE: OPEN/.test(run.stdout), run.stdout.slice(0, 300));
    check('9. dry-run report does not claim every stage passed while the gate is open',
      /VALIDATION: 8 of 9 deterministic checks\/generation stages passed/.test(run.stdout),
      (run.stdout.match(/VALIDATION:.*/) || ['(absent)'])[0]);
    check('9a. dry-run report does not claim media is approved while the gate is open',
      !/MEDIA: approved/.test(run.stdout), (run.stdout.match(/MEDIA:.*/) || ['(absent)'])[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- 8/9/10: the founder-facing real-write report --------------------------
const packet = { event: { title: 'Fixture Event' }, control: { as_of: '2026-09-02' } };
const openResult = {
  packet_sha256: 'x', changed_files: ['index.html'],
  validations: [MEDIA_GATE_SCRIPT, OTHER_SCRIPT],
  validation_outcomes: [
    { step: MEDIA_GATE_SCRIPT, status: 2, passed: false, media_gate_open: true },
    { step: OTHER_SCRIPT, status: 0, passed: true, media_gate_open: false }
  ],
  media_gate: MEDIA_GATE_OPEN, media_gate_open: true, merge_allowed: false
};
const openReport = reportFor(packet, openResult);

check('8b. real-write founder report states MEDIA GATE: OPEN', /MEDIA GATE: OPEN/.test(openReport));
check('9b. real-write founder report does not call the media validator approved when status is 2',
  !/- Media: approved/.test(openReport) && /NOT media-complete/.test(openReport),
  (openReport.match(/- Media:.*/) || ['(absent)'])[0]);
check('9c. real-write founder report counts 1 of 2 validators passed, not 2',
  /- Validation: 1 of 2 incumbent validators passed/.test(openReport),
  (openReport.match(/- Validation:.*/) || ['(absent)'])[0]);
check('10. merge readiness stays false while the media gate is open',
  openResult.merge_allowed === false && /- Merge allowed: false/.test(openReport));

// The closed-gate path must still read as a clean pass, so none of the above is
// merely asserting that the report always says OPEN.
const closedReport = reportFor(packet, {
  ...openResult,
  validation_outcomes: openResult.validation_outcomes.map((outcome) => ({ ...outcome, status: 0, passed: true, media_gate_open: false })),
  media_gate: MEDIA_GATE_PASSED, media_gate_open: false
});
check('10b. a closed gate still reports approved media and a full pass',
  /- Media: approved manifest and verified local asset/.test(closedReport)
  && /- Validation: 2 of 2 incumbent validators passed/.test(closedReport)
  && /MEDIA GATE: PASSED/.test(closedReport));
check('10c. merge allowed stays false even when the gate is closed (founder approval is separate)',
  /- Merge allowed: false/.test(closedReport));

console.log(`\nMedia-gate propagation tests: ${passed}/${passed + failures.length} passed.`);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
