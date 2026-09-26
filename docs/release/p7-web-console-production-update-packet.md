# OWNER REVIEW — PRODUCTION UPDATE PACKET

**Scope:** Existing-Worker UPDATE path for Skyline-Gazer/CFWorker4AliCDT. This is
an owner review packet only. Decision C authorizes **no production deployment**.

## Program and revision

```text
PROGRAM_STATUS=UPDATE_PATH_READY_FOR_OWNER_REVIEW_PENDING_MERGE
CURRENT_MAIN_SHA=ad671bc1f186faf78c3f063858eedc72ee5bb1fe (base; executor refreshes after merge)
LAST_PRODUCTION_RELEASE_SHA=106f4d214a883ac9bfdf0798110f845092fbe971
ISSUE=Refs #105
```

## Audit summary

Commits on current `main` after production RELEASE `106f4d21`:

- `c9edaa1` recorded the measured Workers Free Cron CPU result.
- `0fd6b21` (Refs #100) added donor provenance and API compatibility documentation.
- `b25941f` (Refs #101) added the static donor UI and the `ASSETS` binding/configuration.
- `dbbf226` (Refs #102) added authenticated status, refresh, and history adapters; the
  donor control action remains a non-mutating placeholder.
- `f3c6522` (Refs #103) added decision-reason auditability and
  `0002_decision_reason.sql`. The migration adds a nullable column without backfill.
- `ad671bc` (Refs #104) refreshed the Milestone-1 release packet's main SHA.

The code changes since the last production release add the dashboard/static assets,
read-only donor surfaces, and additive decision-reason reporting. The control path
only carries the decision reason for auditability; **ECS mutation semantics and the
Cron-only ECS mutation authority do not change**. The current main tip remains held
and has not been deployed.

## Local validation evidence

```text
LOCAL_VALIDATE=PASS
COMMAND=npm run validate
EVIDENCE=Format, lint, typecheck, test (801 passed / 24 files), deploy:dry-run PASS on branch feat/ops-existing-worker-update-path (Asia/Shanghai 2026-09-26 ~20:11)
UPDATE_SMOKE=resolver --mode update emits triggers.crons=["*/10 * * * *"], secrets.required retained, custom_domain cdt.q9m3.com; --mode preflight still emits []
```

## UPDATE path

- Resolver: `scripts/resolve-deploy-config.mjs --mode update` writes the ignored
  root-level `wrangler.update.jsonc` artifact.
- Workflow: `.github/workflows/update.yml`, workflow-dispatch only, protected
  `production` Environment, main-ref guard, and a separate non-cancelling
  `deploy-update` concurrency group.
- Required inputs, with no defaults: `confirmation=UPDATE`,
  `EXISTING_WORKER_CONFIRMED=YES`, and an explicit
  `HTTP_EXPOSURE_MODE=workers_dev|custom_domain`.
- The existing-Worker attestation confirms that the Worker exists and its Cron is
  already live. UPDATE does not require `LIVE_READ_ONLY_VERIFIED`, which is the
  first-deployment RELEASE gate.
- The generated config carries Cron `*/10 * * * *`, keeps the selected HTTP
  exposure (`cdt.q9m3.com` when the owner selects the current custom-domain mode),
  disables temporary preview URLs, and retains committed `secrets.required`.
- Workflow order: validate and check required inputs → resolve UPDATE config →
  apply remote D1 migrations → deploy with that config → verify required Worker
  Secret names. No secret values are printed.
- After update, verify Cron remains present, review the migration result, and check
  the console and health endpoint.

PRE-FLIGHT is only for creating a new Worker. Its `triggers.crons = []` removes all
Cron Triggers; do not use PRE-FLIGHT against the live Cron service.

## Migration plan — `0002_decision_reason.sql`

`0002_decision_reason.sql` runs:

```sql
ALTER TABLE traffic_checks ADD COLUMN decision_reason TEXT;
```

This is additive and nullable, with no default and no backfill; existing rows stay
`NULL`. Apply the remote migration **before** deploying Worker code that writes
`decision_reason`. The UPDATE workflow orders `wrangler d1 migrations apply` before
`wrangler deploy` and passes `wrangler.update.jsonc` to both commands. No remote D1
migration has been run for this packet.

## Expected Cron

```text
EXPECTED_CRON_AFTER_UPDATE=*/10 * * * *
```

## Rollback

If an update regresses, prepare a reviewed `main` commit that restores the last
known-good application code from `LAST_PRODUCTION_RELEASE_SHA` while retaining the
UPDATE workflow/resolver and the already-applied additive migration. Then use the
UPDATE workflow with the same explicit Cron and HTTP exposure confirmations. The
nullable column is backward-compatible and remains applied. Never use PRE-FLIGHT
for rollback; its empty Cron array removes the live schedule.

## Production action state

```text
PRODUCTION_DEPLOYED=NO
PRE_FLIGHT_DISPATCHED=NO
RELEASE_DISPATCHED=NO
UPDATE_DISPATCHED=NO
NEXT_OWNER_GATE=OWNER AUTHORIZATION — PRODUCTION UPDATE
```

No production Cron, domain, D1 database, or ECS resource was contacted or changed.
