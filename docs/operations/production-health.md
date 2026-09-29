# Production health monitoring

The `Production health` GitHub Actions workflow probes the public
`https://cdt.q9m3.com/health` endpoint hourly at minute 17 UTC and supports a
manual `workflow_dispatch`. The HTTP probe has a 10-second per-attempt timeout,
makes up to three attempts with a short backoff, and accepts only HTTP 200 with
the JSON contract `{ "status": "ok", "service": "cfworker4alicdt" }`.

The same run independently probes
`https://cdt.q9m3.com/api/monitor/cron` with the optional GitHub Actions secret
`MONITOR_READ_TOKEN`. That endpoint requires `Authorization: Bearer …`, reads a
bounded projection of D1 `traffic_checks` history, returns `Cache-Control:
no-store`, and exposes only timestamps, status counts, and a sanitized failure
classification. It has no ECS start or stop capability. It never accepts URL
query credentials. `ADMIN_TOKEN` does not authorize this route.

`MONITOR_READ_TOKEN` is intentionally optional in Wrangler's `secrets.required`
list and in the Worker secret-name deployment check. Until an owner installs the
same dedicated value as a Worker Secret and a GitHub Actions Secret, the Cron
probe records `UNKNOWN` with telemetry unavailable. The HTTP `/health` probe
still runs. Missing or invalid monitor credentials do not make the HTTP probe
fail.

Each run writes `production-health-result.json` and uploads it as an Actions
artifact retained for 30 days. The summary and artifact record HTTP and Cron
health in separate fields. The GitHub Actions job fails for an HTTP health
failure. Cron failures and unavailable telemetry create or update their own
Issue, while an HTTP success leaves the Cron Issue unchanged. An HTTP incident
uses `[production-health] cdt.q9m3.com`; a Cron incident uses
`[production-cron] cdt.q9m3.com`. Recovery searches and closes only the matching
component's title, so recovery of one signal cannot close the other component's
incident. The workflow uses GitHub's token for Issue operations only and has no
Worker deployment credentials.

The Cron Issue is incident-centric: an unhealthy, unknown, or unavailable Cron
signal is tracked in GitHub without failing the job when HTTP is healthy. Empty
D1 history is `UNKNOWN` with `telemetry_available: true`; it is not proof that
Cron never ran. A D1 read failure is `UNKNOWN` with
`telemetry_available: false` and a sanitized telemetry error classification.

## Cron health classification

The endpoint uses a 25-minute freshness threshold for the existing `*/10`
schedule and summarizes at most 200 rows across a 24-hour lookback. Invalid or
future timestamps are ignored. Its health policy is:

- A latest success within 25 minutes and no failures in the 24-hour lookback is
  `HEALTHY`.
- A latest error within 25 minutes is `DEGRADED`; a latest error older than 25
  minutes is `UNHEALTHY`.
- Recent activity with an unknown status is `DEGRADED` while the latest activity
  and last success are no more than 50 minutes old.
- No success for more than 50 minutes is `UNHEALTHY`, including when recent
  executions are failing.
- A stale success is `DEGRADED` from 25 through 50 minutes, then `UNHEALTHY`.
- Empty or unusable history is `UNKNOWN`; a failed D1 read is also `UNKNOWN` but
  has `telemetry_available: false`.

The failure classification is an allowlisted mapping of `error_stage` values.
Raw `error_message`, instance identifiers, traffic figures, D1 rows, response
bodies, and secret values are not returned or copied into the artifact, summary,
or incidents.

## What HTTP `/health` measures

HTTP `/health` remains public, inert liveness. Its response is unchanged and
contains no Cron fields. It performs no D1, Alibaba, ECS, or configuration read.
HTTP success never claims that Cron or ECS is healthy. The authenticated Cron
endpoint is a separate signal backed only by D1 history; it does not establish
ECS health.

## Owner authorization

Cron observability is not operational until an owner completes the steps in the
[Cron monitor owner authorization packet](../release/cron-monitor-owner-authorization.md).
The packet covers installing the dedicated Worker and Actions secrets, using
the existing `update.yml` owner-gated deployment, and verifying the Cron fields
through `workflow_dispatch`. The monitoring token has no admin or ECS mutation
authority.
