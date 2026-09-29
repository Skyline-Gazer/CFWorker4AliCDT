# OWNER DECISION — `save_config` and monthly billing

> Historical owner decision record. It preserves the approved decisions; current runtime availability and gates are documented in the operator guides.


**Status:** Decision/history. Issue #128 Option C and Issue #129 Option C are
approved and their donor-facing UX/contracts are implemented. This document
**does not** authorize production enablement, IAM expansion, or
UPDATE/RELEASE/PRE-FLIGHT dispatch.

Parent tracking: Epic **#77**, follow-up **#116**. Related production UPDATE
packet: `docs/release/p7-web-console-production-update-packet.md` (live tip
`38a3e09`).

---

## 1. `save_config` persistence — Issue **#128** (Option C approved)

**Current code:** authenticated donor `save_config` remains a **PLACEHOLDER**
(`BACKEND_NOT_AVAILABLE`, HTTP 501). Option C is implemented: the API failure,
disabled dashboard button, visible notice, and alert explain that dashboard
configuration writes are unavailable by design. Operators change Cloudflare
Worker variables and Secrets out of band. Nothing is persisted to D1, and secrets
must never be entered in the browser. No production authorization is implied.

### Options considered

| Option | Summary | Risk / notes |
| --- | --- | --- |
| **A — Defer indefinitely (recommended default)** | Dashboard config writes stay unavailable. Operators change Worker vars/Secrets out-of-band. | Lowest risk. |
| **B — Non-secret prefs only** | Narrow allowlist of non-secret prefs in D1. Explicit denylist for `ALIYUN_*`, `ADMIN_TOKEN`, `WEBHOOK_*`, `SMTP_*`, `TELEGRAM_*`. | Requires a focused implementation issue after the pick. |
| **C — Reject with clearer UX only (approved)** | No persistence; improve donor-facing message / docs only. | Implemented for #128; no new storage. |

### Non-goals

- No Cloudflare API self-mutation of Worker secrets from the dashboard.
- No HTTP ECS control authority changes.
- No production deploy from #128 alone.

The #128 decision is complete. Any production UPDATE remains separately owner
authorized; this decision does not authorize deployment or secret changes.

---

## 2. Monthly billing availability — Issue **#129** (Option C approved and implemented)

**Current code:** `get_billing` can expose **balance** when `ENABLE_BILLING` is
on **and** BSS `QueryAccountBalance` IAM is authorized. The adapter returns
`monthly_available: false` and `monthly_cost: null`; the donor UI hides monthly
spend and labels any displayed amount as **账户余额**. Billing remains behind
the existing gate, balance behavior is unchanged, and no IAM permission or BSS
Action was added. Production billing remains disabled unless separately
authorized; this decision does not authorize production changes.

### Options considered

| Option | Summary | Risk / notes |
| --- | --- | --- |
| **A — Accept “monthly unavailable”** | Keep `monthly_cost: null` for this surface; document in UI/matrix. No new RAM. | Monthly spend remains unavailable. |
| **B — Add a monthly bill API** | Choose a specific Alibaba BSS OpenAPI Action + RAM action; define donor fields; separate production enablement (still behind billing gate(s)). | Requires explicit IAM expansion authorization. |
| **C — Hide monthly UI (approved and implemented)** | Adapter exposes `monthly_available: false`, keeps `monthly_cost: null`, and the UI shows balance only. | No new IAM; existing balance gate and path are preserved. |

### Non-goals

- Do not expand RAM automatically.
- Do not set `ENABLE_BILLING` in production from #129 alone.

Issue #129 Option C is implemented in this worktree. No production authorization,
PRE-FLIGHT, RELEASE, UPDATE, IAM expansion, or billing activation is implied.

---

## Cross-links

| Artifact | Path / Issue |
| --- | --- |
| Production UPDATE packet (live tip `38a3e09`) | `docs/release/p7-web-console-production-update-packet.md` |
| Owner gates #90–#93 | `docs/release/p7-owner-gates-90-93.md` |
| Donor capability matrix | `docs/planning/p7-donor-api-compatibility.md` |
| Worker SMTP architecture | `docs/architecture/worker-smtp.md` |
| `save_config` decision | GitHub **#128** |
| Monthly billing decision | GitHub **#129** |
| Placeholder tracker | GitHub **#116** |
| Epic | GitHub **#77** |
