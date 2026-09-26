# OWNER AUTHORIZATION — PRE-FLIGHT/RELEASE VERIFICATION PACKET

**Packet scope:** documentation for owner review only. It does not dispatch a
workflow, contact a production account, or authorize a deployment.

## Revision and source

- `MAIN_SHA`: `f3c6522ce935b155c0c288fe224b2c48b21c9716` — current `main` tip after
  WEB-10/11 squash-merge (PR #103). Includes nullable `decision_reason`,
  aggregation audit surfaces, and this verification packet.
- Related work: Refs #87 #88 (DoD verified post-merge; Issues closed when Project
  Status set to Done).
- `PRODUCTION_DEPLOYED=NO`
- `PRE-FLIGHT_DISPATCHED=NO`
- `RELEASE_DISPATCHED=NO`
- `OWNER_AUTHORIZATION=NOT_GIVEN`

The prior production release baseline is **none**: the owner context records no
production PRE-FLIGHT or RELEASE. Configuration deltas below are measured against
the post-WEB-10/11 `main` SHA above, not against a production deployment.

## Adapter inventory

| Capability | State | Review notes |
| --- | --- | --- |
| `login`, `check_login` | `ADAPTED` | Use the existing Basic/Bearer `ADMIN_TOKEN` gate. Login creates no server session and returns no credential. |
| `get_status` | `ADAPTED` | Live query for one configured ECS instance. Includes the actual decision reason, the all-returned-entry summation scope, and CDT business-region byte totals. |
| `refresh_account` | `ADAPTED` | Repeats that read-only live query. The donor ID is ignored; it performs no D1 write and no ECS mutation. |
| `get_history` | `ADAPTED` | Reads at most 200 real D1 rows. Charts use actual traffic samples; up to five recent stored reasons are returned, with unknown reasons preserved as `null`. |
| `control_instance` | `PLACEHOLDER` | HTTP 501, `FEATURE_NOT_IMPLEMENTED`, `success: false`, `mutation: false`; no ECS call. |
| `clear_logs` | `PLACEHOLDER` | HTTP 501; no delete operation. |
| `logout` | `PLACEHOLDER` | Server action remains HTTP 501. The page can clear its in-memory Bearer token; no server session exists. |
| `check_init`, `setup`, `get_config`, `save_config` | `FUTURE_BACKEND` | No initialization, account setup, browser config read, or config write API. |
| `send_test_email`, `send_test_telegram`, `send_test_webhook` | `FUTURE_BACKEND` | No notification-test capabilities. |
| `get_logs` | `FUTURE_BACKEND` | No application log API or log store. D1 monitoring history remains a separate read-only surface. |

## Regression guarantees

- The Cron Trigger remains the only ECS mutation authority. Authenticated HTTP
  status, refresh, history, and query paths are read-only.
- `control_instance` stays a 501 placeholder with `mutation: false`; `clear_logs`
  and `logout` stay placeholders. No control, config-write, setup, or notification
  test capability is introduced by this work.
- Access keys, `ADMIN_TOKEN`, and webhook credentials are not stored in D1 or sent
  to browser code. The UI keeps its Bearer token in page memory and sends it in the
  Authorization header. Secrets are not placed in logs, fixtures, notices, or
  this packet.
- CDT traffic is converted from bytes to console-aligned GB using the existing
  `1024^3` divisor. Audit detail remains in bytes and does not alter the total used
  by `decide()`.
- Authentication remains fail-closed. Missing, malformed, or invalid credentials
  do not expose the UI or protected API.
- Reasons are persisted only when `decide()` actually produced one. Migration
  `0002_decision_reason.sql` adds a nullable column; old rows and pre-decision
  failures remain `NULL`. No historical reason is synthesized.
- Aggregation audit fields describe the entries returned by the one configured
  CDT credential set. `BusinessRegionId` is distinct from the ECS `REGION_ID`;
  missing identifiers remain unknown, and no account rows are invented.
- History charts contain only stored observations: 24-hour actual samples and
  latest known snapshots per UTC date for 30 days. No zero-filled dates or
  historical regional series are generated.

## D1, binding, Wrangler, and Static Assets deltas

| Area | Confirmed shared-main baseline | WEB-10/11 branch delta |
| --- | --- | --- |
| D1 schema | `TRAFFIC_DB` uses versioned migrations in `migrations/`. | Add `0002_decision_reason.sql`, an additive nullable `TEXT` column. It has no default and no backfill, so existing rows remain `NULL`. The gated deployment workflow must apply migrations before deploying code that reads or writes the new column. |
| Bindings | `TRAFFIC_DB` and `ASSETS` are already declared. | No binding names are added, removed, or renamed. |
| `wrangler.jsonc` | D1 `database_name` and `migrations_dir` are declared without a committed `database_id`. Static Assets use `./static`, binding `ASSETS`, `html_handling: none`, SPA not-found handling, and `run_worker_first: true`. | No Wrangler configuration change. No production database identifier is added. |
| Static Assets | Worker serves the imported donor UI from `./static`. | `static/index.html` displays the live decision reason and CDT business-region totals, and shows recent stored decision reasons alongside the existing real-data history charts. Asset directory, binding, fallback, and routing configuration do not change. |

The production database ID remains an owner-supplied deployment input resolved by the
existing gated deployment process. This branch has not run a deployment or a remote
migration.

## Owner decision gate

This packet is ready for owner review at the `MAIN_SHA` above. The owner decides
separately whether to authorize any later PRE-FLIGHT or RELEASE. Until then:

```text
PRODUCTION_DEPLOYED=NO
PRE-FLIGHT_DISPATCHED=NO
RELEASE_DISPATCHED=NO
```
