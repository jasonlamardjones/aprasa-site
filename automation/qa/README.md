# Post-publication QA (Phase 2A)

Read-only detection and observability for the deployed production site.

Phase 2A answers one question — *is the deployed A PRASA production site
behaving and presenting as expected?* — and records structured evidence a
future Phase 2B could act on. It terminates at **DETECT → CLASSIFY → RECORD →
REPORT**. It never fixes anything.

## Zero mutation authority

Nothing in `scripts/qa/` commits, pushes, opens or merges a pull request,
deploys, deletes a branch, files an issue, or notifies an external service.
Live traffic is GET-only against derived same-origin routes; there is no
crawler. `.github/workflows/post-publication-qa-tests.yml` fails the build if a
write-capable call ever appears in the QA layer.

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
and `scripts/qa/reconcile-delayed-recheck.mjs` answers one cheap question: is
there a successful `github-pages` deployment aged 30–180 minutes that has not
been rechecked? Almost every firing answers "no" in a few seconds.

The dedupe marker is the delayed run's own evidence artifact
(`post-publication-qa-delayed-<sha>`), so no QA state is ever committed to the
repository.

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
- **Live HTTP** — status, redirect correctness, content type, page shell,
  `html lang`, protected `A PRASA` spelling, required same-origin assets,
  `sitemap.xml`, `robots.txt`.
- **Things-to-Do live contract** — EN and PT detail routes live, event identity
  and provider on the detail page, canonical route ↔ sitemap correspondence,
  Home currentness against the committed `as_of`, live sitemap agreement.
- **Localization** — governed PT navigation values on the live PT Home (read
  from the generated locale data, never hardcoded), `lang` contract, brand
  corruption. No translation-quality judgement, no LLM.
- **Browser** — 375px mobile and 1440px desktop: horizontal overflow, rendered
  image decode, page shell, primary content, console and page errors, failed
  requests. Screenshots are captured as evidence and never pixel-compared.

## Console and network classification

| Source | Severity | Code |
| --- | --- | --- |
| Same-origin request or script | ERROR | `FIRST_PARTY_REQUEST_FAILED`, `FIRST_PARTY_PAGE_ERROR`, `FIRST_PARTY_CONSOLE_ERROR` |
| Known third party (`plausible.io`, Google Fonts) | WARNING | `EXTERNAL_DEPENDENCY_WARNING` |
| Unrecognised third party | WARNING | `EXTERNAL_UNCLASSIFIED_FAILURE` |
| Browser-implicit (`/favicon.ico`) | INFO | `BROWSER_IMPLICIT_REQUEST_FAILED` |

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
- Redirects that only add https or a trailing slash on the same origin are INFO.

## Report contract

`scripts/qa/qa-report.schema.json` (`1.0.0`) is the published envelope, and
every run validates its own report against it. Results stay in four distinct
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

## Running locally

```sh
# Against production, read-only. Deployment state will be UNKNOWN without a token.
node scripts/qa/run-post-publication-qa.mjs --mode=MANUAL --out=qa-artifacts

# The deterministic test matrix (loopback fixtures only).
node scripts/qa/test-post-publication-qa.mjs
```

The production target is pinned to `https://aprasa.org`. An alternative base
URL is accepted only with `APRASA_QA_ALLOW_TEST_TARGET=1`, only over plain HTTP,
and only against loopback — this is not a general-purpose URL scanner.

## Browser dependency

The repository has no `package.json` and no dependency tree, so the browser
layer is a ~200-line CDP client (`scripts/qa/lib/cdp.mjs`) speaking to whatever
Chrome/Chromium the runner already provides. Nothing is installed. If no
binary is found the browser domain is skipped with a warning rather than
failing the run. Set `APRASA_QA_CHROME` to point at a specific binary.

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

## Phase 2B compatibility

Issues carry `code`, `severity`, `category`, `domain`, `route`, `locale`,
`check`, `observed`, `expected`, `evidence`, `deterministic`, `resolver_class`,
`retryable`, and `auto_remediation_candidate`, so a later orchestrator can route
a finding without re-reading the site. Resolver classes are `TECHNICAL`,
`LOCALIZATION`, `CONTENT_GOVERNANCE`, `MEDIA`, `EXTERNAL_DEPENDENCY`,
`DEPLOYMENT`, `UNKNOWN`.
