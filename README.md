# CFWorker4AliCDT

A single stateless Cloudflare Worker that enforces an Alibaba Cloud CDT traffic
threshold by starting and stopping **one** ECS instance.

> **Status: pre-deployment.** No Worker has been deployed and no live Alibaba Cloud
> call has been made. Several load-bearing facts cannot be verified without a
> first deployment; they are recorded as assumptions in
> [`docs/operations/assumptions-register.md`](docs/operations/assumptions-register.md)
> rather than presented as documented behaviour.

## Why this exists

An ECS instance relays traffic billed under Cloudflare Data Transfer (CDT). When
monthly internet traffic reaches an allowance, continued operation risks unexpected
spend. Managing that by hand fails in both directions: traffic can cross the
threshold while nobody is watching, or an operator can misread a dashboard and
leave the instance in the wrong state.

Existing community scripts solve the happy path but share one specific defect: when
the traffic response is missing or malformed, they coerce it to `0`, conclude "under
threshold", and leave the instance running. They also tend to expose unauthenticated
control endpoints and issue unsolicited reboots. Those behaviours are recorded here
as **anti-requirements** so they are not reintroduced.

## What it does

Every 10 minutes, on a Cron Trigger:

1. Query CDT internet traffic.
2. Describe the managed instance.
3. Decide the desired state from a threshold rule.
4. Perform **at most one** mutation, and only if the desired state differs from the
   observed one.
5. Report the outcome to a webhook.
6. Record the outcome in D1 as monitoring history.

## The central invariant

> **Inability to establish the traffic value is never evidence that the traffic
> value is zero.**

In plain language: **if traffic cannot be determined, nothing is started or stopped.**
The instance is left exactly as found, and an error is reported.

This is deliberately asymmetric. A false abort costs one monitoring interval. A
false "under threshold" costs money and cannot be undone retroactively. Everything
below follows from that asymmetry.

## Fail-closed behaviour, concretely

Every one of these aborts the run **before any ECS call**:

- the traffic response is missing, empty, malformed, or not an array
- a traffic value is absent, `null`, `""`, non-numeric, `NaN`, infinite, or negative
- the API returns an error code, or the transport fails
- the instance is absent from the describe response
- the observed instance state is transitional or unrecognised in a direction with no
  safe transition

An empty `TrafficDetails` array is treated as **invalid, not as zero**. Zero traffic
and unavailable traffic are different facts, and only one of them is safe to infer.

## Safety posture

- **No public control endpoint.** The Cron Trigger is the only path that can start or
  stop an instance. There is no route that can reboot, start, or stop anything.
- **One instance.** No multi-instance or multi-region management.
- **At most one mutation per run**, enforced structurally rather than by convention.
- **No force-stop.** `ForceStop` is `false` and not configurable; force-stopping risks
  filesystem corruption.
- **Secrets never appear** in logs, webhook payloads, D1 rows, rendered HTML, or
  error strings. Redaction is a single boundary, not a per-call-site habit.
- **The dashboard and API are authenticated**; the only public route is `GET /health`,
  which performs no privileged work.

## Configuration

Five secrets (set via `wrangler secret put`; never committed):

| Secret                     | Notes                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| `ALIYUN_ACCESS_KEY_ID`     | From the least-privilege RAM user.                                         |
| `ALIYUN_ACCESS_KEY_SECRET` | Its paired secret.                                                         |
| `WEBHOOK_URL`              | Absolute `https://` URL. Validated at config time.                         |
| `WEBHOOK_TOKEN`            | Optional. Sent as `Authorization: Bearer <token>`.                         |
| `ADMIN_TOKEN`              | Required for the dashboard and API. Absent ⇒ every protected route denies. |

Seven plain variables (`wrangler.jsonc`):

| Variable               | Default            | Notes                                            |
| ---------------------- | ------------------ | ------------------------------------------------ |
| `REGION_ID`            | —                  | ECS region.                                      |
| `ECS_INSTANCE_ID`      | —                  | The single managed instance.                     |
| `TRAFFIC_THRESHOLD_GB` | `180`              | **Decimal** GB. See below.                       |
| `CDT_ENDPOINT`         | `cdt.aliyuncs.com` | Configurable because the hostname is unverified. |
| `BUSINESS_REGION_ID`   | unset              | When set, applied as a server-side CDT filter.   |
| `SIGNATURE_VERSION`    | `v3`               | `v2` or `v3`.                                    |
| `STOPPED_MODE`         | `KeepCharging`     | See the deployment doc before changing.          |

## The decimal-GB divergence — read this if migrating

The threshold is in **decimal gigabytes** (`10^9` bytes), not binary (`1024^3`).

**180 GB decimal equals 167.6 GiB**, so enforcement trips **earlier** for the same
byte count than the originating script and both reference implementations. This
divergence is intentional and documented rather than silently inherited.

## HTTP surface

| Method | Path           | Auth     | Behaviour                                                                |
| ------ | -------------- | -------- | ------------------------------------------------------------------------ |
| `GET`  | `/health`      | Public   | Liveness only. No Alibaba call, no D1 read, no configuration disclosed.  |
| `GET`  | `/`            | Required | Server-rendered dashboard.                                               |
| `GET`  | `/api/history` | Required | Bounded monitoring history, newest first.                                |
| `POST` | `/api/query`   | Required | Live **read-only** query: what the system sees and what it would decide. |

Every other path returns `404`; a known path with the wrong method returns `405`.

`POST /api/query` deliberately stops one step before acting. It is read-only **by
construction** — its dependencies expose no mutation seam at all — so it cannot
become a second mutation authority.

## Documentation

| Document                                                                             | Contents                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [`docs/planning/project-plan.md`](docs/planning/project-plan.md)                     | Approved plan: scope, risks, phases.                                   |
| [`docs/planning/project-spec.md`](docs/planning/project-spec.md)                     | Normative behaviour and acceptance criteria.                           |
| [`docs/architecture/overview.md`](docs/architecture/overview.md)                     | Component boundaries and the run pipeline.                             |
| [`docs/security/ram-policy.md`](docs/security/ram-policy.md)                         | The least-privilege policy and credential procedure.                   |
| [`docs/operations/deployment.md`](docs/operations/deployment.md)                     | Deployment, operations, `StopCharging` implications, plan requirement. |
| [`docs/operations/assumptions-register.md`](docs/operations/assumptions-register.md) | Every unverified claim, how to verify it, and the impact if wrong.     |

## Development

```sh
npm ci
npm run validate    # format, lint, typecheck, test, and a deploy dry-run, in CI order
```

No test performs a live Alibaba Cloud call, and no test requires network access. All
network I/O is mocked, and CI holds no credentials and performs no deployment.
