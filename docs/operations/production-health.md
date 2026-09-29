# Production HTTP health monitoring

The `Production HTTP health` GitHub Actions workflow probes the public
`https://cdt.q9m3.com/health` endpoint hourly at minute 17 UTC and supports a
manual `workflow_dispatch`. The probe has a 10-second per-attempt timeout, makes
up to three attempts with a short backoff, and accepts only HTTP 200 with the
JSON contract `{ "status": "ok", "service": "cfworker4alicdt" }`.

Each run writes `production-health-result.json` and uploads it as an Actions
artifact retained for at least 30 days. The step summary reports the timestamp,
HTTP status, latency, attempts, result, and failure reason when present. A
confirmed failure creates an incident issue or comments on the existing open
issue titled `[production-health] cdt.q9m3.com`; a recovery comments on and
closes the open issue. Workflow concurrency serializes scheduled and manually
started runs so they share one incident identity.

The workflow has no production deploy credentials and does not perform Worker,
Cron, ECS, or Alibaba mutations. It uses the GitHub token only for Issue
operations. Probe output and Issue text exclude response bodies and redact
credential-shaped values.

## What the probe measures

HTTP `/health` success is **not** Cron health and is **not** ECS health. It proves
only that the public Worker endpoint returned the expected HTTP response and
JSON fields. `cron_health` is hardcoded to `UNKNOWN` until secure Cron telemetry
exists. ECS health is not measured by this workflow.

The public `/health` response has no Cron fields. The donor `get_logs` operation
is authenticated with `ADMIN_TOKEN` in `src/web/router.ts`, and Cloudflare does
not expose Cron trigger history to an Actions token without Cloudflare
credentials. There is no public Cron health signal today.

Future owner-gated, read-only options (not implemented by this workflow):

1. An owner-authorized `ADMIN_TOKEN` or dedicated read-only monitor token in a
   locked GitHub Environment, then call donor `get_logs` / history. This needs
   separate owner authorization.
2. A Cloudflare API token with Workers Scripts Read and Observability read
   permissions to inspect Cron trigger history. This needs a new secret and
   separate owner authorization.
3. Public signal: none exists today.

Until one of those telemetry paths is separately reviewed and authorized,
`CRON_HEALTH=UNKNOWN` remains the only valid Cron health value in this workflow.
