# Cron monitor owner authorization packet

## Status

The read-only Cron monitor is implemented in code, but is **not operational**
until an owner installs the dedicated token, deploys the merged Worker code, and
verifies a production-health run. Current implementation status:

- `PRODUCTION_DEPLOYED=NO`
- No Worker Secret or GitHub Actions Secret value has been changed by this work.
- No UPDATE, RELEASE, or PRE-FLIGHT workflow has been dispatched.

This packet authorizes no action by itself. An owner can use it to authorize the
following production steps after reviewing the merged code and repository state.

## Owner steps

1. **Generate a dedicated token.** Create a high-entropy random value in an
   approved password manager or secret-generation tool. Do not reuse
   `ADMIN_TOKEN`, an Alibaba credential, or any other credential. Do not include
   the value in an Issue, terminal command argument, log, artifact, summary,
   document, or commit.
2. **Install the Worker Secret.** For the production Worker, install the value
   under the exact name `MONITOR_READ_TOKEN` using the Cloudflare secret UI or
   the interactive `wrangler secret put MONITOR_READ_TOKEN` command. Keep the
   value out of shell history and logs.
3. **Install the GitHub Actions Secret.** In the repository's Actions secrets,
   create a secret named `MONITOR_READ_TOKEN` with the same value. The production
   health workflow passes it only through the probe step's environment; it does
   not print or persist the value.
4. **Deploy the merged Worker HEAD through UPDATE.** From `main`, manually
   dispatch `.github/workflows/update.yml` with `confirmation=UPDATE`,
   `EXISTING_WORKER_CONFIRMED=YES`, and `HTTP_EXPOSURE_MODE=custom_domain` to
   preserve the production custom domain and the existing `*/10 * * * *` Cron
   schedule. The UPDATE workflow applies pending D1 migrations before deploying
   and verifies the required Worker Secret names. `MONITOR_READ_TOKEN` remains
   optional in deploy validation, so the owner must confirm its installation
   separately.
5. **Verify Cron telemetry.** After UPDATE succeeds, manually dispatch
   `.github/workflows/production-health.yml`. Inspect the
   `production-health-result.json` artifact and confirm HTTP and Cron fields are
   independent, `cron_telemetry_available` is `true`, and `cron_health` matches
   the D1 history. Confirm the summary and any incidents contain no credential
   value. If the response is `UNKNOWN` with unavailable telemetry, check the
   Worker Secret installation and endpoint response before treating the monitor
   as operational.

## Authority boundary

`MONITOR_READ_TOKEN` authorizes only `GET /api/monitor/cron` using Bearer
authentication. The route does not accept Basic auth, does not accept
`ADMIN_TOKEN`, and rejects token-like URL query parameters. Its data source is a
bounded, read-only D1 query selecting only timestamps, statuses, and sanitized
failure stages. The route dependencies expose no ECS start or stop operation.
The token has **no admin or ECS mutation authority**.

Public HTTP `/health` remains unchanged and reports inert Worker liveness only.
It does not imply Cron success. Cron issues are tracked independently from HTTP
health issues, and a Cron-only failure does not fail the Actions job when HTTP
health succeeds.
