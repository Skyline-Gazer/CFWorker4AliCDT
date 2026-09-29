# Configuration

This guide separates Worker runtime bindings from GitHub deployment settings. Runtime values come from wrangler.jsonc and the generated deployment configs; deploy-only credentials and inputs are not application configuration.

## Worker runtime bindings

### Required Worker Secrets

| Name                     | Purpose                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| ALIYUN_ACCESS_KEY_ID     | Alibaba RAM AccessKey ID used by the scheduled control path and live read-only query.                                                                 |
| ALIYUN_ACCESS_KEY_SECRET | Paired Alibaba RAM secret.                                                                                                                            |
| ADMIN_TOKEN              | Password in HTTP Basic auth for the dashboard, API routes, and donor actions. Required by the deploy configuration and post-deploy secret-name check. |

Keep the Alibaba credential on a dedicated least-privilege RAM user. See [the RAM policy](../security/ram-policy.md). ADMIN_TOKEN does not authorize the Cron monitor route.

### Optional Worker Secrets

| Name                                 | Purpose and requirements                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MONITOR_READ_TOKEN                   | Dedicated Bearer token for GET /api/monitor/cron. It is optional for deploy validation but required for the GitHub Cron probe. It is separate from ADMIN_TOKEN. Install or rotate it with install-monitor-read-token.yml; the workflow pipes the value to Wrangler stdin and verifies only the name. |
| WEBHOOK_URL                          | Enables one webhook notification attempt per scheduled run when configured. Must be an absolute HTTPS URL.                                                                                                                                                                                           |
| WEBHOOK_TOKEN                        | Optional webhook Bearer credential. It requires WEBHOOK_URL.                                                                                                                                                                                                                                         |
| SMTP_USER, SMTP_PASS                 | Optional SMTP AUTH credentials. They are used only by the manually gated SMTP test.                                                                                                                                                                                                                  |
| TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID | Telegram test destination and bot credential. Both are needed for a manual Telegram test.                                                                                                                                                                                                            |
| TELEGRAM_PROXY_URL                   | Optional HTTPS Telegram API proxy base URL.                                                                                                                                                                                                                                                          |

Secret values are never part of the repository, Wrangler vars, GitHub Variables, log output, or a command-line argument. Do not print them to verify configuration. The installer for MONITOR_READ_TOKEN confirms presence by secret name only.

### Worker runtime variables

| Name                        | Required/default       | Meaning                                                                                                                                                                                   |
| --------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REGION_ID                   | Required, no default   | Alibaba ECS region.                                                                                                                                                                       |
| ECS_INSTANCE_ID             | Required, no default   | The one instance controlled by this Worker.                                                                                                                                               |
| TRAFFIC_THRESHOLD_GB        | 180                    | Must be finite and greater than zero. Traffic GB uses a 1024³ byte divisor.                                                                                                               |
| CDT_ENDPOINT                | cdt.aliyuncs.com       | CDT API endpoint.                                                                                                                                                                         |
| BUSINESS_REGION_ID          | Unset                  | Optional server-side CDT filter.                                                                                                                                                          |
| SIGNATURE_VERSION           | v3                     | Accepted values: v2 or v3.                                                                                                                                                                |
| STOPPED_MODE                | KeepCharging           | Accepted values: KeepCharging and StopCharging; see deployment implications before changing.                                                                                              |
| ADMIN_USER                  | admin                  | HTTP Basic username.                                                                                                                                                                      |
| ENABLE_BILLING              | Off                    | Enables read-only account balance lookup only for 1, true, or yes, case-insensitive. A separate owner authorization for Alibaba BSS permission is required; monthly spend is unavailable. |
| ENABLE_MANUAL_WEBHOOK_TEST  | Off                    | Enables the donor webhook test only for 1, true, or yes, case-insensitive, and only when a valid WEBHOOK_URL is configured.                                                               |
| ENABLE_MANUAL_TELEGRAM_TEST | Off                    | Enables the donor Telegram test only for 1, true, or yes, case-insensitive, and only when Telegram credentials are configured.                                                            |
| ENABLE_MANUAL_SMTP_TEST     | Off                    | Enables the donor SMTP test only for 1, true, or yes, case-insensitive, and only when SMTP host and sender are configured.                                                                |
| SMTP_HOST                   | Unset                  | SMTP server hostname for the manually gated test.                                                                                                                                         |
| SMTP_PORT                   | 587 in the test sender | Port 465 uses implicit TLS; other supported ports use STARTTLS. Port 25 is rejected.                                                                                                      |
| SMTP_FROM                   | Unset                  | Sender address for the manually gated SMTP test.                                                                                                                                          |
| TRAFFIC_DB                  | Optional D1 binding    | Observation-only history. The traffic_checks schema comes from migrations 0001_traffic_checks.sql and 0002_decision_reason.sql.                                                           |
| ASSETS                      | Wrangler asset binding | Static dashboard resources; fixed bundle files may be fetched publicly while the dashboard document remains protected.                                                                    |

The default-off flags enable a capability only when both the flag and its required configuration are present. Manual notification tests have external messaging side effects, but no ECS control dependency.

### Other runtime behavior

- ADMIN_TOKEN is deliberately absent from wrangler.jsonc defaults and must be installed as a Worker Secret.
- loadConfig() rejects missing Alibaba credentials, REGION_ID, or ECS_INSTANCE_ID, and rejects invalid threshold, signature version, stop mode, or webhook pairing.
- If ADMIN_TOKEN is absent, protected Basic-auth routes deny access.
- If TRAFFIC_DB is absent or unreadable, monitor telemetry is UNKNOWN; history remains observation-only.
- MONITOR_READ_TOKEN is not included in the required Worker Secret list. It is required to authenticate the Cron telemetry probe, not to execute scheduled control.

## Deployment-only settings

These values control how GitHub Actions deploy the Worker. They are not Worker runtime variables.

| Name                  | GitHub location                   | Purpose                                                                                                                         |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| D1_DATABASE_ID        | Repository Variable               | Required by deployment config generation; remote database identifier injected into the generated TRAFFIC_DB binding.            |
| WORKER_CUSTOM_DOMAIN  | Repository Variable               | Bare hostname, required only for custom_domain exposure.                                                                        |
| CLOUDFLARE_API_TOKEN  | production Environment Secret     | Scoped Cloudflare deployment credential.                                                                                        |
| CLOUDFLARE_ACCOUNT_ID | production Environment Secret     | Cloudflare account identifier.                                                                                                  |
| HTTP_EXPOSURE_MODE    | RELEASE and UPDATE dispatch input | Explicit choice of workers_dev or custom_domain; RELEASE has no default and UPDATE requires a choice. PRE-FLIGHT has no inputs. |

Application settings such as REGION_ID, ECS_INSTANCE_ID, and optional overrides are repository Variables and are copied into generated Wrangler config. The protected production Environment should require owner review and restrict deploy branches to main.

## Installing or rotating MONITOR_READ_TOKEN

1. Store the same newly generated token as the GitHub Actions secret MONITOR_READ_TOKEN.
2. Dispatch .github/workflows/install-monitor-read-token.yml with confirmation INSTALL. The protected production Environment provides Cloudflare credentials. The workflow sends the token to wrangler secret put over stdin; it does not pass the value in argv or log it.
3. Confirm the workflow's name-only check succeeds.
4. Because wrangler secret put creates a Worker version, run the authorized update.yml workflow afterward to deploy the intended application revision with Cron preserved.
5. Confirm the Cron probe authenticates and returns telemetry. Do not place the token in a URL, issue, log, or command argument.

For the complete update sequence, see [deployment](deployment.md). Runtime binding names and workflow references are checked by the documentation tests.
