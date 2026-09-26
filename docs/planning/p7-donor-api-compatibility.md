# P7 donor API compatibility matrix

This inventory maps the actual `fetch('?action=...')` calls in the donor's
[`static/index.html` at the pinned commit](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html)
to the current CFWorker4AliCDT HTTP and storage contracts. The call locations
are from the supplied `donor-index.html` inventory snapshot; an omitted method
means the donor uses `fetch`'s default `GET` method. The imported page now uses
the same action names where an adapter is available and keeps the remaining
actions explicit placeholders.

This inventory was first recorded for Refs #78 #80. Runtime compatibility adds
authenticated adapters for login UX, live status, read-only refresh, and bounded
history while preserving placeholders for unsupported backend capabilities.

## Current CFWorker4AliCDT surface

| Current capability | Contract |
| --- | --- |
| Authentication | Protected routes accept Basic or Bearer credentials checked against Worker Secret `ADMIN_TOKEN`; the Basic username defaults to `admin`. The page's password field sends the token only as a Bearer `Authorization` header and keeps it in page memory. No JSON password login or server session exists. |
| `GET /health` | Public liveness response only; it does not disclose configuration. |
| `GET /` | Authenticated donor dashboard served from Workers Static Assets. |
| `GET` or `POST /?action=...` | Authenticated donor facade. Login/check-login confirm the existing Authorization gate; status and refresh adapt the read-only query; history and logs adapt bounded D1 reads. Status includes a decision reason and live CDT aggregation audit. History includes up to five recent scheduled reasons, preserving unknown as `null`. Other actions return HTTP 501 JSON with `success: false`, `available: false`, and `mutation: false`. |
| `GET /api/history` | Authenticated, bounded, newest-first monitoring rows from D1 `traffic_checks`; maximum 200 rows. `decision_reason` is nullable; older rows remain `null`. |
| `POST /api/query` | Authenticated live query of traffic and the one configured ECS instance. It returns `reason` from `decide()` and actual `TrafficDetails` aggregation audit, is read-only, and returns `mutation: false`. |
| ECS mutation | Cron is the only ECS mutation authority. No HTTP route can start, stop, or reboot an instance. |
| Configuration | Runtime configuration comes from Worker variables and Secrets; there is no browser config read/write API. Secret values are not exposed to the dashboard. |
| Optional billing | `ENABLE_BILLING` is an optional Worker variable, default-off (only `1`, `true`, or `yes`, case-insensitive, enables it). When enabled, authenticated reads call BSS `QueryAccountBalance` through the shared signed RPC transport. The response exposes available cash balance and currency; monthly spend remains `null` because this operation does not report a monthly bill. BSS failures return null amounts and a safe error. Billing is never written to D1 or exposed in secrets. |
| D1 | `traffic_checks` stores observational run history. It is not an account store, platform log store, or runtime configuration store. |

The donor uses the root path plus a query action. Those calls reach the
authenticated facade rather than dashboard HTML or a method collision. The
status adapter exposes one configured instance only, passes through the query's
already-converted GB value, and leaves missing observations unknown. Its CDT
audit reports the explicit sum of all returned `TrafficDetails` entries and
actual totals grouped by `BusinessRegionId`; absent IDs remain unknown. CDT
business regions are not ECS regions or account identifiers. History includes
only actual D1 totals and stored reasons; old/missing reasons remain unknown,
and chart series contain no zero-filled points or inferred regional history.
`get_billing` is an authenticated read-only action and adds optional `cost` data to the status card. `control_instance`, `clear_logs`, and `logout` remain placeholders;
`check_init`, setup, configuration writes, and notification actions remain
unavailable. The donor logs view is a projection of the same bounded
`traffic_checks` observations, with stored error text redacted before response.

## Action matrix

| Donor action | Actual donor call | Classification | Current compatibility |
| --- | --- | --- | --- |
| `check_init` | `GET ?action=check_init` ([L1113](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1113)) | `FUTURE_BACKEND` | There is no initialization-state endpoint. Deployment configuration is provisioned through Worker variables and Secrets; public `/health` intentionally reports liveness only. |
| `setup` | `POST ?action=setup`, JSON `setupData` ([L1140](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1140)) | `FUTURE_BACKEND` | No runtime setup or account-provisioning API exists. Configuration is supplied out of band to the Worker. |
| `login` | `POST ?action=login`, JSON `{ password }` in the pinned donor ([L1440](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1440)) | `ADAPTED` | The imported UI sends the entered token as `Authorization: Bearer …`; the server's existing Basic/Bearer gate validates it. The request body and response contain no credential, and no session is created. |
| `check_login` | `GET ?action=check_login` ([L1159](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1159)) | `ADAPTED` | Returns `logged_in: true` only after the existing Authorization gate succeeds; invalid or missing authorization gets 401. |
| `get_status` | `GET ?action=get_status` ([L1177](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1177)) | `ADAPTED` | Maps the authenticated live query to one configured-instance card. Traffic and threshold are in GB; percent is derived for display only. Current ECS status and query target state are separate fields. Includes the actual decision reason, all-entry summation scope, and CDT `BusinessRegionId` byte totals; no accounts are synthesized. Query failure returns an empty data list and an unknown-status message. |
| `control_instance` | `POST ?action=control_instance`, JSON `{ id, action }` ([L1230](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1230)) | `PLACEHOLDER` | **Disabled; zero mutation.** Returns HTTP 501 and `FEATURE_NOT_IMPLEMENTED`; the handler does not read the body or call ECS. Cron remains the only mutation authority. |
| `get_config` | `GET ?action=get_config` ([L1461](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1461)) | `ADAPTED` | Authenticated read-only projection of the validated runtime config: region, instance, threshold, CDT endpoint, business region, signature version, stopped mode, `enable_billing`, secret-presence booleans, and webhook transport metadata (`webhook_method: "POST"`, `webhook_content_type: "application/json"`). Access keys, admin/webhook tokens, and the webhook URL are never returned. |
| `get_billing` | `GET ?action=get_billing` | `ADAPTED` | Authenticated read-only BSS balance lookup. Disabled returns `available: false` and null billing values without making an Alibaba request. Enabled returns `available: true`; RPC, parse, or IAM failures return `success: false`, null amounts, and a safe error. Monthly cost is null; the implementation does not treat balance as monthly spend. |
| `save_config` | `POST ?action=save_config`, JSON config ([L1500](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1500)) | `FUTURE_BACKEND` | There is no runtime config-write path. Changes to Worker variables or Secrets require operator provisioning outside the dashboard. |
| `send_test_email` | `POST ?action=send_test_email`, JSON `{ email }` ([L1553](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1553)) | `FUTURE_BACKEND` | No email sender or test-notification endpoint exists. |
| `send_test_telegram` | `POST ?action=send_test_telegram`, JSON `{ telegram }` ([L1563](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1563)) | `FUTURE_BACKEND` | No Telegram integration or test-notification endpoint exists. |
| `send_test_webhook` | `POST ?action=send_test_webhook`, JSON `{ webhook }` ([L1573](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1573)) | `FUTURE_BACKEND` | Dedicated authenticated fail-closed response; request body credentials are ignored. Without configured Worker `WEBHOOK_URL`, returns HTTP 501 with `WEBHOOK_NOT_CONFIGURED`; when a URL is configured, returns HTTP 501 with `BACKEND_NOT_AVAILABLE`. Both responses report `success: false`, `available: false`, and `mutation: false`. Manual sending is not activated; the scheduled Cron webhook remains the only sender. |
| `refresh_account` | `POST ?action=refresh_account`, JSON `{ id }` ([L1203](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1203)) | `ADAPTED` | Runs the existing authenticated live query for the singleton. The donor ID is ignored; this path has no Start/Stop call or D1 write and reports `mutation: false`. |
| `get_logs` | `GET ?action=get_logs&tab=...` ([L1510](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1510)) | `ADAPTED` | Returns up to 200 newest D1 `traffic_checks` observations as donor log entries, using only allowlisted monitoring fields and redacting stored error text. The optional tab is ignored; no separate log store is introduced. |
| `clear_logs` | `POST ?action=clear_logs`, JSON `{ tab }` ([L1522](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1522)) | `PLACEHOLDER` | Disabled; returns HTTP 501 and `FEATURE_NOT_IMPLEMENTED`. No delete route exists; D1 observational history is not cleared. |
| `get_history` | `GET ?action=get_history&id=...` ([L1290](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1290)) | `ADAPTED` | Reads at most the newest 200 D1 rows. The 24-hour series uses actual samples; the 30-day series uses the latest known sample per UTC date. Unknown traffic and missing dates produce no chart point. The response includes up to five newest stored decision reasons; pre-migration and pre-decision rows remain `null`. The donor account ID is ignored. |
| `logout` | `GET ?action=logout` ([L1427](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1427)) | `PLACEHOLDER` | The server action still returns HTTP 501 and `FEATURE_NOT_IMPLEMENTED`. The UI can clear its page-memory Bearer token, but there is no server session and the browser may retain Basic credentials. |

## Classification meanings

- `SUPPORTED_NOW`: the donor action contract works against the existing route and
  response shape without an adapter.
- `ADAPTED`: the authenticated Worker capability is mapped to a donor-compatible
  response while preserving its documented semantics.
- `ADAPTER_REQUIRED`: an existing current capability can serve the use case after
  the UI maps its route, authentication, inputs, or response shape.
- `PLACEHOLDER`: explicitly disabled or inert in the donor UI; it must not imply
  that a protected or destructive operation occurred.
- `FUTURE_BACKEND`: requires a new backend capability, data model, or platform
  integration beyond this current Worker surface.

The follow-up remains within corrective Epic #77. Issue #39 remains CLOSED for the
historical server-rendered acceptance, and Issue #47 remains Done. This matrix
does not change that history or authorize production PRE-FLIGHT/RELEASE.
