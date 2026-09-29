# P7 CLOSEOUT — PRODUCTION UPDATE SETTLEMENT

> Historical production update packet. SHA, Worker version, and action state in this packet describe its recorded event only; see the dated governance evidence snapshot for the audited v0.1.0 baseline.


**Scope:** Closeout record for the existing-Worker UPDATE path for
Skyline-Gazer/CFWorker4AliCDT. The production UPDATE completed successfully;
this document records the verified deployment and post-UPDATE observation.

## Program and revision

```text
PROGRAM_STATUS=UPDATE_SUCCESSFUL_POST_UPDATE_OBSERVED
CURRENT_MAIN_SHA=38a3e09b38411b140deb5a1d2dffb349b4fdb302
RECOMMENDED_UPDATE_SHA=38a3e09b38411b140deb5a1d2dffb349b4fdb302
LAST_PRODUCTION_DEPLOYED_SHA=38a3e09b38411b140deb5a1d2dffb349b4fdb302
ISSUE=Refs #116 #77 #128 #129
PRODUCTION_DEPLOYED=YES
WORKER_VERSION_ID=5d7001df-35ed-460e-bd00-ad1ef07194c7
UPDATE_RUN=https://github.com/Skyline-Gazer/CFWorker4AliCDT/actions/runs/36430555069 SUCCESS
NEXT_OWNER_GATE=#90–#93 deferred OWNER_GATE backlog + optional ENABLE_MANUAL_* / ENABLE_BILLING decisions; no further UPDATE of this live tip
```

## CI result

```text
TIP_MERGE_COMMITS=#123 dcda7b0 (webhook), #125 5cfd1b6 (Telegram), #127 19cea6a (SMTP), #131 a9d25e0 (save_config UX), #132 51c5d3c (monthly billing UX), #134 38a3e09 (docs sync; live tip)
TIP_CI=SUCCESS on each feature PR (Format, lint, typecheck, test); docs PRs as applicable
LOCAL_VALIDATE=PASS (Node 22; 912 tests on #129 tip before merge)
PRODUCTION_DEPLOYED_FOR_TIP_38a3e09=YES
UPDATE_DISPATCHED=YES (https://github.com/Skyline-Gazer/CFWorker4AliCDT/actions/runs/36430555069 SUCCESS)
```

## Production diff summary (history since previous deployment `76f093f`)

The feature commits below remain the application history since previous
production SHA `76f093f`. The current live tip also includes #134 `38a3e09`, a
docs sync; the UPDATE deployed that tip.

| SHA | Summary |
| --- | --- |
| `dcda7b0` (#123 / #122) | FEATURE — gated manual webhook test-send (`ENABLE_MANUAL_WEBHOOK_TEST`, default-off) |
| `5cfd1b6` (#125 / #124) | FEATURE — gated manual Telegram test-send (`ENABLE_MANUAL_TELEGRAM_TEST`, default-off) |
| `19cea6a` (#127 / #126) | FEATURE — gated manual SMTP test-send via `cloudflare:sockets` (`ENABLE_MANUAL_SMTP_TEST`, default-off); see `docs/architecture/worker-smtp.md` |
| `720dc77` (#130) | DOCS — prior UPDATE packet refresh for tip `19cea6a` |
| `a9d25e0` (#131 / #128) | FEATURE/UX — `save_config` Option C clearer unavailable UX (still HTTP 501 `BACKEND_NOT_AVAILABLE`; no persistence) |
| `51c5d3c` (#132 / #129) | FEATURE/UX — monthly billing Option C: `monthly_available: false`; balance-only donor UI; no new IAM |
| `5bc2ebe` (#133) | DOCS — UPDATE packet refresh for tip including #128/#129 Option C |
| `38a3e09` (#134) | DOCS — closeout sync for the live production tip |

Application paths changed vs `76f093f` (excluding pure docs/tests): `scripts/resolve-deploy-config.mjs`, `src/aliyun/api.ts`, `src/config.ts`, `src/index.ts`, `src/notify/smtp.ts`, `src/notify/telegram.ts`, `src/web/donor-actions.ts`, `src/web/router.ts`, `static/index.html`, plus workflow var passthrough for the three `ENABLE_MANUAL_*` gates.

### Capability honesty (not “fully operational”)

- `get_config` — **ADAPTER** (safe read). `save_config` — **PLACEHOLDER** / fail-closed HTTP 501 `BACKEND_NOT_AVAILABLE` with clearer Option C UX (**#128** landed). No D1 persistence; operators must not enter secrets in the dashboard; change Worker vars/Secrets out-of-band.
- Notification **manual test-sends** — **ADAPTER (gated)**:
  - `send_test_webhook` when `WEBHOOK_URL` configured **and** `ENABLE_MANUAL_WEBHOOK_TEST` truthy
  - `send_test_telegram` when Telegram credentials configured **and** `ENABLE_MANUAL_TELEGRAM_TEST` truthy
  - `send_test_email` when `SMTP_HOST`/`SMTP_FROM` configured **and** `ENABLE_MANUAL_SMTP_TEST` truthy
  - Production gates remain unset and transports are unset; live calls returned HTTP 501 `*_NOT_CONFIGURED`. With credentials present but gate off → explicit `*_MANUAL_*_TEST_DISABLED` (501). With gate on, transport failure returns honest non-500 JSON (`mutation: false`).
  - **All three gates remain unset in production** unless a **separate** owner authorization enables them.
- Cron scheduled webhook sender unchanged. SMTP details: `docs/architecture/worker-smtp.md` (no nodemailer; port 25 prohibited; 465 TLS / 587 STARTTLS).
- `get_billing` — fail-closed when `ENABLE_BILLING` off; **ADAPTER** balance-only when on **and** BSS IAM present. Option C (**#129** landed): `monthly_available: false`, `monthly_cost: null`; donor UI shows **账户余额** only and states monthly spend unavailable. **No new BSS/IAM.**
- `control_instance` remains **PLACEHOLDER**; Cron (`*/10 * * * *`) is the sole ECS mutation authority.
- **#90–#93** (multi-account / manual Start-Stop / daily schedule / keep-alive) remain **inactive** owner gates — see `docs/release/p7-owner-gates-90-93.md`.

### New / changed variables

| Variable | Required? | Default | Notes |
| --- | --- | --- | --- |
| `ENABLE_BILLING` | No | unset / omitted (default-off) | Optional. Resolver omits when unset/empty. Runtime enables only for `1`/`true`/`yes` (case-insensitive). **Do not set true in production without separate owner auth + BSS IAM.** |
| `ENABLE_MANUAL_WEBHOOK_TEST` | No | unset / omitted (default-off) | Optional. Same truthy parse / omit-when-unset wiring as billing. **Must remain unset in production unless separate owner auth.** |
| `ENABLE_MANUAL_TELEGRAM_TEST` | No | unset / omitted (default-off) | Same pattern. **Must remain unset in production unless separate owner auth.** |
| `ENABLE_MANUAL_SMTP_TEST` | No | unset / omitted (default-off) | Same pattern. **Must remain unset in production unless separate owner auth.** |
| BSS IAM `QueryAccountBalance` (`bssopenapi.aliyuncs.com`) | — | **NOT applied** | OWNER GATE. This packet does **not** grant Alibaba RAM/BSS permission. |

No change to required secrets (`ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, `ADMIN_TOKEN`). Optional notification secrets (`WEBHOOK_*`, `SMTP_*`, `TELEGRAM_*`) stay Worker Secrets / bindings — never D1, never returned by the API.

## D1 migrations

```text
MIGRATIONS_ON_MAIN=0001_traffic_checks.sql, 0002_decision_reason.sql
NEWER_THAN_0002=NONE
0002_ALREADY_APPLIED_IN_PRODUCTION=YES (per prior UPDATE path; additive nullable decision_reason)
EXPECTED_REMOTE_MIGRATION_WORK_THIS_UPDATE=none beyond re-apply no-op if already applied
```

## Verified Cron / domain / Secret state

```text
CRON=*/10 * * * *
DOMAIN=cdt.q9m3.com
EXPECTED_SECRETS_REQUIRED=ALIYUN_ACCESS_KEY_ID, ALIYUN_ACCESS_KEY_SECRET, ADMIN_TOKEN
SECRETS_VALUES=unchanged (workflow verifies names only; never prints values)
```

## UPDATE path (owner-operated only)

- Resolver: `scripts/resolve-deploy-config.mjs --mode update` → ignored `wrangler.update.jsonc`.
- Workflow: `.github/workflows/update.yml` (workflow_dispatch only, protected `production` Environment).
- Required inputs (no defaults): `confirmation=UPDATE`, `EXISTING_WORKER_CONFIRMED=YES`, explicit `HTTP_EXPOSURE_MODE=custom_domain` (or `workers_dev` if that is the live mode).
- Order: validate → resolve UPDATE config → `wrangler d1 migrations apply` → `wrangler deploy` → assert required Worker Secret **names**.
- **Rollback via UPDATE only** (restore known-good application code on `main`, then UPDATE). **Never PRE-FLIGHT** against the live Cron service — PRE-FLIGHT emits `triggers.crons = []` and would remove the schedule.

## Post-UPDATE observation summary

```text
OBSERVATION_START=2026-09-28T14:46:20Z
OBSERVATION_END≈2026-09-28T14:52:24Z
EXPECTED_CRON_IN_WINDOW=1 OBSERVED=1 SUCCESS=1 FAILED=0
LAST_SUCCESSFUL_EXECUTION=2026-09-28T14:50:38Z id=421
POST_UPDATE_CRON_ROW=id=421 time=2026-09-28T14:50:38Z action=none-running
PRE_UPDATE_CADENCE=~10min (ids 417–420)
trafficBytes=40663500 → traffic_gb≈0.03787 (confirms 1024^3)
threshold_gb=180; decision=fail-closed none-running while Running
save_config=501 BACKEND_NOT_AVAILABLE (Option C message)
get_billing=available:false monthly_available:false
control_instance=501 FEATURE_NOT_IMPLEMENTED
send_test_*=501 *_NOT_CONFIGURED (gates off + transports unset)
ENABLE_*=unset before and after UPDATE (repo vars; remain off)
CRON=*/10 * * * *
DOMAIN=cdt.q9m3.com
```

## Remaining owner decisions (not activated)

| Topic | Issue | Packet |
| --- | --- | --- |
| `save_config` persistence | **#128** Option C **landed** (UX only; still no persistence) | `docs/release/p7-owner-decision-save-config-monthly.md` |
| Monthly billing availability | **#129** Option C **landed** (`monthly_available: false`; no new IAM) | same |
| Multi-account / HTTP Start-Stop / schedule / keep-alive | **#90–#93** still deferred | `docs/release/p7-owner-gates-90-93.md` |
| Tracking placeholders / follow-ups | **#116** | capability matrix in `docs/planning/p7-donor-api-compatibility.md` |

## Production action state

```text
PRODUCTION_DEPLOYED=YES
PRODUCTION_SHA=38a3e09b38411b140deb5a1d2dffb349b4fdb302
WORKER_VERSION_ID=5d7001df-35ed-460e-bd00-ad1ef07194c7
PRE_FLIGHT_DISPATCHED=NO
RELEASE_DISPATCHED=NO
UPDATE_DISPATCHED=YES (run 36430555069 SUCCESS)
ENABLE_BILLING_IN_PRODUCTION=unset/off (confirmed in GitHub repository variables — not present)
ENABLE_MANUAL_WEBHOOK_TEST_IN_PRODUCTION=unset/off (confirmed — not present)
ENABLE_MANUAL_TELEGRAM_TEST_IN_PRODUCTION=unset/off (confirmed — not present)
ENABLE_MANUAL_SMTP_TEST_IN_PRODUCTION=unset/off (confirmed — not present)
BSS_IAM_APPLIED=NO
GATES_90_93_ACTIVE=NO
NEXT_OWNER_GATE=#90–#93 deferred OWNER_GATE backlog + optional ENABLE_MANUAL_* / ENABLE_BILLING decisions; no further UPDATE of this live tip
```

## P7 Milestone-1 closeout settlement

Issue **#116** placeholder tracking is settled for the approved product-completion
scope: the supported paths are implemented, gated, or explicitly deferred under
the #128/#129 Option C decisions. Epic **#77 Milestone-1** and its approved
product-completion scope are complete. Issues **#90–#93 remain open** as deferred
`OWNER_GATE` backlog; they are not Done. The [donor compatibility matrix](../planning/p7-donor-api-compatibility.md)
records capability status, and the [successful UPDATE run](https://github.com/Skyline-Gazer/CFWorker4AliCDT/actions/runs/36430555069)
plus this post-UPDATE observation summary record production evidence.

This closeout documents the already-verified UPDATE. No PRE-FLIGHT or RELEASE
was dispatched, and no enablement, D1 mutation, ECS mutation, or notification was
performed as part of this documentation edit.
