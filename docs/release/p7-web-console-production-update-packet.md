# OWNER REVIEW — PRODUCTION UPDATE PACKET

**Scope:** Existing-Worker UPDATE path for Skyline-Gazer/CFWorker4AliCDT. This is
an owner review packet only. It authorizes **no production deployment**.

## Program and revision

```text
PROGRAM_STATUS=UPDATE_PATH_MERGED_AWAITING_OWNER_AUTHORIZATION
CURRENT_MAIN_SHA=433cb5ea7017f120584572d5a9e7124a25d5f75e
LAST_PRODUCTION_DEPLOYED_SHA=471dda0758ea21ec9b6e2f30a33c815ec70100fd
ISSUE=Refs #115 #116
PRODUCTION_DEPLOYED=NO
NEXT_OWNER_GATE=OWNER AUTHORIZATION — PRODUCTION UPDATE
```

## CI result

```text
PR=#117
PR_CI=SUCCESS (Format, lint, typecheck, test)
MERGE_COMMIT=fc71143414e0f567acfb3845d0c82cd48c1b2659
MAIN_CI=SUCCESS https://github.com/Skyline-Gazer/CFWorker4AliCDT/actions/runs/36315698833
LOCAL_VALIDATE=PASS (npm run validate; 853 tests on the ENABLE_BILLING wiring branch before merge)
DOCS_ONLY_AFTER_WIRING=PR #118 production UPDATE packet + PR #119 owner-gates #90–#93 (no Worker code change after fc71143)
```

## Production diff summary (FEATURE + wiring + docs since `471dda07`)

Commits on current `main` after last deployed production SHA `471dda07`:

| SHA | Summary |
| --- | --- |
| `5a7758c` (#108) | FEATURE — adapt donor `get_config` safe non-secret fields |
| `22c64a1` (#109) | FEATURE — adapt donor `get_logs` from bounded D1 history |
| `f2d76f6` (#110) | FEATURE — read-only BSS billing enrichment behind `ENABLE_BILLING` (default-off) |
| `88488ce` (#111) | FEATURE — webhook metadata + fail-closed `send_test_webhook` |
| `e535724` (#112) | FEATURE — fail-closed SMTP test send + `smtp_configured` flag |
| `9dd1e07` (#113) | FEATURE — fail-closed Telegram test send + `telegram_configured` flag |
| `928e965` (#114) | docs — FEATURE-11 donor parity audit |
| `82ecde0` / `fc71143` (#117) | OPS — wire optional `ENABLE_BILLING` through deploy resolver + workflows; reconcile capability matrix (Refs #115 #116) |
| `b6b0923` (#118) | docs — production UPDATE packet refresh |
| `433cb5e` (#119) | docs — owner gates #90–#93 decision packet (no activation) |

### Capability honesty (not “fully operational”)

- `get_config` — **ADAPTER** (safe read). `save_config` — **PLACEHOLDER** / not operational.
- SMTP / Telegram / webhook **test sends** — **PLACEHOLDER** fail-closed; transports not activated. Cron scheduled webhook sender unchanged.
- `get_billing` — fail-closed when `ENABLE_BILLING` off; **ADAPTER** balance-only when on **and** BSS IAM present. **Monthly billing NOT AVAILABLE**.
- `control_instance` remains **PLACEHOLDER**; Cron (`*/10 * * * *`) is the sole ECS mutation authority.

### New / changed variables

| Variable | Required? | Default | Notes |
| --- | --- | --- | --- |
| `ENABLE_BILLING` | No | unset / omitted (default-off) | Optional GitHub Variable / Worker var. Resolver omits when unset/empty; injects trimmed value when set. Runtime enables only for `1`/`true`/`yes` (case-insensitive). **Do not set true in production without separate owner auth.** |
| BSS IAM `QueryAccountBalance` (`bssopenapi.aliyuncs.com`) | — | **NOT applied** | OWNER GATE. This packet does **not** grant Alibaba RAM/BSS permission. Enabling billing in production requires both the variable **and** separate IAM authorization. |

No change to required secrets (`ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, `ADMIN_TOKEN`).

## D1 migrations

```text
MIGRATIONS_ON_MAIN=0001_traffic_checks.sql, 0002_decision_reason.sql
NEWER_THAN_0002=NONE
0002_ALREADY_APPLIED_IN_PRODUCTION=YES (per prior UPDATE path; additive nullable decision_reason)
EXPECTED_REMOTE_MIGRATION_WORK_THIS_UPDATE=none beyond re-apply no-op if already applied
```

## Expected Cron / domain / Secret state (unchanged)

```text
EXPECTED_CRON_AFTER_UPDATE=*/10 * * * *
EXPECTED_DOMAIN=cdt.q9m3.com (custom_domain exposure; owner confirms current mode)
EXPECTED_SECRETS_REQUIRED=ALIYUN_ACCESS_KEY_ID, ALIYUN_ACCESS_KEY_SECRET, ADMIN_TOKEN
SECRETS_VALUES=unchanged (workflow verifies names only; never prints values)
```

## UPDATE path (owner-operated only)

- Resolver: `scripts/resolve-deploy-config.mjs --mode update` → ignored `wrangler.update.jsonc`.
- Workflow: `.github/workflows/update.yml` (workflow_dispatch only, protected `production` Environment).
- Required inputs (no defaults): `confirmation=UPDATE`, `EXISTING_WORKER_CONFIRMED=YES`, explicit `HTTP_EXPOSURE_MODE=custom_domain` (or `workers_dev` if that is the live mode).
- Order: validate → resolve UPDATE config → `wrangler d1 migrations apply` → `wrangler deploy` → assert required Worker Secret **names**.
- **Rollback via UPDATE only** (restore known-good application code on `main`, then UPDATE). **Never PRE-FLIGHT** against the live Cron service — PRE-FLIGHT emits `triggers.crons = []` and would remove the schedule.

## Post-update acceptance checks (after future owner auth)

1. Worker version matches `CURRENT_MAIN_SHA` (or the owner-authorized tip).
2. Cron still `*/10 * * * *`; domain still `cdt.q9m3.com` (if custom_domain).
3. `GET /health` liveness OK; authenticated dashboard loads.
4. `get_config` returns allowlisted non-secret fields only.
5. `control_instance` still HTTP 501 / non-mutating.
6. Notification test actions still fail-closed (no transport activation).
7. `ENABLE_BILLING` remains unset/false unless a **separate** owner decision sets the variable **and** authorizes BSS IAM.
8. No secret values appear in workflow logs.

## Production action state

```text
PRODUCTION_DEPLOYED=NO
PRE_FLIGHT_DISPATCHED=NO
RELEASE_DISPATCHED=NO
UPDATE_DISPATCHED=NO
ENABLE_BILLING_IN_PRODUCTION=unset/off (expected)
BSS_IAM_APPLIED=NO
NEXT_OWNER_GATE=OWNER AUTHORIZATION — PRODUCTION UPDATE
```

No production Cron, domain, D1 database, Worker secret value, or ECS resource was contacted or changed by preparing this packet.
