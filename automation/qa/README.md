# Post-publication QA (Phase 2A)

Read-only detection and observability for the deployed production site.

Phase 2A answers one question — *is the deployed A PRASA production site
behaving and presenting as expected?* — and records structured evidence a
future Phase 2B could act on. It terminates at **DETECT → CLASSIFY → RECORD →
REPORT**. It never fixes anything.

## Zero mutation authority

Nothing in `scripts/qa/` commits, pushes, opens or merges a pull request,
deploys, deletes a branch, files an issue, or notifies an external service.

Live traffic is GET/HEAD-only against derived same-origin routes, and that is
**enforced rather than intended**. The distinction matters because the browser
runs the real production JavaScript: repository permissions say nothing about
what a page, an analytics tag, a beacon or a future service worker does inside
Chrome. So the guarantee is implemented at two request layers:

| Layer | Mechanism | What it prevents |
| --- | --- | --- |
| HTTP (`lib/qa-http.mjs`) | `assertReadOnlyMethod` on the single funnel every request passes through | any code path issuing anything but GET/HEAD |
| HTTP redirects | every hop's `Location` is resolved and origin-checked *before* the hop is requested | live traffic leaving `aprasa.org` through a redirect |
| Browser (`lib/qa-browser-guard.mjs`) | CDP `Fetch` interception at the Request stage on the page and on every auto-attached worker target | POST/PUT/PATCH/DELETE/OPTIONS, XHR, `fetch`, form submissions, and off-origin top-level navigation |
| Browser (in-page) | a guard installed on every new document that cancels form submissions and neutralises `navigator.sendBeacon` | unload-time mutations, where interception is least reliable |

Blocked requests are never transmitted. They are recorded with their method,
URL and the reason they were refused, then classified: a first-party mutation
attempt is a WARNING (unexpected on a static site, so it is surfaced explicitly
rather than silently allowed), a third-party beacon or analytics POST is INFO,
and an off-origin top-level navigation is a WARNING. **None of them is an
ERROR**, because a correctly prevented analytics beacon must never read as a
production defect. If a page genuinely cannot render without a blocked request,
the render, content and required-asset checks fail on their own merits.

Service workers cannot become a side channel: page traffic bypasses them
(`Network.setBypassServiceWorker`), and any worker target the page spawns is
auto-attached and gated by the same rule. The guard deliberately does *not*
monkey-patch `serviceWorker.register`, because rejecting that promise inside the
page would surface as a first-party page error — exactly the false defect this
layer exists to avoid.

Three independent checks in CI keep this honest, and none substitutes for the
others:

1. `scripts/qa/audit-read-only.mjs` — structural. Asserts every QA workflow
   holds only `read`/`none` permissions and that the pinned origin, both
   `READ_ONLY_METHODS` sets and the guard installation are still in the source.
2. A grep guard in `post-publication-qa-tests.yml` — textual. Fails the build if
   a write-capable call appears in `scripts/qa/`.
3. The test matrix — behavioural. A recording `fetch` proves every GitHub API
   call is a bodyless GET, and the fixture server's own request log proves that
   a real Chrome running real page code only ever issued GET.

`auto_remediation_candidate` on an issue is classification metadata for a
future phase. It grants no authority here.

## Modes and cadence

| Mode | Trigger | Cost profile |
| --- | --- | --- |
| `IMMEDIATE_POST_DEPLOY` | push to `main`, after a bounded Pages readiness wait | source + full live HTTP + small browser pass |
| `DELAYED_RECHECK` | reconciler, 30–90 min after a successful deployment | source + full live HTTP, no browser |
| `DAILY_LIGHTWEIGHT` | 07:10 UTC, Sun and Tue–Sat | source + full live HTTP, no browser |
| `WEEKLY_DEEP` | 07:40 UTC Monday | source + full live HTTP + 8-route browser pass |
| `MANUAL` | `workflow_dispatch` | source + full live HTTP + small browser pass |

Cron times are UTC; production is `Atlantic/Cape_Verde` (UTC−1), so the daily
run lands at 06:10 local. Daily skips Monday so the weekly deep pass is that
day's single run — exactly one scheduled QA run per day.

### Why the delayed check is a reconciler

A delayed verification must land roughly 30–90 minutes after a deployment.
Parking a runner in `sleep` for that hour would bill an hour of idle time per
publication. Instead `post-publication-qa-reconcile.yml` runs every 30 minutes,
and `scripts/qa/reconcile-delayed-recheck.mjs` answers one cheap question.

The question is deliberately narrow: **is the commit that is currently the head
of `main` deployed, successfully, inside the window, and not yet validly
rechecked?** Every clause is load-bearing:

- It starts from current `main`, resolved from the repository's default branch,
  not from "the newest deployment that happens to have succeeded". Scanning the
  deployment list for a success will happily pick a commit from two
  publications ago while the commit that is actually live is pending or failed,
  and then report on content nobody is serving any more.
- The deployment SHA must equal current `main` **exactly**. There is no nearest
  match and no fallback to an older success, however recent.
- If current `main` is undeployed, `PENDING`, `FAILED`, or unreadable, the
  answer is a conservative no-run — `CURRENT_MAIN_NOT_DEPLOYED`,
  `CURRENT_MAIN_DEPLOYMENT_PENDING`, `CURRENT_MAIN_DEPLOYMENT_FAILED`,
  `CURRENT_MAIN_DEPLOYMENT_UNKNOWN`, `CURRENT_MAIN_UNREADABLE` — never a run
  against a different SHA.

Concurrent firings cannot race into duplicate work: the workflow serialises on
its own concurrency group, and the recheck job serialises again per SHA.

### Dedupe is a completion marker, never the evidence artifact

Two artifacts, two jobs:

| Artifact | Uploaded | Meaning |
| --- | --- | --- |
| `post-publication-qa-delayed-<sha>` | `always()` | evidence, including from a crashed run |
| `post-publication-qa-complete-DELAYED_RECHECK-<sha>` | only after validation | this SHA has genuinely been rechecked |

Evidence has to be uploaded unconditionally, because a crashed run's partial
output is exactly what someone needs in order to understand the crash. But an
artifact that exists *because* a runner died is not proof the recheck happened,
and using it as the dedupe signal would cancel the very recheck the crash made
necessary. Only the marker suppresses a future run.

`scripts/qa/verify-delayed-completion.mjs` writes the marker only when the final
report exists, validates against the published schema, carries the exact
expected SHA and the `DELAYED_RECHECK` mode, has a parseable `completed_at`, and
reached a terminal verdict. `UNKNOWN` is deliberately **not** terminal: it means
the run could not identify what is deployed, so that SHA stays eligible for
another attempt inside its window. An expired or empty marker artifact does not
dedupe either — retention must not quietly become policy.

No QA state is ever committed to the repository; it all lives in GitHub's
artifact store.

## Deployment provenance

The site carries no build stamp — Phase 2A must not alter public HTML to add
one — so deployed identity comes only from GitHub's `github-pages` deployment
records:

| State | Meaning |
| --- | --- |
| `DEPLOYMENT_VERIFIED` | GitHub reports a successful deployment of exactly the expected SHA |
| `DEPLOYMENT_PENDING` | that deployment is queued/in progress, or none exists yet and the commit is inside the propagation window |
| `DEPLOYMENT_FAILED` | that deployment reports failure or error |
| `DEPLOYMENT_UNKNOWN` | no token, no metadata, or a result we cannot interpret conservatively |

`VERIFIED` asserts that GitHub finished publishing that commit, not that every
CDN edge already serves it; the report says so in its evidence. Matching live
bytes are recorded as supporting evidence and never upgrade the state on their
own, because identical bytes do not prove which commit produced them.

While a deployment is `PENDING`, live HTTP and browser ERRORs are downgraded to
WARNING and tagged `DEPLOYMENT_PENDING_PROPAGATION_WINDOW`. Source-validation
and deployment findings are never downgraded.

### Edge readiness after a VERIFIED deployment

`DEPLOYMENT_VERIFIED` and "every CDN edge serves the new content" are not the
same statement, and treating the first stale 200 as a defect is a false failure
during ordinary propagation. So `IMMEDIATE_POST_DEPLOY` — and only that mode —
retries the live HTTP pass inside a bounded grace window while the *only*
findings a stale edge could explain are still present.

| Parameter | Default | Flag |
| --- | --- | --- |
| Grace window | 180 000 ms (3 minutes) | `--edge-grace-ms` |
| Retry cadence | 30 000 ms (30 seconds) | `--edge-retry-ms` |

Each retried attempt is recorded as its own INFO `EDGE_PROPAGATION_RETRY`
finding tagged `propagation_related: true`, so a run that recovered still shows
what it saw first. The window can also end early: if the live Home bytes match
the checked-out commit, propagation is demonstrably finished and anything still
mismatched is real. Once the window closes, surviving findings keep their normal
ERROR/CRITICAL severity and gain
`edge_grace_outcome: EXHAUSTED_STILL_MISMATCHED` — the record that propagation
was considered and ruled out, not a downgrade.

Eligibility is a closed list, because a stale edge produces one shape of
symptom: presence/absence of content it has not received yet.

**Eligible** — `ROUTE_NOT_FOUND`, `ROUTE_UNEXPECTED_STATUS`,
`ROUTE_SERVER_ERROR`, `ROUTE_UNREACHABLE`, `RESPONSE_BODY_EMPTY`,
`SITEMAP_ROUTE_MISSING`, `SITEMAP_PUBLIC_ROUTE_MISMATCH`, `TTD_IDENTITY_MISSING`,
`TTD_CURRENT_RECORD_MISSING_FROM_HOME`, `TTD_EXPIRED_SURFACED`,
`LOCALE_PT_ROUTE_MISSING`, `LOCALE_REQUIRED_VALUE_MISSING`.

**Never downgraded** — everything in `SOURCE_VALIDATION` and
`DEPLOYMENT_PROVENANCE` (excluded structurally, by domain), plus live findings a
stale edge cannot cause: `ROUTE_BODY_INVALID` (a stale edge serves a valid
*older* shell), `CONTENT_TYPE_UNEXPECTED` (server configuration),
`LOCALE_LANG_MISMATCH` (an older page still carries a correct `lang`),
`LOCALE_BRAND_CORRUPTION` (a protected-brand rule, never softened), and the
redirect codes (routing configuration).

The browser domain is not graced, and does not need to be: it runs after the
HTTP pass has already settled or exhausted its window, so by the time a page is
rendered the edge question is answered.

## What is checked

Targets are derived from authoritative repository data — `sitemap.xml`,
`data/things-to-do-events.json`, `data/things-to-do-currentness.json`,
`data/locales/locale-data.generated.json`, and which PT pages exist on disk.
There is no second hardcoded event list, so a newly published event is picked
up with no edit here.

- **Source** — the incumbent validators run unchanged as child processes:
  events, currentness, surface equivalence, sitemap, locale contract, PT Home
  event regions, card media. Structural failures are ERROR; live-date
  currentness drift is WARNING.
- **Live HTTP** — status, per-hop redirect origin and correctness, content
  type, page shell, `html lang`, protected `A PRASA` spelling, required
  same-origin assets, `sitemap.xml`, `robots.txt`.
- **Things-to-Do live contract** — EN and PT detail routes live, event identity
  and provider on the detail page, canonical route ↔ sitemap correspondence,
  Home currentness against the committed `as_of`, live sitemap agreement.
- **Localization** — governed PT navigation values on the live PT Home (read
  from the generated locale data, never hardcoded), `lang` contract, brand
  corruption. No translation-quality judgement, no LLM.
- **Browser** — 375px mobile and 1440px desktop: horizontal overflow, rendered
  image decode, page shell, primary content, console and page errors, failed
  requests, and the read-only enforcement record (what the guard refused, and
  why). Screenshots are captured as evidence and never pixel-compared.

## Console and network classification

| Source | Severity | Code |
| --- | --- | --- |
| Same-origin request or script | ERROR | `FIRST_PARTY_REQUEST_FAILED`, `FIRST_PARTY_PAGE_ERROR`, `FIRST_PARTY_CONSOLE_ERROR` |
| Known third party (`plausible.io`, Google Fonts) | WARNING | `EXTERNAL_DEPENDENCY_WARNING` |
| Unrecognised third party | WARNING | `EXTERNAL_UNCLASSIFIED_FAILURE` |
| Browser-implicit (`/favicon.ico`) | INFO | `BROWSER_IMPLICIT_REQUEST_FAILED` |
| First-party mutating request, refused | WARNING | `BROWSER_FIRST_PARTY_MUTATION_BLOCKED` |
| Third-party beacon or mutating request, refused | INFO | `BROWSER_THIRD_PARTY_MUTATION_BLOCKED` |
| Off-origin top-level navigation, refused | WARNING | `BROWSER_OFFSITE_NAVIGATION_BLOCKED` |
| Off-origin HTTP redirect, refused | ERROR | `ROUTE_REDIRECT_OFF_ORIGIN_BLOCKED` |
| Chrome's console echo of our own block | INFO | `BROWSER_READ_ONLY_GUARD_CONSOLE_ECHO` |

Nothing is dropped without a named rule. Adding a third-party origin to
`KNOWN_EXTERNAL_ORIGINS` in `scripts/qa/lib/qa-classify.mjs` is a deliberate,
reviewable act.

## False-positive controls

- Pages propagation downgrades live errors while a deployment is pending.
- Home currentness is judged against the committed `as_of`, not wall-clock
  time; a record that has merely aged since the last publication run is a
  `TTD_CURRENTNESS_DRIFT` **warning**, not an error.
- Bounded retry for transport errors and retryable statuses only — a stable 404
  is returned on the first attempt and never retried away.
- Overflow must reproduce across two measurement passes; a single-pass reading
  is a non-deterministic warning.
- Overflow is measured against `documentElement.clientWidth`, because Chrome's
  mobile emulation expands `innerWidth` to the overflowing content width and
  would hide the defect.
- Render checks apply only to images the browser actually renders. A PRASA
  ships locale-variant images that CSS hides on the other locale; those never
  load by design and judging them would be a pure false positive.
- Lazy images are swept viewport by viewport and waited for on a bounded
  budget. An incomplete image is INFO — a *broken* image reports
  `complete === true` with `naturalWidth === 0`, so incompleteness only ever
  means "still loading".
- Redirects that only add https or a trailing slash on the same origin are INFO,
  and every hop is checked — a chain that detours off-origin and comes back is
  not benign just because its endpoints agree.
- Chrome logs `net::ERR_BLOCKED_BY_CLIENT` for every request the read-only guard
  refuses. The run is headless with no extensions, so in this context that text
  has exactly one source: us. It is classified INFO as
  `BROWSER_READ_ONLY_GUARD_CONSOLE_ECHO` rather than blamed on the site, and the
  attempt itself is still recorded in full with its method and URL.
- A blocked off-origin *navigation* is aborted rather than hard-failed, so the
  document under measurement survives and the render checks still judge the real
  page instead of a Chrome error page.

## Report contract

`scripts/qa/qa-report.schema.json` (`1.0.0`) is the published envelope, and
every run validates its own report against it. `version` is pinned to the exact
string `1.0.0` rather than a version-shaped pattern, and `started_at` /
`completed_at` must be RFC 3339 timestamps, so a consumer can rely on both. Results stay in four distinct
domains: `SOURCE_VALIDATION`, `LIVE_HTTP_VALIDATION`, `LIVE_BROWSER_VALIDATION`,
`DEPLOYMENT_PROVENANCE`.

Severity is `INFO | WARNING | ERROR | CRITICAL`; overall status is
`HEALTHY | DEGRADED | FAILED | UNKNOWN`, rolled up as:

1. any ERROR or CRITICAL → `FAILED`
2. otherwise an unknown deployed SHA → `UNKNOWN`
3. otherwise any WARNING → `DEGRADED`
4. otherwise `HEALTHY`

Only `FAILED` fails the workflow. Warnings never do.

## Evidence

Each run uploads `qa-artifacts/` — `post-publication-qa.json`, `summary.md`,
and `screenshots/<route>--<viewport>.png` — as a GitHub Actions artifact, and
writes a concise Step Summary. Routine QA results are never committed.

A delayed recheck additionally publishes `qa-marker/completion.json` under
`post-publication-qa-complete-DELAYED_RECHECK-<sha>`, but only once its report
has passed validation. That marker is the dedupe signal; the evidence artifact
never is.

## Running locally

```sh
# Against production, read-only. Deployment state will be UNKNOWN without a token.
node scripts/qa/run-post-publication-qa.mjs --mode=MANUAL --out=qa-artifacts

# The deterministic test matrix (loopback fixtures only).
node scripts/qa/test-post-publication-qa.mjs

# The structural read-only re-audit CI also runs.
node scripts/qa/audit-read-only.mjs
```

The production target is pinned to `https://aprasa.org`. An alternative base
URL is accepted only with `APRASA_QA_ALLOW_TEST_TARGET=1`, only over plain HTTP,
and only against loopback — this is not a general-purpose URL scanner. That
override is the single non-production target mechanism in the layer; there is no
other way to point live traffic anywhere else, and the redirect guard means the
site itself cannot move it either.

## Browser dependency

The repository has no `package.json` and no dependency tree, so the browser
layer is a ~200-line CDP client (`scripts/qa/lib/cdp.mjs`) speaking to whatever
Chrome/Chromium the runner already provides. Nothing is installed. If no
binary is found the browser domain is skipped with a warning rather than
failing the run. Set `APRASA_QA_CHROME` to point at a specific binary.

Every CDP command carries its own 30-second deadline, so one wedged command
costs a failed check rather than the whole job budget. A launch that fails
part-way — no debugging endpoint, or a websocket that never opens — kills the
spawned Chrome and removes its temporary profile directory rather than leaking
both for the rest of the run.

## Cost

Approximate GitHub Actions runner minutes:

| Job | Frequency | Minutes per run | Minutes per month |
| --- | --- | --- | --- |
| Delayed reconciler (no-op path) | 48/day | ~0.4 | ~580 |
| Delayed recheck (fires) | per publication | ~2 | small |
| Daily lightweight | 6/week | ~2 | ~50 |
| Weekly deep | 1/week | ~6 | ~26 |
| Immediate | per merge to main | ~5 (incl. up to 5 min readiness wait) | small |

The reconciler dominates by count and is the obvious dial: raising its cron to
`0 * * * *` roughly halves that line at the cost of a wider delayed window.
Public repositories bill no Actions minutes.

## Known limitations

- `DEPLOYMENT_VERIFIED` proves GitHub published the commit, not that every CDN
  edge serves it. The bounded edge-readiness window above is the mitigation;
  without altering public HTML to carry a build stamp there is no stronger
  available signal, and Phase 2A must not alter public HTML.
- Browser coverage is deliberately narrow (Home EN/PT plus a dynamically
  selected current detail route; weekly adds About and Mindelo Essentials). Not
  every route is rendered every run, by design.
- Rendered-image checks skip images the browser does not render, so a regression
  that hides a required image via CSS surfaces as a missing Home surface rather
  than a broken image.
- `IMAGE_NOT_SETTLED` is INFO and aggregated per route/viewport; a persistently
  slow image is visible but never fails a run.
- Cron firing is best-effort, so the delayed window is 30–180 minutes rather
  than a strict 30–90.
- The reconciler fires ~48 times a day; see the cost dial above.
- Rendered-image inspection is capped at the first 200 images per page.

## Phase 2B compatibility

Issues carry `code`, `severity`, `category`, `domain`, `route`, `locale`,
`check`, `observed`, `expected`, `evidence`, `deterministic`, `resolver_class`,
`retryable`, and `auto_remediation_candidate`, so a later orchestrator can route
a finding without re-reading the site. Resolver classes are `TECHNICAL`,
`LOCALIZATION`, `CONTENT_GOVERNANCE`, `MEDIA`, `EXTERNAL_DEPENDENCY`,
`DEPLOYMENT`, `UNKNOWN`.
