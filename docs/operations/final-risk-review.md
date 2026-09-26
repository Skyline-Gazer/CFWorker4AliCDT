# Final risk and acceptance review

This is the closing review required by PLAN §19 and SPEC §13. It verifies that every
current PLAN risk is mitigated or documented, and that every current SPEC acceptance
criterion is demonstrated by **executable evidence** rather than intent.

> **Scope note.** The originating Issue (#33) still carries Revision-1 wording
> (R1–R10 / A1–A10). The authoritative scope is the **current** canonical PLAN/SPEC:
> **R1–R12** and **A1–A13**. This document covers the full current set.

## 0. Reviewed revision

| Field | Value |
| --- | --- |
| Canonical `main` SHA | `e350cbd62d25e23642cd08c5414e65a055f06c23` |
| PLAN | Revision 2 (approved 2026-09-20, amended 2026-09-22) |
| SPEC | Revision 2, companion to the PLAN |
| Evidence basis | Repository state, merged PRs, GitHub settings, executed tests |
| Test suite at review | **591 tests, 18 files**, all passing |
| Validation | `npm run validate` exit 0 (format, lint, typecheck, test, dry-run) |

No deployment has been performed and no live Alibaba Cloud call has been made. Items
that can only be closed by real runtime observation are marked
`BLOCKED_BY_LIVE_DEPLOYMENT` rather than closed.

> **Amendment (2026-09-26), CPU and plan only.** Production RELEASE
> [36159977416](https://github.com/Skyline-Gazer/CFWorker4AliCDT/actions/runs/36159977416)
> at `106f4d214a883ac9bfdf0798110f845092fbe971` has since passed. The first natural
> Cron (`2026-09-25T16:50:28Z`, `*/10 * * * *`, count 1, custom domain `cdt.q9m3.com`)
> measured `cpuTimeMs` **9** (success / ok, action `none-running`, D1 history write
> yes, `webhook_attempted=false`). **R8** in §1, the CPU rows in §5, finding 5, and
> the CPU step in §7 record that measurement. **Required plan: Workers Free.** Paid
> is not required solely by this single-run observation. The rest of this review is
> unchanged, including the release-state flags in §6.

## 1. PLAN risks R1–R12

| Risk | Status | Evidence | Residual risk | Follow-up |
| --- | --- | --- | --- | --- |
| **R1** — `ListCdtInternetTraffic` undocumented | **MITIGATED** | Every field treated as optional and validated: `reduceTraffic` raises `TrafficUnavailableError` for absent/null/non-array/empty `TrafficDetails` and for a `Traffic` that is absent, `null`, `""`, non-numeric, `NaN`, infinite, or negative. Tests: `test/aliyun/api.test.ts` (`fails closed` block, 16 cases). | The *shape* is pinned by our own tests, not by a provider contract. If the real response differs, the run aborts. Accepts abort, never misreads. | — |
| **R2** — CDT endpoint unconfirmed | **DOCUMENTED; BLOCKED_BY_LIVE_DEPLOYMENT** | `CDT_ENDPOINT` is configuration (`wrangler.jsonc`), not a constant, so correction is a variable change. Documented as assumption A1 in `docs/operations/assumptions-register.md` with verification steps. | Total monitoring failure if wrong — but it fails **closed**: every run aborts at `stage: "cdt-query"` with no mutation. | — (verification is the first-run procedure) |
| **R3** — Signature method unconfirmable | **MITIGATED; BLOCKED_BY_LIVE_DEPLOYMENT** | Single `callRpc()` boundary; `SIGNATURE_VERSION` selects `v3`/`v2`; both official vectors pinned byte-exact in `test/aliyun/signing.test.ts`; V2 retained. Recorded as assumption A2. | The accepted method for *this* operation cannot be confirmed without a live call. Fails closed. | — |
| **R4** — `Traffic` unit is an assumption (bytes) and displayed values must match CDT | **DOCUMENTED; BLOCKED_BY_LIVE_DEPLOYMENT** | Conversion isolated in `trafficBytesToGb` with `BYTES_PER_GB = 1024^3`. Assumption A3/A4; deployment verification compares the Worker reading to CDT for the same period using this divisor. | **The one risk whose failure could cause an incorrect action rather than an abort** — a wrong raw unit or scope stops early or enforces late. Stated as such in the register. | — |
| **R5** — Conversion remains aligned with the CDT GB display | **MITIGATED IN CODE; DEPLOYMENT CHECK PENDING** | `test/aliyun/api.test.ts` pins `1024^3`, exact conversion at 180 GB, and the owner-provided `27,858,630`-byte example (`0.02594537 GB`, console `0.02595 GB`). The README documents that the public label remains GB and the divisor is not `10^9`. | The deployed Worker still requires comparison against CDT for the same period. The threshold default remains `180` with no compensation. | — |
| **R6** — Asynchronous ECS operations | **MITIGATED** | Exactly one immediate follow-up describe, no polling. `test/monitor/execute.test.ts` asserts one follow-up and that a transitional result (`starting`) is preserved as observed. | None. | — |
| **R7** — `StoppedMode` silently ignored | **MITIGATED** | `ForceStop` pinned `"false"` at one call site (`src/aliyun/api.ts`); mode reported as **requested**, never applied. `test/aliyun/api.test.ts` asserts the result is `{ requested: true }` and not `{ applied: true }`; `test/monitor/execute.test.ts` asserts what is sent equals what is recorded. | Billing behaviour still depends on instance support, which is not observable. No logic branches on it. | — |
| **R8** — Free platform CPU allowance / Workers plan | **MEASURED — Workers Free** | First natural Cron `2026-09-25T16:50:28Z` on RELEASE `106f4d214a883ac9bfdf0798110f845092fbe971` ([run 36159977416](https://github.com/Skyline-Gazer/CFWorker4AliCDT/actions/runs/36159977416), PASS) measured `cpuTimeMs` **9**, within the Workers Free 10 ms allowance. Outcome success / ok; action `none-running`; D1 history write yes; `webhook_attempted=false`. Cron `*/10 * * * *`, count 1; custom domain `cdt.q9m3.com`. Recorded in `docs/operations/deployment.md` §7. Paid is not required solely by this single-run observation. Retries are bounded; no long-polling; custom `limits.cpu_ms` stays omitted. | A later run above 10 ms CPU may still be terminated mid-flight. It aborts **safely** (no mutation) but reports nothing. | deployment.md §7 |
| **R9** — Log persistence / secret leakage | **MITIGATED** | Single redaction boundary (`src/redact.ts`), consumed by rpc, webhook, storage, dashboard, query, router. `test/redaction-surfaces.test.ts` asserts the same credential cannot escape **any** of the four destinations via real module paths, and that every module exporting `redact` exports the same function **by reference**. | None identified. | — |
| **R10** — CI/test performing a live mutation | **MITIGATED** | CI holds no credentials and runs no deploy (`.github/workflows/ci.yml`); all network I/O is mocked; deployment is manual and gated. | None. | — |
| **R11** — Branch protection unenforceable | **MITIGATED** | Repository is public; protection **enabled and verified**: PR required, `Format, lint, typecheck, test` required, admin enforcement on, force-push and deletion blocked. All four acceptance behaviours were demonstrated live on Issue #15 (direct push rejected `GH006`; failing-CI merge refused as `BLOCKED`; passing CI merged; force-push rejected). | None. | #15 (closed) |
| **R12** — D1 availability/limits | **MITIGATED structurally; BLOCKED_BY_LIVE_DEPLOYMENT** | `monitor/` contains **no** reference to storage or D1, so D1 is not a control input. `recordRun` resolves rather than rejects on any failure; a missing binding is a recorded storage failure, not a failed run. `test/monitor/*` and `test/storage/history.test.ts` assert isolation. | Absolute D1 quota behaviour under sustained load is unobserved. Retention is indefinite by owner decision (PLAN Q5). | — (observation) |

## 2. SPEC acceptance criteria A1–A13

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| **A1** | CDT failure ⇒ zero ECS mutations, error report, exit; notify once when configured | **PASS** | `test/monitor/execute.test.ts` asserts the **mutation count** is zero for CDT transport failure and unavailable traffic, with the correct stage; scheduled integration covers configured notification and no-webhook operation. |
| **A2** | Missing/invalid traffic never becomes `0` | **PASS** | `test/aliyun/api.test.ts` ×16 fail-closed cases; `test/storage/schema.test.ts` asserts NULL round-trips as NULL and is distinguishable from a genuine `0`. |
| **A3** | Desired equals observed ⇒ no mutation | **PASS** | `test/monitor/decision.test.ts` asserts `none-*` for all matching states including transitional forms; `test/monitor/execute.test.ts` asserts zero calls on a no-op. |
| **A4** | Webhook failure cannot alter ECS control | **PASS** | `test/monitor/execute.test.ts`: a rejecting and a throwing webhook both leave the action and the mutation count unchanged. |
| **A5** | No secret in logs, payloads, HTML, D1, or errors | **PASS** | `test/redaction-surfaces.test.ts` exercises all four destinations through real module paths for 10 credential forms, and asserts boundary identity by reference. |
| **A6** | No HTTP route mutates; `/api/query` read-only | **PASS** | `test/index.test.ts` asserts no `StartInstance`/`StopInstance` in any request body across all routes; `test/web/router.test.ts` asserts 404 for control paths and that `RouteDeps` exposes no mutation seam; `test/web/query.test.ts` asserts `QueryDeps` has exactly two read members. |
| **A7** | Both official signature vectors reproduce exactly | **PASS** | `test/aliyun/signing.test.ts` reproduces the V3 worked example (`HashedCanonicalRequest 7ea06492…`, `Signature 06563a9e…`) and the V2 vector byte-exact. |
| **A8** | Boundary: `< threshold` running, `>= threshold` stopped | **PASS** | `test/monitor/decision.test.ts` asserts `threshold−1`, exactly `threshold`, `threshold+1`, and exactly-representable halves (`179.5`/`180.5`). |
| **A9** | Every `fail-safe` row performs no mutation | **PASS** | `test/monitor/decision.test.ts` asserts all six `fail-safe` rows with `mutation: false`; `test/monitor/execute.test.ts` asserts the abort path issues zero mutations. |
| **A10** | CI passes with no credentials and no live calls | **PASS** | `.github/workflows/ci.yml` references no secrets and runs no deploy; CI green on `main`; every suite is offline. |
| **A11** | D1 write failure does not alter the control outcome | **PASS** | `test/storage/history.test.ts`: `recordRun` resolves on a rejected promise *and* on a synchronous throw, does not mutate the report, and logs locally. `test/index.test.ts` asserts a full run completes against a rejecting D1 with no mutation. |
| **A12** | Protected routes deny unauthenticated and malformed requests | **PASS** | `test/web/auth.test.ts` (42 tests) covers valid/invalid/malformed Basic, Bearer, missing/empty `ADMIN_TOKEN`, and timing-safety discrimination; `test/index.test.ts` asserts 401 on every protected route. |
| **A13** | `decision()` is pure and testable without mocks | **PASS** | `test/monitor/decision.test.ts` asserts identical results across repeated calls and that the input is not mutated. `decision.ts` imports only a **type** — no I/O, no clock, no config. CodeGraph confirms its callees are local helpers only. |

## 3. Anti-requirement and invariant verification

Each was re-checked against the reviewed SHA. Where a structural property is claimed
it is backed by a reachability proof, not only a test.

| # | Invariant | Verified by |
| --- | --- | --- |
| I1 | Missing/invalid traffic is never coerced to `0` | `test/aliyun/api.test.ts`; `test/storage/schema.test.ts` (NULL ≠ 0) |
| I2 | Invalid traffic cannot trigger an ECS mutation | `test/monitor/execute.test.ts` — mutation **count** asserted zero on every abort path |
| I3 | HTTP routes cannot call `StartInstance`/`StopInstance` | **Reachability proof**: `codegraph callers startInstance` → sole production caller `pipelineDeps`; `callers pipelineDeps` → sole caller `runScheduled`; `runScheduled` has exactly one call site, inside `scheduled()`. `fetch()` passes a fixed deps object to `route()` with no mutation member. Plus `test/index.test.ts`. |
| I4 | Cron is the only mutation authority | Same reachability proof as I3. |
| I5 | No `RebootInstance` path exists | `rg "RebootInstance\|reboot" src/` → **no match**. |
| I6 | `ForceStop` is false and non-configurable | `src/aliyun/api.ts` — a literal `"false"`, with no parameter to change it; `test/aliyun/api.test.ts` asserts `ForceStop=false` and that no config path reaches it |
| I7 | `StoppedMode` reported as requested, never applied | `test/aliyun/api.test.ts`; `test/monitor/execute.test.ts` asserts sent == recorded; no field named `applied` exists |
| I8 | D1 is observational, never a control input | **Structural proof**: `rg "storage\|D1" src/monitor/*.ts` → **no match**. `monitor/` cannot read D1. |
| I9 | D1 failure cannot alter the control outcome | `test/storage/history.test.ts`; `test/index.test.ts` (full run against rejecting D1) |
| I10 | Webhook failure cannot alter the control outcome | `test/monitor/execute.test.ts` (throwing and rejecting) |
| I11 | Manual `/api/query` does not write history | `test/web/query.test.ts` asserts the exact `QueryDeps` key set contains no write seam; `src/web/query.ts` performs no insert |
| I12 | `GET /health` is public and inert | `test/index.test.ts` — 200 without auth, no config disclosed, prepared-statement counter is 0 |
| I13 | Protected routes fail closed when `ADMIN_TOKEN` is absent | `test/web/auth.test.ts`; `test/index.test.ts` asserts 401 on all three protected routes |
| I14 | Auth comparison is timing-safe | `test/web/auth.test.ts` — XOR-accumulating comparison; the test was proven to **discriminate** by substituting a short-circuiting comparator and observing failure |
| I15 | Secrets cannot escape logs, payloads, HTML, D1, or errors | `test/redaction-surfaces.test.ts` — 10 forms × 4 destinations, through real module paths |
| I16 | All modules exporting `redact` resolve to the same boundary **by reference** | `test/redaction-surfaces.test.ts` — reference identity assertion. This found a live defect: `rpc.ts` wrapped the boundary rather than re-exporting it; fixed in PR #63. |
| I17 | At most one ECS mutation per scheduled run | **Structural**: both control actions route through a single `issueMutation()` call site; `test/monitor/execute.test.ts` asserts exactly one call |

## 4. Findings raised by this review

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | `src/aliyun/rpc.ts` **wrapped** the redaction boundary rather than re-exporting it, leaving a second function identity. Behaviour identical, so no behavioural test could detect it — but it is the shape that produced the original two-implementation divergence that leaked a credential into D1. | **fixed** — PR #63; now a true re-export, asserted by reference |
| 2 | `ApiContext` carried no `signatureVersion`, so a validated `SIGNATURE_VERSION` was silently ignored (`callRpc` always used `v3`). SPEC §4.1 requires the method be selectable because the operation is undocumented. | **fixed** — PR #62 |
| 3 | The first log-surface redaction test hand-rolled a console call with a raw string instead of exercising module paths, so it verified nothing. | **fixed** — PR #63 |
| 4 | A branch for #44 was built from an earlier `main` and would have **silently reverted** the P6 phase-review pin. | **fixed** — caught before merge; branch rebuilt from current `main` |
| 5 | Deployment docs could have satisfied their criterion text with an invented CPU figure. | **not_applicable at review time** — stated as pending because only a deployment can produce it. **Subsequently recorded** from the first natural Cron: `cpuTimeMs` 9, required plan Workers Free (`docs/operations/deployment.md` §7). |
| 6 | `threshold_gb` is written without a finiteness guard. | **deferred_non_blocking** — unreachable from `loadConfig`, which rejects non-finite and non-positive thresholds |
| 7 | Repo-wide credential scan returns hits. | **not_applicable** — all are deliberately fake test fixtures used as redaction oracles |

**Blocking unresolved findings: 0.**

## 5. Open and deployment-gated items

### CPU and plan, recorded after this review

The review below was written before production RELEASE. The first natural Cron has
since been measured, and that measurement is what the plan requirement uses.

| Item | Record |
| --- | --- |
| **#28** — measured CPU per run | `cpuTimeMs` **9** at `2026-09-25T16:50:28Z` on RELEASE `106f4d214a883ac9bfdf0798110f845092fbe971` ([run 36159977416](https://github.com/Skyline-Gazer/CFWorker4AliCDT/actions/runs/36159977416), PASS). Required plan: Workers Free. Redaction, the other part of this issue, was already mitigated (R9, A5). |
| **#31** — Cloudflare plan statement | `docs/operations/deployment.md` §7 cites `cpuTimeMs` 9 and states Workers Free as the required plan. Paid is not required solely by this single-run observation. |
| **R8** — CPU budget | Measured. 9 ms is within the Workers Free 10 ms allowance. Custom `limits.cpu_ms` stays omitted. |

### Still outstanding

These still require a live observation or an owner action. The CPU measurement above
does not settle them.

| Item | Why it remains outstanding |
| --- | --- |
| **#47** — deployment workflow, protected environment, ordered remote migration | Requires creating remote resources; owner-gated |
| **R2, R3, R4** — endpoint, accepted signature method, traffic unit | Empirically unconfirmable without a live call |
| **R12** — D1 behaviour under real load | Requires a remote database |

## 6. Release state

**This review does not mean the project is released.**

```
P8_REVIEW_COMPLETE=YES
P8_IMPLEMENTATION_COMPLETE=NO
LIVE_DEPLOYMENT_REQUIRED=YES
PRODUCTION_VERIFIED=NO
V1_RELEASE_READY=NO
```

## 7. Owner action required next

1. **Create the remote D1 database** and supply its identifier via a repository
   variable (never committed), so #47's migration step has a target.
2. **Authorize the protected GitHub Environment** with required reviewers, so no
   unattended push can deploy.
3. **Confirm the pre-deployment checklist** in `docs/operations/deployment.md` §1 —
   all seven variables and the three required RELEASE secrets. The optional
   webhook pair is needed only when notification is wanted; a token requires its URL.
4. **Merge #47** and perform the first deployment.
5. **Run the first-run verification** (assumptions register §4). The CPU part of
   that procedure is recorded: first natural Cron `cpuTimeMs` 9, required plan
   Workers Free (`docs/operations/deployment.md` §7). The other first-run checks
   are separate from that recording.
6. Only then is `V1_RELEASE_READY` claimable.

## 8. References

PLAN §11 (risks R1–R12), §12 (D1), §14.1 (branch protection), §18 (resolved
questions). SPEC §13 (A1–A13), §9 (D1), §8 (HTTP surface). Supporting registers:
`docs/operations/assumptions-register.md`, `docs/security/ram-policy.md`,
`docs/operations/deployment.md`, `docs/architecture/overview.md`.
