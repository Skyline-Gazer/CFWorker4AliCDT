# Architecture overview

One Cloudflare Worker. Thin layers, with a hard separation between **deciding** and
**acting**.

## Module boundaries

```
src/index.ts              scheduled() + fetch(); wiring only
src/config.ts             env parsing, validation, structural redaction
src/redact.ts             the single redaction boundary

src/aliyun/encoding.ts    percentEncode(), canonicalQueryString()
src/aliyun/signing.ts     signV3(), signV2(), signRequest()
src/aliyun/rpc.ts         callRpc(), RpcError, error classification
src/aliyun/api.ts         listCdtInternetTraffic(), describeInstance(),
                          startInstance(), stopInstance()

src/monitor/decision.ts   decide()  — pure, no I/O
src/monitor/execute.ts    runPipeline(), fail-safe gate, report assembly

src/notify/webhook.ts     optional run reporting, failure-isolated

src/storage/history.ts    D1 write path
src/storage/read.ts       bounded D1 read

src/web/auth.ts           Basic + Bearer, timing-safe
src/web/router.ts         path/method dispatch, auth gate
src/web/dashboard.ts      server-rendered HTML
src/web/query.ts          read-only live query

migrations/               versioned D1 schema
```

The entrypoint is deliberately thin. The reference implementation this project
analysed concentrates routing, authentication, orchestration, HTTP clients, and a
large inline document in a single ~630-line `src/index.ts`; that is the one pattern
this project explicitly rejects. A reviewer should be able to read `decision.ts`
without scrolling past routing code.

## The scheduled path

```
scheduled()
     │
     ▼
 loadConfig(env) ──── invalid ──▶ config error; notify only with usable HTTPS URL
     └────────────────────────▶ exit, no mutation, no history row
     │
     ▼
 getTraffic() ─── CDT failure / missing / invalid ──▶ error report, NO mutation
     │  trafficBytes: valid, non-negative, finite
     ▼
 describeInstance() ─── ECS failure / instance absent ──▶ error report, no mutation
     │
     ▼
decide(trafficGB, thresholdGB, observed) ──▶ { desired, action, mutation, reason }
     │
     ▼
 action === "fail-safe" ───▶ error report, NO mutation
     │
     ▼
 at most ONE mutation (start | stop) ─── failure ──▶ error report
     │
     ▼
one immediate follow-up describe  (transitional results are valid; never polled)
     │
     ▼
 build report ──▶ optional notify() when WEBHOOK_URL is configured
     │
     ▼
 recordRun() ──▶ D1   ← AFTER control; failure degrades history only
```

Failure labels in the diagram mean the pipeline returns early from Alibaba work
with a classified report; validly configured outcomes then converge on report
handling and D1 persistence. Config errors exit before a history row is written.

Without `WEBHOOK_URL`, the notifier is omitted: no request is made, the report
sets `webhookAttempted` to `false` and leaves `webhookOk` undefined, and D1 stores
`webhook_ok` as NULL. With a URL, one notification attempt follows every validly
configured scheduled run. Alibaba remains authoritative; D1 and enabled webhook
reporting are observational.

Three properties of this ordering are load-bearing:

1. **Every abort happens before any ECS call.** The mutation is reached only after a
   valid traffic figure *and* a recognised instance state.
2. **The decision is pure.** `decide()` takes the traffic, the threshold, and the
   observed status. It takes no database handle, no `fetch`, and no webhook client,
   so it cannot perform I/O and is exhaustively testable without mocks.
3. **Reporting and persistence happen after control.** Neither can influence it.

## The manual path

```
POST /api/query ──▶ auth ──▶ getTraffic() ──▶ describeInstance() ──▶ decide() ──▶ JSON response
                                                                                    │
                                                          no mutation, no D1 write, no webhook
```

The manual path shares `decide()` with the scheduled path, so its answer is a genuine
prediction of what Cron would do rather than a parallel implementation that could
drift. It diverges immediately before acting.

**Its read-only guarantee is structural.** `QueryDeps` has exactly two members, both
reads. There is no `startInstance`, no `stopInstance`, no history insert, and no
webhook, so the path cannot start mutating by wiring alone — that would require
widening the interface, which is the reviewable change the design wants.

## The decision engine

`decide()` implements the full twelve-row matrix from SPEC §6.3 as a **literal
table** rather than a derived rule. A derived rule would have to encode the
`fail-safe` rows as exceptions, and an exception that is easy to reason about once
is easy to lose in a refactor. As a table, every row is reviewable against the
specification at a glance, and the type system checks exhaustiveness.

| Desired | Observed | Action | Mutation |
| --- | --- | --- | --- |
| running | `running` | `none-running` | none |
| running | `starting` | `none-starting` | none |
| running | `stopped` | `start` | `StartInstance` |
| running | `stopping` / `pending` / `unknown` | `fail-safe` | **none** |
| stopped | `stopped` | `none-stopped` | none |
| stopped | `stopping` | `none-stopping` | none |
| stopped | `running` | `stop` | `StopInstance` |
| stopped | `starting` / `pending` / `unknown` | `fail-safe` | **none** |

Boundary: `trafficGB < thresholdGB` ⇒ running; `>=` ⇒ **stopped**. Exactly at the
threshold stops.

Invalid input — non-finite, negative, or zero traffic or threshold — returns
`fail-safe` with no mutation. `NaN` is called out explicitly, because `NaN >= x` and
`NaN < x` are both false, so a naive comparison falls through to whichever branch was
written last.

## Data flow and authority

| Concern | Authority |
| --- | --- |
| ECS state | **Alibaba Cloud.** Never D1, never cache. |
| Traffic | **CDT API.** Unavailable traffic is never zero. |
| Mutation | **Cron only.** No HTTP route can mutate. |
| Monitoring history | **D1, observational.** No decision reads it. |

D1 is history, not state. A D1 failure cannot change a control outcome: the write
happens after any action has been applied, and `recordRun` resolves rather than
rejects so a storage failure cannot reach the control path.

## Redaction

A **single** boundary (`src/redact.ts`) is consumed by the RPC layer, the webhook,
the D1 write path, the dashboard, the query, and the router. Every destination that
persists or displays untrusted text routes through it.

This replaced two implementations. The weaker one treated an `Authorization` scheme
word as the value, which left the credential behind for the second pass to mangle —
and the credential reached a D1 row. Two key lists can always disagree again; one
boundary cannot. Idempotence is a security property here, because text on the path
to D1 is redacted more than once.

## Deployment shape

- `wrangler.jsonc` is the source of truth, and is never mutated by a deployment.
- Cron `*/10 * * * *`, UTC, 5-field — RELEASE enables it after first-deploy
  read-only verification; UPDATE explicitly preserves that schedule on an existing
  Worker.
- The first deployment is two owner actions. PRE-FLIGHT creates a new Worker with
  `triggers.crons = []` and a Version URL; verification is read-only against that
  URL; RELEASE enables Cron and the chosen HTTP endpoint. PRE-FLIGHT must never run
  against the live Cron Worker because its empty Cron array removes the schedule.
- Normal production re-deployments use UPDATE, which keeps the selected HTTP
  exposure and Cron schedule while applying pending D1 migrations before code.
- HTTP exposure is an explicit owner choice (`workers_dev` or `custom_domain`) with
  no default. `workers_dev: false` plus no route means the production dashboard has
  no stable endpoint until that choice is made.
- `secrets.required` is declared so a deployment missing a secret fails loudly rather
  than at the first scheduled run.
- The D1 binding is declared without a `database_id`; a real identifier is supplied at
  deploy time and never committed. The generated configs
  (`wrangler.preflight.jsonc`, `wrangler.deploy.jsonc`, `wrangler.update.jsonc`) live at the repository root
  — Wrangler resolves `main` relative to the config's directory — and are gitignored.
- CI holds no credentials and performs no deployment.

## References

PLAN §7 (architecture direction), §9 (fail-safe model), §12 (D1 history). SPEC §6
(ECS control), §8 (HTTP surface), §9 (D1), §10 (run pipeline).
