# CFWorker4AliCDT

CFWorker4AliCDT is a Cloudflare Worker that checks Alibaba Cloud CDT internet traffic and, on its scheduled path, may start or stop one configured ECS instance when a threshold decision calls for it. D1 stores monitoring history; it does not decide control behavior.

## Current product

A Cron Trigger runs the control pipeline every 10 minutes:

1. Read CDT traffic and describe the configured ECS instance.
2. Decide from validated traffic, the configured threshold, and the observed instance state.
3. Make at most one StartInstance or StopInstance call when the decision requires it.
4. Attempt the configured webhook notification, if enabled, and record the run in D1.

If traffic or ECS state cannot be established, the pipeline fails closed and does not mutate the instance. An unavailable or invalid traffic value is never treated as zero. HTTP handlers do not call this scheduled pipeline.

Traffic values labeled GB use a 1024³ byte divisor to match the CDT console convention.

## Safety boundaries

- The scheduled Cron pipeline is the only ECS mutation authority.
- POST /api/query performs live reads and returns the decision the scheduled logic would make. It has no StartInstance or StopInstance dependency.
- D1 is observation history. A D1 failure does not supply a control decision.
- GET /health is public liveness only. It does not prove Cron or ECS health.
- GET /api/monitor/cron reads sanitized D1 telemetry and requires its own MONITOR_READ_TOKEN Bearer credential. ADMIN_TOKEN does not authorize it.
- Manual donor notification tests can send external messages only when explicitly enabled and configured. They never control ECS.

See [security invariants](docs/security/invariants.md) for the security boundaries and [the API guide](docs/operations/api.md) for every route and donor action.

## Repository, GitHub Release, and production are separate

Repository HEAD can move as commits merge. A GitHub Release is a tag and notes for a source revision; creating it does not dispatch release.yml or deploy a Cloudflare Worker. Production runs whichever Worker version was last deployed through the owner-gated Cloudflare workflow.

Therefore repo HEAD, the GitHub Release tag, and the production Worker may identify different revisions. The README avoids fixed production SHAs because they become stale. Use the dated [v0.1.0 governance evidence snapshot](docs/release/v0.1.0-documentation-governance.md) as the recorded production reference, then verify the live Worker version in Cloudflare and its last UPDATE run before operational decisions.

## HTTP surface

Protected routes use HTTP Basic authentication: username ADMIN_USER (default admin) and password ADMIN_TOKEN.

| Method     | Path                 | Authentication            | Behavior                                                                                                       |
| ---------- | -------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| GET        | /health              | Public                    | Static liveness JSON only.                                                                                     |
| GET        | /                    | Basic                     | Authenticated dashboard HTML.                                                                                  |
| GET        | /api/history         | Basic                     | Bounded D1 run history, newest first.                                                                          |
| POST       | /api/query           | Basic                     | Live read-only CDT/ECS query and decision. Always reports mutation: false.                                     |
| GET        | /api/monitor/cron    | Bearer MONITOR_READ_TOKEN | Sanitized, bounded Cron telemetry from D1; no ECS read or mutation.                                            |
| GET / HEAD | Static bundle assets | Public                    | Only the fixed CSS, JavaScript bundles, icon, and input stylesheet used to render the authenticated dashboard. |

With valid authentication, wrong methods on known routes return 405 and unknown paths return 404. Protected namespaces authenticate before route lookup, so an unauthenticated request there can receive 401 first. The monitor endpoint never accepts query-string credentials. Its full response and status behavior is in [the API guide](docs/operations/api.md).

The donor UI uses /?action=... compatibility responses. Some actions map to read-only data, notification sends are gated, and unsupported actions return honest 501 responses with mutation: false. This is not full donor backend parity; see the [donor action table](docs/operations/api.md#donor-actions).

## Deferred owner decisions

Issues [#90–#93](docs/release/p7-owner-gates-90-93.md) remain open and deferred:

- #90: multi-account support.
- #91: manual Start/Stop controls.
- #92: daily schedule control.
- #93: keep-alive behavior.

These features are not active in this Worker. Cron remains the only ECS mutation authority.

## Operator guides

- [Deployment](docs/operations/deployment.md): first deployment, updates, GitHub Release distinction, verification, and monitor token installation.
- [Configuration](docs/operations/configuration.md): runtime variables, Worker Secrets, GitHub settings, and feature gates.
- [Usage](docs/operations/usage.md): operator checks for health, console, query, history, and Cron telemetry.
- [API](docs/operations/api.md): route authentication, responses, status codes, and donor action coverage.
- [Monitoring](docs/operations/monitoring.md): HTTP and Cron probes, health states, incidents, and limits.
- [Security invariants](docs/security/invariants.md): fail-closed control, auth boundaries, and secret handling.
- [RAM policy](docs/security/ram-policy.md): least-privilege Alibaba permissions.
- [Documentation governance](docs/release/v0.1.0-documentation-governance.md): audited inventory, consistency matrix, and dated production evidence.
- [Third-party notices](THIRD_PARTY_NOTICES.md): donor provenance and bundled asset licenses.

Historical plans, review packets, and owner decision records remain available under [planning](docs/planning/project-plan.md) and [release](docs/release/p7-owner-gates-90-93.md). They preserve their original context; current behavior is described by code, tests, and the operator guides above.

## Development

    npm ci
    npm run validate

npm run validate runs formatting checks, lint, typecheck, tests, and a Wrangler deploy dry-run. The .github/workflows/ci.yml workflow runs offline tests and has no production credentials or deploy step. The lightweight documentation consistency checks run as part of npm test.
