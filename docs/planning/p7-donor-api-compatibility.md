# P7 donor API compatibility matrix

This inventory maps the actual `fetch('?action=...')` calls in the donor's
[`static/index.html` at the pinned commit](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html)
to the current CFWorker4AliCDT HTTP and storage contracts. The call locations
are from the supplied `donor-index.html` inventory snapshot; an omitted method
means the donor uses `fetch`'s default `GET` method.

This is a documentation inventory for Refs #78 #80. It does not add action
routes, adapters, or runtime behavior.

## Current CFWorker4AliCDT surface

| Current capability | Contract |
| --- | --- |
| Authentication | Protected routes accept Basic or Bearer credentials checked against Worker Secret `ADMIN_TOKEN`; the Basic username defaults to `admin`. There is no JSON password login or server session. |
| `GET /health` | Public liveness response only; it does not disclose configuration. |
| `GET /` | Authenticated server-rendered dashboard. Query parameters do not dispatch donor actions, so `GET /?action=...` returns dashboard HTML after authentication. |
| `GET /api/history` | Authenticated, bounded, newest-first monitoring rows from D1 `traffic_checks`; maximum 200 rows. |
| `POST /api/query` | Authenticated live query of traffic and the one configured ECS instance. It is read-only and returns `mutation: false`. |
| ECS mutation | Cron is the only ECS mutation authority. No HTTP route can start, stop, or reboot an instance. |
| Configuration | Runtime configuration comes from Worker variables and Secrets; there is no browser config read/write API. Secret values are not exposed to the dashboard. |
| D1 | `traffic_checks` stores observational run history. It is not an account store, platform log store, or runtime configuration store. |

The donor uses the root path plus a query action, while this Worker routes by
pathname and method. Donor `POST /?action=...` calls therefore receive `405`
for `/`; they do not invoke an action handler. No donor action endpoint is
implemented verbatim, so no row is classified `SUPPORTED_NOW`.

## Action matrix

| Donor action | Actual donor call | Classification | Current compatibility |
| --- | --- | --- | --- |
| `check_init` | `GET ?action=check_init` ([L1113](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1113)) | `FUTURE_BACKEND` | There is no initialization-state endpoint. Deployment configuration is provisioned through Worker variables and Secrets; public `/health` intentionally reports liveness only. |
| `setup` | `POST ?action=setup`, JSON `setupData` ([L1140](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1140)) | `FUTURE_BACKEND` | No runtime setup or account-provisioning API exists. Configuration is supplied out of band to the Worker. |
| `login` | `POST ?action=login`, JSON `{ password }` ([L1440](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1440)) | `ADAPTER_REQUIRED` | Replace the donor password/session request with the current Basic or Bearer `Authorization` flow using `ADMIN_TOKEN`; no JSON login route exists. |
| `check_login` | `GET ?action=check_login` ([L1159](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1159)) | `ADAPTER_REQUIRED` | Use successful access to a protected current route and handle its `401` challenge. There is no `logged_in` JSON response or session endpoint. |
| `get_status` | `GET ?action=get_status` ([L1177](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1177)) | `ADAPTER_REQUIRED` | Use the dashboard or adapt `POST /api/query`. The current query reports the configured singleton and its read-only decision, not the donor's `data[]` account collection. |
| `control_instance` | `POST ?action=control_instance`, JSON `{ id, action }` ([L1230](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1230)) | `PLACEHOLDER` | **Disabled; zero mutation.** There is no HTTP control route. Any imported UI control must remain an explicit `FEATURE_NOT_IMPLEMENTED` placeholder and must not call ECS. Cron remains the only mutation authority. |
| `get_config` | `GET ?action=get_config` ([L1461](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1461)) | `FUTURE_BACKEND` | There is no config API. Worker Secrets and variables are not returned to browser code. |
| `save_config` | `POST ?action=save_config`, JSON config ([L1500](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1500)) | `FUTURE_BACKEND` | There is no runtime config-write path. Changes to Worker variables or Secrets require operator provisioning outside the dashboard. |
| `send_test_email` | `POST ?action=send_test_email`, JSON `{ email }` ([L1553](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1553)) | `FUTURE_BACKEND` | No email sender or test-notification endpoint exists. |
| `send_test_telegram` | `POST ?action=send_test_telegram`, JSON `{ telegram }` ([L1563](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1563)) | `FUTURE_BACKEND` | No Telegram integration or test-notification endpoint exists. |
| `send_test_webhook` | `POST ?action=send_test_webhook`, JSON `{ webhook }` ([L1573](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1573)) | `FUTURE_BACKEND` | The optional Worker webhook sends scheduled run reports only. There is no manual test endpoint, and webhook credentials must not be sent from browser code. |
| `refresh_account` | `POST ?action=refresh_account`, JSON `{ id }` ([L1203](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1203)) | `ADAPTER_REQUIRED` | Adapt to `POST /api/query` for a live, read-only refresh of the one configured instance. The current API does not select donor account IDs and reports `mutation: false`. |
| `get_logs` | `GET ?action=get_logs&tab=...` ([L1510](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1510)) | `FUTURE_BACKEND` | There is no app log endpoint or action/heartbeat log store. D1 monitoring history is available separately through `GET /api/history`. |
| `clear_logs` | `POST ?action=clear_logs`, JSON `{ tab }` ([L1522](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1522)) | `PLACEHOLDER` | Disabled. No delete route exists; D1 `traffic_checks` is observational history retained indefinitely and must not be cleared by the donor control. |
| `get_history` | `GET ?action=get_history&id=...` ([L1290](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1290)) | `ADAPTER_REQUIRED` | Adapt `GET /api/history` rows to a run-history view. The donor's account-ID lookup and 24-hour/30-day chart series are not present; the current endpoint returns at most 200 run rows and has no per-account grouping. |
| `logout` | `GET ?action=logout` ([L1427](https://github.com/kfqkfy/cdt-monitor-worker/blob/75e6962d46791c517d4489227b6f0cf0c5c6a208/static/index.html#L1427)) | `PLACEHOLDER` | There is no server session or logout route, and Basic credentials cannot be revoked by a request. Do not represent local UI state clearing as server-side logout. |

## Classification meanings

- `SUPPORTED_NOW`: the donor action contract works against the existing route and
  response shape without an adapter. There are currently zero such action calls.
- `ADAPTER_REQUIRED`: an existing current capability can serve the use case after
  the UI maps its route, authentication, inputs, or response shape.
- `PLACEHOLDER`: explicitly disabled or inert in the donor UI; it must not imply
  that a protected or destructive operation occurred.
- `FUTURE_BACKEND`: requires a new backend capability, data model, or platform
  integration beyond this current Worker surface.

The follow-up remains within corrective Epic #77. Issue #39 remains CLOSED for the
historical server-rendered acceptance, and Issue #47 remains Done. This matrix
does not change that history or authorize production PRE-FLIGHT/RELEASE.
