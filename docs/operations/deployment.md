# Deployment and operations

Deployment is **manual, owner-gated, and two-stage**. No CI job deploys, and no
scheduled ECS mutation occurs without explicit owner authorization.

> **No credential value is ever printed, echoed, pasted into an issue, written to
> a log, or committed.** Every command below either prompts for a value or
> references one by name. If you find yourself typing a secret as a command
> argument, stop — the argument is recorded in shell history.

## 0. The two deployment models

It is worth being explicit about the difference, because conflating them is what
made the earlier single-stage design unsafe.

| | **Initial bootstrap** | **Normal production operation** |
| --- | --- | --- |
| Frequency | Once, for a new Worker | Re-deployments of an existing Worker |
| Cron authority | **Disabled** (`triggers.crons = []`) | Enabled (`*/10 * * * *`) |
| HTTP endpoint | Version URL only, temporary | Stable endpoint, deliberately chosen |
| Verification | Read-only, live, **this is the point** | Regression checks on the change |
| Workflows | `preflight.yml` | `release.yml` |
| Config | `wrangler.preflight.jsonc` | `wrangler.deploy.jsonc` |

The bootstrap is two owner actions, not one:

```
preflight deploy  →  Version URL  →  read-only live verification  →  owner confirms
                                                                          │
                                                                          ▼
                                                                   release deploy
                                                          (stable endpoint + Cron)
```

**RELEASE is never triggered by PRE-FLIGHT.** Nothing chains them. The owner
dispatches each deliberately.

### Why the bootstrap cannot use `wrangler versions upload`

Cloudflare documents that `wrangler versions upload` **cannot be used for the
first upload of a new Worker project**; the command fails. The first upload must be
`wrangler deploy` (or C3). `wrangler versions upload` becomes useful *after* a
Worker already exists, and is where a future update workflow would start — but no
such workflow is implemented here, and this document does not claim one.

So the safe bootstrap is a **real first deploy whose config has Cron explicitly
disabled**. That is what makes it safe: the Worker exists, the code is real, and
there is no schedule that can start or stop an instance.

## 1. Pre-deployment checklist

The owner confirms each item **before** the Worker is allowed to run against a
real account. Nothing here is discoverable from the code; each is an owner
decision or an external fact.

### Plain variables (Wrangler `vars`)

| Variable | Requirement | Confirmed? |
| --- | --- | --- |
| `REGION_ID` | The ECS region, e.g. a region identifier. Used to build `ecs.<REGION_ID>.aliyuncs.com`. | ☐ |
| `ECS_INSTANCE_ID` | **Exactly one** instance. The Worker manages no other. | ☐ |
| `TRAFFIC_THRESHOLD_GB` | Threshold in **decimal GB** (default `180`). See §5 on the unit. | ☐ |
| `CDT_ENDPOINT` | Default `cdt.aliyuncs.com` — **unverified** (A1). Confirm at first run. | ☐ |
| `BUSINESS_REGION_ID` | Optional. Unset by default, so no CDT filter is applied. | ☐ |
| `SIGNATURE_VERSION` | `v3` (default) or `v2`. See §6 if the first run is rejected. | ☐ |
| `STOPPED_MODE` | `KeepCharging` (default) or `StopCharging`. **Read §4 before changing.** | ☐ |

These seven are the SPEC §2.2 **application** variables. They configure the
Worker at runtime. Deployment-only values (§3c) are a separate set and are never
added to this table.

### Secrets (Workers Secrets) — five names, values never committed

| Secret | Requirement | Confirmed? |
| --- | --- | --- |
| `ALIYUN_ACCESS_KEY_ID` | From the RAM user in `docs/security/ram-policy.md`. | ☐ |
| `ALIYUN_ACCESS_KEY_SECRET` | Its paired secret. | ☐ |
| `WEBHOOK_URL` | An absolute `https://` URL. Validated at config time. | ☐ |
| `WEBHOOK_TOKEN` | Optional. When set, sent as `Authorization: Bearer <token>`. | ☐ |
| `ADMIN_TOKEN` | **Required for the dashboard/API.** Absent ⇒ every protected route denies. | ☐ |

### External confirmations

| Item | Confirmed? |
| --- | --- |
| The RAM policy grants **exactly four** actions and no wildcard action. | ☐ |
| The instance's current state is known, and stopping it is acceptable. | ☐ |
| The webhook endpoint is reachable and will record what it receives. | ☐ |
| The Cloudflare account plan matches what §7 concludes. | ☐ |
| A D1 database exists for the binding, or a decision to run without history is recorded. | ☐ |
| The HTTP exposure decision has been made (see §3c), or a record exists of choosing none. | ☐ |

## 2. Setting secrets

Each command prompts; the value is not echoed, not stored in history, and not
written to a file.

```sh
npx wrangler secret put ALIYUN_ACCESS_KEY_ID
npx wrangler secret put ALIYUN_ACCESS_KEY_SECRET
npx wrangler secret put WEBHOOK_URL
npx wrangler secret put WEBHOOK_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

**Verify by absence, not by printing.** Do not run a command that echoes a secret
to confirm it was set. Confirmation comes from the deployment, which fails loudly
when a required secret is missing, and from a successful first run.

## 3. Deploying

There are four paths: two workflows (the normal way) and their manual
equivalents, for when a step needs to be visible.

### 3a. Generated configs — why they exist and where they go

`wrangler.jsonc` is the committed source of truth. It deliberately declares the
`TRAFFIC_DB` binding with **no** `database_id`, so no production identifier is ever
committed and local development uses Wrangler's local D1 emulation.

A remote deployment still needs the identifier. Rather than commit it or rewrite
the committed config in CI, `scripts/resolve-deploy-config.mjs` reads
`wrangler.jsonc` and writes a **generated** config:

| Mode | Output | Purpose |
| --- | --- | --- |
| `--mode preflight` | `wrangler.preflight.jsonc` | First deploy; Cron disabled; Version URL. |
| `--mode release` | `wrangler.deploy.jsonc` | Production; Cron enabled; chosen endpoint. |

Three properties are enforced by the resolver, and each closes a measured defect:

1. **The generated file is written to the repository root.** Wrangler treats the
   config's *directory* as the project root, so a config written anywhere else
   makes `main: "src/index.ts"` resolve outside the repository and fail with
   "The entry-point file at `src/index.ts` was not found". The resolver refuses any
   other location.
2. **The committed `wrangler.jsonc` is never mutated.** Generation is read-and-copy.
   A config rewrite in CI is how a local config silently drifts from the deployed one.
3. **Both generated files are gitignored**, and their names are distinct from
   `wrangler.jsonc` so Wrangler never picks one up implicitly.

The workflow steps pass `--config` explicitly for the same reason: the dry-run in
`npm run validate` uses `wrangler.jsonc`, and a validation against a *different*
config proves nothing about the one being deployed.

### 3b. Initial bootstrap — PRE-FLIGHT, then RELEASE

**Step 1 — PRE-FLIGHT** (creates the Worker, no Cron). Dispatch
`.github/workflows/preflight.yml`. It resolves `--mode preflight`, applies remote
migrations, and performs the first `wrangler deploy`.

The preflight config sets `preview_urls = true`, `workers_dev = false`, no route,
and `triggers.crons = []`.

**Why `[]` and not an omitted field.** Cloudflare documents the difference: if
`crons` is an **empty array**, all Cron Triggers are removed; if `triggers` or
`crons` is **`undefined`**, the currently deployed Cron Triggers are left in place.
Omitting the field would be a silent "change nothing", which is not the same
operation as "have no schedule".

The deploy reports a **Version URL**. That URL exists even with `workers_dev =
false`, provided `preview_urls` is enabled.

**Step 2 — live read-only verification.** Performed by the owner against the
Version URL, **before** Cron exists. The full procedure is §6.

**Step 3 — RELEASE** (enables Cron). Dispatch `.github/workflows/release.yml`.
This is a separate action, and the only path that enables scheduled mutation.

### 3c. Deployment-only configuration (owner action, one time)

These are **not** Worker runtime variables. They configure *how the deployment is
performed*, and they are not in the SPEC §2.2 seven.

| Name | Kind | Scope | Purpose |
| --- | --- | --- | --- |
| `D1_DATABASE_ID` | Variable | **Repository** | The remote `TRAFFIC_DB` UUID. |
| `HTTP_EXPOSURE_MODE` | Dispatch input | — | `workers_dev` or `custom_domain`. **No default.** |
| `WORKER_CUSTOM_DOMAIN` | Variable | **Repository** | Required only when the mode is `custom_domain`. |
| `CLOUDFLARE_API_TOKEN` | Secret | **Repository** | Scoped to Workers + D1. |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | **Repository** | The account identifier. |

**These must be repository-level, not environment-level.** PRE-FLIGHT does not
target the `production` environment, so a value stored only in that environment
is invisible to it and the preflight deploy would fail with empty credentials.
The protected-environment gate exists to require approval for **RELEASE**, not to
hold the credentials both stages need.

`D1_DATABASE_ID` is a **variable, not a secret**: it is an identifier rather than a
credential, and treating it as a secret would make it harder to audit without
making it safer. It is nonetheless never committed.

**Configure the protected environment** (GitHub settings; a workflow file cannot
assert these):

1. **Settings → Environments → New environment**, named exactly `production`.
2. Enable **Required reviewers** and add the owner. This is the gate that makes an
   unattended release impossible.
3. Optionally restrict **Deployment branches** to `main`.

**Choose the HTTP exposure mode.** The committed config has `workers_dev = false`
and no routes, so the production dashboard/API has **no stable inbound endpoint**
until the owner chooses one. That choice is explicit, and there is no default:

| Mode | Generated release config | When to use |
| --- | --- | --- |
| `workers_dev` | `workers_dev = true`, no route | The simpler personal/hobby path. |
| `custom_domain` | `workers_dev = false` + a `custom_domain` route | A domain you control. |

For `custom_domain`, set `WORKER_CUSTOM_DOMAIN` to a bare hostname (for example
`worker.example.com`). The resolver fails closed — producing no config at all — when
the mode is absent, unrecognised, or `custom_domain` without a domain, and when the
domain is malformed.

Protected routes remain authenticated in **both** modes. Choosing a public hostname
does not make a route public; it makes the *address* predictable. `GET /health` is
the only public route in either mode.

### 3d. RELEASE gates

The release workflow fails closed unless **all** of these hold:

1. The job targets the protected `production` environment (owner approval).
2. `confirmation` is exactly `DEPLOY`.
3. `LIVE_READ_ONLY_VERIFIED` is exactly `YES` — the owner may only supply this
   after §6 has passed.
4. `HTTP_EXPOSURE_MODE` is `workers_dev` or `custom_domain`, and the custom domain
   is present and well-formed when required.

Every confirmation is `required` with **no default**, because a defaulted boolean is
a gate that passes when nobody looks at it.

### 3e. Manual equivalents

For the preflight stage, so every step is visible:

```sh
npm ci
npm run validate                                   # format, lint, typecheck, test, dry-run
export D1_DATABASE_ID=<the remote TRAFFIC_DB uuid>
node scripts/resolve-deploy-config.mjs --mode preflight
npx wrangler d1 migrations apply TRAFFIC_DB --remote --config wrangler.preflight.jsonc
npx wrangler deploy --config wrangler.preflight.jsonc
```

For the release stage:

```sh
npm ci
npm run validate
export D1_DATABASE_ID=<the remote TRAFFIC_DB uuid>
export HTTP_EXPOSURE_MODE=workers_dev              # or: custom_domain
export WORKER_CUSTOM_DOMAIN=<hostname>             # required only for custom_domain
node scripts/resolve-deploy-config.mjs --mode release
npx wrangler d1 migrations apply TRAFFIC_DB --remote --config wrangler.deploy.jsonc
npx wrangler deploy --config wrangler.deploy.jsonc
```

`npm run validate` runs the same checks as CI, in the same order, in one
invocation — so it cannot be left half-run. The migration step is ordered before
the deploy so the schema exists before a Worker version that writes to it is live.

### 3f. Version URL lifecycle

- **PRE-FLIGHT:** `preview_urls = true`, so a Version URL exists for verification.
- **RELEASE:** `preview_urls = false`, so the temporary verification exposure is not
  retained. Version URLs are public while they exist; a Version URL runs the
  uploaded version against **production** resources, so it is a verification window,
  not a staging environment.

The stable endpoint after release is the one the owner chose in §3c, and it is
explicit in the generated config rather than implicit in the absence of one.

## 4. `StopCharging` implications — read before changing `STOPPED_MODE`

The default is **`KeepCharging`**. Changing it trades restart reliability and
public-address preservation for compute cost. Both risks below are **silent**: the
API returns no error, and both are discovered only at restart, which is the worst
possible moment.

### Restart-capacity risk

`StopCharging` releases compute resources. A later `StartInstance` then depends on
capacity being available for that instance type in that zone. The failure mode is
`OperationDenied.NoStock`, which under this design surfaces as `stage: "ecs-start"`
with the instance **left stopped** — traffic enforcement succeeded, but automatic
recovery did not.

### Public-IP risk

Depending on the instance's addressing mode, releasing resources can change or lose
the public address. For a traffic-relay use case that can break the very relay the
instance exists to provide. Confirm the address survives a stop/start cycle
**before** trusting `StopCharging` in production.

### What is not affected

- `ForceStop` is `false` and **not configurable**. Force-stopping risks filesystem
  corruption and is excluded by design.
- A successful `StopInstance` is **not** evidence that `StoppedMode` took effect.
  The API returns success even when economical mode is unsupported and silently
  ignores it. The system therefore reports the mode as **requested**, never as
  applied, and no logic depends on it having applied.

## 5. The decimal-GB divergence

The threshold is **decimal gigabytes** (`10^9` bytes), not binary (`1024^3`). This
is deliberate and diverges from the prior script and both reference
implementations. **180 GB decimal equals 167.6 GiB**, so enforcement trips
**earlier** for the same byte count.

An operator migrating from the prior implementation will see the instance stop at
what looks like a lower traffic figure. That is this behaviour, not a bug.

## 6. First-live-run verification — performed BEFORE Cron is enabled

This is the procedure that makes the two-stage bootstrap worth its extra step. It
runs against the **Version URL** from PRE-FLIGHT, while there is no Cron Trigger and
therefore no way for the system to act.

### Why it cannot wait until after a scheduled run

Most assumptions in the register fail safe: if they are wrong, the run aborts and
nothing mutates. **R4 is the exception.** If the traffic-unit assumption is wrong,
the system does not fail — it computes a *valid but incorrect* comparison and may
act on it. The fail-closed design cannot detect this, because nothing failed.

So the traffic figure must be checked empirically **before** scheduled authority
exists. Verifying it afterwards is verifying the assumption with the instance
already able to be stopped by it.

### The sequence

1. **`GET /health`** — public, inert. Confirms the Worker is reachable and returns
   `200` with no Alibaba call and no D1 read.
2. **Unauthenticated access to the protected routes** — confirm `GET /`,
   `GET /api/history`, and `POST /api/query` each return `401`. Auth is not weakened
   for preflight; there is no reduced-security mode.
3. **Authenticate and call `POST /api/query`.** This is the read-only live query.
4. **Confirm what `/api/query` did and did not do.** It must have queried CDT,
   described ECS, and evaluated `decide()`; it must expose an `action` and a
   `mutation: false`, and it must have performed **no** `StartInstance`, **no**
   `StopInstance`, **no** D1 history write, and dispatched **no** webhook. The
   read-only guarantee is structural — `QueryDeps` exposes no mutation seam — and
   this step confirms it operationally.
5. **Compare the returned traffic against the Alibaba console for the same
   period.** This is R4.
6. **Confirm the four assumptions:**
   - **R2 — CDT endpoint.** The call succeeded. A `stage: "cdt-query"` error means
     the endpoint or the signature method is wrong, **not** that traffic is zero.
   - **R3 — accepted signature method.** The call succeeded. A signature rejection
     is `SignatureDoesNotMatch` or a `4xx` at `stage: "cdt-query"`; try
     `SIGNATURE_VERSION=v2` before investigating further.
   - **R4 — traffic unit and summation.** `trafficGB` matches the console. Treat it
     as **unverified** until it does. A mismatch of roughly 7% suggests a
     decimal/binary confusion (A4); orders of magnitude suggests the unit is not
     bytes.
   - **ECS observed state.** `ecsStatus` matches the console for the managed
     instance.
7. **Only then authorize RELEASE.**

### Reading the output afterwards

**Webhook.** One report per scheduled execution, including no-ops. `status:
"success"` carries the traffic, states before/after, the action, and the duration;
`status: "error"` carries a `stage` and a sanitised message. A webhook failure is
logged locally and does not affect control.

**Logs.** Workers Logs persist by default, so redaction is a correctness
requirement. A run logs its start, the observed traffic, the observed and desired
states, the chosen action, and the duration. Secrets never appear.

**Dashboard.** Served from the same Worker at `/`, authenticated. Read-only with
respect to ECS control: it reports what the system sees and decided, never a way to
make it act.

## 7. Cloudflare plan requirement

**Measured figure: pending a first deployment.**

The requirement is derived from measured CPU per scheduled invocation, not
asserted, because the plan's CPU limit is the binding constraint:

| Plan | Cron CPU per invocation | Consequence |
| --- | --- | --- |
| Workers Free | **10 ms** | A run exceeding it may be terminated mid-flight. |
| Workers Paid | 30 s (< 1 hour interval) | Ample headroom. |

Network waiting — the CDT call, the ECS call, the D1 write, the webhook — does
**not** consume CPU. What does is JSON parsing, redaction, and rendering.

**How to derive it:** after RELEASE, read the Cron invocation's `cpuTime` from
Workers observability and record it here. The owner's decision is to remain on
**Free** initially and upgrade only if the measured figure requires it (PLAN Q4,
resolved 2026-09-22).

A terminated run issues **no** mutation, so it aborts safely — but it also reports
nothing, which is why the figure must be recorded rather than assumed.

## 8. Operating notes

- **Retention.** `traffic_checks` rows are retained indefinitely; there is no
  automatic deletion (PLAN Q5, resolved 2026-09-22). At a 10-minute cadence that is
  ~144 rows/day. Pruning, if ever needed, is a manual operation.
- **A D1 failure never affects control.** History is written after any action has
  been applied; a storage failure degrades the record only, and is surfaced in the
  webhook payload.
- **Changing the cadence** is a one-line edit to `PRODUCTION_CRONS` in
  `scripts/resolve-deploy-config.mjs`, followed by a RELEASE. The committed
  `wrangler.jsonc` still declares `*/10 * * * *` as the documented intent.
- **The Cron Trigger is the only ECS mutation authority.** No HTTP route can start,
  stop, or reboot an instance. `POST /api/query` is read-only by construction: its
  dependencies expose no mutation seam.
- **A re-deployment of an existing Worker** uses RELEASE. `wrangler versions upload`
  is the natural starting point for a future safer update workflow, because the
  Worker now exists; **no such workflow is implemented yet**, and this document does
  not claim one exists.

## 9. References

PLAN §14 (deployment model), §11 (risks), Q4/Q5 (resolved). SPEC §2
(configuration), §6.4 (stop semantics), §8 (HTTP surface), §9 (D1), §11 (runtime
constraints). `docs/security/ram-policy.md`, `docs/operations/assumptions-register.md`.
Cloudflare: [Deployment
management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/)
(the first-upload constraint), [Cron
Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
(empty array removes triggers), [Version
URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/).