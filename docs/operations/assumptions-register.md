# Assumptions and verification register

Several load-bearing facts about this system **cannot be verified without a live
deployment**. This register records every such claim as an **assumption**, names
the concrete observation that would verify it, and states what breaks if it is
wrong and whether the system fails safe in the meantime.

> Nothing in this document is presented as documented behaviour unless a primary
> source is cited. Where a claim rests on SDK typing, an independent
> implementation, or inference, it says so.

## 1. How to read this register

Each entry states:

- **Claim** — what the system assumes.
- **Evidence for it** — and, importantly, what kind of evidence: *documented*
  (primary source), *SDK-derived*, or *empirically unconfirmed*.
- **How to verify** — the concrete artefact or observation.
- **If wrong** — the impact, and whether the system fails safe.
- **In the meantime** — what the code does today.

**Fails safe** means: the wrong assumption cannot cause an ECS mutation that
should not have happened. The system's asymmetry is deliberate — a false abort
costs one monitoring interval, whereas a false "under threshold" costs money and
cannot be undone.

## 2. Entries

### A1 — The CDT endpoint is `cdt.aliyuncs.com`
Evidence: **empirically unconfirmed.** No authoritative source exists. The
hostname is inferred from SDK behaviour and from independent implementations;
`endpoints.json` is absent for this product, and the OpenAPI metadata service
returns `{"code":500,"message":"Product is not public"}` for product code `cdt`.
How to verify: a single `ListCdtInternetTraffic` call at first deployment, or the
endpoint listed in the Alibaba console for the CDT product.
If wrong: every run fails at `stage: "cdt-query"` and **no instance is ever
started or stopped**. Fails safe, but total monitoring failure.
In the meantime: `CDT_ENDPOINT` is configuration, not a constant, so correcting it
is a variable change rather than a code change (PLAN R2).

### A2 — The accepted signature method cannot be confirmed for this operation
Evidence: **partially documented.** V3 (`ACS3-HMAC-SHA256`) is the current
documented method and V2 is documented as discontinued; both official V3 and V2
worked examples are reproduced byte-exact by the tests. What cannot be confirmed
is which method *this specific operation* accepts, because the operation is
undocumented.
How to verify: observe the first live call's HTTP status. A signature rejection is
`SignatureDoesNotMatch` or a 4xx at `stage: "cdt-query"`.
If wrong: the call fails and **no mutation occurs**. Fails safe.
In the meantime: `SIGNATURE_VERSION` selects the method through a single
`callRpc()` boundary, so switching is configuration, not a refactor (PLAN R3).

### A3 — `Traffic` is expressed in bytes
Evidence: **SDK-derived.** The SDK types the field as a 64-bit integer. **No
Alibaba prose source states the unit.** Independent implementations treat it as
bytes.
How to verify: compare the API's figure against the traffic shown in the Alibaba
console for the same period. Performed against the **PRE-FLIGHT Version URL**,
before Cron exists — see §4.
If wrong: the threshold trips at the wrong traffic level. This is the one
assumption whose failure could cause an *incorrect* action rather than an abort —
too-large a unit stops the instance early; too-small a unit lets it run past the
allowance. **Not inherently fail-safe**, which is why verification is required
before scheduled authority is granted rather than afterwards.
In the meantime: the conversion lives in exactly one named function
(`trafficBytesToDecimalGb`), so a corrected unit is a one-line change, and the
figure is recorded in D1 and, when webhook reporting is configured, in the webhook
payload so a wrong unit is auditable after the fact (PLAN R4).

### A4 — The threshold unit is **decimal** GB (`10^9` bytes)
Evidence: **owner decision**, not an external fact. Recorded because it is a
deliberate divergence: the originating script and both reference implementations
divide by `1024^3`, so this project stops the instance **earlier** for the same
byte count. 180 GB decimal equals 167.6 GiB.
How to verify: not applicable — this is intent, and the tests pin the divisor and
assert it is *not* `1024^3`.
If wrong: nothing breaks technically; an operator migrating from the prior script
would see enforcement trip earlier than expected.
In the meantime: documented prominently in the README and here, never silently
inherited (PLAN R5).

### A5 — Summation scope: every `TrafficDetails` entry is summed
Evidence: **empirically unconfirmed.** No official source defines the semantics.
The two reference implementations disagree over whether to sum all entries or only
those matching a configured business region.
How to verify: compare the summed total against the account's CDT total in the
console.
If wrong: the effective threshold differs from the operator's intent. If the API
returns more scope than expected, the instance stops early (safe); if less,
enforcement trips late (not safe).
In the meantime: `BUSINESS_REGION_ID` is applied as a **server-side request
parameter**, so the sum always reflects what the API returned, and the per-region
breakdown is retained in the payload so the scope is auditable (PLAN Q1).

### A6 — ECS `RegionId` and CDT `BusinessRegionId` are independent namespaces
Evidence: **empirically unconfirmed.** No source establishes whether the two
identifiers coincide.
How to verify: compare a known region identifier against a CDT business region.
If wrong: a configured `BUSINESS_REGION_ID` could filter unexpectedly, changing
the summed total.
In the meantime: they are two separate optional variables, and `BUSINESS_REGION_ID`
defaults to **unset**, so no filter is applied unless the owner sets one
(PLAN Q3).

### A7 — The Terraform-style id-less D1 binding deploys
Evidence: **partially verified.** `database_id` is documented as optional in
Wrangler's own schema, and every local path resolves the binding correctly
(`dev`, `d1 migrations list/execute --local`, `deploy --dry-run`). A real
`wrangler deploy` could not be exercised without live credentials, because
account lookup fails first.
How to verify: the first real `wrangler deploy`, which is the PRE-FLIGHT stage.
If wrong: deployment fails, loudly, before any Worker runs.
In the meantime: no remote database is referenced and no placeholder identifier is
committed; a real identifier is supplied from a repository variable at deploy time.

### A11 — A generated config is accepted by Wrangler at the path Wrangler requires
Evidence: **partially verified, and previously wrong once.** Wrangler treats the
config file's *directory* as the project root, so `main` resolves relative to the
config's location. A generated config written outside the repository root fails
with "The entry-point file at `src/index.ts` was not found" — measured, not
assumed, and the defect that PR #66 fixed.
What *is* verified: both generated configs (`wrangler.preflight.jsonc` and
`wrangler.deploy.jsonc`) are accepted by `wrangler deploy --dry-run` **against
those exact files**, resolving the entry point, the `TRAFFIC_DB` binding with the
injected id, and the config schema. That is asserted in
`test/deploy/artifact-dryrun.test.ts`, because a validation against `wrangler.jsonc`
does not prove a different file works.
What is *not* verified without credentials: the remote upload itself.
How to verify: the first real `wrangler deploy` (PRE-FLIGHT).
If wrong: deployment fails, loudly, before any Worker runs.
In the meantime: the resolver refuses any output path outside the repository root,
and the dry-run is run against the generated artifact rather than the committed one.

### A8 — The required Cloudflare plan
Evidence: **not yet measured.** The plan is a function of measured CPU per run,
which requires a deployment.
How to verify: the Cron invocation's `cpuTime` in Workers observability.
If wrong: on the Free plan a run exceeding 10 ms CPU may be terminated mid-flight.
**Not fail-safe in the sense that matters**: a terminated run issues no mutation
(so it aborts safely), but it also reports nothing.
In the meantime: the owner's decision is to remain on Free initially and measure
before upgrading; retries are bounded and no long-polling occurs (PLAN R8, Q4
resolved 2026-09-22).

### A9 — `StoppedMode` is silently ignored when unsupported
Evidence: **documented.** Alibaba states that when an instance does not support
economical mode, "no error is returned on the API side" and the instance stops
under the priority mode instead.
How to verify: not applicable — this is documented behaviour.
If wrong: the assumption is conservative. The system reports the mode as
*requested*, never as applied, so no logic depends on it having taken effect.
In the meantime: `ForceStop` is `false` and not configurable, and `STOPPED_MODE`
defaults to `KeepCharging`, which preserves resources and the public address
(PLAN R7, SPEC §6.4).

### A10 — `ListCdtInternetTraffic` has no pagination
Evidence: **SDK-derived.** The operation's request shape has exactly one optional
parameter (`BusinessRegionId`) and no page parameters.
How to verify: the response contains no pagination token, and the summed total
matches the console.
If wrong: a truncated response would under-report traffic, so enforcement could
trip late. **Not fail-safe on its own.**
In the meantime: this is why the summation is asserted against an independently
computed expectation, and why an empty `TrafficDetails` array is treated as
**invalid rather than as zero** (PLAN §5.1, SPEC §5.5).

### A12 — A first deploy cannot declare `secrets.required`
Evidence: **documented and verified in the Wrangler implementation.** Wrangler
validates `secrets.required` at deploy time. For a Worker that does not yet exist it
fails with *"This Worker does not exist yet, so secrets cannot be set in advance
with `wrangler secret put`."* The check is in
`addRequiredSecretsInheritBindings` and it distinguishes `type: "deploy"` from
`type: "upload"` precisely for `workerExists === false`.
How to verify: not applicable — this is current Wrangler behaviour, and it is
asserted structurally in `test/deploy/config-resolution.test.ts`.
If wrong: the first deployment fails, loudly, before any Worker runs. It fails
**closed**, and the remedy is to scaffold the Worker another way or pass secrets on
the command line — neither of which is wanted.
In the meantime: the PRE-FLIGHT generated config declares `secrets: { required: [] }`,
so the first deploy can succeed; **RELEASE requires exactly the Alibaba AccessKey ID,
Alibaba AccessKey secret, and `ADMIN_TOKEN`**, so a missing required secret still
fails deployment loudly. Webhook secrets are optional. Note that
`wrangler deploy --dry-run` does **not** surface this, because validation runs on
the real upload path.

### A13 — Required runtime vars must be injected at generation time, not discovered late
Evidence: **verified by exercise.** `src/config.ts` requires `REGION_ID` and
`ECS_INSTANCE_ID`; the committed `wrangler.jsonc` deliberately declares neither
(only the four non-required defaults). A generated config that omitted them
therefore deploys cleanly and then fails `loadConfig()` on **every** request the
Worker serves — a Wrangler dry-run cannot detect it, because Wrangler never calls
`loadConfig()`.
How to verify: `test/deploy/artifact-dryrun.test.ts` feeds the exact generated
`vars` block plus fake Worker Secrets to the real `loadConfig()` and asserts it is
accepted, with a negative control proving the check has teeth.
If wrong: the Worker deploys and is then permanently non-functional until
redeployed — the failure mode this guard exists to prevent.
In the meantime: the resolver fails **before generating** when either is absent or
whitespace-only, in both modes, naming the binding and never printing a value. It
injects application variables from one boundary for both modes, so a change of
deployment mode cannot silently change the region, instance, threshold, endpoint,
business-region selection, signature version, or stopped mode.

### A14 — Secret mutation creates a new Worker version
Evidence: **documented.** `wrangler secret put` creates a new version and deploys it
immediately; only `wrangler versions secret put` avoids deploying. So the Version
URL printed by the initial bootstrap deploy is not necessarily the version that
exists after secrets are attached.
How to verify: the `wrangler secret put` output and the Worker's Deployments list.
If wrong: verification is performed against a superseded version, so its evidence
does not describe what is deployed. This does **not** risk mutation — every version
descends from the preflight config that declares `triggers.crons = []`, so Cron is
absent throughout — but it would make the verification evidence invalid.
In the meantime: the deployment runbook instructs the owner to locate and verify the
**latest applicable Version URL** after the final secret update.

## 3. Recorded corrections to the originating brief

| Brief claim | Correction | Source |
| --- | --- | --- |
| CDT API version `2021-08-31` | **Does not exist for this product.** The correct version is **`2021-08-13`**. | The Tea specification (`aliyun/alibabacloud-sdk/cdt-20210813/main.tea`) and the Python SDK client (`alibabacloud_cdt20210813/client.py`), identically. |
| `ListCdtInternetTraffic` has pagination | It has **no pagination parameters**. The brief's pagination test is replaced by multi-entry summation over `TrafficDetails`. | SDK request shape; the substitution is stated in PLAN §5.1 and SPEC §5.3 so it is not mistaken for a dropped requirement. |

## 4. First-live-run verification procedure

Performed by the owner against the **PRE-FLIGHT Version URL**, *before* any Cron
Trigger exists. No step prints a credential.

> **Why before, and not after a scheduled run.** Most entries below fail safe: if
> the assumption is wrong, the run aborts and no instance is touched. **A3/R4 is
> the exception.** A wrong traffic unit does not cause a failure — it causes a
> *valid but incorrect* threshold comparison. The system cannot detect that,
> because nothing failed. So the traffic figure is verified while the Worker has no
> scheduled authority, rather than after it has been given the ability to act on a
> wrong number.

The two-stage bootstrap is described in `docs/operations/deployment.md` §3b. In
short: PRE-FLIGHT deploys the real Worker with `triggers.crons = []`, exposing a
Version URL and no stable endpoint; verification happens against that URL; RELEASE
is a separate owner action that restores `*/10 * * * *`.

1. **Confirm liveness (A-adjacent).** `GET /health` returns `200` without
   authentication. It performs no Alibaba call and no D1 read.
2. **Confirm authentication is not weakened for preflight.** `GET /`,
   `GET /api/history`, and `POST /api/query` each return `401` unauthenticated.
3. **Confirm the read-only query acts on nothing.** Authenticated `POST /api/query`
   returns the traffic, the ECS state, and the decision, with `mutation: false`. It
   performed no `StartInstance`, no `StopInstance`, no D1 history write, and
   dispatched no webhook.
4. **Confirm the endpoint (A1).** The query succeeded. A `stage: "cdt-query"` error
   means the endpoint or the signature method is wrong (A2), not that traffic is zero.
5. **Confirm the unit (A3).** Compare the `trafficGB` in the response against the
   Alibaba console figure for the same period. A mismatch of roughly 7% suggests a
   decimal/binary confusion (A4); a mismatch of orders of magnitude suggests the
   unit is not bytes.
6. **Confirm the summation scope (A5).** Compare `trafficGB` against the console
   total for the intended regions, and inspect the per-region breakdown.
7. **Confirm the observed state.** Verify `ecsStatus` matches the console for the
   managed instance.
8. **Only then authorize RELEASE.** Once Cron is enabled, the first scheduled run
   should again be read: confirm the webhook payload agrees with the figures when webhook reporting is configured, or confirm the D1 row records the figures with webhook result NULL when it is not.
   Confirm a below-threshold run is a `none-*` no-op with the instance untouched.
9. **Measure CPU (A8).** Read the first scheduled invocation's `cpuTime` and record
   the required plan in the deployment documentation.

Steps 1–7 must be run against the **latest applicable Version URL**. Because
`wrangler secret put` deploys a new version (A14), re-locate it after the final
secret update rather than reusing the URL from the initial bootstrap deploy.

Until steps 5–6 pass, treat the traffic figure as **unverified**, not as a
measurement. Until RELEASE, there is no scheduled mutation to be wrong about.

## 5. References

PLAN §4 (external dependencies), §11 (risks R1–R7), §13 (open questions). SPEC §3
(units), §4 (RPC), §5 (CDT), §14 (open questions).
