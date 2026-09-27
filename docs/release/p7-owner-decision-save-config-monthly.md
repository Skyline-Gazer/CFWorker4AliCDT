# OWNER DECISION — `save_config` and monthly billing

**Status:** Decision-only. This document **does not** authorize implementation,
production enablement, IAM expansion, or UPDATE/RELEASE/PRE-FLIGHT dispatch.

Parent tracking: Epic **#77**, follow-up **#116**. Related production UPDATE
packet: `docs/release/p7-web-console-production-update-packet.md` (tip
`19cea6a…`).

---

## 1. `save_config` persistence — Issue **#128**

**Current code:** authenticated donor `save_config` remains a **PLACEHOLDER**
(`BACKEND_NOT_AVAILABLE`). Secrets must never enter D1 or the browser.

### Options (pick one in a comment on #128)

| Option | Summary | Risk / notes |
| --- | --- | --- |
| **A — Defer indefinitely (recommended default)** | Dashboard config writes stay unavailable. Operators change Worker vars/Secrets out-of-band. | Lowest risk. |
| **B — Non-secret prefs only** | Narrow allowlist of non-secret prefs in D1. Explicit denylist for `ALIYUN_*`, `ADMIN_TOKEN`, `WEBHOOK_*`, `SMTP_*`, `TELEGRAM_*`. | Requires a focused implementation issue after the pick. |
| **C — Reject with clearer UX only** | No persistence; improve donor-facing message / docs only. | Docs/UX only; no new storage. |

### Non-goals

- No Cloudflare API self-mutation of Worker secrets from the dashboard.
- No HTTP ECS control authority changes.
- No production deploy from #128 alone.

**Until the owner comments A/B/C on #128, that Issue stays OPEN and blocks coding.**

---

## 2. Monthly billing availability — Issue **#129**

**Current code:** `get_billing` can expose **balance** when `ENABLE_BILLING` is
on **and** BSS `QueryAccountBalance` IAM is authorized. **Monthly spend is NOT
AVAILABLE** from that API (`monthly_cost: null`).

### Options (pick one in a comment on #129)

| Option | Summary | Risk / notes |
| --- | --- | --- |
| **A — Accept “monthly unavailable” (recommended default)** | Keep `monthly_cost: null` for this surface; document in UI/matrix. No new RAM. | Lowest risk. |
| **B — Add a monthly bill API** | Choose a specific Alibaba BSS OpenAPI Action + RAM action; define donor fields; separate production enablement (still behind billing gate(s)). | Requires explicit IAM expansion authorization. |
| **C — Hide monthly UI** | Adapter exposes a clear `monthly_available: false` (or equivalent) so the UI does not imply spend data exists. | Docs + small adapter tweak; no new IAM. |

### Non-goals

- Do not expand RAM automatically.
- Do not set `ENABLE_BILLING` in production from #129 alone.

**Until the owner comments A/B/C on #129, that Issue stays OPEN.**

---

## Cross-links

| Artifact | Path / Issue |
| --- | --- |
| Production UPDATE packet (tip `19cea6a`) | `docs/release/p7-web-console-production-update-packet.md` |
| Owner gates #90–#93 | `docs/release/p7-owner-gates-90-93.md` |
| Donor capability matrix | `docs/planning/p7-donor-api-compatibility.md` |
| Worker SMTP architecture | `docs/architecture/worker-smtp.md` |
| `save_config` decision | GitHub **#128** |
| Monthly billing decision | GitHub **#129** |
| Placeholder tracker | GitHub **#116** |
| Epic | GitHub **#77** |
