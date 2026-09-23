# Deployment and operations

Deployment is **manual and owner-gated**. No CI job deploys, and no live ECS
mutation occurs without explicit owner approval.

> **No credential value is ever printed, echoed, pasted into an issue, written to
> a log, or committed.** Every command below either prompts for a value or
> references one by name. If you find yourself typing a secret as a command
> argument, stop — the argument is recorded in shell history.

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

There are two paths. Use the **manual local** path for a first deployment, so every
step is visible. Use the **gated workflow** once the environment is configured.

### 3a. Manual local deployment

```sh
npm ci
npm run validate          # format, lint, typecheck, test, dry-run
npx wrangler d1 migrations apply TRAFFIC_DB --remote
npx wrangler deploy
```

`npm run validate` runs the same five checks as CI, in the same order, in one
invocation — so it cannot be left half-run.

The migration step is ordered before the deploy so the schema exists before a
Worker version that writes to it is live.

### 3b. Gated workflow (`.github/workflows/deploy.yml`)

Three properties are enforced by the workflow file itself:

1. **No pull request can trigger it.** Only `workflow_dispatch`. PR CI is a
   separate workflow that holds no credentials and performs no deployment, so a PR
   cannot reach production secrets even indirectly.
2. **A human gate stands in front of it.** The job targets the `production` GitHub
   Environment. **Configuring that environment with required reviewers is an owner
   action** — see §3c. Without it the workflow still requires a manual dispatch and
   a typed confirmation, but there is no approval step.
3. **The migration runs before the Worker**, because the schema must exist before a
   Worker version that writes to it is live.

It also requires a typed `DEPLOY` confirmation, so a mis-click cannot reach
production.

### 3c. Configuring the protected environment (owner action, one time)

The workflow cannot assert these; they are GitHub settings.

1. **Settings → Environments → New environment**, named exactly `production`.
2. Enable **Required reviewers** and add the owner. This is the gate that makes an
   unattended deploy impossible.
3. Optionally restrict **Deployment branches** to `main`.
4. Add the following to that environment (or to repository settings):

   | Name | Kind | Value |
   | --- | --- | --- |
   | `D1_DATABASE_ID` | **Variable** | The remote `TRAFFIC_DB` UUID |
   | `CLOUDFLARE_API_TOKEN` | Secret | A token scoped to Workers + D1 |
   | `CLOUDFLARE_ACCOUNT_ID` | Secret | The account identifier |

`D1_DATABASE_ID` is a **variable, not a secret**: it is an identifier rather than a
credential, and treating it as a secret would make it harder to audit without making
it safer. It is nonetheless never committed — `scripts/resolve-deploy-config.mjs`
injects it into a generated config at deploy time and fails loudly if it is unset.

**The committed `wrangler.jsonc` is never modified by the deploy process.** It
declares the `TRAFFIC_DB` binding with no `database_id`, which keeps the repository
free of production configuration.

## 4. `StopCharging` implications — read before changing `STOPPED_MODE`

The default is **`KeepCharging`**. Changing it trades restart reliability and
public-address preservation for compute cost. Both risks below are **silent**: the
API returns no error, and both are discovered only at restart, which is the worst
possible moment.

### Restart-capacity risk

`StopCharging` releases compute resources. A later `StartInstance` then depends on
capacity being available for that instance type in that zone. The failure mode is
`OperationDenied.NoStock`, which under this design surfaces as
`stage: "ecs-start"` with the instance **left stopped** — traffic enforcement
succeeded, but automatic recovery did not.

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

## 6. First run and verification

The full procedure is in the assumptions register, §4. Summary:

1. Trigger one scheduled run and read the **webhook payload**.
2. A `stage: "cdt-query"` error means the endpoint (A1) or the signature method
   (A2) is wrong — **not** that traffic is zero. If the error is a signature
   rejection, try `SIGNATURE_VERSION=v2` before investigating further.
3. Compare `trafficGB` against the Alibaba console for the same period. Treat it
   as **unverified** until it matches.
4. Confirm `ecsStatusBefore` matches the console.
5. With traffic below the threshold, confirm the run is a `none-*` no-op and the
   instance is untouched.
6. Only then treat enforcement as authoritative.

### Reading the output

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

**How to derive it:** on the first deployment, read the Cron invocation's
`cpuTime` from Workers observability and record it here. The owner's decision is to
remain on **Free** initially and upgrade only if the measured figure requires it
(PLAN Q4, resolved 2026-09-22).

A terminated run issues **no** mutation, so it aborts safely — but it also reports
nothing, which is why the figure must be recorded rather than assumed.

## 8. Operating notes

- **Retention.** `traffic_checks` rows are retained indefinitely; there is no
  automatic deletion (PLAN Q5, resolved 2026-09-22). At a 10-minute cadence that is
  ~144 rows/day. Pruning, if ever needed, is a manual operation.
- **A D1 failure never affects control.** History is written after any action has
  been applied; a storage failure degrades the record only, and is surfaced in the
  webhook payload.
- **Changing the cadence** is a one-line edit to the `crons` entry in
  `wrangler.jsonc`.
- **The Cron Trigger is the only ECS mutation authority.** No HTTP route can start,
  stop, or reboot an instance. `POST /api/query` is read-only by construction: its
  dependencies expose no mutation seam.

## 9. References

PLAN §14 (deployment model), §11 (risks), Q4/Q5 (resolved). SPEC §2
(configuration), §6.4 (stop semantics), §8 (HTTP surface), §9 (D1), §11 (runtime
constraints). `docs/security/ram-policy.md`, `docs/operations/assumptions-register.md`.