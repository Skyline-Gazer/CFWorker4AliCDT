# CFWorker4AliCDT — Project Plan

> Status: **APPROVED by owner (2026-09-20).** This document is the approved planning
> baseline. Implementation proceeds under TDD in phases P0–P7, with the GitHub Project
> as the canonical execution tracker. No local TODO/tracker Markdown files.
>
> Amendment: PLAN Q2 (`StoppedMode`) resolved by owner — default `KeepCharging`.

## 1. Document control

| Field | Value |
| --- | --- |
| Repository | `Skyline-Gazer/CFWorker4AliCDT` (private) |
| Planning baseline SHA | `72e63ee2910fcb5f6998827e3e356fd369912143` |
| Baseline commit | `72e63ee` "Create README.md" — Mark Deng, 2026-09-20 15:20:58 +0800 |
| Baseline tree | `README.md` only (18 bytes, `# CFWorker4AliCDT`) |
| Companion spec | [`project-spec.md`](./project-spec.md) |
| Planning branch | `docs/project-plan-spec` |
| Runtime implementation | **None.** Prohibited until PLAN + SPEC approval. |

## 2. Problem statement

An Alibaba Cloud ECS instance is used to relay traffic billed under Cloudflare
Data Transfer (CDT). When monthly internet traffic reaches a configured allowance,
continued operation risks unexpected spend (or suspension). Today this is managed
manually: an operator periodically checks traffic and starts or stops the instance
by hand. Manual monitoring fails in both directions:

- **Fail-open risk** — traffic crosses the threshold while nobody is watching, and
  the instance keeps running and keeps accruing cost.
- **Error risk** — an operator misreads a dashboard, stops an instance that should
  be running, or leaves it stopped after the window has passed.

Existing community scripts solve the happy path but, on inspection, contain the
specific failure this project exists to prevent: when the traffic response is
missing or malformed they coerce the value to `0`, conclude "under threshold", and
leave the instance running. They also expose unauthenticated control endpoints and
issue unsolicited reboots. Those behaviours are treated here as **anti-requirements**
— documented so they are not reintroduced.

## 3. Objective

A single stateless Cloudflare Worker, invoked by a Cron Trigger every 10 minutes,
that:

1. Retrieves current CDT internet traffic from the Alibaba Cloud CDT API.
2. Retrieves the current state of exactly one ECS instance.
3. Applies a deterministic threshold rule to decide the *desired* instance state.
4. Performs **at most one** idempotent ECS state mutation, and only when the desired
   state differs from the observed state.
5. Reports the outcome of every run to a webhook.

### Success criteria

| # | Criterion |
| --- | --- |
| S1 | A scheduled run that cannot reliably retrieve traffic performs **zero** ECS mutations, logs, dispatches an error webhook, and exits. |
| S2 | A missing, null, non-numeric, negative, or unparseable traffic value is **never** interpreted as `0`. |
| S3 | Desired state equals observed state ⇒ no API mutation is issued. |
| S4 | Webhook delivery failure never changes, cancels, reverses, or triggers an ECS operation. |
| S5 | No credential, token, or secret-bearing value is ever logged, echoed, returned over HTTP, or committed. |
| S6 | No HTTP route other than `GET /health` performs privileged work. |
| S7 | All behaviour in this PLAN and the SPEC is covered by deterministic tests that perform no live Alibaba Cloud mutation. |

### Explicit non-goals

Out of scope for the initial release, and MUST NOT be added opportunistically:
database, Durable Objects, KV, D1, dashboard, user accounts, multi-instance
management, multi-threshold rules, a public control API, a generic provider
framework, queues, and cross-invocation state persistence. The Worker is stateless.

## 4. Repository baseline and retained assets

The repository contains one commit and one file. There is no existing
implementation to retain or migrate.

| Asset | Disposition |
| --- | --- |
| `README.md` | **Retain.** Extend into a user-facing document (purpose, setup, configuration). MUST NOT be destructively overwritten or repurposed as a tracking document. |
| Everything else | Does not exist. |

No local task-tracking markdown (`todo.md`, `tasks.md`, Kanban files) is permitted.
Task state lives in GitHub Projects; technical design lives in `docs/`.

## 5. External API dependencies

All contracts below were verified against primary sources during research. Where a
contract could not be verified, that fact is stated explicitly and treated as a risk
with a mitigation — it is never presented as confirmed.

### 5.1 CDT — `ListCdtInternetTraffic`

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
**bytes** and records that as an assumption (see SPEC §traffic units), not as
established fact. Mitigation: the unit is never implicit in code — conversion happens
in exactly one named function.

**Reduction rule.** The total is the arithmetic sum of `TrafficDetails[].Traffic`.
There is no pagination to walk. This replaces the brief's "pagination" test
requirement, and the SPEC MUST state the substitution plainly so that a reviewer does
not read it as a dropped requirement.

### 5.2 ECS — `DescribeInstances`, `StartInstance`, `StopInstance`

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

### 5.3 Request signing

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
| Signed headers | `host`, `x-acs-action`, `x-acs-content-sha256`, `x-acs-date`, `x-acs-signature-nonce`, `x-acs-version` (sorted, lowercase, `;`-joined) |
| Clock skew | `x-acs-date` must be within **15 minutes** |
| Digest | SHA-256; hex, lowercase |
| Signing key | **Raw** AccessKey secret (no `&` suffix — this differs from V2) |
| Signature | `HexEncode(HMAC-SHA256(secret, "ACS3-HMAC-SHA256\n" + HexEncode(SHA256(CanonicalRequest))))`, lowercase hex |
| Encoding | RFC 3986; space → `%20`, `*` → `%2A`, `%7E` → `~` |

**Both official test vectors were reproduced byte-exactly during research**, using only
`crypto.subtle` (the Workers-native Web Crypto surface):

| Fixture | Result |
| --- | --- |
| V3 — `RunInstances` on `ecs.cn-shanghai.aliyuncs.com`, nonce `3156853299f313e23d1673dc12e1703d`, date `2023-10-26T10:22:32Z` | `HashedCanonicalRequest = 7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259` ✓<br>`Signature = 06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0` ✓ |
| V2 — `DescribeDedicatedHosts`, `testid`/`testsecret`, nonce `edb2b34af0af9a6d14deaf7c1a5315eb`, ts `2023-03-13T08:34:30Z` | `Signature = 9NaGiOspFP5UPcwX8Iwt2YJXXuk=` ✓ |

These are deterministic, offline, network-free fixtures and become mandatory tests.

**Residual risk.** No signature method can be confirmed *for this operation*, because
the operation is undocumented (§5.1). Two independent reference implementations use
V2 HMAC-SHA1 successfully against `cdt.aliyuncs.com`, which means either V2 remains
accepted for RPC+AK despite the deprecation notice, or those implementations predate
enforcement. Mitigation: all signing goes through a single `callRpc()` boundary, and
the method is selected by configuration (`SIGNATURE_VERSION`, default `v3`). Switching
is a configuration change, not a refactor. SPEC requires the V3 fixture as the primary
test and retains the V2 fixture as a pin for the shared percent-encoding and sort
contract.

## 6. Architecture direction

One Worker, one entrypoint, thin layers with a hard separation between *deciding* and
*acting*.

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
  decide(traffic, threshold, status) ──▶ { desired: 'running' | 'stopped', action }
        │
        ▼
  apply(desired, status) ─── at most ONE mutation, idempotent ──▶ observe-after
        │
        ▼
  notify(success payload)          ← failure here is isolated and logged only
```

Proposed layout (the repository has no competing conventions; this is offered as the
initial structure and may be adapted during P0):

```
src/index.ts            scheduled + GET /health only
src/config.ts           env parsing, validation, redaction helpers
src/aliyun/rpc.ts       callRpc(): V3 signing, retry/backoff, error classification
src/aliyun/cdt.ts       listCdtInternetTraffic()
src/aliyun/ecs.ts       describeInstances(), startInstance(), stopInstance()
src/services/monitor.ts orchestration + decision engine
src/services/webhook.ts notify()
src/types/              shared types
test/                   rpc, cdt, ecs, monitor, webhook
docs/planning|architecture|operations|security/
```

`decide()` is a pure function with no I/O. That is deliberate: it is the component
whose failure is most expensive, and purity makes every boundary case trivially
testable without mocks.

## 7. Fail-safe model

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

## 8. Security model

- **Least privilege.** The RAM policy grants exactly four actions:
  `cdt:ListCdtInternetTraffic`, `ecs:DescribeInstances`, `ecs:StartInstance`,
  `ecs:StopInstance`. All four names were verified against current documentation.
  No wildcard resources beyond the single instance and the CDT product.
- **Secrets.** `ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, `WEBHOOK_URL`,
  and optional `WEBHOOK_TOKEN` are Workers Secrets. Non-secret configuration
  (`REGION_ID`, `ECS_INSTANCE_ID`, `TRAFFIC_THRESHOLD_GB`) lives in `vars`.
  `secrets.required` is declared in the Wrangler config so a misconfigured deploy
  **fails loudly** instead of deploying a Worker that cannot authenticate.
- **Secret hygiene.** No credential, token, or secret-bearing URL is ever logged,
  returned over HTTP, written to a test fixture, or committed. Error text is
  sanitised before leaving the Worker. Workers Logs persist by default, so
  redaction is a correctness requirement, not a nicety.
- **Attack surface.** The only HTTP route is `GET /health`, which performs no
  privileged operation and reveals nothing beyond liveness. Every other path is
  refused. There is no endpoint that can start, stop, or reboot anything.
- **No live mutation from CI.** Unit tests mock all network I/O. CI contains no
  Alibaba or Cloudflare credentials and performs no deployment.

## 9. Test strategy

Test-driven, offline, deterministic. No test performs a live Alibaba Cloud mutation,
and no test requires network access.

| Area | Required coverage |
| --- | --- |
| RPC signing | Both official vectors byte-exact; RFC 3986 encoding of space/`*`/`~`/`!`/`'`/`(`/`)`; sort order excluding `Signature`; canonical header ordering |
| RPC transport | 2xx success; API-level error code; HTTP ≥500; HTTP 429; transport throw; retry then success; retry exhaustion; no retry on 4xx validation errors |
| CDT | Multi-entry summation; single entry; `TrafficDetails` absent; empty array; non-array; `Traffic` null/undefined/`""`/non-numeric/negative; API error; malformed JSON |
| ECS | All five states; both transitions; transitional states; unknown state; API error; describe failure; start failure; stop failure |
| Decision | `threshold - ε` ⇒ running; exactly `threshold` ⇒ stopped; `threshold + ε` ⇒ stopped; idempotency across the full state matrix |
| Webhook | Success payload shape; error payload shape per stage; bearer auth present/absent; non-2xx; throw; failure does not affect the ECS outcome |
| Config | Missing required var; malformed number; non-positive threshold |
| HTTP | `GET /health` succeeds and is inert; every other path/method refused |

Existing tests are written only where a plausible bug would fail them. Tests that
assert implementation details — field copies, mock echoes, source text — are not
written, and any that exist are removed.

## 10. Deployment model

- Cloudflare Worker, deployed with Wrangler, `wrangler.jsonc` as the source of truth.
- Cron Trigger `*/10 * * * *` (every 10 minutes), UTC, 5-field syntax. Changing the
  cadence is a one-line config edit.
- `worker_dev` disabled for the scheduled-only surface as appropriate; if enabled,
  the handler still refuses every non-health path.
- Secrets set via `wrangler secret put`; never via `vars`, never via a committed file.
- Local development uses `.dev.vars` (gitignored) with obvious fake values.
- Deployment is manual and gated on owner confirmation of: Worker config, RAM policy,
  region, instance ID, threshold, cron expression, presence of all secrets, and the
  webhook target. Credential values are never printed.
- CI validates by installing, formatting, linting, type-checking, and running unit
  tests. CI performs **no** deployment and makes **no** live API call.
- A ruleset protecting `main` (pull request required, CI status check required) is
  added once CI exists.

## 11. Delivery phases

Each phase is tracked as GitHub Issues linked to a parent Epic, grouped under a
GitHub Project. Status transitions: `Backlog → Ready → In Progress → Review → Done`.
An item moves to `Done` only after its acceptance criteria pass and its pull request
is merged — never merely because code was written.

| Phase | Scope |
| --- | --- |
| **P0** Repository & tooling | Package manager, TypeScript config, Wrangler config, formatter, linter, test runner, CI workflow, branch protection. No Alibaba logic. |
| **P1** Alibaba RPC layer | V3 signing (both fixtures green), RPC transport, retry policy, error classification, request encoding. |
| **P2** CDT monitoring | `ListCdtInternetTraffic` client, response validation, summation, traffic-unit conversion. |
| **P3** ECS control | `DescribeInstances`, `StartInstance`, `StopInstance`, state normalisation, idempotency. |
| **P4** Orchestration & fail-safe | Decision engine, run pipeline, abort paths, error stages. |
| **P5** Webhook | Success and error payloads, optional bearer auth, failure isolation. |
| **P6** Cloudflare runtime | `scheduled` handler, Cron Trigger wiring, `GET /health`, logging and redaction. |
| **P7** Security, documentation, release | RAM least-privilege policy, deployment procedure, README, operations and security docs, release checklist. |

Implementation order is strictly P0 → P7. Within a phase, TDD: write the failing test,
implement, make it pass, refactor.

## 12. Risks

| ID | Risk | Impact | Mitigation |
| --- | --- | --- | --- |
| R1 | `ListCdtInternetTraffic` is undocumented; its contract could differ from the SDK-derived shape. | Traffic misread; wrong decision. | Treat every field as optional and validated. Tolerate missing/reordered fields. Never default to zero. Surface a distinct error stage on shape mismatch. |
| R2 | CDT endpoint is unconfirmed (`cdt.aliyuncs.com` is a hypothesis from SDK behaviour and independent implementations; `endpoints.json` is absent and no authoritative source exists). | Total monitoring failure. | Make the endpoint configuration, not a constant. Verify empirically at first deployment; fail closed and report if the endpoint does not resolve. |
| R3 | Signature method for this operation cannot be confirmed against documentation. | Total API failure. | Single `callRpc()` boundary; method selected by config; both official fixtures pinned; V2 retained as a documented fallback path. |
| R4 | The `Traffic` unit is an assumption (bytes). | Threshold trips at the wrong traffic level. | Document as an assumption. Isolate conversion in one named function. Verify against the Alibaba console at first deployment before enforcing. |
| R5 | Decimal GB (`1000^3`) is a deliberate break from the prior script and both reference implementations (`1024^3`). 180 GB decimal = 167.6 GiB, so enforcement trips **earlier** for the same byte count. | Behavioural surprise for anyone migrating. | Owner-selected. Documented explicitly as a divergence in the SPEC and README; never silently inherited. |
| R6 | Asynchronous ECS operations mean the observed state after a call is transitional, not terminal. | A naive implementation would poll, exceed runtime limits, or report a false final state. | One immediate follow-up describe only. `Starting`/`Stopping` are reported as valid observed states. No long-polling. |
| R7 | `StoppedMode` is silently ignored for unsupported instances. | Billing behaves differently than configured, with no error. | Pin `StoppedMode` explicitly and document the silent-ignore behaviour; never rely on account defaults. |
| R8 | Cron CPU limit is 10 ms on the free plan. | Runs are terminated mid-flight. | Measure actual CPU. If the free plan is insufficient, the paid plan is a documented prerequisite rather than a silent assumption. |
| R9 | Workers Logs persist by default. | Secret leakage into retained logs. | Centralised redaction; secrets never interpolated into log or error strings; tested. |
| R10 | CI or a test could accidentally perform a live mutation. | Unintended instance stop/start. | All network mocked; no credentials in CI; deployment is manual and gated. |

## 13. Open decisions and blocking questions

**Resolved by the owner (recorded, not re-opened):**

1. Units — decimal `1000^3`, labelled `GB`; the name `TRAFFIC_THRESHOLD_GB` is kept.
2. Notification cadence — a webhook is sent on **every** scheduled run, including
   no-op runs.
3. Branch protection — a ruleset requiring pull request + CI status check on `main`,
   added once CI exists.

**Resolved during planning (no owner input required):**

4. CDT API version is `2021-08-13`, correcting the brief's `2021-08-31`.
5. There is no pagination for `ListCdtInternetTraffic`; the brief's pagination test is
   replaced by multi-entry summation.
6. Signing method is V3, with a configuration switch and both fixtures pinned.
7. `cdt.aliyuncs.com` becomes configuration with that default, flagged for empirical
   confirmation.

**Open, and requiring owner confirmation before or at deployment:**

| # | Question | Why it matters | Proposed default |
| --- | --- | --- | --- |
| Q1 | **Summation scope.** Sum all `TrafficDetails` entries, or only those whose `BusinessRegionId` equals the configured `REGION_ID`? The two reference implementations disagree. No official source defines the semantics. | Changes the effective threshold. Summing everything is the conservative choice; filtering is the literal reading of "this region's traffic". | Sum **all** entries, treat the result as the total internet traffic, and expose the per-region breakdown in the webhook payload so the choice is auditable. |
| Q2 | **`StoppedMode`** — **RESOLVED by owner: `KeepCharging` (default).** Rationale: the primary objective is CDT traffic enforcement with reliable automatic recovery, not compute-cost optimisation; `KeepCharging` preserves instance resources and avoids economical-mode restart/inventory and public-IP risks in v1. Remains configurable to `StopCharging` without code changes. `ForceStop=false`; the mode is never inferred to have taken effect from a successful `StopInstance`; `StopCharging` implications documented in SPEC §6.4. | Directly affects cost, restart reliability, and public-IP preservation. | **`KeepCharging`.** |
| Q3 | **ECS `RegionId` vs CDT `BusinessRegionId`.** Are the ECS region (e.g. `cn-hongkong`) and the CDT business region the same identifier namespace? | Determines whether one variable can serve both, or two are required. | Assume **independent** variables (`REGION_ID` for ECS, optional `BUSINESS_REGION_ID` for CDT), defaulting the latter to unset so no filter is applied. |
| Q4 | **Cloudflare plan.** Free (10 ms CPU per Cron invocation) or Paid? | Determines retry headroom and whether backoff is viable. | Implement with bounded retries, measure CPU, and state the required plan in the deployment doc. |

## 14. Acceptance of this PLAN

**Approved by the owner on 2026-09-20.** Implementation proceeds under TDD in phases
P0–P7, one pull request per phase, with the GitHub Project as the canonical tracker.
Normal PR/review gates apply: no deployment and no live ECS mutation without explicit
owner approval.
