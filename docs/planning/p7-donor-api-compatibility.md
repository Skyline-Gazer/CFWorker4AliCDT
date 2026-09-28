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
| Configuration | Runtime configuration comes from Worker variables and Secrets. Authenticated `get_config` provides an allowlisted read-only summary; there is no browser config-write path, and `save_config` returns HTTP 501. Secret values must not be entered in the browser, returned to the dashboard, or persisted to D1. |
| Optional billing | `ENABLE_BILLING` is an optional Worker variable, default-off (unset/empty disables it; only `1`, `true`, or `yes`, case-insensitive, enables it). When enabled and the account has Alibaba RAM permission for BSS `QueryAccountBalance` on `bssopenapi.aliyuncs.com`, authenticated reads use the shared signed RPC transport. The response exposes available cash balance and currency; monthly spend is **NOT AVAILABLE** because this operation does not report a monthly bill. BSS failures return null amounts and a safe error. Production enablement plus IAM authorization is an **OWNER_GATE**; this branch does not apply IAM. Billing is never written to D1 or exposed in secrets. |
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
`get_billing` is an authenticated read-only action: it fails closed when billing is off and adapts the BSS balance response only when enabled and authorized; monthly spend is **NOT AVAILABLE**. `control_instance`, `clear_logs`, and `logout` remain placeholders;
`check_init`, setup, and configuration writes remain unavailable. Notification
test actions stay fail-closed placeholders (SMTP/webhook/Telegram report
configuration codes; no browser notification authority). The donor logs view is a projection of the same bounded
`traffic_checks` observations, with stored error text redacted before response.

## Action matrix

| Donor action | Actual donor call | Classification | Current compatibility |
| --- | --- | --- | --- |
| `check_init` | `GET ?action=check_init` ([L1113](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1113)) | `PLACEHOLDER` | There is no initialization-state endpoint. Deployment configuration is provisioned through Worker variables and Secrets; public `/health` intentionally reports liveness only. |
| `setup` | `POST ?action=setup`, JSON `setupData` ([L1140](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1140)) | `PLACEHOLDER` | No runtime setup or account-provisioning API exists. Configuration is supplied out of band to the Worker. |
| `login` | `POST ?action=login`, JSON `{ password }` in the pinned donor ([L1440](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1440)) | `ADAPTER` | The imported UI sends the entered token as `Authorization: Bearer …`; the server's existing Basic/Bearer gate validates it. The request body and response contain no credential, and no session is created. |
| `check_login` | `GET ?action=check_login` ([L1159](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1159)) | `OPERATIONAL` | Returns `logged_in: true` only after the existing Authorization gate succeeds; invalid or missing authorization gets 401. |
| `get_status` | `GET ?action=get_status` ([L1177](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1177)) | `ADAPTER` | Maps the authenticated live query to one configured-instance card. Traffic and threshold are in GB; percent is derived for display only. Current ECS status and query target state are separate fields. Includes the actual decision reason, all-entry summation scope, and CDT `BusinessRegionId` byte totals; no accounts are synthesized. Query failure returns an empty data list and an unknown-status message. |
| `control_instance` | `POST ?action=control_instance`, JSON `{ id, action }` ([L1230](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1230)) | `PLACEHOLDER` | **Disabled; zero mutation.** Returns HTTP 501 and `FEATURE_NOT_IMPLEMENTED`; the handler does not read the body or call ECS. Cron remains the only ECS mutation authority. |
| `get_config` | `GET ?action=get_config` ([L1461](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1461)) | `ADAPTER` | Authenticated safe read-only projection of the validated runtime config: region, instance, threshold, CDT endpoint, business region, signature version, stopped mode, `enable_billing`, secret-presence booleans, webhook transport metadata (`webhook_method: "POST"`, `webhook_content_type: "application/json"`), `smtp_configured` (true when Worker `SMTP_HOST` and `SMTP_FROM` are set), and `telegram_configured` (true when Worker `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set). Access keys, admin/webhook/SMTP/Telegram credentials, webhook URL, SMTP host/from, and Telegram chat IDs are never returned. |
| `get_billing` | `GET ?action=get_billing` | `ADAPTER` (enabled + BSS IAM); otherwise `OPERATIONAL` fail-closed | Authenticated read-only BSS balance lookup. With billing off it returns `available: false` and null values without an Alibaba request. When enabled and IAM-authorized, it adapts the balance response; RPC, parse, or IAM failures return `success: false`, null amounts, and a safe error. **Monthly billing is NOT AVAILABLE.** |
| `save_config` | `POST ?action=save_config`, JSON config ([L1500](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1500)) | `PLACEHOLDER` (Option C) | **Unavailable by design; fail-closed with HTTP 501 `BACKEND_NOT_AVAILABLE`.** The dashboard makes no config-write request and its save control is disabled. The response explains that operators change Cloudflare Worker variables and Secrets out of band. Secrets must never be entered in the browser or persisted to D1; there is no runtime config-write path. |
| `send_test_email` | `POST ?action=send_test_email`, JSON `{ email }` ([L1553](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1553)) | `ADAPTER` (gated) | Authenticated only. Requires Worker `SMTP_HOST`/`SMTP_FROM` and owner gate `ENABLE_MANUAL_SMTP_TEST`; otherwise HTTP 501 `SMTP_NOT_CONFIGURED` or `MANUAL_SMTP_TEST_DISABLED`. With both configured, sends via isolated Worker SMTP notifier and returns HTTP 200 including on delivery failure. A well-formed body email is an optional recipient; invalid/missing addresses fall back to `SMTP_FROM`. Body SMTP credentials are ignored. |
| `send_test_telegram` | `POST ?action=send_test_telegram`, JSON `{ telegram }` ([L1563](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1563)) | `ADAPTER` (gated) | Authenticated only; request body bot tokens are ignored. Missing Worker `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` → HTTP 501 `TELEGRAM_NOT_CONFIGURED`; configured with default-off `ENABLE_MANUAL_TELEGRAM_TEST` → HTTP 501 `MANUAL_TELEGRAM_TEST_DISABLED`. With both configured and enabled, sends a labeled manual test via the isolated Worker Telegram notifier and returns HTTP 200 `{ success: <delivery result>, available: true, mutation: false, action: "send_test_telegram" }`, including on transport failure. Optional `TELEGRAM_PROXY_URL` is Worker-only. Secrets stay Worker Secrets. |
| `send_test_webhook` | `POST ?action=send_test_webhook`, JSON `{ webhook }` ([L1573](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1573)) | `ADAPTER` (gated) | Authenticated only; request body credentials are ignored. Missing Worker `WEBHOOK_URL` → HTTP 501 `WEBHOOK_NOT_CONFIGURED`; URL present with default-off `ENABLE_MANUAL_WEBHOOK_TEST` → HTTP 501 `MANUAL_WEBHOOK_TEST_DISABLED`. With both configured and enabled, calls the existing Worker webhook notifier and returns HTTP 200 `{ success: <delivery result>, available: true, mutation: false, action: "send_test_webhook" }`, including on transport failure. Production enablement is an `OWNER_GATE`; leave the variable unset by default. Scheduled Cron webhook behavior is unchanged. |
| `refresh_account` | `POST ?action=refresh_account`, JSON `{ id }` ([L1203](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1203)) | `ADAPTER` | Runs the existing authenticated live query for the singleton. The donor ID is ignored; this path has no Start/Stop call or D1 write and reports `mutation: false`. |
| `get_logs` | `GET ?action=get_logs&tab=...` ([L1510](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1510)) | `ADAPTER` | Returns up to 200 newest D1 `traffic_checks` observations as donor log entries, using only allowlisted monitoring fields and redacting stored error text. The optional tab is ignored; no separate log store is introduced. |
| `clear_logs` | `POST ?action=clear_logs`, JSON `{ tab }` ([L1522](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1522)) | `PLACEHOLDER` | Disabled; returns HTTP 501 and `FEATURE_NOT_IMPLEMENTED`. No delete route exists; D1 observational history is not cleared. |
| `get_history` | `GET ?action=get_history&id=...` ([L1290](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1290)) | `ADAPTER` | Reads at most the newest 200 D1 rows. The 24-hour series uses actual samples; the 30-day series uses the latest known sample per UTC date. Unknown traffic and missing dates produce no chart point. The response includes up to five newest stored decision reasons; pre-migration and pre-decision rows remain `null`. The donor account ID is ignored. |
| `logout` | `GET ?action=logout` ([L1427](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1427)) | `PLACEHOLDER` | The server action still returns HTTP 501 and `FEATURE_NOT_IMPLEMENTED`. The UI can clear its page-memory Bearer token, but there is no server session and the browser may retain Basic credentials. |

## FEATURE-11 parity audit (Refs #99)

Audited against main tip after FEATURE-06/07/08/09 landings. Epic invariants still hold:
Cron (`*/10 * * * *`) is the sole ECS mutation authority; Worker Secrets never return to
the browser or D1; notification test actions stay fail-closed (no fake success).

### Action coverage (donor matrix)

| Classification | Actions |
| --- | --- |
| `OPERATIONAL` | `check_login` |
| `ADAPTER` | `login`, `get_status`, `refresh_account`, `get_history`, `get_logs`, `get_config`; `get_billing` only when `ENABLE_BILLING` is enabled and BSS IAM is authorized; `send_test_webhook` only when `WEBHOOK_URL` is configured and `ENABLE_MANUAL_WEBHOOK_TEST` is truthy; `send_test_telegram` only when Telegram credentials are configured and `ENABLE_MANUAL_TELEGRAM_TEST` is truthy; `send_test_email` only when SMTP host/sender are configured and `ENABLE_MANUAL_SMTP_TEST` is truthy |
| `PLACEHOLDER` (fail-closed / disabled) | `check_init`, `setup`, `control_instance`, `save_config`, `clear_logs`, `logout`; manual notification test actions while their Worker gate is off or required credentials are missing |
| `OWNER_GATE` | Production billing activation and required BSS `QueryAccountBalance` RAM authorization; **monthly billing is NOT AVAILABLE** |

### Intentional gaps (not defects for this audit)

- **OWNER GATE** (packets only; no production activation): #90 multi-account, #91 manual Start/Stop, #92 daily schedule, #93 keep-alive.
- Manual SMTP test-send is available only behind `ENABLE_MANUAL_SMTP_TEST` and configured `SMTP_HOST`/`SMTP_FROM`; the variable is an owner gate and remains unset by default. Manual Telegram test-send is available only behind `ENABLE_MANUAL_TELEGRAM_TEST` and configured `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`; the variable is an owner gate and remains unset by default. Manual webhook test-send is available only behind `ENABLE_MANUAL_WEBHOOK_TEST` and configured `WEBHOOK_URL`; that variable remains documented as an owner gate and unset by default. Scheduled Cron webhook sender is unchanged.
- Issue #128 selected **Option C — reject with clearer UX**. The donor save control is disabled, the UI notice and alert explain the policy, and `save_config` still returns HTTP 501 `BACKEND_NOT_AVAILABLE`. There is no config-write path and no D1 persistence: operators must not enter secrets in the dashboard (fields may still exist in the donor UI shell), the API never returns secret values, and operators change Cloudflare Worker variables and Secrets out of band.
- Billing is an optional balance adapter behind `ENABLE_BILLING` and an owner-authorized BSS permission; monthly billing is **not available**.
- Production Worker may still run an older SHA until a future owner UPDATE; this audit is about **main tip** parity docs/code, not live deploy.

### Verdict

The donor facade has operational and adapted read paths, while notification test
transports, `save_config`, and manual ECS control remain unavailable or fail-closed.
Billing exposes an optional balance adapter only after its owner gate; monthly billing
is unavailable. Cron remains the sole ECS mutation authority. OWNER GATE work (#90–#93)
and any future transport activation require separate authorization.

## Classification meanings

- `OPERATIONAL`: the donor action contract works against the existing route and
  response shape without a compatibility adapter.
- `ADAPTER`: an authenticated Worker capability is mapped to a donor-compatible
  response while preserving its documented semantics.
- `PLACEHOLDER`: explicitly disabled or inert in the donor UI; it must not imply
  that a protected or destructive operation occurred.
- `OWNER_GATE`: requires separate owner authorization, such as production billing
  enablement and BSS IAM permission.

The follow-up remains within corrective Epic #77. Issue #39 remains CLOSED for the
historical server-rendered acceptance, and Issue #47 remains Done. This matrix
does not change that history or authorize production PRE-FLIGHT/RELEASE.
