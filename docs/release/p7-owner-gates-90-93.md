# OWNER DECISION PACKET — P7 gates #90–#93

**Status:** Decision packets only. **No production activation** of multi-account,
manual Start/Stop, daily schedule, or keep-alive. Cron remains the sole ECS
mutation authority until an explicit, separate owner authorization changes that
policy.

```text
PACKET=docs/release/p7-owner-gates-90-93.md
EPIC=#77
ISSUES=#90 #91 #92 #93
ACTIVATION=NO
PRODUCTION_DEPLOYED=NO
POLICY_PRECEDENCE=Cron-only ECS mutation (control_instance fail-closed)
```

## Shared invariants (all four gates)

1. **Cron-only ECS mutation.** Scheduled Cron (`*/10 * * * *`) is the only authority
   that may Start/Stop the managed ECS instance. `POST ?action=control_instance`
   remains HTTP 501 / `FEATURE_NOT_IMPLEMENTED` with `mutation: false`.
2. **Secrets never enter D1 or browser responses.** Worker Secrets stay Worker Secrets.
3. **Fail-closed defaults.** Absence of owner authorization means the feature stays
   off / placeholder; no silent console authority.
4. **Activation requires a new focused issue + owner auth** after this packet. Merging
   this document does **not** enable any gate.
5. Prefer versioned D1 migrations for any future schema; no ad-hoc production DDL.

---

## #90 — Multi-account / account model (OWNER GATE)

| Field | Content |
| --- | --- |
| Issue | #90 P7-FEATURE-02 — Account model / multi-account architecture |
| Current production model | **Singleton:** one `REGION_ID` + one `ECS_INSTANCE_ID` |
| Decision asked | Whether to evolve toward multiple accounts/instances in the Worker/console |
| Policy conflict | Multi-account Start/Stop from the browser would break Cron-only mutation unless redesigned |
| Recommended default until authorized | Keep singleton; dashboard adapters ignore donor account IDs |
| Activation prerequisites | Explicit owner choice of data model; migration plan; authz model; **separate** issue to implement; UPDATE only after review |
| Not in this packet | Implementing multi-account storage, UI account switcher, or per-account Cron |

**Owner decision (fill in):** ☐ Defer / keep singleton · ☐ Authorize design spike only · ☐ Authorize implementation issue (still no auto-activate)

---

## #91 — Manual Start/Stop (OWNER GATE)

| Field | Content |
| --- | --- |
| Issue | #91 P7-FEATURE-03 — Manual Start/Stop |
| Current behavior | `control_instance` placeholder; zero ECS calls from HTTP |
| Decision asked | Whether an authenticated human may Start/Stop outside Cron |
| Policy precedence | **Cron-only wins** unless owner explicitly supersedes it |
| If authorized later | Must define: who may call it, audit logging, interaction with in-flight Cron, rate limits, and whether Cron remains primary |
| Recommended default | Keep fail-closed; do not wire ECS Start/Stop to HTTP |
| Activation prerequisites | Written policy superseding Cron-only; security review; focused implementation issue; production UPDATE only after auth |

**Owner decision (fill in):** ☐ Keep Cron-only (recommended) · ☐ Authorize limited manual override (specify conditions) · ☐ Reject permanent manual control

---

## #92 — Daily schedule control (OWNER GATE)

| Field | Content |
| --- | --- |
| Issue | #92 P7-FEATURE-04 — Daily schedule control |
| Current schedule | Fixed Cron expression `*/10 * * * *` in committed config / UPDATE|RELEASE artifacts |
| Decision asked | Whether operators may change schedule from the console or a variable-driven daily window |
| Risk | Browser- or D1-driven schedule changes could diverge from the audited UPDATE path |
| Recommended default | Schedule changes only via reviewed config + UPDATE/RELEASE; no runtime schedule API |
| Activation prerequisites | Owner policy for who may change schedule; whether windows pause mutation; conflict rules with keep-alive (#93) |

**Owner decision (fill in):** ☐ Keep fixed Cron-only · ☐ Authorize GitHub Variable / reviewed config schedule only · ☐ Authorize console schedule API (requires superseding policy)

---

## #93 — Keep Alive (OWNER GATE)

| Field | Content |
| --- | --- |
| Issue | #93 P7-FEATURE-05 — Keep-alive policy |
| Current behavior | Decision engine follows traffic threshold vs `STOPPED_MODE`; no separate keep-alive mode |
| Decision asked | Whether to force instance stay-running regardless of CDT threshold (e.g. maintenance / business hours) |
| Policy interaction | Keep-alive that Starts an instance is still an **ECS mutation** and must not bypass Cron-only unless #91 is also authorized |
| Recommended default | No keep-alive flag; Cron + threshold logic only |
| Activation prerequisites | Define override semantics vs threshold; audit; focused issue; no HTTP mutation without #91 policy |

**Owner decision (fill in):** ☐ Defer / no keep-alive · ☐ Authorize Cron-evaluated keep-alive window (no HTTP Start) · ☐ Authorize with manual control (#91) — requires both gates

---

## Policy precedence matrix

| Proposed capability | Allowed under current policy? | What would supersede Cron-only? |
| --- | --- | --- |
| Cron Start/Stop from traffic decision | Yes (production authority today) | — |
| HTTP `control_instance` | No (PLACEHOLDER) | Owner auth on #91 + implementation |
| Multi-account HTTP mutation | No | Owner auth on #90 and #91 + design |
| Console-changed Cron / daily window | No | Owner auth on #92 + UPDATE path redesign |
| Keep-alive forcing Start | No via HTTP; Cron-only path would need #93 design that stays inside Cron | Owner auth on #93 (± #91) |

---

## What this packet does **not** do

- Does not dispatch PRE-FLIGHT, RELEASE, or UPDATE.
- Does not change Cron, domain, secrets, D1, or ECS.
- Does not activate transports (SMTP/Telegram/manual webhook) or `save_config`.
- Does not set `ENABLE_BILLING=true` or grant BSS IAM (see #115 / production UPDATE packet).

## Next steps after owner marks decisions

1. Record decisions on issues #90–#93 (and Epic #77).
2. Open focused implementation issues only for authorized gates.
3. Keep placeholders fail-closed until those issues merge and a separate production UPDATE is authorized.
