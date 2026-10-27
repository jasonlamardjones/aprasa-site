#!/usr/bin/env node
// P04-RH-A: synthetic Resource Hub projection adapter tests.
// Run: node scripts/resource-hub/test-projection-adapter.mjs
// Synthetic fixtures only; in-memory output only; no network, no file writes.

import { projectBatch } from '../../internal/resource-hub/project-record.mjs';
import { validateProjectionOutput, checkPublicUrl } from '../../internal/resource-hub/projection-validator.mjs';
import { OUTCOME, PUBLIC_OUTPUT_FIELDS, canonicalJson } from '../../internal/resource-hub/projection-contract.mjs';
import { build, contextOf } from '../../internal/resource-hub/fixtures/synthetic-records.mjs';

const checks = [];
const groups = new Map();
function check(group, name, ok) {
  checks.push({ group, name, ok: Boolean(ok) });
  if (!groups.has(group)) groups.set(group, true);
  if (!ok) groups.set(group, false);
}

const run = (bundle) => projectBatch(bundle.records, contextOf(bundle));
const rec = (b) => b.records[0];
const hasCodes = (r, codes) => codes.every((code) => r.errors.some((e) => e.code === code));

// Change a claim consistently in the record, the decision and (optionally) the evidence scope.
function setClaim(b, field, value, { evidence = true } = {}) {
  const apply = (list) => {
    const hit = list.find((c) => c.field === field);
    if (hit) hit.value = value;
    else list.push({ field, value });
  };
  apply(rec(b).approved_claims);
  rec(b).approved_claims.find((c) => c.field === field).evidence_refs ??= [rec(b).evidence_refs[0]];
  apply(b.decisions[0].approved_claims);
  if (evidence) {
    const scope = b.evidence[0].claim_scope;
    const hit = scope.find((s) => s.field === field);
    if (hit) hit.value = value;
    else scope.push({ field, value });
  }
}
const renameId = (b, from, to) => JSON.parse(JSON.stringify(b).split(from).join(to));
const withClaim = (b, field, value) => { setClaim(b, field, value); return b; };

// Required synthetic cases. expect.status plus optional codes / projection / selection assertions.
const CASES = [
  { id: 'A', label: 'valid evergreen resource', build: () => build(1),
    expect: { status: OUTCOME.ACCEPT, present: ['actionability', 'action_url', 'checked_at'], absent: ['deadline', 'start_date', 'end_date'],
      selection: { ordinary_directory_eligibility: true, home_feature_selection: false } } },
  { id: 'B', label: 'valid deadline opportunity', build: () => build(2, { kind: 'deadline' }),
    expect: { status: OUTCOME.ACCEPT, present: ['deadline', 'start_date', 'end_date', 'action_url'] } },
  { id: 'C', label: 'held record', build: () => {
    const b = build(3); rec(b).publication_readiness = 'Held'; b.decisions[0].public_safe_decision = 'Held'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['PUBLICATION_NOT_READY', 'DECISION_NOT_PUBLIC_SAFE'] } },
  { id: 'D', label: 'closed / expired record', build: () => build(4, { currentness: 'Closed / Expired', claimOverrides: { actionability: 'Closed', action_url: null } }),
    expect: { status: OUTCOME.SUPPRESS, noProjection: true, identityRetained: true,
      selection: { ordinary_directory_eligibility: false } } },
  { id: 'E', label: 'currentness unknown (no actionable claim)', build: () => build(5, { currentness: 'Currentness Unknown', claimOverrides: { actionability: null, action_url: null } }),
    expect: { status: OUTCOME.NO_ACTIONABLE_CLAIM, noProjection: true, identityRetained: true, selection: { ordinary_directory_eligibility: false } } },
  { id: 'AG', label: 'currentness unknown, title says applications open -> no public projection', build: () =>
    build(34, { currentness: 'Currentness Unknown', claimOverrides: { title: 'Applications now open', actionability: null, action_url: null } }),
    expect: { status: OUTCOME.NO_ACTIONABLE_CLAIM, noProjection: true, identityRetained: true } },
  { id: 'E2', label: 'currentness unknown + open claim', build: () => build(5, { currentness: 'Currentness Unknown' }),
    expect: { status: OUTCOME.REJECT, codes: ['UNKNOWN_CURRENTNESS_ACTIONABLE'] } },
  { id: 'F', label: 'missing evidence', build: () => { const b = build(6); b.evidence = []; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['MISSING_EVIDENCE'] } },
  { id: 'G', label: 'claim/evidence scope mismatch', build: () => {
    const b = build(7); setClaim(b, 'cost_status', 'Free for everyone', { evidence: false }); return b; },
    expect: { status: OUTCOME.REJECT, codes: ['EVIDENCE_SCOPE_MISMATCH'] } },
  { id: 'H', label: 'unknown provider', build: () => { const b = build(8); rec(b).primary_provider_id = 'SYN-PRV-9999'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['UNRESOLVED_PROVIDER'] } },
  { id: 'I', label: 'private-field injection (envelope key)', build: () => { const b = build(9); rec(b).reviewer = 'synthetic reviewer'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['PRIVATE_FIELD_PRESENT'] } },
  { id: 'I2', label: 'private-field injection (claim field)', build: () => {
    const b = build(9); rec(b).approved_claims.push({ field: 'review_notes', value: 'internal', evidence_refs: [rec(b).evidence_refs[0]] }); return b; },
    expect: { status: OUTCOME.REJECT, codes: ['PRIVATE_FIELD_PRESENT'] } },
  { id: 'I3', label: 'private-field injection (evidence ID in text)', build: () => withClaim(build(9), 'summary', 'See SYN-EV-000901 for details.'),
    expect: { status: OUTCOME.REJECT, codes: ['PRIVATE_VALUE_LEAK'] } },
  { id: 'I4', label: 'private-field injection (contact in text)', build: () => withClaim(build(9), 'public_caveat', 'Write to someone@example.invalid'),
    expect: { status: OUTCOME.REJECT, codes: ['PRIVATE_VALUE_LEAK'] } },
  { id: 'I5', label: 'private-field injection (private_contact key)', build: () => { const b = build(9); rec(b).private_contact = 'x'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['PRIVATE_FIELD_PRESENT'] } },
  { id: 'J', label: 'gateway evidence cannot open child', build: () => { const b = build(10); b.evidence[0].record_id = 'SYN-RES-0009'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['EVIDENCE_RECORD_MISMATCH'], noProjection: true } },
  { id: 'K', label: 'directory eligible, not Home selected', build: () => build(11),
    expect: { status: OUTCOME.ACCEPT, selection: { ordinary_directory_eligibility: true, home_feature_requested: false, home_feature_selection: false } } },
  { id: 'L', label: 'Home selection cannot override Held', build: () => {
    const b = build(12, { home: true }); rec(b).publication_readiness = 'Held'; b.decisions[0].public_safe_decision = 'Held'; return b; },
    expect: { status: OUTCOME.REJECT, selection: { home_feature_requested: true, home_feature_selection: false, ordinary_directory_eligibility: false } } },
  { id: 'M', label: 'Home selected and all gates pass', build: () => build(13, { home: true }),
    expect: { status: OUTCOME.ACCEPT, selection: { ordinary_directory_eligibility: true, home_feature_selection: true } } },
  { id: 'N', label: 'Home selection cannot override Closed', build: () => build(14, { home: true, currentness: 'Closed / Expired', claimOverrides: { actionability: 'Closed', action_url: null } }),
    expect: { status: OUTCOME.SUPPRESS, selection: { home_feature_requested: true, home_feature_selection: false } } },
  { id: 'O', label: 'revalidation due is not closed', build: () => build(15, { currentness: 'Revalidation Due' }),
    expect: { status: OUTCOME.REVIEW_REQUIRED, noProjection: true, identityRetained: true, selection: { ordinary_directory_eligibility: false } } },
  { id: 'P', label: 'missing stable_resource_id', build: () => { const b = build(16); delete rec(b).stable_resource_id; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['MISSING_STABLE_RESOURCE_ID'] } },
  { id: 'Q', label: 'duplicate stable_resource_id', build: () => {
    const b = build(17); b.records.push({ ...structuredClone(rec(b)), site_slug: 'synthetic-duplicate-17' }); return b; },
    expect: { status: OUTCOME.REJECT, codes: ['DUPLICATE_STABLE_RESOURCE_ID'], all: true } },
  { id: 'R', label: 'no governing decision', build: () => { const b = build(18); b.decisions = []; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['NO_GOVERNING_DECISION'] } },
  { id: 'S', label: 'decision does not match record', build: () => { const b = build(19); b.decisions[0].record_id = 'SYN-RES-0099'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['DECISION_RECORD_MISMATCH'] } },
  { id: 'T', label: 'evidence not usable for public claim', build: () => { const b = build(20); b.evidence[0].usable_for_public_claim = false; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['EVIDENCE_NOT_USABLE'] } },
  { id: 'U', label: 'consequential claim inferred, not approved', build: () => {
    const b = build(21); b.decisions[0].approved_claims = b.decisions[0].approved_claims.filter((c) => c.field !== 'cost_status'); return b; },
    expect: { status: OUTCOME.REJECT, codes: ['INFERRED_CONSEQUENTIAL_CLAIM'] } },
  { id: 'V', label: 'synthesized provider relationship', build: () => {
    const b = build(22); rec(b).provider_relationships = [{ provider_id: 'SYN-PRV-0002', relationship_type: 'partner', basis: 'name_match', approved: false }]; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['UNAPPROVED_PROVIDER_RELATIONSHIP'] } },
  { id: 'V2', label: 'explicit relationship accepted but not emitted', build: () => {
    const b = build(22); rec(b).provider_relationships = [{ provider_id: 'SYN-PRV-0002', relationship_type: 'partner', basis: 'explicit', approved: true }]; return b; },
    expect: { status: OUTCOME.ACCEPT, absent: ['provider_relationships'] } },
  { id: 'W', label: 'closed record carrying an open claim', build: () => build(23, { currentness: 'Closed / Expired' }),
    expect: { status: OUTCOME.REJECT, codes: ['CLOSED_PROJECTED_AS_ACTIONABLE'] } },
  { id: 'X', label: 'non-synthetic resource id refused', build: () => { const b = build(24); rec(b).stable_resource_id = 'XYZ-0001'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['NON_SYNTHETIC_ID'] } },
  { id: 'Y', label: 'actionable claim backed by non-current evidence', build: () => { const b = build(25); b.evidence[0].currentness = 'Revalidation Due'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['ACTIONABLE_EVIDENCE_NOT_CURRENT'] } },
  { id: 'AA', label: 'valid record, directory selection false (not auto-eligible)', build: () => build(27, { directory: false }),
    expect: { status: OUTCOME.ACCEPT, selection: { ordinary_directory_eligibility: false, home_feature_selection: false } } },
  { id: 'AB', label: 'valid record, Home selected, directory not selected (independent)', build: () => build(28, { directory: false, home: true }),
    expect: { status: OUTCOME.ACCEPT, selection: { ordinary_directory_eligibility: false, home_feature_selection: true } } },
  { id: 'AC', label: 'old invented project03 value refused', build: () => { const b = build(29); rec(b).project03_disposition = 'Cleared for Projection'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['PROJECT03_DISPOSITION_MISMATCH'] } },
  { id: 'AD', label: 'non_public_pilot_only is not publication authority', build: () => {
    const b = build(29); rec(b).publication_readiness = 'Held'; b.decisions[0].public_safe_decision = 'Held'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['PUBLICATION_NOT_READY'] } },
  { id: 'AE', label: 'locale_status must be the R1 value', build: () => { const b = build(29); rec(b).locale_status = 'en-only'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['LOCALE_STATUS_MISMATCH'] } },
  { id: 'AF', label: 'summary asserting unsupported accreditation', build: () => {
    const b = build(35); setClaim(b, 'summary', 'Nationally accredited program.', { evidence: false }); return b; },
    expect: { status: OUTCOME.REJECT, codes: ['EVIDENCE_SCOPE_MISMATCH'] } },
  { id: 'AH', label: 'Current actionable opportunity with past deadline', build: () => build(36, { kind: 'deadline', claimOverrides: { deadline: '2026-01-01' } }),
    expect: { status: OUTCOME.REJECT, codes: ['DEADLINE_PAST_FOR_CURRENT_ACTIONABLE'] } },
  { id: 'AH2', label: 'Current actionable opportunity with past end_date', build: () => build(36, { kind: 'deadline', claimOverrides: { end_date: '2026-10-26', start_date: '2026-10-01' } }),
    expect: { status: OUTCOME.REJECT, codes: ['DEADLINE_PAST_FOR_CURRENT_ACTIONABLE'] } },
  { id: 'AH5', label: 'free-form actionability ("Enroll now!"), past deadline, no action_url', build: () =>
    build(44, { kind: 'deadline', claimOverrides: { actionability: 'Enroll now!', deadline: '2026-01-01', action_url: null } }),
    expect: { status: OUTCOME.REJECT, codes: ['DEADLINE_PAST_FOR_CURRENT_ACTIONABLE'] } },
  { id: 'AH6', label: 'free-form actionability, deadline equal to assessment date', build: () =>
    build(44, { kind: 'deadline', claimOverrides: { actionability: 'Enroll now!', deadline: '2026-10-27', action_url: null } }),
    expect: { status: OUTCOME.ACCEPT } },
  { id: 'AH3', label: 'deadline equal to assessment date is not past', build: () => build(36, { kind: 'deadline', claimOverrides: { deadline: '2026-10-27' } }),
    expect: { status: OUTCOME.ACCEPT } },
  { id: 'AH4', label: 'missing assessment date fails closed', build: () => { const b = build(36); delete b.assessment_date; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['ASSESSMENT_DATE_INVALID'] } },
  { id: 'AI', label: 'unsupported legacy record_family refused', build: () => { const b = build(37); rec(b).record_family = 'evergreen_resource'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['INVALID_RECORD_FAMILY'] } },
  { id: 'AI2', label: 'R1 practical_business_support_tool accepted', build: () => { const b = build(37); rec(b).record_family = 'practical_business_support_tool'; return b; },
    expect: { status: OUTCOME.ACCEPT, projection: { record_family: 'practical_business_support_tool' } } },
  { id: 'AJ', label: 'mixed evidence dates -> oldest checked_at', build: () => {
    const b = build(38); const ev = structuredClone(b.evidence[0]);
    ev.evidence_id = 'SYN-EV-003802'; ev.checked_at = '2026-09-01';
    const summary = rec(b).approved_claims.find((c) => c.field === 'summary');
    ev.claim_scope = [{ field: 'summary', value: summary.value }];
    summary.evidence_refs = [ev.evidence_id];
    b.evidence.push(ev); rec(b).evidence_refs.push(ev.evidence_id); b.decisions[0].evidence_refs.push(ev.evidence_id); return b; },
    expect: { status: OUTCOME.ACCEPT, projection: { checked_at: '2026-09-01' } } },
  { id: 'AK', label: 'evidence dated after assessment date', build: () => { const b = build(39); b.evidence[0].checked_at = '2026-11-01'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['EVIDENCE_DATE_IN_FUTURE'] } },
  { id: 'AL', label: 'non-synthetic provider id (internally consistent)', build: () => renameId(build(40), 'SYN-PRV-0001', 'PRV-0001'),
    expect: { status: OUTCOME.REJECT, codes: ['NON_SYNTHETIC_ID'] } },
  { id: 'AM', label: 'non-synthetic decision id (internally consistent)', build: () => renameId(build(41), 'SYN-DEC-004101', 'DEC-0041'),
    expect: { status: OUTCOME.REJECT, codes: ['NON_SYNTHETIC_ID'] } },
  { id: 'AN', label: 'non-synthetic evidence id (internally consistent)', build: () => renameId(build(42), 'SYN-EV-004201', 'EV-0042'),
    expect: { status: OUTCOME.REJECT, codes: ['NON_SYNTHETIC_ID'] } },
  { id: 'AO', label: 'unexpected private-note property inside a claim', build: () => { const b = build(43); rec(b).approved_claims[0].private_note = 'internal'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['UNEXPECTED_CLAIM_KEY'] } },
  { id: 'AP', label: 'forbidden-named property inside a claim', build: () => { const b = build(43); rec(b).approved_claims[0].reviewer = 'x'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['PRIVATE_FIELD_PRESENT'] } },
  { id: 'Z', label: 'slug equal to resource id refused', build: () => { const b = build(26); rec(b).site_slug = 'syn-res-0026'; return b; },
    expect: { status: OUTCOME.REJECT, codes: ['SLUG_EQUALS_RESOURCE_ID'] } },
];

const caseResults = new Map();
const accepted = [];
for (const c of CASES) {
  const results = run(c.build());
  const targets = c.expect.all ? results : [results[0]];
  const r = results[0];
  caseResults.set(c.id, r);
  let ok = results.length > 0 && targets.every((t) => t.status === c.expect.status);
  if (c.expect.codes) ok = ok && targets.every((t) => hasCodes(t, c.expect.codes));
  if (c.expect.status !== OUTCOME.REJECT) ok = ok && r.errors.length === 0;
  if (c.expect.noProjection) ok = ok && r.projection === null;
  if (c.expect.identityRetained) ok = ok && r.identity_retained === true && typeof r.stable_resource_id === 'string';
  for (const f of c.expect.present || []) ok = ok && r.projection !== null && f in r.projection;
  for (const f of c.expect.absent || []) ok = ok && !(r.projection && f in r.projection);
  for (const [k, v] of Object.entries(c.expect.projection || {})) ok = ok && r.projection?.[k] === v;
  for (const [k, v] of Object.entries(c.expect.selection || {})) ok = ok && r.selection[k] === v;
  if (c.expect.status === OUTCOME.REJECT) ok = ok && targets.every((t) => t.projection === null);
  check('CASES', `${c.id} ${c.label} -> ${c.expect.status}`, ok);
  if (r.projection) accepted.push({ id: c.id, projection: r.projection });
}

// Currentness gates.
const status = (id) => caseResults.get(id).status;
check('CURRENTNESS_GATES', 'Current may proceed', status('A') === OUTCOME.ACCEPT);
check('CURRENTNESS_GATES', 'Revalidation Due -> review required, not Closed', status('O') === OUTCOME.REVIEW_REQUIRED && status('O') !== OUTCOME.SUPPRESS);
check('CURRENTNESS_GATES', 'Closed / Expired suppressed, identity retained', status('D') === OUTCOME.SUPPRESS && caseResults.get('D').identity_retained);
check('CURRENTNESS_GATES', 'Unknown never emits an actionable status', status('E') === OUTCOME.NO_ACTIONABLE_CLAIM && caseResults.get('E').projection === null && status('AG') === OUTCOME.NO_ACTIONABLE_CLAIM && caseResults.get('AG').projection === null && status('E2') === OUTCOME.REJECT);
check('CURRENTNESS_GATES', 'Closed cannot carry an actionable claim', status('W') === OUTCOME.REJECT);
check('CURRENTNESS_GATES', 'Gateway currentness does not propagate to child', status('J') === OUTCOME.REJECT);

// Directory vs Home are three distinct concepts.
const sel = (id) => caseResults.get(id).selection;
check('DIRECTORY_HOME_SEPARATION', 'directory true, Home false stays valid (not hidden/expired/unapproved)',
  status('K') === OUTCOME.ACCEPT && sel('K').ordinary_directory_eligibility && !sel('K').home_feature_selection);
check('DIRECTORY_HOME_SEPARATION', 'Home true does not override Held', status('L') === OUTCOME.REJECT && sel('L').home_feature_requested && !sel('L').home_feature_selection);
check('DIRECTORY_HOME_SEPARATION', 'Home true does not override Closed', status('N') === OUTCOME.SUPPRESS && !sel('N').home_feature_selection);
check('DIRECTORY_HOME_SEPARATION', 'Home flag never appears in public projection',
  accepted.every((a) => !Object.keys(a.projection).some((k) => /home|directory/i.test(k))));

// Private-field exclusion.
const allKeysAllowed = accepted.every((a) => Object.keys(a.projection).every((k) => PUBLIC_OUTPUT_FIELDS.includes(k)));
const serialized = accepted.map((a) => canonicalJson(a.projection)).join('\n');
check('PRIVATE_FIELD_EXCLUSION', 'accepted projections use allowlisted keys only', allKeysAllowed);
check('PRIVATE_FIELD_EXCLUSION', 'no evidence/decision/export ids or reviewer in output', !/SYN-(EV|DEC|EXP|PRV)-|reviewer|private_contact|review_notes|someone@/i.test(serialized));
check('PRIVATE_FIELD_EXCLUSION', 'envelope, claim-field and value injection all rejected',
  ['I', 'I2', 'I3', 'I4', 'I5'].every((id) => status(id) === OUTCOME.REJECT));
check('PRIVATE_FIELD_EXCLUSION', 'unexpected output field rejected', validateProjectionOutput({ ...caseResults.get('A').projection, extra_field: 'x' }).some((e) => e.code === 'UNEXPECTED_OUTPUT_FIELD'));
check('PRIVATE_FIELD_EXCLUSION', 'private output key rejected', validateProjectionOutput({ ...caseResults.get('A').projection, reviewer: 'x' }).some((e) => e.code === 'PRIVATE_FIELD_IN_OUTPUT'));
check('PRIVATE_FIELD_EXCLUSION', 'diagnostics do not echo rejected values',
  !JSON.stringify(caseResults.get('I3').errors).includes('SYN-EV-000901') && !JSON.stringify(caseResults.get('I4').errors).includes('someone@'));
check('PRIVATE_FIELD_EXCLUSION', 'optional unsupported fields are omitted, not empty',
  Object.values(caseResults.get('A').projection).every((v) => typeof v === 'string' && v !== ''));
check('PRIVATE_FIELD_EXCLUSION', 'identity separation: slug differs from resource id', accepted.every((a) => a.projection.site_slug !== a.projection.stable_resource_id.toLowerCase()));

// URL safety.
const BAD_URLS = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', '/etc/passwd',
  'C:\\Users\\x\\file.txt', '\\\\host\\share', '//example.org/x', 'ftp://example.org/x', ' https://example.org/x',
  'https://user:pw@example.org/x', 'http://localhost/x', 'https://127.0.0.1/x', 'https://intranet/x', 'https:example.org'];
for (const url of BAD_URLS) check('URL_SAFETY', `checkPublicUrl rejects ${JSON.stringify(url)}`, checkPublicUrl(url) !== null);
check('URL_SAFETY', 'https destination accepted', checkPublicUrl('https://example.org/a?b=1') === null);
check('URL_SAFETY', 'http destination accepted', checkPublicUrl('http://example.org/a') === null);
for (const url of ['javascript:alert(1)', 'data:text/plain,x', 'file:///tmp/x', '/var/data/x']) {
  const b = withClaim(build(30), 'source_url', url);
  const r = run(b)[0];
  check('URL_SAFETY', `record with source_url ${JSON.stringify(url)} rejected`, r.status === OUTCOME.REJECT && hasCodes(r, ['UNSAFE_URL']));
}
{
  const b = withClaim(build(31), 'action_url', 'javascript:alert(1)');
  check('URL_SAFETY', 'unsafe action_url rejected', run(b)[0].status === OUTCOME.REJECT);
}

// Determinism: repeat runs, key-shuffled clone, input untouched.
{
  const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
  const reverseKeys = (v) => Array.isArray(v) ? v.map(reverseKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])])) : v;
  const merged = [build(1), build(2, { kind: 'deadline' }), build(5, { currentness: 'Currentness Unknown', claimOverrides: { actionability: null, action_url: null } })];
  const bundle = {
    records: merged.flatMap((b) => b.records), evidence: merged.flatMap((b) => b.evidence),
    decisions: merged.flatMap((b) => b.decisions), providers: merged[0].providers, assessment_date: merged[0].assessment_date,
    directory_selected_ids: [], home_feature_ids: [],
  };
  const before = canonicalJson(bundle);
  deepFreeze(bundle);
  let threw = false; let first; let second; let shuffled;
  try {
    first = canonicalJson(run(bundle));
    second = canonicalJson(run(bundle));
    const clone = reverseKeys(structuredClone(bundle));
    clone.records.reverse();
    shuffled = canonicalJson(projectBatch(clone.records, contextOf(clone)));
  } catch { threw = true; }
  check('DETERMINISM', 'transform does not mutate (frozen) input', !threw && before === canonicalJson(bundle));
  check('DETERMINISM', 'repeat run is byte-identical', !threw && first === second && first.length > 0);
  check('DETERMINISM', 'key and record order of input does not change output', !threw && first === shuffled);
  const direct = JSON.stringify(run(bundle).map((r) => r.projection));
  check('DETERMINISM', 'raw serialization is identical across runs', direct === JSON.stringify(run(bundle).map((r) => r.projection)));
  check('DETERMINISM', 'projection keys follow allowlist order', accepted.every((a) => {
    const idx = Object.keys(a.projection).map((k) => PUBLIC_OUTPUT_FIELDS.indexOf(k));
    return idx.every((v, i) => i === 0 || idx[i - 1] < v);
  }));
}

// Report.
const failed = checks.filter((c) => !c.ok);
const groupNames = ['CASES', 'DETERMINISM', 'PRIVATE_FIELD_EXCLUSION', 'URL_SAFETY', 'CURRENTNESS_GATES', 'DIRECTORY_HOME_SEPARATION'];
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  [${c.group}] ${c.name}`);
console.log('');
for (const g of groupNames) console.log(`${groups.get(g) ? 'PASS' : 'FAIL'}  group ${g}`);
const expectedNonAccept = CASES.filter((c) => c.expect.status !== OUTCOME.ACCEPT).length;
console.log('');
console.log(`tests passed: ${checks.length - failed.length}`);
console.log(`tests failed: ${failed.length}`);
console.log(`accepted projections: ${accepted.filter((a) => caseResults.get(a.id).status === OUTCOME.ACCEPT).length} (cases: ${accepted.filter((a) => caseResults.get(a.id).status === OUTCOME.ACCEPT).map((a) => a.id).join(', ')})`);
console.log(`expected rejections/suppressions/review/no-actionable cases: ${expectedNonAccept}`);
process.exit(failed.length === 0 ? 0 : 1);
