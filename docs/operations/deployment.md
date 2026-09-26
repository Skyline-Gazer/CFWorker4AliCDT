# Deployment and operations

Deployment is **manual and owner-gated**. No CI job deploys, and no scheduled ECS
mutation occurs without explicit owner authorization.

> **No credential value is ever printed, echoed, pasted into an issue, written to
> a log, or committed.** Every command below either prompts for a value or
> references one by name. If you find yourself typing a secret as a command
> argument, stop — the argument is recorded in shell history.

## 0. Initial deployment and normal updates

It is worth being explicit about the difference, because conflating them is what
made the earlier single-stage design unsafe.

| | **Initial bootstrap** | **Existing-Worker update** |
| --- | --- | --- |
| Frequency | Once, for a new Worker | Normal production re-deployments |
| Cron authority | PRE-FLIGHT disables it; RELEASE enables `*/10 * * * *` after live verification | Preserved at `*/10 * * * *` |
| HTTP endpoint | Version URL during verification, then explicit owner choice | Existing exposure is explicitly redeclared |
| Verification | Read-only, live, before first Cron enable | Regression checks, then console and health checks |
| Workflows | `preflight.yml`, then `release.yml` | `update.yml` |
| Config | `wrangler.preflight.jsonc`, then `wrangler.deploy.jsonc` | `wrangler.update.jsonc` |

The bootstrap is two owner actions, not one:

```
preflight deploy  →  Version URL  →  read-only live verification  →  owner confirms
                                                                          │
                                                                          ▼
                                                                   release deploy
                                                          (stable endpoint + Cron)
```

**PRE-FLIGHT is first-deploy only. Never run it against a Worker with live Cron.**
Its generated config writes `triggers.crons = []`, which removes every Cron
Trigger on that Worker. RELEASE is the separate first-Cron-enable action after
live read-only verification. Normal re-deployments use UPDATE, whose config keeps
the production schedule at `*/10 * * * *`.

### Why the bootstrap cannot use `wrangler versions upload`

Cloudflare documents that `wrangler versions upload` **cannot be used for the
first upload of a new Worker project**; the command fails. The first upload must be
`wrangler deploy` (or C3). Once the Worker exists, `update.yml` is the normal
owner-gated path for an application update. It applies pending migrations before
deploying code, keeps the known Cron schedule and HTTP exposure, and checks the
required Worker Secret names after deployment.

So the safe bootstrap is a **real first deploy whose config has Cron explicitly
disabled**. That is what makes it safe: the Worker exists, the code is real, and
there is no schedule that can start or stop an instance.

## 1. Pre-deployment checklist

The owner confirms each item **before** the Worker is allowed to run against a
real account. Nothing here is discoverable from the code; each is an owner
decision or an external fact.

### 1a. The three classes of configuration — do not blur them

Three distinct classes exist, and conflating them causes real deployment defects:

| Class | Lives in | Set by | Examples |
| --- | --- | --- | --- |
| **Application runtime variables** | Generated Wrangler `vars` | GitHub **Variables** | `REGION_ID`, `ECS_INSTANCE_ID`, `TRAFFIC_THRESHOLD_GB` |
| **Deployment-only values** | The resolver / workflow invocation | Repository Variables, `production` Environment Secrets, dispatch inputs | `D1_DATABASE_ID`, `HTTP_EXPOSURE_MODE`, `CLOUDFLARE_API_TOKEN` |
| **Worker Secrets** | Cloudflare Worker Secrets | `wrangler secret put` / Cloudflare secret UI | `ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, `ADMIN_TOKEN` |

The difference that matters: **application runtime variables configure how the
Worker behaves and are not credentials**, so they belong in GitHub Variables, not
Secrets. **Worker Secrets are credentials**, are attached on Cloudflare, and are
never routed through GitHub.

### Deployment trust boundary

All deployment workflows target the `production` GitHub Environment.
The owner must configure that Environment with **required reviewers enabled** and
deployment branches/tags **restricted to `main` only**. These are mandatory
security settings, not optional hardening.

Store `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as **secrets on the
`production` Environment**, not as repository secrets. Keep `REGION_ID`,
`ECS_INSTANCE_ID`, `D1_DATABASE_ID`, and the optional application overrides as
repository Variables; `WORKER_CUSTOM_DOMAIN` may also remain a repository
Variable. `HTTP_EXPOSURE_MODE` remains an explicit RELEASE and UPDATE input.

All workflows also reject refs other than `refs/heads/main` before checkout or
privileged steps. **This workflow-level ref guard is supplementary.** Workflow code
comes from the selected ref, so the authoritative boundary is the `production`
Environment's required reviewer, main-only deployment branch restriction, and
Environment-scoped Cloudflare credentials. Repository tests can check the workflow
files and this runbook; they cannot prove the live Environment is configured.

### 1b. Application runtime repository variables

These become the `vars` block of the generated deployment config. Because the
generated artifact is authoritative, they must be present at generation time.

**Required.** `loadConfig()` rejects a Worker whose environment lacks these, so a
deployment that omitted them would succeed and then fail at the first request:

| Variable | Requirement | Confirmed? |
| --- | --- | --- |
| `REGION_ID` | The ECS region. Used to build `ecs.<REGION_ID>.aliyuncs.com`. | ☐ |
| `ECS_INSTANCE_ID` | **Exactly one** instance. The Worker manages no other. | ☐ |

**Optional overrides.** When the repository variable is unset or empty, the
committed default in `wrangler.jsonc` is preserved — the repository stays the one
place a default is stated:

| Variable | Committed default | Notes |
| --- | --- | --- |
| `TRAFFIC_THRESHOLD_GB` | `180` | Threshold in console-aligned GB; calculated with a `1024^3` divisor. See §5. |
| `CDT_ENDPOINT` | `cdt.aliyuncs.com` | **Unverified** (A1). Confirm at first run. |
| `BUSINESS_REGION_ID` | *(absent)* | When unset, no CDT filter is applied. |
| `SIGNATURE_VERSION` | `v3` | `v2` or `v3`. See §6 if the first run is rejected. |
| `STOPPED_MODE` | `KeepCharging` | **Read §4 before changing.** |

Together these are the SPEC §2.2 **application** variables. Deployment-only values
(§3c) are a separate set and are never added to this table.

**Why the config, not the Cloudflare Dashboard.** Wrangler treats the config as the
source of truth. Without `keep_vars`, a later deploy replaces Dashboard-managed
vars with those in the deployed config, so Dashboard edits are silently lost. Since
this project has a deterministic generated-config boundary, the fix is to keep
resolution there rather than to add hidden Dashboard state via `keep_vars`.

**Credentials must stay Worker Secrets.** Never put `ALIYUN_ACCESS_KEY_ID`,
`ALIYUN_ACCESS_KEY_SECRET`, or `ADMIN_TOKEN` in Wrangler `vars`, GitHub Variables,
or Cloudflare Dashboard plaintext vars. PRE-FLIGHT, RELEASE, and UPDATE deploy the generated
config as the authoritative `vars` set, so a Dashboard plaintext var absent from
that config is removed during deploy. This is how a plaintext `ALIYUN_ACCESS_KEY_ID`
binding can be wiped; use Worker Secrets instead.

**Resolution happens in the resolver, not in the Worker.** The resolver's
responsibility is *deployment completeness*: it fails before generating if a
required variable is absent, and injects values deterministically. It deliberately
does **not** re-implement runtime semantic validation — whether the threshold is a
positive number or the signature version is `v2`/`v3` remains `loadConfig()`'s job,
so there is exactly one implementation of each rule.

### 1c. Worker Secrets — required and optional names, values never committed

| Secret | Requirement | Confirmed? |
| --- | --- | --- |
| `ALIYUN_ACCESS_KEY_ID` | **Required by PRE-FLIGHT's post-deploy gate, RELEASE, and UPDATE.** From the RAM user in `docs/security/ram-policy.md`. | ☐ |
| `ALIYUN_ACCESS_KEY_SECRET` | **Required by PRE-FLIGHT's post-deploy gate, RELEASE, and UPDATE.** Its paired secret. | ☐ |
| `WEBHOOK_URL` | Optional. When set, must be absolute `https://` and enables one webhook attempt per scheduled run. | ☐ |
| `WEBHOOK_TOKEN` | Optional with `WEBHOOK_URL`. When set, sent as `Authorization: Bearer <token>`; token alone is a config error. | ☐ |
| `ADMIN_TOKEN` | **Required by PRE-FLIGHT's post-deploy gate, RELEASE, and UPDATE** for the dashboard/API. Absent ⇒ every protected route denies. | ☐ |

### External confirmations

| Item | Confirmed? |
| --- | --- |
| The RAM policy grants **exactly four** actions and no wildcard action. | ☐ |
| The instance's current state is known, and stopping it is acceptable. | ☐ |
| If webhook reporting is configured, the endpoint is reachable and will record what it receives. | ☐ |
| The Cloudflare account plan matches what §7 concludes. | ☐ |
| A D1 database exists for the binding, or a decision to run without history is recorded. | ☐ |
| The HTTP exposure decision has been made (see §3c), or a record exists of choosing none. | ☐ |
| `REGION_ID` and `ECS_INSTANCE_ID` are set as repository **variables** (not secrets). | ☐ |

Set `ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, and `ADMIN_TOKEN` as Worker
Secrets. PRE-FLIGHT keeps `secrets.required: []` so the first deploy can create a
Worker, then hard-fails if `wrangler secret list` does not contain all three names.
RELEASE and UPDATE also declare them in `secrets.required`. Configure `WEBHOOK_URL` and,
optionally, `WEBHOOK_TOKEN` only when notification is wanted; neither is required
by the name gate, and `WEBHOOK_TOKEN` without `WEBHOOK_URL` is a runtime config
error.

## 2. Setting Worker Secrets

Each command prompts; the value is not echoed, not stored in history, and not
written to a file.

```sh
npx wrangler secret put ALIYUN_ACCESS_KEY_ID
npx wrangler secret put ALIYUN_ACCESS_KEY_SECRET
npx wrangler secret put ADMIN_TOKEN
```

Optional webhook reporting uses `WEBHOOK_URL`; when authentication is required,
also set `WEBHOOK_TOKEN`. Never set the token without the URL.

Cloudflare's Worker Secret UI is an equivalent alternative; do not use its
plaintext variable UI for these bindings.

**Verify by absence, not by printing.** Do not run a command that echoes a secret
to confirm it was set. PRE-FLIGHT checks names only after deploy; the live read-only
query confirms that the Alibaba credentials work.

If `ALIYUN_ACCESS_KEY_ID` was ever present in GitHub Actions logs, the owner must
rotate the Alibaba AccessKey. Review the affected run by its Actions URL, for
example `https://github.com/Skyline-Gazer/CFWorker4AliCDT/actions/runs/36014384495`;
never copy the key value into an issue, log, chat, or repository file.

> **`wrangler secret put` has version semantics.** It creates a new Worker version
> and deploys it immediately. That interacts with preflight verification — see
> §3b step 2.

## 3. Deploying

There are six documented invocations: three owner-gated workflows (the normal
way) and their manual equivalents, for when a step needs to be visible.

### 3a. Generated configs — why they exist and where they go

`wrangler.jsonc` is the committed source of truth. It deliberately declares the
`TRAFFIC_DB` binding with **no** `database_id`, so no production identifier is ever
committed and local development uses Wrangler's local D1 emulation.

A remote deployment still needs the identifier. Rather than commit it or rewrite
the committed config in CI, `scripts/resolve-deploy-config.mjs` reads
`wrangler.jsonc` and writes a **generated** config:

| Mode | Output | Purpose |
| --- | --- | --- |
| `--mode preflight` | `wrangler.preflight.jsonc` | First deploy only; Cron disabled; Version URL. |
| `--mode release` | `wrangler.deploy.jsonc` | First Cron enable after live verification; chosen endpoint. |
| `--mode update` | `wrangler.update.jsonc` | Existing Worker; production Cron and selected HTTP exposure retained. |

Three properties are enforced by the resolver, and each closes a measured defect:

1. **The generated file is written to the repository root.** Wrangler treats the
   config's *directory* as the project root, so a config written anywhere else
   makes `main: "src/index.ts"` resolve outside the repository and fail with
   "The entry-point file at `src/index.ts` was not found". The resolver refuses any
   other location.
2. **The committed `wrangler.jsonc` is never mutated.** Generation is read-and-copy.
   A config rewrite in CI is how a local config silently drifts from the deployed one.
3. **All generated files are gitignored**, and their names are distinct from
   `wrangler.jsonc` so Wrangler never picks one up implicitly.

A fourth property is what the resolver gained for deployment readiness: **all
modes inject the application runtime variables from the same boundary** (§1b). A
change of deployment mode may alter only mode-specific properties — Cron, the
preview URL, `workers_dev` vs a custom domain, and the required-secret declaration.
It may not silently change the region, the instance, the threshold, the endpoint,
the business-region filter, the signature version, or the stopped mode.

The workflow steps pass `--config` explicitly for the same reason: the dry-run in
`npm run validate` uses `wrangler.jsonc`, and a validation against a *different*
config proves nothing about the one being deployed.

### 3b. Initial bootstrap — PRE-FLIGHT, then RELEASE

**Step 1 — PRE-FLIGHT** (creates the Worker, no Cron). Dispatch
`.github/workflows/preflight.yml`. It resolves `--mode preflight`, applies remote
migrations, and performs the first `wrangler deploy`.

PRE-FLIGHT is for a new Worker only. The preflight config sets `preview_urls =
true`, `workers_dev = false`, no route, and `triggers.crons = []`.

> **Never run PRE-FLIGHT against the live production Worker.** An empty Cron array
> removes all Cron Triggers, so using this first-deploy workflow during normal
> operations would remove the live `*/10 * * * *` schedule.

**Why `[]` and not an omitted field.** Cloudflare documents the difference: if
`crons` is an **empty array**, all Cron Triggers are removed; if `triggers` or
`crons` is **`undefined`**, the currently deployed Cron Triggers are left in place.
Omitting the field would be a silent "change nothing", which is not the same
operation as "have no schedule".

**Why the preflight config also omits `secrets.required`.** Wrangler validates
`secrets.required` at deploy time, and a Worker that does not exist yet cannot hold
secrets — it refuses with *"This Worker does not exist yet, so secrets cannot be
set in advance with `wrangler secret put`."* So a first deploy that declared
`secrets.required` could never succeed. The preflight config therefore declares
`required: []`, and **RELEASE and UPDATE require exactly the two Alibaba credentials and
`ADMIN_TOKEN`**, where the Worker exists and the fail-loudly-on-a-missing-secret
guarantee applies. The optional webhook pair is not in `secrets.required`.

This is a real constraint on the bootstrap order, not a relaxed safety property:
after deploying, PRE-FLIGHT runs `wrangler secret list --format json` through
`scripts/assert-worker-secret-names.mjs` and fails the job unless
`ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, and `ADMIN_TOKEN` are present.
Webhook names remain optional. RELEASE and UPDATE also check the names after deploy
and declare the required names in `secrets.required`. Note also that
`wrangler deploy --dry-run` does **not** surface `secrets.required` validation,
because that validation runs on the real upload path — which is why it is asserted
structurally in `test/deploy/config-resolution.test.ts`.

The deploy reports a **Version URL**. That URL exists even with `workers_dev =
false`, provided `preview_urls` is enabled.

**Step 2 — configure Worker Secrets, then verify.** Performed while Cron is still
absent, so nothing can act on a wrong figure.

On the first-ever deploy, the Worker is created before the name gate runs. If the
three secrets are not present yet, PRE-FLIGHT deploys with Cron disabled and then
fails at the gate. Set the missing names with `wrangler secret put` once the Worker
exists. Each `secret put` creates and deploys a new Worker version, so a rerun of
PRE-FLIGHT is usually unnecessary when only secrets changed; confirm the names and
perform the live read-only check against the newest Version URL after secret repair.

> **Secret updates create versions.** `wrangler secret put` creates a new Worker
> version and deploys it immediately. So the Version URL printed by the initial
> bootstrap deploy is **not** necessarily the version you end up verifying after
> secrets are attached. After the final secret update, locate and use the **latest
> applicable Version URL after any secret update** — from the `wrangler secret put`
> output, or the Worker's Deployments list in the Cloudflare dashboard.
>
> This does not reintroduce risk: Cron is still absent on every one of these
> versions, because they all descend from the preflight config that declares
> `triggers.crons = []`. What changes is which version URL you point the checks at.

Configure the three required Worker Secrets for a *useful* live verification —
without the Alibaba credentials and `ADMIN_TOKEN`, `loadConfig()` or HTTP
authentication fails and `/api/query` cannot return anything:

- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- `ADMIN_TOKEN`

Webhook reporting is optional. If configuring it, set `WEBHOOK_URL` to an absolute
HTTPS URL; set `WEBHOOK_TOKEN` only if the endpoint requires bearer authentication.

Then perform the read-only verification in §6 against the latest Version URL.

**These are Cloudflare Worker Secrets, not GitHub Actions secrets.** Making them
GitHub secrets solely to automate preflight is a different security model; it is
not the current one, and changing it is an owner decision, not a convenience.

**Step 3 — RELEASE** (first production Cron enable). Dispatch
`.github/workflows/release.yml` after the live read-only verification. RELEASE
sets the production schedule and the owner's selected HTTP endpoint. This is the
first-enable action; subsequent application deployments use UPDATE.

### 3c. Deployment-only configuration (owner action, one time)

These are **not** Worker runtime variables and **not** Worker Secrets. They
configure *how the deployment is performed*, and they are not in the SPEC §2.2
seven. See §1a for how the three classes differ.

| Name | Kind | Scope | Purpose |
| --- | --- | --- | --- |
| `D1_DATABASE_ID` | Variable | **Repository** | The remote `TRAFFIC_DB` UUID. |
| `HTTP_EXPOSURE_MODE` | Dispatch input | — | `workers_dev` or `custom_domain`. **No default.** |
| `WORKER_CUSTOM_DOMAIN` | Variable | **Repository** | Required only when the mode is `custom_domain`. |
| `CLOUDFLARE_API_TOKEN` | Secret | **`production` Environment** | Scoped to Workers + D1. |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | **`production` Environment** | The account identifier. |

`D1_DATABASE_ID` and the application/runtime values must remain repository-level
Variables. Cloudflare deployment credentials must be Environment-level Secrets so
they are unavailable to jobs outside the protected deployment boundary. PRE-FLIGHT,
RELEASE, and UPDATE attach `environment: production` and receive those secrets
only after the Environment's owner-side protections allow the job to proceed.

`D1_DATABASE_ID` is a **variable, not a secret**: it is an identifier rather than a
credential, and treating it as a secret would make it harder to audit without
making it safer. It is nonetheless never committed.

**Configure the protected Environment** (GitHub settings; workflow files cannot
assert these live settings):

1. **Settings → Environments → New environment**, named exactly `production`.
2. Enable **Required reviewers** and add the owner. This is mandatory for all
   deployment workflows.
3. Restrict **Deployment branches and tags** to `main` only. This is mandatory:
   the Environment is the authoritative ref boundary because workflow code comes
   from the selected ref.
4. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as Environment secrets.
   Do not store them as repository secrets.

The workflows contain an explicit `github.ref == refs/heads/main` guard as defense
in depth. The guard is supplementary; it is not a substitute for the Environment's
required reviewer, main-only deployment restriction, or Environment-scoped
credentials. Keep `REGION_ID`, `ECS_INSTANCE_ID`, `D1_DATABASE_ID`, and optional
runtime overrides in repository Variables.

**Choose the HTTP exposure mode.** The committed config has `workers_dev = false`
and no routes, so the production dashboard/API has **no stable inbound endpoint**
until the owner chooses one. That choice is explicit, and there is no default:

| Mode | Generated config | When to use |
| --- | --- | --- |
| `workers_dev` | `workers_dev = true`, no route | The simpler personal/hobby path. |
| `custom_domain` | `workers_dev = false` + a `custom_domain` route | A domain you control. |

For `custom_domain`, set `WORKER_CUSTOM_DOMAIN` to a bare hostname (for example
`worker.example.com`). The resolver fails closed — producing no config at all — when
the mode is absent, unrecognised, or `custom_domain` without a domain, and when the
domain is malformed.

Protected routes remain authenticated in **both** modes. Choosing a public hostname
does not make a route public; it makes the *address* predictable. `GET /health` is
the only public route in either mode.

### 3d. RELEASE gates

The release workflow fails closed unless **all** of these hold:

1. The job targets the `production` Environment, which requires owner review and
   restricts deployments to `main` only.
2. The supplementary workflow guard confirms `github.ref` is `refs/heads/main`.
3. `confirmation` is exactly `DEPLOY`.
4. `LIVE_READ_ONLY_VERIFIED` is exactly `YES` — the owner may only supply this
   after §6 has passed.
5. `HTTP_EXPOSURE_MODE` is `workers_dev` or `custom_domain`, and the custom domain
   is present and well-formed when required.

Every confirmation is `required` with **no default**, because a defaulted boolean is
a gate that passes when nobody looks at it.

### 3e. Existing-Worker UPDATE

Use `.github/workflows/update.yml` for normal production re-deployments after the
Worker has been created and RELEASE has enabled its Cron. The workflow targets the
protected `production` Environment, rejects non-`main` refs, and requires these
dispatch inputs with no defaults:

| Input | Required value | Owner confirms |
| --- | --- | --- |
| `confirmation` | `UPDATE` | This is an intentional production update. |
| `EXISTING_WORKER_CONFIRMED` | `YES` | The Worker exists and Cron `*/10 * * * *` is already live. |
| `HTTP_EXPOSURE_MODE` | `workers_dev` or `custom_domain` | The HTTP exposure to retain. For `custom_domain`, `WORKER_CUSTOM_DOMAIN` must be a valid hostname. |

UPDATE does not require `LIVE_READ_ONLY_VERIFIED`; that gate belongs to the
first-deployment RELEASE. It resolves `--mode update` into
`wrangler.update.jsonc`, which explicitly carries Cron `*/10 * * * *`, sets the
selected workers.dev or custom-domain exposure, disables temporary
preview URLs, and retains `secrets.required` from `wrangler.jsonc`. The post-deploy
gate checks the three required Worker Secret names without reading or printing
secret values.

The workflow validates the repository, checks deployment credential and variable
presence, resolves the generated config, applies remote D1 migrations, deploys with
that same config, and checks required secret names. D1 migrations run before the
Worker version that needs their schema.

**Migration `0002_decision_reason.sql` is additive and nullable.** It runs
`ALTER TABLE traffic_checks ADD COLUMN decision_reason TEXT;`: there is no default
or backfill, and existing rows remain `NULL`. Apply it to remote D1 before deploying
Worker code that writes `decision_reason`; `update.yml` applies pending migrations
before its deploy step.

The expected post-update Cron state is exactly **`*/10 * * * *`**. After the run,
confirm the Cron remains present, review the applied migration, and check the
console and health endpoint at the selected exposure. The Cron Trigger remains the
only ECS mutation authority; the update path changes no control decision or ECS
mutation semantics.

### 3f. Manual equivalents

For the preflight stage, so every step is visible:

```sh
npm ci
npm run validate                                   # format, lint, typecheck, test, dry-run
export D1_DATABASE_ID=<the remote TRAFFIC_DB uuid>
export REGION_ID=<the ECS region>                  # required at runtime
export ECS_INSTANCE_ID=<the single instance>       # required at runtime
node scripts/resolve-deploy-config.mjs --mode preflight
npx wrangler d1 migrations apply TRAFFIC_DB --remote --config wrangler.preflight.jsonc
npx wrangler deploy --config wrangler.preflight.jsonc
# Attach Worker Secrets, then verify against the LATEST Version URL (§3b step 2).
```

Optional overrides may be exported alongside these (`TRAFFIC_THRESHOLD_GB`,
`CDT_ENDPOINT`, `BUSINESS_REGION_ID`, `SIGNATURE_VERSION`, `STOPPED_MODE`); unset,
the committed `wrangler.jsonc` default is preserved.

For the release stage:

```sh
npm ci
npm run validate
export D1_DATABASE_ID=<the remote TRAFFIC_DB uuid>
export REGION_ID=<the ECS region>                  # required at runtime
export ECS_INSTANCE_ID=<the single instance>       # required at runtime
export HTTP_EXPOSURE_MODE=workers_dev              # or: custom_domain
export WORKER_CUSTOM_DOMAIN=<hostname>             # required only for custom_domain
node scripts/resolve-deploy-config.mjs --mode release
npx wrangler d1 migrations apply TRAFFIC_DB --remote --config wrangler.deploy.jsonc
npx wrangler deploy --config wrangler.deploy.jsonc
```

For an existing-Worker update, first confirm the production Cron is already live
and choose the HTTP exposure that is already in use:

```sh
npm ci
npm run validate
export D1_DATABASE_ID=<the remote TRAFFIC_DB uuid>
export REGION_ID=<the ECS region>                  # required at runtime
export ECS_INSTANCE_ID=<the single instance>       # required at runtime
export HTTP_EXPOSURE_MODE=workers_dev              # or: custom_domain
export WORKER_CUSTOM_DOMAIN=<hostname>             # required only for custom_domain
node scripts/resolve-deploy-config.mjs --mode update
npx wrangler d1 migrations apply TRAFFIC_DB --remote --config wrangler.update.jsonc
npx wrangler deploy --config wrangler.update.jsonc
```

Then confirm Cron remains `*/10 * * * *`, the pending D1 migration is applied, the
required Worker Secret names remain present, and console/health checks pass.

`npm run validate` runs the same checks as CI, in the same order, in one
invocation — so it cannot be left half-run. The migration step is ordered before
the deploy so the schema exists before a Worker version that writes to it is live.

### 3g. Version URL lifecycle

- **PRE-FLIGHT:** `preview_urls = true`, so a Version URL exists for verification.
  Its config also declares `secrets: { required: [] }`, because Wrangler refuses to
  deploy a new Worker that lists required secrets it cannot yet hold.
- **RELEASE:** `preview_urls = false`, so the temporary verification exposure is not
  retained. Version URLs are public while they exist; a Version URL runs the
  uploaded version against **production** resources, so it is a verification window,
  not a staging environment.

The stable endpoint after RELEASE is the one the owner chose in §3c. UPDATE keeps
that same selected exposure explicit in its generated config.

## 4. `StopCharging` implications — read before changing `STOPPED_MODE`

The default is **`KeepCharging`**. Changing it trades restart reliability and
public-address preservation for compute cost. Both risks below are **silent**: the
API returns no error, and both are discovered only at restart, which is the worst
possible moment.

### Restart-capacity risk

`StopCharging` releases compute resources. A later `StartInstance` then depends on
capacity being available for that instance type in that zone. The failure mode is
`OperationDenied.NoStock`, which under this design surfaces as `stage: "ecs-start"`
with the instance **left stopped** — traffic enforcement succeeded, but automatic
recovery did not.

### Public-IP risk

Depending on the instance's addressing mode, releasing resources can change or lose
the public address. For a traffic-relay use case that can break the very relay the
instance exists to provide. Confirm the address survives a stop/start cycle
**before** trusting `StopCharging` in production.

### What is not affected

- `ForceStop` is `false` and **not configurable**. Force-stopping risks filesystem
  corruption and is excluded by design.
- A successful `StopInstance` is **not** evidence that `StoppedMode` took effect.
  The API returns success even when economical mode is unsupported and silently
  ignores it. The system therefore reports the mode as **requested**, never as
  applied, and no logic depends on it having applied.

## 5. Traffic GB and the CDT console

The public field and threshold keep the `GB` label to align with the Alibaba CDT
console. Convert raw CDT `Traffic` bytes with `trafficGB = trafficBytes / 1024^3`;
the divisor is `1,073,741,824`, not SI decimal `10^9`. This is the GiB-scale
calculation displayed under CDT's `GB` label. The default `TRAFFIC_THRESHOLD_GB`
remains `180`; do not change it to compensate for the unit correction.

Owner-provided live evidence: `27,858,630` bytes was displayed as `0.02785863` by
the previous Worker and approximately `0.02595 GB` by the CDT console.
`27,858,630 / 1024^3` is approximately `0.02594537 GB`, which agrees with CDT.

## 6. First-live-run verification — performed BEFORE Cron is enabled

This is the procedure that makes the two-stage bootstrap worth its extra step. It
runs against the **latest applicable Version URL** — see §3b step 2 for why the
secret updates mean that is not necessarily the URL from the initial deploy — while
Cron remains absent and there is no way for the system to act.

### Why it cannot wait until after a scheduled run

Most assumptions in the register fail safe: if they are wrong, the run aborts and
nothing mutates. **R4 is the exception.** If the traffic-unit assumption is wrong,
the system does not fail — it computes a *valid but incorrect* comparison and may
act on it. The fail-closed design cannot detect this, because nothing failed.

So the traffic figure must be checked empirically **before** scheduled authority
exists. Verifying it afterwards is verifying the assumption with the instance
already able to be stopped by it.

### The sequence

**Prerequisite:** the three required Worker Secrets from §1c are configured (§3b
step 2). The two Alibaba credentials enable the live query; `ADMIN_TOKEN` enables
the authenticated HTTP route. Webhook configuration is optional.

1. **`GET /health`** — public, inert. Confirms the Worker is reachable and returns
   `200` with no Alibaba call and no D1 read.
2. **Unauthenticated access to the protected routes** — confirm `GET /`,
   `GET /api/history`, and `POST /api/query` each return `401`. Auth is not weakened
   for preflight; there is no reduced-security mode.
3. **Authenticate and call `POST /api/query`.** This is the read-only live query.
4. **Confirm what `/api/query` did and did not do.** It must have queried CDT,
   described ECS, and evaluated `decide()`; it must expose an `action` and a
   `mutation: false`, and it must have performed **no** `StartInstance`, **no**
   `StopInstance`, **no** D1 history write, and dispatched **no** webhook. The
   read-only guarantee is structural — `QueryDeps` exposes no mutation seam — and
   this step confirms it operationally.
5. **Compare the returned traffic against the Alibaba console for the same
   period using `trafficGB = trafficBytes / 1024^3`.** This is R4; the label is
   `GB` to match CDT, and the divisor is not `10^9`.
6. **Confirm the four assumptions:**
   - **R2 — CDT endpoint.** The call succeeded. A `stage: "cdt-query"` error means
     the endpoint or the signature method is wrong, **not** that traffic is zero.
   - **R3 — accepted signature method.** The call succeeded. A signature rejection
     is `SignatureDoesNotMatch` or a `4xx` at `stage: "cdt-query"`; try
     `SIGNATURE_VERSION=v2` before investigating further.
   - **R4 — traffic unit and summation.** `trafficGB` matches the console when
     calculated with `1024^3`. Treat the deployed result as **unverified** until
     compared for the same period. A mismatch suggests investigating the raw
     Traffic unit, period, or summation scope.
   - **ECS observed state.** `ecsStatus` matches the console for the managed
     instance.
7. **Only then authorize RELEASE.**

### Reading the output afterwards

**Webhook.** When `WEBHOOK_URL` is configured, one report attempt is made per
scheduled execution, including no-ops. With no URL, there are zero webhook
requests, and D1 history still records the run with `webhook_ok = NULL`. `status:
"success"` carries the traffic, states before/after, the action, and the duration;
`status: "error"` carries a `stage` and a sanitised message. A webhook failure is
logged locally and does not affect control.

**Logs.** Workers Logs persist by default, so redaction is a correctness
requirement. A run logs its start, the observed traffic, the observed and desired
states, the chosen action, and the duration. Secrets never appear.

**Dashboard.** Served from the same Worker at `/`, authenticated. Read-only with
respect to ECS control: it reports what the system sees and decided, never a way to
make it act.

## 7. Cloudflare plan requirement

**Required plan: Workers Free.** The first natural production Cron measured
`cpuTimeMs` **9**, which is within the Workers Free **10 ms** CPU allowance.
Paid / Standard Usage Model is not required solely by this measurement. The gate
used is this single natural Cron observation.

| Field | Value |
| --- | --- |
| RELEASE run | [36159977416](https://github.com/Skyline-Gazer/CFWorker4AliCDT/actions/runs/36159977416) (PASS) |
| RELEASE SHA | `106f4d214a883ac9bfdf0798110f845092fbe971` |
| Custom domain | `cdt.q9m3.com` |
| Cron | `*/10 * * * *` (count 1) |
| First natural Cron | `2026-09-25T16:50:28Z` |
| Outcome | success / ok; action `none-running` |
| D1 history write | yes |
| Webhook | `webhook_attempted=false` |
| `cpuTimeMs` | **9** (Workers Free 10 ms CPU, within limit) |

Workers Free applies its 10 ms CPU allowance automatically. Do not configure a
custom `limits.cpu_ms` in `wrangler.jsonc` or either generated deploy config:
Cloudflare rejects custom CPU limits on Free with error **100328**.

| Account model | Platform Cron CPU allowance (< 1 hour interval) | Deployment rule |
| --- | --- | --- |
| Workers Free | **10 ms**, applied automatically | Omit custom `limits.cpu_ms`. This is the required plan. |
| Workers Paid / Standard Usage Model | 30 s | Not required by the measurement above. A later move, and any custom CPU limit, still requires measured evidence and an explicit owner choice. |

Network waiting — the CDT call, the ECS call, the D1 write, the webhook — does
**not** consume CPU. What does is JSON parsing, redaction, and rendering.

The figure is that Cron invocation's `cpuTime` from Workers observability, not an
estimate. The owner's 2026-09-22 decision (PLAN Q4) was to remain on **Free**
until a measurement existed. Any later move to Paid / Standard Usage Model, and
any custom CPU limit there, requires measured evidence and an explicit owner
choice.

A terminated run issues **no** mutation, so it aborts safely — but it also reports
nothing, which is why the figure is recorded rather than assumed.

## 8. Operating notes

- **Retention.** `traffic_checks` rows are retained indefinitely; there is no
  automatic deletion (PLAN Q5, resolved 2026-09-22). At a 10-minute cadence that is
  ~144 rows/day. Pruning, if ever needed, is a manual operation.
- **A D1 failure never affects control.** History is written after any action has
  been applied; a storage failure degrades the record only, and is surfaced in the
  webhook payload.
- **Changing the cadence** is a one-line edit to `PRODUCTION_CRONS` in
  `scripts/resolve-deploy-config.mjs`, followed by an UPDATE for an existing
  Worker. RELEASE uses the same value for the first Cron enable. The committed
  `wrangler.jsonc` still declares `*/10 * * * *` as the documented intent.
- **The Cron Trigger is the only ECS mutation authority.** No HTTP route can start,
  stop, or reboot an instance. `POST /api/query` is read-only by construction: its
  dependencies expose no mutation seam.
- **A re-deployment of an existing Worker** uses the owner-gated UPDATE workflow
  (`.github/workflows/update.yml`) and `wrangler.update.jsonc`. The config retains
  Cron at `*/10 * * * *`, preserves the selected HTTP exposure and required Worker
  Secret declaration, and applies pending D1 migrations before deploying code.

## 9. References

PLAN §14 (deployment model), §11 (risks), Q4/Q5 (resolved). SPEC §2
(configuration), §6.4 (stop semantics), §8 (HTTP surface), §9 (D1), §11 (runtime
constraints). `docs/security/ram-policy.md`, `docs/operations/assumptions-register.md`.
Cloudflare: [Deployment
management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/)
(the first-upload constraint), [Cron
Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
(empty array removes triggers), [Version
URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/).
