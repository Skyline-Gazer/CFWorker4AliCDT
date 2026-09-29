# HTTP API

Routes are defined in src/web/router.ts and authenticated in the router before their handlers run. The static dashboard is served through the ASSETS binding in src/index.ts.

## Routes

| Method | Path              | Authentication                 | Success behavior                                                                |
| ------ | ----------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| GET    | /health           | Public                         | Static liveness JSON. No config, Alibaba, D1, or ECS read.                      |
| GET    | /                 | HTTP Basic                     | Authenticated dashboard HTML.                                                   |
| GET    | /api/history      | HTTP Basic                     | D1 history, newest first; default limit 50, maximum 200.                        |
| POST   | /api/query        | HTTP Basic                     | Live read-only CDT/ECS query and decision. Response always has mutation: false. |
| GET    | /api/monitor/cron | Bearer MONITOR_READ_TOKEN only | Sanitized D1 Cron telemetry; Cache-Control: no-store.                           |

Basic authentication uses ADMIN_USER (default admin) and ADMIN_TOKEN. The monitor route uses the dedicated MONITOR_READ_TOKEN; an admin Basic credential or ADMIN_TOKEN cannot authorize it. The router does not read credentials from query parameters; the monitor route also rejects credential-like query parameter names. Credentials are sent in the Authorization header.

Only fixed static bundle assets (/tailwind-compiled.css, /vue.global.prod.js, /echarts.min.js, /icon.png, and /input.css) allow unauthenticated GET or HEAD requests. The dashboard HTML remains protected.

## Status behavior

| Condition                                                      | Result                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Missing or invalid Basic credentials on protected routes       | 401 with Basic challenge.                                                                                               |
| Missing, invalid, or wrong-scheme monitor credential           | 401 JSON; monitor response is not cached.                                                                               |
| Wrong method on a known path with valid auth                   | 405 with Allow header. Protected path authentication runs before method dispatch, so missing auth can return 401 first. |
| Unknown path after any required namespace authentication       | 404. Unknown paths under protected root or API namespaces require valid auth first.                                     |
| Unhandled handler failure                                      | Generic 500; exception text is not returned.                                                                            |
| /api/query receives a valid request but an upstream read fails | 200 JSON with status: error and a sanitized error classification; it is a query result, not an HTTP route failure.      |
| Cron monitor has no D1 binding or its query fails              | 200 JSON with cron_health: UNKNOWN and telemetry_available: false.                                                      |

## Donor actions

Donor actions use the authenticated root URL query form /?action=<name>. The route checks Basic authentication before action dispatch. The request method must match the action when specified.

| Action                         | Method                     | Behavior                                                                                                                                                   |
| ------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| login, check_login             | POST, GET                  | Authentication UX only; Basic auth is the actual gate. Returns mutation: false.                                                                            |
| get_status, refresh_account    | GET, POST                  | Adapt the live read-only query; no ECS mutation.                                                                                                           |
| get_history, get_logs          | GET                        | Adapt at most 200 D1 observations.                                                                                                                         |
| get_config                     | GET                        | Safe configuration projection; secret values are omitted.                                                                                                  |
| get_billing                    | GET                        | Read-only billing adapter; requires default-off ENABLE_BILLING plus separately authorized BSS permission to query a balance. Monthly spend is unavailable. |
| send_test_webhook              | POST                       | Sends only when ENABLE_MANUAL_WEBHOOK_TEST is truthy and WEBHOOK_URL is configured. Otherwise returns 501.                                                 |
| send_test_email                | POST                       | Sends only when ENABLE_MANUAL_SMTP_TEST is truthy and SMTP host/sender are configured. Otherwise returns 501.                                              |
| send_test_telegram             | POST                       | Sends only when ENABLE_MANUAL_TELEGRAM_TEST is truthy and Telegram credentials are configured. Otherwise returns 501.                                      |
| control_instance               | Any supported donor method | 501 FEATURE_NOT_IMPLEMENTED; no ECS control path exists.                                                                                                   |
| save_config, check_init, setup | Any supported donor method | 501 BACKEND_NOT_AVAILABLE; Worker configuration is managed out of band.                                                                                    |
| clear_logs, logout             | Any supported donor method | 501 FEATURE_NOT_IMPLEMENTED.                                                                                                                               |
| Any other action               | GET or POST                | 501 ACTION_NOT_AVAILABLE.                                                                                                                                  |

Notification tests are external message sends if configured and enabled. They report mutation: false because they never mutate ECS; do not treat that field as a claim that no network side effect occurred. All unavailable or unsupported actions return non-success JSON rather than claiming completion.

## Read-only boundaries

POST /api/query uses dependencies for CDT and ECS reads only. It does not write history or send a webhook. The Cron monitor reads a bounded projection of checked_at, status, and allowlisted error_stage from D1; raw error messages, traffic, and instance details are not returned.

The only ECS StartInstance/StopInstance calls are wired into the scheduled control path. See [security invariants](../security/invariants.md).
