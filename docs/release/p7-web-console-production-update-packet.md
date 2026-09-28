# OWNER REVIEW — PRODUCTION UPDATE PACKET

**Scope:** Existing-Worker UPDATE path for Skyline-Gazer/CFWorker4AliCDT. This is
an owner review packet only. It authorizes **no production deployment**.

## Program and revision

```text
PROGRAM_STATUS=UPDATE_PATH_MERGED_AWAITING_OWNER_AUTHORIZATION
CURRENT_MAIN_SHA=5bc2ebebe6c12cb1cbc752c14422812561ff040d
RECOMMENDED_UPDATE_SHA=5bc2ebebe6c12cb1cbc752c14422812561ff040d
LAST_PRODUCTION_DEPLOYED_SHA=76f093f38acc94d609eccddcdb1c6db77f290109
ISSUE=Refs #116 #77 #128 #129
PRODUCTION_DEPLOYED=NO
NEXT_OWNER_GATE=OWNER AUTHORIZATION — PRODUCTION UPDATE (tip 5bc2ebe) + separate ENABLE_MANUAL_* / ENABLE_BILLING / #90–#93 decisions
```

## CI result

```text
TIP_MERGE_COMMITS=#123 dcda7b0 (webhook), #125 5cfd1b6 (Telegram), #127 19cea6a (SMTP), #131 a9d25e0 (save_config UX), #132 51c5d3c (monthly billing UX)
TIP_CI=SUCCESS on each feature PR (Format, lint, typecheck, test); docs PRs as applicable
LOCAL_VALIDATE=PASS (Node 22; 912 tests on #129 tip before merge)
PRODUCTION_DEPLOYED_FOR_TIP_5bc2ebe=NO
UPDATE_DISPATCHED=NO
```

## Production diff summary (since last deployed `76f093f`)

Commits on current `main` after last deployed production SHA `76f093f`:

| SHA | Summary |
| --- | --- |
| `dcda7b0` (#123 / #122) | FEATURE — gated manual webhook test-send (`ENABLE_MANUAL_WEBHOOK_TEST`, default-off) |
| `5cfd1b6` (#125 / #124) | FEATURE — gated manual Telegram test-send (`ENABLE_MANUAL_TELEGRAM_TEST`, default-off) |
| `19cea6a` (#127 / #126) | FEATURE — gated manual SMTP test-send via `cloudflare:sockets` (`ENABLE_MANUAL_SMTP_TEST`, default-off); see `docs/architecture/worker-smtp.md` |
| `720dc77` (#130) | DOCS — prior UPDATE packet refresh for tip `19cea6a` |
| `a9d25e0` (#131 / #128) | FEATURE/UX — `save_config` Option C clearer unavailable UX (still HTTP 501 `BACKEND_NOT_AVAILABLE`; no persistence) |
| `51c5d3c` (#132 / #129) | FEATURE/UX — monthly billing Option C: `monthly_available: false`; balance-only donor UI; no new IAM |
| `5bc2ebe` (#133) | DOCS — UPDATE packet refresh for tip including #128/#129 Option C |

Application paths changed vs `76f093f` (excluding pure docs/tests): `scripts/resolve-deploy-config.mjs`, `src/aliyun/api.ts`, `src/config.ts`, `src/index.ts`, `src/notify/smtp.ts`, `src/notify/telegram.ts`, `src/web/donor-actions.ts`, `src/web/router.ts`, `static/index.html`, plus workflow var passthrough for the three `ENABLE_MANUAL_*` gates.

### Capability honesty (not “fully operational”)

- `get_config` — **ADAPTER** (safe read). `save_config` — **PLACEHOLDER** / fail-closed HTTP 501 `BACKEND_NOT_AVAILABLE` with clearer Option C UX (**#128** landed). No D1 persistence; operators must not enter secrets in the dashboard; change Worker vars/Secrets out-of-band.
- Notification **manual test-sends** — **ADAPTER (gated)**:
  - `send_test_webhook` when `WEBHOOK_URL` configured **and** `ENABLE_MANUAL_WEBHOOK_TEST` truthy
  - `send_test_telegram` when Telegram credentials configured **and** `ENABLE_MANUAL_TELEGRAM_TEST` truthy
  - `send_test_email` when `SMTP_HOST`/`SMTP_FROM` configured **and** `ENABLE_MANUAL_SMTP_TEST` truthy
  - With credentials present but gate off → explicit `*_MANUAL_*_TEST_DISABLED` (501). With gate on, transport failure returns honest non-500 JSON (`mutation: false`).
  - **All three gates must remain unset in production** unless a **separate** owner authorization enables them.
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
- **Do not dispatch UPDATE for tip `5bc2ebe` until owner authorization.** This packet alone is not authorization.

## Post-update acceptance checks (after future owner auth)

1. Worker version matches `CURRENT_MAIN_SHA` / `RECOMMENDED_UPDATE_SHA` (`5bc2ebe…`) or the owner-authorized tip.
2. Cron still `*/10 * * * *`; domain still `cdt.q9m3.com` (if custom_domain).
3. `GET /health` liveness OK; authenticated dashboard loads.
4. `get_config` returns allowlisted non-secret fields only.
5. `control_instance` still HTTP 501 / non-mutating.
6. `save_config` still HTTP 501 `BACKEND_NOT_AVAILABLE`; donor save control disabled / unavailable notice visible.
7. `ENABLE_MANUAL_WEBHOOK_TEST`, `ENABLE_MANUAL_TELEGRAM_TEST`, and `ENABLE_MANUAL_SMTP_TEST` remain **unset** unless a **separate** owner decision enabled them; with gates unset, configured transports still return `*_MANUAL_*_TEST_DISABLED` (or not-configured codes when bindings missing).
8. `ENABLE_BILLING` remains unset/false unless a **separate** owner decision sets the variable **and** authorizes BSS IAM. When billing is off, fail-closed. When on, balance-only; `monthly_available: false`.
9. No secret values appear in workflow logs.
10. D1 still at migration `0002` (no newer migration expected).

## Remaining owner decisions (not activated by this packet)

| Topic | Issue | Packet |
| --- | --- | --- |
| `save_config` persistence | **#128** Option C **landed** (UX only; still no persistence) | `docs/release/p7-owner-decision-save-config-monthly.md` |
| Monthly billing availability | **#129** Option C **landed** (`monthly_available: false`; no new IAM) | same |
| Multi-account / HTTP Start-Stop / schedule / keep-alive | **#90–#93** still deferred | `docs/release/p7-owner-gates-90-93.md` |
| Tracking placeholders / follow-ups | **#116** | capability matrix in `docs/planning/p7-donor-api-compatibility.md` |

## Production action state

```text
PRODUCTION_DEPLOYED=NO
PRE_FLIGHT_DISPATCHED=NO
RELEASE_DISPATCHED=NO
UPDATE_DISPATCHED=NO
ENABLE_BILLING_IN_PRODUCTION=unset/off (confirmed in GitHub repository variables — not present)
ENABLE_MANUAL_WEBHOOK_TEST_IN_PRODUCTION=unset/off (confirmed — not present)
ENABLE_MANUAL_TELEGRAM_TEST_IN_PRODUCTION=unset/off (confirmed — not present)
ENABLE_MANUAL_SMTP_TEST_IN_PRODUCTION=unset/off (confirmed — not present)
BSS_IAM_APPLIED=NO
GATES_90_93_ACTIVE=NO
NEXT_OWNER_GATE=OWNER AUTHORIZATION — PRODUCTION UPDATE of 5bc2ebe (optional) + ENABLE_MANUAL_* / ENABLE_BILLING / #90–#93 decisions
```

No production Cron, domain, D1 database, Worker secret value, GitHub variable, or ECS resource was contacted or changed by preparing this packet.
