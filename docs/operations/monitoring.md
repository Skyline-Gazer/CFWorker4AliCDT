# Production monitoring

The production-health workflow independently probes public HTTP liveness and authenticated Cron telemetry. It runs hourly at minute 17 UTC and supports manual dispatch. The workflow is named production-health.yml.

## Signals and limits

| Signal      | Source                          | What it proves                                                                                                                        |
| ----------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP health | GET /health                     | The Worker answers the static liveness request with the expected JSON. It does not read configuration, D1, CDT, Cron history, or ECS. |
| Cron health | GET /api/monitor/cron           | A bounded, sanitized summary of recent D1 scheduled-run history, authenticated with MONITOR_READ_TOKEN.                               |
| ECS health  | Not established by these probes | Neither probe calls DescribeInstances. Use the authenticated read-only query when an operator needs a live ECS observation.           |

The Cron endpoint reads up to 200 newest D1 rows and summarizes a 24-hour lookback. It returns timestamps, status counts, and an allowlisted failure classification. It does not return raw error text, traffic values, instance identifiers, or ECS status. Responses use Cache-Control: no-store. Missing D1 or a failed D1 query produces UNKNOWN telemetry rather than a healthy result.

## Cron health classification

The freshness threshold is 25 minutes for the configured */10 schedule. The lookback is 1,440 minutes. Invalid and future timestamps are ignored.

- HEALTHY requires the latest row to be a success within 25 minutes and no error or unknown-status rows in the 24-hour lookback.
- A recent error or an unknown-status row in the lookback prevents HEALTHY; with recent successful activity the result follows the DEGRADED path.
- A latest error within 25 minutes is DEGRADED while the last success is no more than 50 minutes old. A latest error older than 25 minutes is UNHEALTHY.
- No success for more than 50 minutes is UNHEALTHY regardless of recent error or unknown rows; this rule takes precedence over other recent-activity classifications.
- A stale success is DEGRADED after 25 minutes and until it is more than 50 minutes old.
- Empty or unusable history is UNKNOWN with telemetry_available: true. An unavailable D1 binding or failed read is UNKNOWN with telemetry_available: false.

An unknown row is not silently ignored: unknown status in the lookback means the monitor cannot report HEALTHY. The current Cron implementation and tests are in src/storage/cron-monitor.ts and test/storage/cron-monitor.test.ts.

## Workflow and incidents

production-health.yml probes HTTP and Cron independently, using 10-second attempts, up to three attempts, and a short backoff. The probe writes production-health-result.json and uploads it as a 30-day artifact.

- HTTP failure fails the workflow job and updates the [production-health] component incident.
- Cron DEGRADED, UNHEALTHY, UNKNOWN, or unavailable telemetry creates or updates a separate [production-cron] incident. A Cron-only incident does not fail the job when HTTP is healthy.
- Incident synchronization is component-specific and uses the matching issue title, so HTTP recovery cannot close a Cron issue and Cron recovery cannot close an HTTP issue.
- A healthy HTTP result leaves the Cron incident unchanged; it does not imply Cron recovered.

The workflow has GitHub issue permissions only. It has no Cloudflare deploy credentials and does not mutate the Worker.

## Install the monitor credential

The Worker endpoint requires MONITOR_READ_TOKEN as an Authorization: Bearer credential. GitHub Actions also needs a secret with the same value for the scheduled probe. This credential is independent of ADMIN_TOKEN; Basic credentials never authorize the monitor route.

To install or rotate the token, follow [configuration](configuration.md#installing-or-rotating-monitor_read_token) and [deployment](deployment.md#installing-or-rotating-the-cron-monitor-token). The install workflow writes the value to the Worker over stdin, checks only that the name exists, and does not deploy application code.

## Troubleshooting without ECS mutations

1. Check the workflow summary and its production-health-result artifact for the two independent signal results.
2. If HTTP failed, check route exposure and the Worker deployment/version in Cloudflare, then inspect the corresponding Actions run.
3. If Cron is UNKNOWN, confirm the GitHub Actions secret and Worker Secret names are configured and that D1 telemetry is available. Empty history is UNKNOWN, not proof that the schedule never ran.
4. If Cron is DEGRADED or UNHEALTHY, inspect the sanitized failure classification and recent run timestamps, then review Workers observability and D1 availability.
5. If an operator needs to verify current ECS state, use the authenticated POST /api/query read-only route. Do not start or stop an instance to test monitoring.

See [API](api.md) for route authentication and [usage](usage.md) for operator probes.
