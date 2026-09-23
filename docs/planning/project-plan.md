# CFWorker4AliCDT — Project Plan

> Status: **REVISION 2 — APPROVED BY OWNER (2026-09-20), incorporating the Web/D1
> architecture revision.** This document supersedes Revision 1 (the initial planning
> PR [#1](https://github.com/Skyline-Gazer/CFWorker4AliCDT/pull/1)).
> Revision 1's fail-safe model, decision rule, traffic semantics, and ECS control
> semantics are **unchanged**. What changed is the runtime surface: an authenticated
> Web dashboard, D1 monitoring history, and a read-only manual live query are now
> **v1 requirements** rather than non-goals. See §2 for the full delta.
>
> Amendment carried forward: PLAN Q2 (`StoppedMode`) resolved by owner — default
> `KeepCharging`.
>
> Amendment (2026-09-22): the owner approved Revision 2 as the target canonical
> architecture and resolved **Q4** (remain on Workers Free; measure before upgrading),
> **Q5** (retain D1 history indefinitely), and **Q6** (repository is public; enable the
> `main` protection ruleset — R11 resolved, Issue #15 unblocked).

## 1. Document control

| Field | Value |
| --- | --- |
| Repository | `Skyline-Gazer/CFWorker4AliCDT` (**public**) |
| Planning baseline SHA | `1afffec` — planning docs present on `main` |
| Revision branch | `docs/web-d1-architecture-revision` |
| Companion spec | [`project-spec.md`](./project-spec.md) |
| Implementation state at revision | P0 **merged** (`c6380e4`); P1 open (PR #35); P2/P3 open (PR #37) |
| Deployment state | **None.** No Worker has been deployed. No live Alibaba Cloud call has been made. |

## 2. Architecture delta (Revision 1 → Revision 2)

The owner requires an operational Web interface, and an existing first-party
Cloudflare Worker implementation (`GLaDos_Workers_CheckIN`) provides proven, reusable
patterns for Web, Auth, D1, and CI. This section states exactly what changed and why,
so a reviewer can see the revision is additive rather than a rewrite.

### 2.1 Previous v1 assumption (Revision 1)

- A **stateless** Cloudflare Worker.
- **`GET /health` was the only HTTP surface.**
- **No database.** D1, KV, and Durable Objects were explicit non-goals.
- **No dashboard.** Observability was the webhook and Workers Logs only.
- Cross-invocation state persistence was prohibited.

### 2.2 Revised v1 (Revision 2)

- A Cloudflare Worker that is **no longer stateless**: it keeps **monitoring history**
  in D1. It is still **control-stateless** — no decision depends on D1 contents.
- An **authenticated operational dashboard** served from the same Worker.
- **D1 monitoring history** as an observational record of every scheduled run.
- An **authenticated, strictly read-only manual live query** endpoint, powering
  "Query now" / "Refresh" on the dashboard.
- **Cron remains the only ECS mutation authority.** The revision widens the read and
  observe surface; it does **not** widen the control surface.

### 2.3 Reason

An unattended threshold enforcer with no operator-visible history is hard to trust and
hard to debug. When the system declines to act — a `fail-safe` row, an invalid traffic
reading, a `config` error — the operator currently has only a webhook message and
retained logs. A dashboard with history makes the fail-safe behaviour *inspectable*,
which is what allows a conservative design to be operated with confidence rather than
blind faith.

The dashboard is deliberately **read-only with respect to ECS control**. It answers
"what does the system see and what did it decide", never "make it do this now". A manual
mutation button would introduce a second mutation authority, and with it a way to
defeat the threshold enforcement the project exists to provide.

### 2.4 Impact on completed work

| Phase | Impact | Classification |
| --- | --- | --- |
| **P0** — Repository & tooling | None. Formatter, linter, typecheck, test runner, CI, Wrangler config are all unaffected. D1 support is a Wrangler config addition, not a tooling change. | **KEEP** |
| **P1** — Alibaba RPC layer | None. P1 is a signing/transport boundary with no knowledge of HTTP routing, storage, or presentation. | **KEEP** |

Impact begins **after** P1. No completed work is discarded, renamed, or rewritten.

## 3. Problem statement

An Alibaba Cloud ECS instance is used to relay traffic billed under Cloudflare
Data Transfer (CDT). When monthly internet traffic reaches a configured allowance,
continued operation risks unexpected spend (or suspension). Today this is managed
manually: an operator periodically checks traffic and starts or stops the instance
by hand. Manual monitoring fails in both directions:

- **Fail-open risk** — traffic crosses the threshold while nobody is watching, and
  the instance keeps running and keeps accruing cost.
- **Error risk** — an operator misreads a dashboard, stops an instance that should be
  running, or leaves it stopped after the window has passed.

Existing community scripts solve the happy path but, on inspection, contain the
specific failure this project exists to prevent: when the traffic response is
missing or malformed they coerce the value to `0`, conclude "under threshold", and
leave the instance running. They also expose unauthenticated control endpoints and
issue unsolicited reboots. Those behaviours are treated here as **anti-requirements**
— documented so they are not reintroduced.

## 4. Objective

A single Cloudflare Worker, invoked by a Cron Trigger every 10 minutes, that:

1. Retrieves current CDT internet traffic from the Alibaba Cloud CDT API.
2. Retrieves the current state of exactly one ECS instance.
3. Applies a deterministic threshold rule to decide the *desired* instance state.
4. Performs **at most one** idempotent ECS state mutation, and only when the desired
   state differs from the observed state.
5. Reports the outcome of every run to a generic webhook.
6. Records the outcome of every run in D1 as monitoring history.
7. Serves an authenticated dashboard over the history and current state.

### Success criteria

| # | Criterion |
| --- | --- |
| S1 | A scheduled run that cannot reliably retrieve traffic performs **zero** ECS mutations, logs, dispatches an error webhook, and exits. |
| S2 | A missing, null, non-numeric, negative, or unparseable traffic value is **never** interpreted as `0`. |
| S3 | Desired state equals observed state ⇒ no API mutation is issued. |
| S4 | Webhook delivery failure never changes, cancels, reverses, or triggers an ECS operation. |
| S5 | No credential, token, or secret-bearing value is ever logged, echoed, returned over HTTP, stored in D1, or committed. |
| S6 | No HTTP route performs a privileged **mutation**. The only mutating code path is the Cron Trigger. |
| S7 | All behaviour in this PLAN and the SPEC is covered by deterministic tests that perform no live Alibaba Cloud mutation. |
| S8 | A D1 write failure does not reverse, alter, or block an ECS control outcome. |
| S9 | No authenticated HTTP route can start, stop, or reboot an instance. |

### Explicit non-goals

Out of scope for v1, and MUST NOT be added opportunistically: user account systems,
RBAC, multi-user access, React/Vue/Next.js or any frontend framework, a separate
Cloudflare Pages deployment, multiple ECS instances, multi-region orchestration, a
generic Alibaba control console, a manual ECS start/stop UI, any unauthenticated
control endpoint, a general-purpose automation platform, Queues, Durable Objects or KV
unless a technical necessity is demonstrated, notification platform expansion beyond
the single generic webhook, AI forecasting, and traffic prediction.

**Removed from the Revision 1 non-goal list:** D1, dashboard, and any HTTP surface
beyond `/health`. Their removal is the substance of this revision. Everything else in
the Revision 1 non-goal list stands. This remains an operations dashboard for one
instance, not an infrastructure-management console.

## 5. Repository baseline and retained assets

At Revision 1 the repository contained one commit and one file. It now contains the
planning docs on `main`, plus completed P0 and P1 work on open pull requests.

| Asset | Disposition |
| --- | --- |
| `README.md` | **Retain.** Extend into a user-facing document (purpose, setup, configuration). MUST NOT be destructively overwritten or repurposed as a tracking document. |
| `docs/planning/project-plan.md`, `docs/planning/project-spec.md` | **Retain, revised by this document.** These remain the canonical planning docs. |
| P0 tooling (PR #34) | **Retain.** Unchanged. |
| P1 Alibaba RPC (PR #35) | **Retain.** Unchanged, including its file layout and its 144-test baseline. |
| Everything else | Does not exist. |

No local task-tracking markdown (`todo.md`, `phase-todo.md`, `tracker.md`, Kanban
files) is permitted. Task state lives in the GitHub Project; technical design lives in
`docs/`.

## 6. External API dependencies

All contracts below were verified against primary sources during research. Where a
contract could not be verified, that fact is stated explicitly and treated as a risk
with a mitigation — it is never presented as confirmed.

### 6.1 CDT — `ListCdtInternetTraffic`

| Property | Value | Verification |
| --- | --- | --- |
| Product code | `cdt` | SDK |
| API version | **`2021-08-13`** | Verified |
| Style / method | RPC, `POST`, pathname `/` | SDK `.tea` spec |
| Body type | `formData`, `application/x-www-form-urlencoded`, response JSON | SDK `.tea` spec |
| Auth type | `AK` (AccessKey pair) | SDK `.tea` spec |
| Endpoint | `cdt.aliyuncs.com` — **unconfirmed** | See risk R2 |

**Correction to the originating brief.** The brief assumed API version `2021-08-31`.
That version does not exist for this product. The correct version is `2021-08-13`,
confirmed identically by both the Tea specification
(`aliyun/alibabacloud-sdk/cdt-20210813/main.tea`) and the Python SDK client
(`alibabacloud_cdt20210813/client.py`):

```
action = 'ListCdtInternetTraffic'   version = '2021-08-13'
protocol = 'HTTPS'                  pathname = '/'
method = 'POST'                     authType = 'AK'
style = 'RPC'                       reqBodyType = 'formData'
bodyType = 'json'
```

Request parameters: exactly one, `BusinessRegionId` (string, optional).
**There are no pagination parameters.**

Response (`ListCdtInternetTrafficResponseBody`): `RequestId` (string) and
`TrafficDetails` (array), where each element carries `BusinessRegionId` (string),
`ISPType` (string), `ProductTrafficDetails` (array of `{Product, Traffic}`),
`Traffic` (**long**), and `TrafficTierDetails` (array).

**Undocumented operation — structural risk.** The SDK's `api-info.json` places
`ListCdtInternetTraffic` in `apiDoc.noDoc`. Alibaba publishes no prose documentation
for it. Consequences, all observed directly:

- `help.aliyun.com` and the `www.alibabacloud.com/help/en/cdt/developer-reference/...`
  pages for this operation return 404.
- The OpenAPI metadata service returns `{"code":500,"message":"Product is not public"}`
  for product code `cdt` on every version tried.
- CDT is absent from the public 352-entry `products.json`.

Therefore **no behaviour of this operation may be cited as documented.** Its contract
is discovered from the SDK and from independent implementations, and the SPEC pins it
as a contract we own and test rather than one we inherit.

**Unit assumption.** `Traffic` is typed `long`. No Alibaba prose source states the
unit. Independent implementations treat it as bytes. This project treats it as
**bytes** and records that as an assumption (see SPEC §3), not as established fact.
Mitigation: the unit is never implicit in code — conversion happens in exactly one
named function.

**Reduction rule.** The total is the arithmetic sum of `TrafficDetails[].Traffic`.
There is no pagination to walk. This replaces the brief's "pagination" test
requirement, and the SPEC MUST state the substitution plainly so that a reviewer does
not read it as a dropped requirement.

### 6.2 ECS — `DescribeInstances`, `StartInstance`, `StopInstance`

Version `2014-05-26`, RPC style, `POST`/`GET`, HTTPS, AK auth, documented.

| Operation | RAM action | Notes |
| --- | --- | --- |
| `DescribeInstances` | `ecs:DescribeInstances` | `read` / `list`. `RegionId` required. `InstanceIds` is a JSON-array string. `Status` ∈ `Pending│Running│Starting│Stopping│Stopped`. `TotalCount` is meaningless when `NextToken`/`MaxResults` are used. |
| `StartInstance` | `ecs:StartInstance` | **Asynchronous.** Precondition: instance `Stopped`. Returns success, then the instance enters `Starting`. |
| `StopInstance` | `ecs:StopInstance` | **Asynchronous.** `ForceStop` defaults to `false`. `StoppedMode` = `StopCharging│KeepCharging`. |

Error codes in the shared family include `IncorrectInstanceStatus` (403),
`InvalidInstanceId.NotFound` (404), `InstanceLockedForSecurity` (403),
`InsufficientBalance`, `InstanceNotReady`, `OperationDenied.NoStock`.

Two behaviours drive the design:

- **Both control operations are asynchronous.** Success does not mean the terminal
  state has been reached. The Worker issues the call, then performs **one** immediate
  follow-up describe; observing `Starting`/`Stopping` is a valid, expected result and
  MUST NOT be long-polled. The Worker stays short-lived.
- **`StoppedMode` fails silently.** If the instance does not support economical mode
  (local disks, subscription instances), no error is returned and the instance stops
  under the priority mode instead. Leaving `StoppedMode` unset therefore makes billing
  behaviour depend on unreported account state. This PLAN pins it explicitly rather
  than inheriting drift.

**Endpoint**: `ecs.<REGION_ID>.aliyuncs.com`, documented and confirmed.

### 6.3 Request signing

The correct method is **V3 (`ACS3-HMAC-SHA256`)**, not V2. Evidence:

- The V2 page opens: *"The request syntax and signature method V2 are discontinued.
  Use the request syntax and signature method V3."*
- The V3 page states migration from V2 is a direct switch, and that for RPC-style
  APIs `CanonicalURI` remains `/`, that `"in": "formData"` parameters are still
  concatenated as `key1=value1&key2=value2` in the body with
  `content-type: application/x-www-form-urlencoded`, and that complex values still
  flatten to indexed pairs (`{"key":["v1","v2"]}` → `key.1=v1&key.2=v2`).

So the request *shape* is unchanged; only the authentication differs. V3 mechanics:

| Aspect | V3 |
| --- | --- |
| Header | `Authorization: ACS3-HMAC-SHA256 Credential=<AK>,SignedHeaders=<...>,Signature=<...>` |
| Signed headers | `host`, `x-acs-action`, `x-acs-content-sha256`, `x-acs-date`, `x-acs-signature-nonce`, `x-acs-version` (sorted, lowercase, `;`-joined), plus `content-type` when present |
| Clock skew | `x-acs-date` must be within **15 minutes** |
| Digest | SHA-256; hex, lowercase |
| Signing key | **Raw** AccessKey secret (no `&` suffix — this differs from V2) |
| Signature | `HexEncode(HMAC-SHA256(secret, "ACS3-HMAC-SHA256\n" + HexEncode(SHA256(CanonicalRequest))))`, lowercase hex |
| Encoding | RFC 3986; space → `%20`, `*` → `%2A`, `%7E` → `~` |

**Both official test vectors reproduce byte-exactly**, and this is now
implementation-backed rather than research-only. P1 pins them as mandatory tests:

| Fixture | Result |
| --- | --- |
| V3 — `RunInstances` on `ecs.cn-shanghai.aliyuncs.com`, nonce `3156853299f313e23d1673dc12e1703d`, date `2023-10-26T10:22:32Z` | `HashedCanonicalRequest = 7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259` ✓<br>`Signature = 06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0` ✓ |
| V2 — `DescribeDedicatedHosts`, `testid`/`testsecret`, nonce `edb2b34af0af9a6d14deaf7c1a5315eb`, ts `2023-03-13T08:34:30Z` | `Signature = 9NaGiOspFP5UPcwX8Iwt2YJXXuk=` ✓ |

These are deterministic, offline, network-free fixtures and are already implemented.

**`x-acs-content-sha256` is signed for RPC-style requests.** An earlier research probe
against `@alicloud/openapi-core` appeared to show this header excluded from
`SignedHeaders`. That probe was **malformed** — it encoded the operation's form
parameters into the request body path instead of the query string, producing a
different canonical request. The published example and P1's implementation agree:
the header **is** included, sorted with the others. This conclusion is superseded and
MUST NOT be reverted to the earlier one.

**`content-type` is signed only when present.** It is not a fixed default. Adding it
unconditionally changes `SignedHeaders` and therefore the signature. The published
example carries no `content-type`.

**`Action` and `Version` are form parameters as well as signed headers.** The server
resolves the operation from the payload. A headers-only implementation is incorrect.

**Residual risk.** No signature method can be confirmed *for this operation*, because
the operation is undocumented (§6.1). Two independent reference implementations use
V2 HMAC-SHA1 successfully against `cdt.aliyuncs.com`, which means either V2 remains
accepted for RPC+AK despite the deprecation notice, or those implementations predate
enforcement. Mitigation: all signing goes through a single `callRpc()` boundary, and
the method is selected by configuration (`SIGNATURE_VERSION`, default `v3`). Switching
is a configuration change, not a refactor.

## 7. Architecture direction

One Worker, one entrypoint, several handlers with a hard separation between *deciding*
and *acting*. The revision adds read surfaces and a history store; it does not add a
second control authority.

### 7.1 Scheduled control path (authoritative)

```
scheduled(controller, env, ctx)
        │
        ▼
  loadConfig(env) ──── invalid ──▶ error webhook (stage: config) ──▶ exit, no mutation
        │
        ▼
  getTraffic()  ─── CDT failure / missing / invalid ──▶ error webhook ──▶ exit, NO mutation
        │  trafficBytes: valid, non-negative, finite
        ▼
  getInstanceStatus() ─── ECS failure ──▶ error webhook ──▶ exit, no mutation
        │
        ▼
  decide(traffic, threshold, status) ──▶ { desired, action, reason }
        │
        ▼
  apply(desired, status) ─── at most ONE mutation, idempotent ──▶ observe-after
        │
        ▼
  build execution report
        ├──▶ notify(success payload)      ← failure isolated, logged only
        └──▶ recordHistory(report)        ← failure isolated, logged only
```

Alibaba state is authoritative. D1 is an observational record. The webhook is a
notification. **Neither D1 nor the webhook is a prerequisite for ECS control** — both
are consequences of a completed run, never inputs to it.

### 7.2 Manual read path (strictly read-only)

```
GET  /            ──▶ auth ──▶ dashboard (renders from D1 history + last run)
GET  /api/history ──▶ auth ──▶ bounded D1 read, newest first
POST /api/query   ──▶ auth ──▶ CDT query + ECS describe + decide()
                               ▲ STOP. No mutation. StartInstance/StopInstance
                                 MUST NOT be reachable from this path.
```

`POST /api/query` exists so an operator can answer "what does the system see right
now?" without waiting up to ten minutes for the next Cron tick. It deliberately stops
one step before acting. There is no route that performs a mutation.

### 7.3 Module boundaries

A single Worker deployment, with concerns separated by file. The P1 layout shown below
is **already implemented and authoritative** — it MUST NOT be renamed or moved to match
an illustrative tree.

```
src/index.ts                 Env, health, default ExportedHandler (fetch + scheduled)
src/config.ts                env parsing, validation, redaction helpers
src/types.ts                 shared types

src/aliyun/encoding.ts       percentEncode(), canonicalQueryString()      [P1, done]
src/aliyun/signing.ts        signV3(), signV2(), signRequest()            [P1, done]
src/aliyun/rpc.ts            callRpc(), RpcError, classification          [P1, done]
src/aliyun/api.ts            listCdtInternetTraffic(), describeInstance(),
                             startInstance(), stopInstance()              [P1, done]

src/monitor/decision.ts      decide() — pure, no I/O
src/monitor/execute.ts       run pipeline, fail-safe gates, report assembly

src/notify/webhook.ts        generic webhook dispatch, failure isolation

src/storage/history.ts       D1 read/write for monitoring history

src/web/router.ts            path/method dispatch, 404/405
src/web/auth.ts              Basic + Bearer verification, timing-safe compare
src/web/dashboard.ts         server-rendered HTML

migrations/                  D1 schema, versioned

test/                        unit + render-contract tests
```

**The monolithic entrypoint is explicitly rejected.** The reference implementation
(§8) concentrates routing, authentication, orchestration, HTTP clients, and a large
inline HTML/CSS/JS document in a single 630-line `src/index.ts`. That is the single
largest piece of technical debt in the donor, and it is the one pattern this project
MUST NOT reproduce. A reviewer should be able to read `decision.ts` without scrolling
past routing code.

`decide()` is a pure function with no I/O. That is deliberate: it is the component
whose failure is most expensive, and purity makes every boundary case trivially
testable without mocks. It takes **no** database handle, **no** fetch, and **no**
webhook client, and returns a plain value.

## 8. Reference implementation analysis

[`Skyline-Gazer/GLaDos_Workers_CheckIN`](https://github.com/Skyline-Gazer/GLaDos_Workers_CheckIN)
is a first-party Cloudflare Worker with an authenticated dashboard and D1 history.
It was inspected on `main` to extract proven patterns. It is a **different product**
(a multi-account game check-in bot) and is not a template.

Measured shape of the donor: `src/index.ts` 630 lines, `src/glados.ts` 461,
`src/storage.ts` 195, `src/schedule.ts` 173, `src/notify/index.ts` 141,
`src/config.ts` 96, `src/types.ts` 131; 7 test files, 1,022 lines of tests;
2 migrations.

### 8.1 REUSE / ADAPT

Concepts to adapt, not files to copy.

| Donor pattern | Adaptation for this project |
| --- | --- |
| `fetch()` + `scheduled()` coexistence in one `ExportedHandler` | Directly applicable. The Worker already has `scheduled`; `fetch` gains real routes. Note our types differ: `scheduled` takes `ScheduledController` and `fetch` takes only `Request`. |
| `ADMIN_USER` (default `admin`) + `ADMIN_TOKEN` secret | Adopt as-is. Same names, same semantics, same default. |
| Basic Auth for browsers + `Bearer <ADMIN_TOKEN>` for API clients | Adopt as-is. |
| **Timing-safe credential comparison via SHA-256 digests** | Adopt, with one correction — see D5 in §8.3. |
| `WWW-Authenticate: Basic` challenge on 401 | Adopt. |
| `requireAdmin()` returning `Response \| undefined` | Adopt the shape: an early-return guard at the top of each protected route. |
| Server-rendered HTML, no framework | Adopt. Inline `<style>` and a small `<script>` block; no build step, no bundler, no React. |
| Structured JSON logs with an `event` field | Adopt; extend with the existing redaction discipline. |
| D1 access via `db.prepare(sql).bind(...).run()/all()` | Adopt. Our database interface is typed against the real `D1Database` rather than a hand-rolled structural type (see D4). |
| Versioned SQL migration files applied before deploy | Adopt. `wrangler d1 migrations apply`. |
| Read query shape: explicit column list, `ORDER BY <time> DESC, id DESC LIMIT <bound>` | Adopt wholesale. The `id DESC` tiebreaker is what makes ordering deterministic for same-second rows — an easy detail to omit and a hard bug to find later. |
| Workflow running `npm ci` + lint + test + typecheck on PR, deploy only on `push` to `main` | Adopt the gate structure. Our P0 CI already satisfies the PR half; the deploy job is a separate, gated addition (§8.4). |
| Injected `fetcher` parameter defaulting to global `fetch` | Adopt for the webhook and every new network call, so tests need no network-mocking framework. |
| Per-result error isolation (`try`/`catch` per notification channel) | Adopt the principle: one failing side channel must not abort the run. This is invariant I8/I9. |

### 8.2 DO NOT COPY

Business features that belong to the donor's product, not this one:

`GLADOS_ACCOUNTS`, cookies, the GLaDOS API client, multi-account check-in,
random daily scheduling, `scheduled_checkins`, points, remaining days, exchange
plans, cookie-expiry logic, check-in retry semantics, the GLaDOS log schema, and the
GLaDOS notification message formats.

Also not copied: the three notification platform adapters (DingTalk, Telegram, Feishu)
with their per-platform signing schemes. This project keeps the **single generic
webhook** already specified in SPEC §7. Platform adapters are a plausible later
addition, not a v1 one.

### 8.3 TECHNICAL DEBT TO AVOID

Observed in the donor. Each is called out with the corrective decision.

| # | Debt | Why it matters | Decision here |
| --- | --- | --- | --- |
| D1 | **630-line monolithic `src/index.ts`** holding routing, auth, orchestration, HTML, CSS, and client JS. | Routing changes and decision changes share a file; the HTML is unreviewable as code and untestable except by string-matching. | Separate modules (§7.3). Dashboard rendering in `web/dashboard.ts`. |
| D2 | **Large HTML templates embedded in `.ts` string literals.** The donor's dashboard test asserts on literal CSS fragments (`"max-width:1760px"`, `"grid-template-columns:minmax(240px,320px) minmax(0,1fr)"`, `"min-height:520px"`). | These tests break on any restyle while catching no real bug. They pin the *diff*, not the *contract*. | Tests assert **semantic contract**: required fields present, HTML-escaped output, no secret echoed. No assertions on CSS values or layout. |
| D3 | **Destructive manual control endpoints.** The donor exposes `POST /run`, `/checkin`, `/test` performing real mutations. | This is precisely the anti-requirement in §3. | No manual mutation route. `POST /api/query` is read-only by construction (tests assert `StartInstance`/`StopInstance` were never invoked). |
| D4 | **Hand-rolled structural database type** (`CheckinLogDatabase` with optional `run?`/`all?`) instead of `D1Database`. | Optional methods force `?.()` at every call site, and the type cannot catch a wrong `.bind()` arity. | Type against the real binding interface. |
| D5 | **`timingSafeEqual` mixes a hash comparison with an out-of-accumulator length check.** The digest comparison itself is constant-time, but the function's result is also influenced by a plain `left.length === right.length` term outside the accumulator. | A subtle construction to reason about; easy to "simplify" wrongly during maintenance. | Keep constant-time digest comparison, and make the length sensitivity explicit and tested rather than incidental. |
| D6 | **`ORDER BY checked_at DESC` without a deterministic tiebreaker**, and no idempotency guard on the scheduled row. | Same-instant rows order nondeterministically; a retried Cron tick can duplicate rows. | Always order by `(checked_at DESC, id DESC)`. Row identity for the scheduled run is explicit in the SPEC. |
| D7 | **Deploy job runs on every `push` to `main` with no environment gate.** | Any merge to `main` deploys to production. For a Worker holding Alibaba credentials that can stop an instance, that is too much power for a merge. | Deploy is a separate workflow with an explicit dispatch/environment gate and its own concurrency group. Never part of ordinary PR CI. |
| D8 | **`database_id` placeholder rewritten in-tree at deploy time** (`scripts/prepare-d1.mjs` mutates config before deploy). | Config is generated as a side effect of deployment; local config drifts from deployed config. | Use Wrangler's native D1 binding config and `wrangler d1 migrations apply`; inject the id from a repository variable rather than rewriting files in CI. |
| D9 | **No CI check that the dashboard renders without leaking secrets.** | Redaction is asserted for the webhook but not for HTML or the history API. | Explicit redaction tests over the rendered dashboard and the history endpoint. |
| D10 | **`console.log` of whole report objects** (`JSON.stringify({ event, report })`). | Convenient, but couples retained log output to the report's full shape — a future field addition silently widens what is persisted. | Log an explicit allow-listed projection of the report. |

### 8.4 GitHub Actions: adopt the shape, change two things

The donor's workflow is a reasonable shape — PR validation and deployment in one file,
deployment gated by `if: github.event_name == 'push'`. Two changes for this project:

1. **Split deploy from validation.** Ordinary PR CI MUST remain credential-free and
   MUST NOT be able to deploy. The existing P0 workflow already satisfies this and is
   retained unchanged.
2. **Gate deployment on an environment.** A `production` GitHub Environment with
   required reviewers means a merge cannot silently stop an instance. The donor has no
   such gate.

The donor's `concurrency` group with `cancel-in-progress: true` is adopted for
validation; deployment uses a **non-cancelling** group so two deploys cannot interleave.

## 9. Fail-safe model

The central invariant:

> **Inability to establish the traffic value is never evidence that the traffic value
> is zero.**

The decision engine only accepts a traffic value that is present, numeric, finite, and
non-negative. Everything else — absent field, `null`, `""`, `"abc"`, `NaN`, `-1`,
missing `TrafficDetails`, non-array `TrafficDetails`, an empty array, a non-2xx
response, a transport error, an API error code, or an unparseable body — aborts the run
**before any ECS call is made**. The instance is left exactly as found.

This is intentionally asymmetric. A false abort costs one monitoring interval. A false
"under threshold" costs money and cannot be undone retroactively.

### 9.1 Fail-closed invariants (normative)

| # | Invariant |
| --- | --- |
| I1 | CDT query failure ⇒ **no** ECS mutation. |
| I2 | Invalid or missing traffic ⇒ **never** treated as zero ⇒ **no** ECS mutation. |
| I3 | Empty or invalid `TrafficDetails` when authoritative traffic cannot be established ⇒ **no** ECS mutation. |
| I4 | ECS describe failure ⇒ **no** mutation. |
| I5 | Unknown ECS state ⇒ **no** contradictory mutation. |
| I6 | Transitional state with no explicitly safe action ⇒ **no** contradictory mutation. |
| I7 | **At most one** ECS mutation per scheduled execution. |
| I8 | D1 write failure ⇒ does **not** reverse, alter, or block the ECS control result. |
| I9 | Webhook failure ⇒ does **not** reverse, alter, or block the ECS control result. |
| I10 | No HTTP route can cause an ECS mutation. |

I8 and I9 are new in Revision 2 and are the direct consequence of adding a second
side channel. They are why the report is built **before** either side channel runs: the
control outcome is finalized in memory first, then persisted and notified.

## 10. Security model

- **Least privilege.** The RAM policy grants exactly four actions:
  `cdt:ListCdtInternetTraffic`, `ecs:DescribeInstances`, `ecs:StartInstance`,
  `ecs:StopInstance`. All four names were verified against current documentation.
  No wildcard resources beyond the single instance and the CDT product.
- **Secrets.** `ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, `WEBHOOK_URL`,
  optional `WEBHOOK_TOKEN`, and `ADMIN_TOKEN` are Workers Secrets. Non-secret
  configuration (`REGION_ID`, `ECS_INSTANCE_ID`, `TRAFFIC_THRESHOLD_GB`, `ADMIN_USER`,
  `STOPPED_MODE`) lives in `vars`. `secrets.required` is declared in the Wrangler
  config so a misconfigured deploy **fails loudly** instead of deploying a Worker that
  cannot authenticate.
- **Secret hygiene.** No credential, token, or secret-bearing URL is ever logged,
  returned over HTTP, rendered into HTML, written to D1, written to a test fixture, or
  committed. Error text is sanitised before leaving the Worker. Workers Logs persist by
  default, so redaction is a correctness requirement, not a nicety.
- **Attack surface.** The HTTP surface is four routes (§11). Exactly one is public and
  it performs no privileged work. The other three require authentication. **No HTTP
  route performs an ECS mutation**, and no route discloses a secret or a raw
  credential-bearing Alibaba request.
- **Authentication.** `GET /` and `/api/*` require `ADMIN_TOKEN`. Browsers use Basic
  Auth; API clients may use `Bearer <ADMIN_TOKEN>`. Credential comparison is
  timing-safe. A missing `ADMIN_TOKEN` fails **closed** rather than serving the
  dashboard unauthenticated.
- **Stored data.** D1 holds traffic readings, states, actions, and sanitised error
  text. It never holds an AccessKey, a token, a secret-bearing URL, or a raw
  credential-bearing request.
- **No live mutation from CI.** Unit and render tests mock all network I/O. CI contains
  no Alibaba or Cloudflare credentials and performs no deployment.

## 11. HTTP surface

| Method | Path | Auth | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/health` | **Public** | Liveness only. No privileged work, no Alibaba call, no configuration disclosure. |
| `GET` | `/` | Required | Server-rendered operational dashboard. |
| `GET` | `/api/history` | Required | Bounded monitoring history from D1, newest first. Read-only. |
| `POST` | `/api/query` | Required | Live CDT query + ECS describe + `decide()`. **Strictly read-only.** |

Every other path is `404`. Every other method on a known path is `405`.

**There is no `POST /start`, `/stop`, `/run-control`, or `/execute-control`, and none
may be added in v1.** The Cron Trigger is the only mutation authority. `POST /api/query`
MUST NOT reach `StartInstance` or `StopInstance`; a test asserts neither was invoked.

### 11.1 Dashboard content (v1)

| Field | Source |
| --- | --- |
| Current CDT traffic (GB) | Live query or most recent history row |
| Configured threshold (GB) | Config |
| Usage percentage | Derived |
| Remaining traffic before threshold | Derived |
| Current ECS state | Live query or most recent history row |
| Desired ECS state | `decide()` |
| Last decision reason | `decide()` / history |
| Last action | History |
| ECS before / after | History |
| Last scheduled execution time | History |
| Execution success / failure | History |
| Webhook attempt result | History |
| History persistence result | In-memory report field (§19 of the SPEC) |
| Execution duration | History |

The dashboard is a **view**. It performs no privileged operation on render and never
echoes a secret.

## 12. D1 monitoring history

D1 is **observational**. Alibaba remains the authority for ECS state; D1 records what
was observed and what was decided. No decision may read from D1.

- Binding: **`TRAFFIC_DB`**. Table: **`traffic_checks`** (SPEC §9 defines the columns).
- Writes happen only on the scheduled path, after the control outcome is fixed.
- A write failure is recorded in memory and logged. It MUST NOT alter, reverse, or
  block the control result (invariant I8).
- Reads are bounded, newest first, with a deterministic tiebreaker.
- The row MUST NOT claim its own `INSERT` succeeded before the `INSERT` occurs.
  Persistence success is therefore represented in the **in-memory execution report**,
  not as a column written by the insert that would have to describe itself.

## 13. Test strategy

Test-driven, offline, deterministic. No test performs a live Alibaba Cloud mutation and
no test requires network access. **The existing 144 P1 tests are retained unmodified**
and their coverage MUST NOT be reduced.

| Area | Required coverage |
| --- | --- |
| RPC signing | Both official vectors byte-exact; RFC 3986 encoding of space/`*`/`~`/`!`/`'`/`(`/`)`; sort order excluding `Signature`; canonical header ordering |
| RPC transport | 2xx success; API-level error code; HTTP ≥500; HTTP 429; transport throw; retry then success; retry exhaustion; no retry on 4xx validation errors |
| CDT | Multi-entry summation; single entry; `TrafficDetails` absent; empty array; non-array; `Traffic` null/undefined/`""`/non-numeric/negative; API error; malformed JSON |
| ECS | All five states; both transitions; transitional states; unknown state; API error; describe failure; start failure; stop failure |
| Decision | `threshold − ε` ⇒ running; exactly `threshold` ⇒ stopped; `threshold + ε` ⇒ stopped; idempotency across the full state matrix; every `fail-safe` row |
| Webhook | Success payload shape; error payload shape per stage; bearer auth present/absent; non-2xx; throw; failure does not affect the ECS outcome |
| Config | Missing required var; malformed number; non-positive threshold |
| HTTP | `GET /health` succeeds and is inert; protected routes refuse unauthenticated requests |
| **Auth** (new) | Valid Basic; invalid Basic; malformed Basic; missing `ADMIN_TOKEN`; Bearer path if retained |
| **Web router** (new) | `/health` public; `/` protected; `/api/history` protected; `/api/query` protected; unknown route ⇒ 404; wrong method ⇒ 405 |
| **Manual query** (new) | CDT queried; ECS described; decision returned; **`StartInstance` never called**; **`StopInstance` never called** |
| **D1** (new) | Successful insert; bounded history; newest-first ordering; sanitised errors; storage failure does not alter the control decision |
| **Dashboard** (new) | Render-contract: required fields present; HTML-escaped output; no secret echoed |

Dashboard tests are **semantic/render-contract tests**. Pixel snapshots and CSS-literal
assertions are prohibited (debt D2). No unit or CI test may make a live ECS mutation.

## 14. Deployment model

- Cloudflare Worker, deployed with Wrangler, `wrangler.jsonc` as the source of truth
  and never mutated by a deployment.
- Cron Trigger `*/10 * * * *` (every 10 minutes), UTC, 5-field syntax.
- **The first deployment is two owner actions**, because Cron is the only mutation
  authority and the one assumption that can fail unsafely (the traffic unit) is only
  checkable against live data:
  - **PRE-FLIGHT** performs the first `wrangler deploy` with `triggers.crons = []`,
    `workers_dev: false`, no route, and `preview_urls: true`. That exposes a Version
    URL for read-only live verification and no stable endpoint. Cloudflare documents
    that an empty `crons` array *removes* Cron Triggers whereas an omitted field
    leaves existing ones in place, so the field is written explicitly.
  - **RELEASE** is a separate, explicitly authorized dispatch that restores Cron and
    applies the owner's HTTP exposure choice. It is never triggered by PRE-FLIGHT.
  - This replaces the earlier flow of `wrangler versions upload` → verify →
    `versions deploy`, which cannot work for the first Worker upload: Cloudflare
    documents that `wrangler versions upload` fails the first time a new Worker is
    uploaded. It becomes useful only *after* a Worker exists; no update workflow that
    uses it is implemented yet.
- **HTTP exposure is an explicit owner choice**, not an inferred one:
  `HTTP_EXPOSURE_MODE` is `workers_dev` or `custom_domain`, with no default, and the
  resolver fails closed when it is absent, unrecognised, or `custom_domain` without a
  well-formed `WORKER_CUSTOM_DOMAIN`. These are deployment-only values, not Worker
  runtime variables, and are deliberately not added to the SPEC's seven.
- Secrets set via `wrangler secret put`; never via `vars`, never via a committed file.
- D1 database created via Wrangler; `database_id` supplied from a repository
  variable/secret, never committed, never rewritten into config by a CI script (D8).
  The generated configs are written to the repository root, because Wrangler treats
  the config's directory as the project root.
- Migrations applied with `wrangler d1 migrations apply` as a distinct, visible step
  before deploy — never implicitly, in both stages.
- Local development uses `.dev.vars` (gitignored) with obvious fake values.
- Deployment is manual and gated on owner confirmation of: Worker config, RAM policy,
  region, instance ID, threshold, cron expression, presence of all secrets, D1 binding,
  the HTTP exposure decision, and the webhook target. Credential values are never printed.
- CI validates by installing, formatting, linting, type-checking, and running tests. CI
  performs **no** deployment and makes **no** live API call.

### 14.1 Branch protection

**Resolved by owner decision (2026-09-22).** The repository is **public**, so the
platform limitation recorded in Revision 1 no longer applies. The earlier constraint —
a private repository under a free organization plan returning `403 Upgrade to GitHub
Pro or make this repository public` — is historical and no longer blocks the intended
`main` ruleset.

The owner has instructed that the intended ruleset (a pull request required, a passing
CI status check required, force-push and deletion restricted) be **enabled**. Issue
[#15](https://github.com/Skyline-Gazer/CFWorker4AliCDT/issues/15) is unblocked and
tracks the change.

The workflow is therefore both convention-enforced and, once the ruleset is applied,
**technically enforced**:

```
Issue → branch → TDD → PR → CI → review → merge
```

Direct push to `main` is prohibited, and is now rejected by the repository ruleset
rather than by convention alone.

## 15. Delivery phases

Each phase is tracked as GitHub Issues linked to a parent Epic, grouped under the
GitHub Project. Status transitions: `Backlog → Ready → In Progress → Review → Done`. An
item moves to `Done` only after its acceptance criteria pass and its pull request is
merged — never merely because code was written.

### 15.1 Revised phase model

| Phase | Scope | State |
| --- | --- | --- |
| **P0** Repository & tooling | Package manager, TypeScript config, Wrangler config, formatter, linter, test runner, CI workflow, branch protection. | **Complete** (PR #34, open) |
| **P1** Alibaba RPC layer | V3 + V2 signing (both fixtures green), RPC transport, retry policy, error classification, request encoding, typed CDT/ECS operations. | **Complete** (PR #35, open) |
| **P2** CDT monitoring | `ListCdtInternetTraffic` client wiring, response validation, summation, traffic-unit conversion. | Not started |
| **P3** ECS control | `DescribeInstances`, `StartInstance`, `StopInstance`, state normalisation, idempotency. | Not started |
| **P4** Decision & orchestration | Pure `decision()`, run pipeline, abort paths, error stages, config parsing. | Not started |
| **P5** Webhook | Generic success/error payloads, optional bearer auth, failure isolation. | Not started |
| **P6** D1 history | Binding, migration, `src/storage/history.ts`, bounded reads, sanitised writes, failure isolation. | Not started |
| **P7** Authenticated Web/API | Router, auth, dashboard, `/api/history`, read-only `/api/query`. | Not started |
| **P8** Cloudflare integration, security, docs, release | `scheduled` wiring, Cron, deployment workflow with environment gate, RAM policy, operations and security docs, release checklist. | Not started |

### 15.2 Old → revised phase mapping

Existing Issue numbers are **stable and MUST NOT be renumbered** for cosmetic alignment.
The Revision 1 phase labels map onto the revised model as follows:

| Revision 1 phase | Revised phase | Notes |
| --- | --- | --- |
| P0 Repository & tooling | **P0** | Unchanged scope. |
| P1 Alibaba RPC | **P1** | Unchanged scope. |
| P2 CDT monitoring | **P2** | Unchanged scope. |
| P3 ECS control | **P3** | Unchanged scope. |
| P4 Orchestration & fail-safe | **P4** | Unchanged scope; absorbs config parsing from old P6. |
| P5 Webhook | **P5** | Unchanged scope. |
| P6 Cloudflare runtime | **Split: P8** | The `scheduled`/Cron/health wiring moves to the final integration phase. |
| P7 Security, docs & release | **P8** | Merged with the runtime integration into one release phase. |
| — | **P6 D1 history** | **New.** |
| — | **P7 Web/API** | **New.** |

### 15.3 Existing Epic mapping under the revised model

The eight existing Epics remain in place. Where a revised phase is new, it receives a
new Epic **after owner approval** (§17) — it does not displace an existing one.

| Issue | Title | Revised phase |
| --- | --- | --- |
| #2 | P0 — Repository & Tooling | P0 |
| #3 | P1 — Alibaba RPC Layer | P1 |
| #4 | P2 — CDT Traffic Monitoring & Reduction | P2 |
| #5 | P3 — ECS Instance Control | P3 |
| #6 | P4 — Decision Engine & Run Orchestration | P4 |
| #7 | P5 — Run Reporting Webhook | P5 |
| #8 | P6 — Cloudflare Worker Runtime | **Spans P7/P8** — its `scheduled`/health/Cron children land in P8; re-scope after approval, do not renumber. |
| #9 | P7 — Security, Documentation & Release Readiness | **P8** |

Implementation order is strictly sequential. Within a phase, TDD: write the failing
test, implement, make it pass, refactor.

## 16. Risks

| ID | Risk | Impact | Mitigation |
| --- | --- | --- | --- |
| R1 | `ListCdtInternetTraffic` is undocumented; its contract could differ from the SDK-derived shape. | Traffic misread; wrong decision. | Treat every field as optional and validated. Tolerate missing/reordered fields. Never default to zero. Surface a distinct error stage on shape mismatch. |
| R2 | CDT endpoint is unconfirmed (`cdt.aliyuncs.com` is a hypothesis from SDK behaviour and independent implementations; `endpoints.json` is absent and no authoritative source exists). | Total monitoring failure. | Make the endpoint configuration, not a constant. Verify empirically at first deployment; fail closed and report if the endpoint does not resolve. |
| R3 | Signature method for this operation cannot be confirmed against documentation. | Total API failure. | Single `callRpc()` boundary; method selected by config; both official fixtures pinned; V2 retained as a documented fallback path. |
| R4 | The `Traffic` unit is an assumption (bytes). | Threshold trips at the wrong traffic level. | Document as an assumption. Isolate conversion in one named function. Verify against the Alibaba console at first deployment before enforcing. |
| R5 | Decimal GB (`1000^3`) is a deliberate break from the prior script and both reference implementations (`1024^3`). 180 GB decimal = 167.6 GiB, so enforcement trips **earlier** for the same byte count. | Behavioural surprise for anyone migrating. | Owner-selected. Documented explicitly as a divergence in the SPEC and README; never silently inherited. |
| R6 | Asynchronous ECS operations mean the observed state after a call is transitional, not terminal. | A naive implementation would poll, exceed runtime limits, or report a false final state. | One immediate follow-up describe only. `Starting`/`Stopping` are reported as valid observed states. No long-polling. |
| R7 | `StoppedMode` is silently ignored for unsupported instances. | Billing behaves differently than configured, with no error. | Pin `StoppedMode` explicitly and document the silent-ignore behaviour; never rely on account defaults. |
| R8 | Cron CPU limit is 10 ms on the free plan. | Runs are terminated mid-flight. | Measure actual CPU. D1 writes add work to the scheduled path; if the free plan is insufficient, the paid plan is a documented prerequisite rather than a silent assumption. |
| R9 | Workers Logs persist by default. | Secret leakage into retained logs. | Centralised redaction; secrets never interpolated into log or error strings; tested. |
| R10 | CI or a test could accidentally perform a live mutation. | Unintended instance stop/start. | All network mocked; no credentials in CI; deployment is manual, environment-gated, and separate from PR CI. |
| **R11** | **Branch protection** — previously unenforceable (private repo, free org plan, GitHub returned 403). | A direct push to `main` would bypass CI and review. | **Resolved (2026-09-22):** the repository is now public, so the intended ruleset can be applied. Owner instructed it be enabled; tracked by Issue #15. |
| **R12** | **D1 availability/limits** — writes on every scheduled run add a failure mode and consume D1 quota. | A D1 outage could be mistaken for a control failure; quota exhaustion could silently degrade history. | D1 is never a control input (invariant I8). Write failures are isolated and logged. Retention/pruning is an explicit operations task. |

## 17. Issue reconciliation (planned, not yet executed)

Existing Issue numbers are **stable**. Nothing is closed, recreated, or renumbered as
part of this revision. The following delta is **recorded here and MUST NOT be created
until the owner approves this architecture.**

| Action | Item | Parent | Gate |
| --- | --- | --- | --- |
| Re-scope | #8 P6 — Cloudflare Worker Runtime | — | Split its children between P7/P8 equivalents after approval. |
| New Epic | D1 monitoring history (P6) | — | After approval |
| New Issue | `traffic_checks` migration and binding | New D1 Epic | After approval |
| New Issue | `src/storage/history.ts` write path with failure isolation | New D1 Epic | After approval |
| New Issue | Bounded history read + `/api/history` | New D1 Epic | After approval |
| New Epic | Authenticated Web/API (P7) | — | After approval |
| New Issue | `src/web/auth.ts` Basic + Bearer, timing-safe | New Web Epic | After approval |
| New Issue | `src/web/router.ts` dispatch, 404/405 | New Web Epic | After approval |
| New Issue | `src/web/dashboard.ts` render contract | New Web Epic | After approval |
| New Issue | Read-only `POST /api/query` with no-mutation test | New Web Epic | After approval |
| New Issue | Deployment workflow with environment gate + migration step | #9 / P8 | After approval |
| Update | #15 branch protection | #2 | Stays **Blocked**; record the convention-enforced fallback. |

During this revision **no** Issue is created, closed, or edited.

## 18. Open decisions and blocking questions

**Resolved by the owner (recorded, not re-opened):**

1. Units — decimal `1000^3`, labelled `GB`; the name `TRAFFIC_THRESHOLD_GB` is kept.
2. Notification cadence — a webhook is attempted on **every** scheduled execution,
   including no-op and error runs. No `NOTIFY_ON_NOOP` in v1.
3. `STOPPED_MODE` — default `KeepCharging`, `ForceStop=false`.
4. Generic webhook only; no platform adapters in v1.
5. **Cron remains the only ECS mutation authority in v1.**
6. Web dashboard and D1 history are **v1 requirements**, not non-goals.

**Resolved by the owner (2026-09-22):**

7. **Q4 — Cloudflare plan.** Remain on the **Free** plan initially and implement within
   the 10 ms Cron CPU budget; benchmark actual HTTP and Cron CPU usage and upgrade to
   Paid only if the measured usage or risk requires it. The required plan is still to be
   stated in the deployment documentation once measured (§14).
8. **Q5 — History retention.** Retain `traffic_checks` rows **indefinitely in v1**; no
   automatic deletion. Pruning remains an explicit operations task if it is later needed.
9. **Q6 — Repository visibility / plan.** The repository is **public**; branch protection
   is therefore available and the owner has instructed it be enabled (R11 resolved, #15
   unblocked).

**Resolved during planning (no owner input required):**

10. CDT API version is `2021-08-13`, correcting the brief's `2021-08-31`.
11. There is no pagination for `ListCdtInternetTraffic`; the brief's pagination test is
    replaced by multi-entry summation.
12. Signing method is V3, with a configuration switch and both fixtures pinned.
13. `cdt.aliyuncs.com` becomes configuration with that default, flagged for empirical
    confirmation.

**Open, requiring owner confirmation before or at deployment:**

| # | Question | Why it matters | Proposed default |
| --- | --- | --- | --- |
| Q1 | **Summation scope.** Sum all `TrafficDetails` entries, or only those whose `BusinessRegionId` equals the configured region? The two reference implementations disagree and no official source defines the semantics. | Changes the effective threshold. | Sum **all** entries, expose the per-region breakdown in the webhook payload and dashboard so the choice is auditable. |
| Q3 | **ECS `RegionId` vs CDT `BusinessRegionId`.** Same identifier namespace? | Determines whether one variable serves both. | Assume **independent** variables, defaulting `BUSINESS_REGION_ID` to unset. |

**Q2 (`StoppedMode`) is resolved** by owner decision: default `KeepCharging`,
configurable, with `StopCharging` implications documented in SPEC §6.4.

## 19. Acceptance of this PLAN

**Approved by the owner on 2026-09-20**, revised by owner instruction on 2026-09-20 to
include the authenticated dashboard, D1 monitoring history, and read-only manual query.
Implementation proceeds under TDD in phases P0–P8, one pull request per phase, with the
GitHub Project as the canonical tracker. Normal PR/review gates apply: no deployment and
no live ECS mutation without explicit owner approval.
