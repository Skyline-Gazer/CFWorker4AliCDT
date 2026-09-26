# CFWorker4AliCDT

A Cloudflare Worker that enforces an Alibaba Cloud CDT traffic threshold by
starting and stopping **one** ECS instance. It is control-stateless: D1 stores
monitoring history, but no control decision depends on that history.

> **Status: pre-deployment.** No Worker has been deployed and no live Alibaba Cloud
> call has been made. Several load-bearing facts cannot be verified without a
> first deployment; they are recorded as assumptions in
> [`docs/operations/assumptions-register.md`](docs/operations/assumptions-register.md)
> rather than presented as documented behaviour.

## P7 Web Console donor follow-up

Corrective donor UI integration is tracked under Epic #77. The historical
server-rendered P7 acceptance remains in place: Issue #39 remains CLOSED and
Issue #47 remains Done. Refs #78 #80 cover donor provenance and the API
compatibility inventory; they do not revise that acceptance as a failure. The
compatibility matrix is in
[`docs/planning/p7-donor-api-compatibility.md`](docs/planning/p7-donor-api-compatibility.md),
and provenance is recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
This documentation work does not copy donor static assets, add adapters, or
dispatch production PRE-FLIGHT/RELEASE.

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
5. If the optional webhook is configured, send one report for the run.
6. Record the outcome in D1 as monitoring history, whether or not a webhook is configured.

## The central invariant

> **Inability to establish the traffic value is never evidence that the traffic
> value is zero.**

In plain language: **if traffic cannot be determined, nothing is started or stopped.**
The instance is left exactly as found. The error is recorded in D1 and sent to the
webhook when that optional notification endpoint is configured.

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

## Deployment

Pre-deployment, and **two-stage** by design. The short version:

```
PRE-FLIGHT  →  first deploy, Cron explicitly disabled (triggers.crons = [])
            →  Version URL
            →  live READ-ONLY verification of R2/R3/R4 via POST /api/query
            →  owner confirms
RELEASE     →  separate, approved dispatch: stable HTTP endpoint + Cron */10 * * * *
```

The split exists because enabling Cron before the traffic unit has been checked
would let the system act on a _valid but incorrect_ threshold comparison — the one
failure the fail-closed design cannot detect. `wrangler versions upload` cannot be
used for the first upload of a new Worker, so the bootstrap is a real `wrangler
deploy` whose config declares no Cron Trigger.

HTTP exposure is an explicit owner choice (`workers_dev` or `custom_domain`), with
no default; the committed config exposes no stable endpoint. Full procedure:
[`docs/operations/deployment.md`](docs/operations/deployment.md).

Required RELEASE secrets and optional notification secrets (set via
`wrangler secret put`; never committed):

| Secret                     | Requirement         | Notes                                                                                              |
| -------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `ALIYUN_ACCESS_KEY_ID`     | Required            | From the least-privilege RAM user.                                                                 |
| `ALIYUN_ACCESS_KEY_SECRET` | Required            | Its paired secret.                                                                                 |
| `ADMIN_TOKEN`              | Required by RELEASE | Dashboard and API credential. Absent ⇒ every protected route denies.                               |
| `WEBHOOK_URL`              | Optional            | If set, must be an absolute `https://` URL and enables one notification attempt per scheduled run. |
| `WEBHOOK_TOKEN`            | Optional with URL   | Sent as `Authorization: Bearer <token>`. A token without `WEBHOOK_URL` is a config error.          |

The Worker runs scheduled control and records history without webhook secrets. The
webhook is observational when enabled; its failures cannot affect ECS control.

Seven plain variables, as three distinct classes — see
[`docs/operations/deployment.md`](docs/operations/deployment.md) §1a:

- **Required application variables (repository variables, not secrets):**
  `REGION_ID`, `ECS_INSTANCE_ID`. The resolver refuses to generate a deployment
  config without them, because a deploy that omitted them would succeed and then
  fail `loadConfig()` on every request.
- **Optional application overrides (repository variables):** `TRAFFIC_THRESHOLD_GB`
  (`180`), `CDT_ENDPOINT` (`cdt.aliyuncs.com`), `BUSINESS_REGION_ID` (unset),
  `SIGNATURE_VERSION` (`v3`), `STOPPED_MODE` (`KeepCharging`). Unset, the committed
  `wrangler.jsonc` default is preserved.

| Variable               | Default            | Notes                                                   |
| ---------------------- | ------------------ | ------------------------------------------------------- |
| `REGION_ID`            | **required**       | ECS region.                                             |
| `ECS_INSTANCE_ID`      | **required**       | The single managed instance.                            |
| `TRAFFIC_THRESHOLD_GB` | `180`              | Console-aligned GB, calculated with a `1024^3` divisor. |
| `CDT_ENDPOINT`         | `cdt.aliyuncs.com` | Configurable because the hostname is unverified.        |
| `BUSINESS_REGION_ID`   | unset              | When set, applied as a server-side CDT filter.          |
| `SIGNATURE_VERSION`    | `v3`               | `v2` or `v3`.                                           |
| `STOPPED_MODE`         | `KeepCharging`     | See the deployment doc before changing.                 |

Deployment-only values (`D1_DATABASE_ID`, `HTTP_EXPOSURE_MODE`,
`WORKER_CUSTOM_DOMAIN`) are a separate class and are not Worker runtime variables.

## Traffic GB matches the CDT console

The public traffic and threshold labels remain `GB` to align with Alibaba CDT.
Convert raw Traffic bytes as `trafficGB = trafficBytes / 1024^3` (divisor
`1,073,741,824`), not SI decimal `10^9`. Owner-provided live evidence: `27,858,630`
bytes is approximately `0.02594537 GB` by this calculation, matching the CDT
console's `0.02595 GB` display. The default `TRAFFIC_THRESHOLD_GB` remains `180`;
the threshold is not adjusted to compensate for this conversion.

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
