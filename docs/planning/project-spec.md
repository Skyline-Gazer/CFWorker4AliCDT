# CFWorker4AliCDT — Project Specification

> Status: **REVISION 3 — companion to [project-plan.md](./project-plan.md).**
> Supersedes Revision 1. Normative language: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.
> Where this SPEC and the PLAN disagree, the SPEC governs behaviour.
>
> Amendment carried forward: `STOPPED_MODE` defaults to `KeepCharging` (owner decision, §6.4).
> Revision 2 added §7–§10 (webhook cadence, HTTP surface, auth, D1 history).
> Revision 3 makes generic webhook reporting optional while preserving the
> fail-safe control path, required Alibaba configuration, and D1 history. The
> failure semantics in §3–§6 and §11 are unchanged from Revision 1.
>
> Amendment (2026-09-26): the first natural production Cron measured `cpuTimeMs` 9,
> within the Workers Free 10 ms allowance. Workers Free is the required plan (§11).
> Paid is not required solely by that single-run observation. See
> `docs/operations/deployment.md` §7.

> Amendment (2026-09-26): corrective donor UI integration is tracked under
> Epic #77 as a follow-up to the historical server-rendered P7 acceptance. Issue
> #39 remains CLOSED and Issue #47 remains Done; this amendment does not change
> the runtime contract in this SPEC or recast that acceptance as a failure. Donor
> actions and their compatibility boundaries are documented in
> [`p7-donor-api-compatibility.md`](./p7-donor-api-compatibility.md). Refs #78 #80
> are documentation scope only; no production PRE-FLIGHT/RELEASE is authorized by
> this work.

> Amendment (2026-09-26): Refs #87 #88 add nullable scheduled decision-reason
> history and live CDT aggregation audit fields to the donor console contracts.
> Old D1 rows remain unknown. The release verification packet is documentation;
> it does not authorize or dispatch PRE-FLIGHT/RELEASE.

## 1. Scope

This SPEC defines the observable behaviour of the Cloudflare Worker. It is the
authority for implementation and for every acceptance test. It does not describe
internal structure beyond what is needed to make behaviour testable.

## 2. Configuration contract

### 2.1 Secret bindings (Workers Secrets)

| Name | Required | Description |
| --- | --- | --- |
| `ALIYUN_ACCESS_KEY_ID` | Yes | Alibaba Cloud AccessKey ID. |
| `ALIYUN_ACCESS_KEY_SECRET` | Yes | Alibaba Cloud AccessKey secret. Raw value is the V3 signing key. |
| `WEBHOOK_URL` | No | Optional notification endpoint. If set, must be absolute `https://`; enables one attempt per scheduled run. |
| `WEBHOOK_TOKEN` | No | Optional bearer token. Valid only when `WEBHOOK_URL` is configured. |
| `ADMIN_TOKEN` | Required by RELEASE | Dashboard and API credential. See §8. |

The RELEASE `secrets.required` list contains exactly `ALIYUN_ACCESS_KEY_ID`,
`ALIYUN_ACCESS_KEY_SECRET`, and `ADMIN_TOKEN`. The optional notification pair is
not required by RELEASE. Runtime config rejects `WEBHOOK_TOKEN` without
`WEBHOOK_URL`; omitting both leaves scheduled control and D1 history enabled.
PRE-FLIGHT checks those three required names after deploy while keeping
`secrets.required` empty for first-create compatibility. Never place them in
Wrangler `vars`, GitHub Variables, or Cloudflare Dashboard plaintext vars; the
generated deployment config is authoritative for `vars`.

### 2.2 Plain bindings (Wrangler `vars`)

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `REGION_ID` | Yes | — | ECS region, e.g. `cn-hongkong`. Used to build `ecs.<REGION_ID>.aliyuncs.com`. |
| `ECS_INSTANCE_ID` | Yes | — | The single managed instance, e.g. `i-xxxxxxxx`. |
| `TRAFFIC_THRESHOLD_GB` | No | `180` | Threshold in console-aligned GB; one GB is `1024^3` bytes. |
| `CDT_ENDPOINT` | No | `cdt.aliyuncs.com` | CDT API host. Configuration, not a constant (risk R2). |
| `BUSINESS_REGION_ID` | No | unset | If set, CDT `BusinessRegionId`. See §5.3. |
| `SIGNATURE_VERSION` | No | `v3` | `v3` or `v2`. See §4. |
| `STOPPED_MODE` | No | `KeepCharging` | `StopCharging` or `KeepCharging`. See §6.4. |
| `ADMIN_USER` | No | `admin` | Dashboard username. See §8. |

### 2.3 D1 binding

| Binding | Required | Description |
| --- | --- | --- |
| `TRAFFIC_DB` | Yes | D1 database holding monitoring history (§9). |

### 2.4 Validation

Configuration is validated before any Alibaba call. A failure here:

- performs **no** ECS mutation,
- dispatches an error webhook with `stage: "config"` only when a usable HTTPS
  `WEBHOOK_URL` is present,
- records no history row,
- causes the run to exit.

Validation rules:

| Condition | Result |
| --- | --- |
| Any required binding absent or empty | config error |
| `TRAFFIC_THRESHOLD_GB` not a finite number | config error |
| `TRAFFIC_THRESHOLD_GB` ≤ 0 | config error |
| `WEBHOOK_URL` present but not an absolute `https://` URL | config error |
| `WEBHOOK_TOKEN` present while `WEBHOOK_URL` is absent or empty | config error naming both bindings |
| `REGION_ID` or `ECS_INSTANCE_ID` absent | config error |
| `SIGNATURE_VERSION` not in {`v2`, `v3`} | config error |
| `STOPPED_MODE` not in {`StopCharging`, `KeepCharging`} | config error |
| `ADMIN_TOKEN` absent | config error on the **HTTP** path (fail closed, §8.3); the scheduled path MUST NOT require it |

Validation **MUST NOT** echo the offending value when that value came from a secret
binding. Non-secret bindings MAY be named in the error.

## 3. Traffic units

The traffic threshold and public `trafficGB` value use **console-aligned GB**.
The display label remains `GB` to align with the Alibaba CDT console; its divisor
is `1024^3` bytes (the GiB-scale divisor), not the SI decimal `10^9` bytes.

$$\text{trafficGB} = \frac{\text{trafficBytes}}{1024^{3}}$$

Owner-provided live evidence confirms the console-aligned calculation: `27,858,630`
bytes displays as approximately `0.02595 GB` in CDT, and dividing by `1024^3` gives
approximately `0.02594537`. The public field and environment names retain `GB` for
operator and console alignment. The default `TRAFFIC_THRESHOLD_GB` remains `180`;
the threshold number is not adjusted to compensate for the conversion.

The conversion MUST exist in exactly one named function. `Traffic` bytes MUST be
treated as an assumption sourced from SDK typing and reference implementations (no
Alibaba prose source states the unit) and MUST be validated at first deployment
against the Alibaba console before enforcement is trusted (risk R4).

Boundary comparison MUST be performed on values that are exact in binary floating
point for the test inputs chosen, so that boundary tests assert real behaviour rather
than floating-point noise. Implementations SHOULD compare in a domain that avoids
representation error at the boundary.

## 4. Alibaba RPC layer

### 4.1 Method

Signature version **V3 (`ACS3-HMAC-SHA256`)** is the default. V2 (`HMAC-SHA1`) remains
selectable via `SIGNATURE_VERSION` because the target operation is undocumented and the
accepted method cannot be confirmed (risks R1, R3). The choice is configuration, never
a code branch scattered across call sites: there is exactly one `callRpc()` boundary.

### 4.2 V3 request construction

| Aspect | Requirement |
| --- | --- |
| Transport | `POST` over HTTPS |
| Path | `/` for RPC-style APIs |
| Body | form-encoded `key1=value1&key2=value2`; `content-type: application/x-www-form-urlencoded` |
| Headers | `host`, `x-acs-action`, `x-acs-version`, `x-acs-date`, `x-acs-signature-nonce`, `x-acs-content-sha256`, `Authorization` |
| `x-acs-date` | `yyyy-MM-ddTHH:mm:ssZ`, UTC. MUST be within 15 minutes of Alibaba's clock. |
| `x-acs-signature-nonce` | Unique per request; MUST NOT be reused. |
| `x-acs-content-sha256` | `HexEncode(SHA256(body))`, lowercase hex. Empty body ⇒ `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. |
| CanonicalRequest | `Method \n CanonicalURI \n CanonicalQueryString \n CanonicalHeaders \n SignedHeaders \n HashedRequestPayload` |
| StringToSign | `"ACS3-HMAC-SHA256\n" + HexEncode(SHA256(CanonicalRequest))` |
| Signature | `HexEncode(HMAC-SHA256(rawAccessKeySecret, StringToSign))`, lowercase hex |
| `Authorization` | `ACS3-HMAC-SHA256 Credential=<AK>,SignedHeaders=<sorted ;-joined>,Signature=<sig>` |

`CanonicalHeaders` entries are `lowercase(name) + ":" + trim(value) + "\n"`, sorted
ascending by lowercase name; `SignedHeaders` is that same set of names joined by `;`.

**`x-acs-content-sha256` IS a signed header.** An earlier research probe suggested
otherwise; that probe was malformed (form parameters placed in the body instead of the
query string). The published example and the P1 implementation agree, and the
conclusion MUST NOT be reverted.

**`content-type` is signed only when present.** It is not added unconditionally;
doing so changes `SignedHeaders` and therefore the signature.

**`Action` and `Version` are sent as form parameters as well as signed headers.** The
server resolves the operation from the payload. A headers-only implementation is
incorrect.

### 4.3 V2 request construction (fallback)

`Signature = Base64(HMAC-SHA1(AccessKeySecret + "&", UTF8(StringToSign)))` where
`StringToSign = Method + "&" + encodeURIComponent("/") + "&" + encodeURIComponent(CanonicalizedQueryString)`,
with `Signature` excluded from the sorted parameters. Note the differing signing key:
V2 appends `&` to the secret, V3 does not.

### 4.4 Percent-encoding (identical in both versions)

RFC 3986 with unreserved set `A-Za-z0-9-_.~` left intact. Additionally:

| Character | Encoding |
| --- | --- |
| space | `%20` |
| `*` | `%2A` |
| `~` | left as `~` (never `%7E`) |
| `!` `'` `(` `)` | percent-encoded |

Parameters are sorted ascending by key with `Signature` excluded. Array and object
values flatten to indexed key-value pairs (`{"k":["v1","v2"]}` → `k.1=v1&k.2=v2`).

### 4.5 Required signing tests

Both official vectors MUST be pinned as deterministic, offline tests:

| Fixture | Expected |
| --- | --- |
| V3 — `POST /`, `host=ecs.cn-shanghai.aliyuncs.com`, `x-acs-action=RunInstances`, `x-acs-version=2014-05-26`, `x-acs-date=2023-10-26T10:22:32Z`, `x-acs-signature-nonce=3156853299f313e23d1673dc12e1703d`, body `ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai`, secret `YourAccessKeySecret` | `HashedCanonicalRequest = 7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259`<br>`Signature = 06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0` |
| V2 — `GET /`, `AccessKeyId=testid`, `Action=DescribeDedicatedHosts`, `Format=JSON`, `RegionId=cn-beijing`, `SignatureMethod=HMAC-SHA1`, `SignatureNonce=edb2b34af0af9a6d14deaf7c1a5315eb`, `SignatureVersion=1.0`, `Timestamp=2023-03-13T08:34:30Z`, `Version=2014-05-26`, secret `testsecret` | `Signature = 9NaGiOspFP5UPcwX8Iwt2YJXXuk=` |

Both fixtures reproduce byte-exact and are implemented in P1 (`test/aliyun/signing.test.ts`).

A wire-level test MUST verify the produced signature with an implementation that does
not share the production helper code, so that a shared mistake cannot pass unnoticed.
That test MUST discriminate: pinning the payload hash to the empty-body constant MUST
make it fail.

### 4.6 Error classification

| Condition | Class | Retryable |
| --- | --- | --- |
| Transport throw / DNS / TLS / connection reset | transport | Yes |
| HTTP 429 | throttle | Yes |
| HTTP ≥ 500 | server | Yes |
| Body contains a throttle-style error code | throttle | Yes |
| HTTP 4xx (validation, auth, not-found) | client | **No** |
| HTTP 2xx with API error code | api | **No** |
| HTTP 2xx with unparseable body | parse | **No** |

**HTTP status is authoritative for classification.** A 4xx MUST NOT be reclassified as
retryable merely because its body carries a service-specific `Code`. An earlier draft
did exactly that and would have burned the Cron budget on calls that cannot succeed.

Retries MUST be bounded by a small constant (currently 2 attempts) and MUST use
backoff. An unbounded or long retry loop is prohibited: the Cron invocation has a
finite CPU and duration budget (§11).

### 4.7 Success determination

A response is successful only if the transport succeeded, the body parsed, and the
API reported success. Alibaba signals success either by a 2xx with a usable body or by
a `Code` value of `ok`, `200`, or `success`. Any other `Code` is an error and its
`Message` MUST be surfaced (sanitised).

An empty or unparseable body on a 2xx is a **parse failure**, never an empty success.
Treating it as `{}` would surface as zero traffic and trip the threshold against
unknown state.

## 5. CDT monitoring

### 5.1 Request

`ListCdtInternetTraffic`, version `2021-08-13`, `POST` to `CDT_ENDPOINT`, RPC style,
form body. The only request parameter is `BusinessRegionId`, sent **only** when
`BUSINESS_REGION_ID` is configured. There are no pagination parameters, and the
implementation MUST NOT send or expect them.

### 5.2 Response contract (owned by this project, not inherited)

`RequestId` (string) and `TrafficDetails` (array). Each entry MAY contain
`BusinessRegionId`, `ISPType`, `ProductTrafficDetails[]`, `Traffic` (long), and
`TrafficTierDetails[]`.

Because the operation is undocumented, **every field is treated as optional**. The
implementation MUST tolerate absent, reordered, additionally-present, and
differently-typed fields, and MUST fail closed when the required value cannot be
established.

### 5.3 Reduction rule

$$\text{trafficBytes} = \sum_{i} \texttt{TrafficDetails}[i].\texttt{Traffic}$$

All entries are summed. When `BUSINESS_REGION_ID` is configured it is applied as a
server-side request parameter, not as a client-side filter, so that the sum always
reflects what the API returned. The live query, donor status card, and scheduled
webhook expose the all-entry scope and `BusinessRegionId` totals from those actual
entries. Missing region identifiers remain `null`. These are CDT business regions
under one configured credential set; they are not ECS regions or multiple accounts.
Historical D1 rows retain total-only traffic because per-entry data is not stored.

There is **no pagination**. This replaces the originating brief's pagination
requirement; multi-entry summation over `TrafficDetails` is the substitute test
obligation, and the substitution is stated here so it is not mistaken for a dropped
requirement.

### 5.4 Validation — fail closed

The value is **valid** only if all hold:

1. The response is a success per §4.7.
2. `TrafficDetails` is present and is an array.
3. Every element's `Traffic`, when present, is a finite number ≥ 0.
4. The summed result is finite and ≥ 0.

Otherwise the run **aborts before any ECS call**. These are all invalid and MUST NOT
be coerced to `0`:

- `TrafficDetails` absent, `null`, not an array
- an entry's `Traffic` absent, `null`, `""`, non-numeric, `NaN`, `Infinity`, or negative
- an empty `TrafficDetails` array (see §5.5)
- an API error code, a malformed body, or a transport failure

> **Invariant.** Inability to establish traffic is never evidence that traffic is zero.

### 5.5 Empty array

An empty `TrafficDetails` array is treated as **invalid**, not as zero. Zero traffic
and unavailable traffic are different facts, and only one of them is safe to infer.
A genuinely zero-traffic account is expected to still report its regions.

This is a deliberate, conservative choice: it fails closed. If, at first live
deployment, Alibaba returns an empty array for a legitimately zero-traffic account,
this rule will be revisited with evidence — not pre-emptively loosened.

## 6. ECS control

### 6.1 Describe

`DescribeInstances`, version `2014-05-26`, `POST` to
`ecs.<REGION_ID>.aliyuncs.com`, with `RegionId` and `InstanceIds` (JSON-array string)
for the single managed instance.

The observed status is the matching instance's `Status`, normalised to one of:

| Status | Normalised | Terminal? |
| --- | --- | --- |
| `Running` | `running` | yes |
| `Stopped` | `stopped` | yes |
| `Starting` | `starting` | no (transitional) |
| `Stopping` | `stopping` | no (transitional) |
| `Pending` | `pending` | no (transitional) |
| anything else, absent, or non-string | `unknown` | no |

If the instance is absent from the response, the status is `unknown` **and** this is
treated as an ECS failure: the run aborts with no mutation. A missing instance is not
evidence that the instance is stopped.

### 6.2 Decision rule

Desired state:

| Condition | Desired |
| --- | --- |
| `trafficGB < thresholdGB` | `running` |
| `trafficGB >= thresholdGB` | `stopped` |

Comparison is on the boundary: exactly at the threshold means **stopped**. Tests MUST
cover `threshold − ε`, exactly `threshold`, and `threshold + ε`.

`decision()` is a **pure function**. It MUST NOT perform network I/O, read D1, or
dispatch a webhook. Its inputs are the traffic total, the threshold, and the observed
ECS status; its output is the desired state, the chosen action, and a reason. It MUST
be testable with no mocks.

### 6.3 Action matrix

| Desired | Observed | Action | Mutation |
| --- | --- | --- | --- |
| running | `running` | `none-running` | none |
| running | `starting` | `none-starting` | none |
| running | `stopped` | `start` | `StartInstance` |
| running | `stopping` | `fail-safe` | **none** |
| running | `pending` | `fail-safe` | **none** |
| running | `unknown` | `fail-safe` | **none** |
| stopped | `stopped` | `none-stopped` | none |
| stopped | `stopping` | `none-stopping` | none |
| stopped | `running` | `stop` | `StopInstance` |
| stopped | `starting` | `fail-safe` | **none** |
| stopped | `pending` | `fail-safe` | **none** |
| stopped | `unknown` | `fail-safe` | **none** |

At most **one** mutation is issued per run. Repeated Start or Stop issuance is
prohibited: if the observed state already reflects the desired state — including its
transitional form — the run is a no-op. The `fail-safe` rows abort with an error
webhook and no mutation, deliberately, because issuing a control command against an
instance in an unrecognised state risks acting on a stale or contradictory reading.
No safe transition exists for these rows and none is invented.

### 6.4 Stop semantics

`ForceStop` is `false` and MUST NOT be made configurable to `true` in the initial
release. Force-stopping risks filesystem corruption and is exactly the kind of
destructive shortcut this project exists to avoid.

`StoppedMode` defaults to **`KeepCharging`** and is sent on every stop request. It
remains configurable so it can be changed to `StopCharging` later without any code
change.

**Owner decision and rationale.** The primary objective of this project is CDT traffic
enforcement with reliable automatic recovery, not compute-cost optimisation.
`KeepCharging` preserves instance resources — including the public IP and any local
state — and avoids introducing economical-mode restart-capacity and public-IP risks
into the initial release.

Two behaviours constrain how this is implemented:

1. **Success is not evidence of effect.** Alibaba **returns no error** when an instance
   does not support economical mode; it stops under the priority mode instead and the
   configured `StoppedMode` is silently ignored. The implementation MUST NOT infer that
   the requested mode took effect merely because `StopInstance` returned success. The
   mode is reported as *requested*, never as *applied*, and no branch of logic may
   depend on it having taken effect.
2. **If `StopCharging` is selected later**, the operator MUST first read the documented
   implications below. The configuration is therefore safe to change but not safe to
   change blindly.

#### Implications of selecting `StopCharging` (documentation obligation)

These MUST be recorded in the operations documentation so that a future operator
changing `STOPPED_MODE` to `StopCharging` does so with the consequences visible:

- **Restart capacity risk** — a stopped-with-charging-disabled instance releases its
  compute resources, so a later `StartInstance` depends on capacity being available for
  that instance type in that zone. `OperationDenied.NoStock` becomes a live failure mode
  that does not exist under `KeepCharging`. Under this project's design that failure
  surfaces as `stage: "ecs-start"` with the instance left stopped — i.e. traffic
  enforcement succeeds but automatic recovery may not.
- **Public IP risk** — depending on the instance's public-IP addressing mode, releasing
  resources can change or lose the public address, which for a traffic-relay use case
  can break the very relay the instance exists to provide. The address MUST be verified
  as preserved before trusting `StopCharging` in production.
- **Silent-ignore caveat still applies** — neither risk produces an error at stop time.
  Both are discovered only at restart, which is the worst possible moment.

### 6.5 Hierarchy of authority

CDT failure and ECS describe failure both abort before any mutation. A failure to
*observe* is never resolved by *acting*.

**Alibaba Cloud is the authority for ECS state.** D1 history (§9) and the webhook (§7)
are observational and are never inputs to a control decision.

## 7. Webhook reporting

### 7.1 Independence

Webhook reporting is an optional subsystem, logically independent of ECS control.
A webhook failure MUST NOT
cancel, reverse, or trigger an ECS operation, change the decision, or cause an unsafe
fallback. Notification is a reporting side channel, never a control input. Webhook
dispatch MUST NOT be able to throw into the control path.

### 7.2 Cadence

`WEBHOOK_URL` is optional. When it is absent, no webhook request is attempted and
the report has `webhookAttempted: false` and `webhookOk: undefined`; D1 stores
`webhook_attempted = 0` and `webhook_ok = NULL`. When a valid URL is configured,
exactly one attempt is made for each scheduled run, including `none-running`,
`none-stopped`, `start`, `stop`, and pipeline error runs. `WEBHOOK_TOKEN` may be
omitted for an unauthenticated endpoint, but cannot be set without the URL.

Webhook dispatch is non-blocking with respect to the control result: the outcome is
already fixed before dispatch begins.

### 7.3 Success payload

```jsonc
{
  "status": "success",
  "trafficGB": 123.45,
  "thresholdGB": 180,
  "ecsStatusBefore": "running",
  "ecsStatusAfter": "stopped",
  "action": "stop",
  "decisionReason": "traffic 123.45 GB has reached threshold 180 GB; instance is \"running\", so a stop is required",
  "trafficAggregation": {
    "unit": "bytes",
    "summationScope": "all TrafficDetails entries",
    "totalBytes": 132553428173,
    "entries": [{"businessRegionId": "cn-hongkong", "ispType": "CMI", "trafficBytes": 132553428173}],
    "byBusinessRegion": [{"businessRegionId": "cn-hongkong", "trafficBytes": 132553428173, "entryCount": 1}]
  },
  "stoppedModeRequested": "KeepCharging",
  "instanceId": "i-xxxxxxxx",
  "region": "cn-hongkong",
  "time": "2026-09-20T15:20:58Z",
  "durationMs": 812
}
```

`decisionReason` is included only after `decide()` produced a reason. The
`trafficAggregation` audit is included only when a valid CDT reading exists.
`region` remains the configured ECS `REGION_ID`; `trafficAggregation` uses CDT
`BusinessRegionId` values and contains no account identifiers.

`stoppedModeRequested` is present only when a stop was issued, and records the mode
that was **requested** in the request — never a claim that it was applied. Per §6.4,
Alibaba silently ignores an unsupported mode and returns no error, so the applied mode
is not observable from the API response and MUST NOT be inferred or reported.

`action` ∈ {`none-running`, `none-starting`, `none-stopped`, `none-stopping`,
`start`, `stop`, `fail-safe`}. `ecsStatusAfter` is the state observed from **one**
immediate follow-up describe and MAY legitimately be `starting` or `stopping`;
`running` or `stopped` is not guaranteed on the same invocation. No long-polling.

`time` is ISO 8601 UTC. `durationMs` is wall-clock milliseconds for the run.

### 7.4 Error payload

```jsonc
{
  "status": "error",
  "stage": "cdt-query",
  "error": "sanitised message",
  "thresholdGB": 180,
  "instanceId": "i-xxxxxxxx",
  "region": "cn-hongkong",
  "time": "2026-09-20T15:20:58Z",
  "durationMs": 340
}
```

An error payload may include `decisionReason` or `trafficAggregation` when the run
established those values before the error. They are omitted otherwise. A missing
reason is never reconstructed from an error message.

`stage` ∈ {`config`, `cdt-query`, `ecs-describe`, `ecs-start`, `ecs-stop`,
`webhook`, `unexpected`}. The HTTP surface adds no new stages; failures on the manual
path are returned as HTTP responses, not as webhook dispatches.

For `stage: "webhook"` the webhook cannot report its own failure; the failure is
logged locally and the payload is not sent.

### 7.5 Secret hygiene

No AccessKey ID, AccessKey secret, webhook token, `ADMIN_TOKEN`, `Authorization`
header, or secret-bearing URL is ever included in a payload, a log line, a rendered
HTML document, a D1 row, or an error string. When `stage` is `config` or `webhook`,
messages are composed from literals rather than interpolating binding values. Error
text originating from a remote service is sanitised before dispatch.

### 7.6 Authentication

When `WEBHOOK_TOKEN` is set, each request carries
`Authorization: Bearer <token>`. The token is never logged.

### 7.7 Delivery

When configured, `WEBHOOK_URL` receives `POST` with
`content-type: application/json`. Any non-2xx status or thrown error is logged
locally and produces `webhookOk: false`; it has no other effect on the report or
control outcome. When absent, the transport is not called.

## 8. HTTP surface and authentication

### 8.1 Routes

| Method | Path | Auth | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/health` | **Public** | `200` with a small JSON liveness body. |
| `GET` | `/` | Required | Donor console served from Workers Static Assets (§8.4). |
| `GET` | `/api/history` | Required | Bounded monitoring history (§9.5). |
| `POST` | `/api/query` | Required | Live read-only query (§8.5). |

Every other path MUST return `404`. A known path with an unsupported method MUST
return `405`.

`GET /health` performs no privileged work, reads no Alibaba API, mutates nothing, reads
no D1 row, and reveals no configuration beyond liveness.

### 8.2 Authentication model

| Mechanism | Use |
| --- | --- |
| HTTP Basic (`ADMIN_USER`:`ADMIN_TOKEN`) | Browser access to `/` and `/api/*`. |
| Bearer (`ADMIN_TOKEN`) | Non-browser API clients. |

- `ADMIN_USER` defaults to `admin` when unset or empty.
- `ADMIN_TOKEN` is a Workers Secret. It MUST NOT be logged, rendered, or returned.
- Credential comparison MUST be timing-safe. Comparison MUST NOT short-circuit on the
  first differing character.
- On failure the Worker MUST respond `401` with a
  `WWW-Authenticate: Basic realm="..."` challenge and MUST NOT disclose whether the
  username or the password was wrong.
- A malformed `Authorization` header (unparseable Base64, no `:` separator,
  unrecognised scheme) MUST be treated as unauthenticated, never as authenticated.
- The `Authorization` header MUST NOT be echoed in any response body or log line.

### 8.3 Fail closed on missing `ADMIN_TOKEN`

If `ADMIN_TOKEN` is absent or empty, every protected route MUST deny access. The Worker
MUST NOT serve the dashboard or API unauthenticated, and MUST NOT fall back to an
empty or default token. This is a deliberate fail-closed choice: an operator who
forgets to set the secret gets a locked door, not an open one.

### 8.4 Dashboard content

The donor console is served from the same Worker through the `ASSETS` binding. It
shows one configured ECS instance with current traffic and threshold in GB, usage
percentage, current ECS status, read-only query target state, and the live decision
reason. It also displays the all-entry CDT summation scope and actual
`BusinessRegionId` byte totals. Its history view uses real traffic samples and shows
recent scheduled reasons from D1; pre-migration reasons stay visibly unknown.

The donor console performs no privileged operation merely by being rendered, and
MUST NOT embed a secret, token, or credential-bearing URL in the document. Dynamic
reason and region values are rendered as text, not HTML.

### 8.5 Manual query — strictly read-only

`POST /api/query` performs:

1. a live CDT traffic query,
2. a live ECS `DescribeInstances`,
3. `decision()`.

It then returns those results. **It MUST NOT invoke `StartInstance` or
`StopInstance`.** Both operations MUST be unreachable from every HTTP route; a test
MUST assert that neither was called.

When the CDT reading is valid, the response includes `reason` from `decide()` and a
`trafficAggregation` object: byte unit, explicit all-`TrafficDetails` summation
scope, the actual entries, and totals grouped by CDT `BusinessRegionId`. Missing
identifiers are `null`; the response does not synthesize regions or account rows.

The endpoint exists to power "Query now" / "Refresh" on the dashboard, so an operator
can observe current state without waiting for the next Cron tick. It deliberately stops
one step before acting.

**There is no `POST /start`, `/stop`, `/run-control`, or `/execute-control`, and none
may be added in v1.** The Cron Trigger is the only ECS mutation authority in v1.

A manual query MUST NOT write a history row: history records **scheduled executions**,
and a manual read MUST NOT be able to masquerade as a control run (§9.2).

## 9. D1 monitoring history

### 9.1 Role

D1 is **observational history**. Alibaba Cloud remains the authority for ECS state.
No control decision may read from D1, and a D1 failure MUST NOT alter a control
outcome.

### 9.2 Trigger semantics

Row identity MUST distinguish how the run was triggered. Only config-valid
**scheduled** executions produce rows in v1; config failures exit before history
persistence, and manual queries (§8.5) do not write. This keeps history an accurate
record of *automatic* decisions and prevents a manual read from appearing as a
control run.

### 9.3 Schema

Binding `TRAFFIC_DB`, table `traffic_checks`, introduced by a versioned migration:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | Insertion order; used as the ordering tiebreaker. |
| `checked_at` | TEXT NOT NULL | ISO 8601 UTC. |
| `trigger` | TEXT NOT NULL | e.g. `scheduled`. |
| `status` | TEXT NOT NULL | `success` or `error`. |
| `traffic_gb` | REAL | Null when traffic could not be established. |
| `threshold_gb` | REAL NOT NULL | |
| `usage_percent` | REAL | Derived; null when traffic is unknown. |
| `remaining_gb` | REAL | Derived; null when traffic is unknown. |
| `ecs_status_before` | TEXT | Normalised status, or null when not observed. |
| `desired_ecs_state` | TEXT | |
| `action` | TEXT | |
| `ecs_status_after` | TEXT | Null when no mutation or no follow-up describe. |
| `decision_reason` | TEXT | Nullable. Set only when `decide()` produced a reason; rows written before migration and runs that never reached a decision remain NULL. Added by `0002_decision_reason.sql`; no backfill. |
| `control_ok` | INTEGER | Boolean. |
| `webhook_attempted` | INTEGER | Boolean. |
| `webhook_ok` | INTEGER | Boolean; null when not attempted. |
| `error_stage` | TEXT | Null on success. |
| `error_message` | TEXT | **Sanitised.** Null on success. |
| `duration_ms` | INTEGER | |

Indexed on `checked_at` to support bounded reads.

**Unknown traffic MUST be stored as NULL, not as `0`.** §5.4's invariant applies to
persistence as well: a row MUST NOT record a fabricated zero for a value that could
not be established.

### 9.4 Prohibited content

A row MUST NOT contain:

- `ALIYUN_ACCESS_KEY_ID` or `ALIYUN_ACCESS_KEY_SECRET`
- `ADMIN_TOKEN` or `WEBHOOK_TOKEN`
- any secret-bearing URL
- a raw credential-bearing Alibaba request or response

Error messages MUST be sanitised before insertion. `stage` MUST be one of the
enumerated values in §7.4; unrecognised internal errors map to `unexpected`.

### 9.5 Read API

`GET /api/history`:

- requires authentication (§8.2),
- returns rows **newest first**,
- orders deterministically by `(checked_at DESC, id DESC)`,
- applies a bounded limit with a hard maximum; an oversized or malformed `limit`
  parameter MUST be clamped rather than honoured,
- is read-only: it MUST NOT write, migrate, or mutate anything,
- returns JSON; it does not render HTML.
- includes `decision_reason` as NULL for old or otherwise unknown rows; no reason is
  reconstructed from the status, action, or error text.

### 9.6 Failure isolation

A D1 write failure MUST NOT reverse, alter, or block the ECS control result. It MUST
be recorded in the **in-memory execution report** for the current run and logged, and
it MUST NOT throw into the control path.

> **A row MUST NOT claim its own `INSERT` succeeded before the `INSERT` occurs.**
> Persistence success (`storageOk`) is therefore represented as a field of the
> in-memory execution report, **not** as a value written by the very insert that would
> have to describe itself.

A failure to *read* history (dashboard or `/api/history`) MUST NOT affect the
scheduled control path, which never reads history.

### 9.7 Retention

Rows accumulate at the Cron cadence (~144/day). Per owner decision (PLAN **Q5**,
resolved 2026-09-22), v1 retains them **indefinitely** and performs no automatic
deletion. Pruning is an explicit operations task if unbounded growth later becomes a
concern.

## 10. Manual query vs scheduled control

The distinction is normative and MUST be visible in code and tests:

| | `POST /api/query` — manual | Cron — scheduled |
| --- | --- | --- |
| Auth | Required | Not applicable |
| CDT query | Yes | Yes |
| ECS describe | Yes | Yes |
| `decision()` | Yes | Yes |
| ECS mutation | **Never** | At most one, per §6.3 |
| Webhook dispatch | **No** | One attempt per execution when configured (§7.2) |
| D1 write | **No** | Every config-valid execution (§9.2) |
| Failure surface | HTTP response | D1 + optional webhook |

The two paths share the read and decide logic but diverge strictly before any act. The
manual path is not a weakened or bypassed version of the scheduled path; it is a
different path that stops earlier.

## 11. Runtime constraints

| Constraint | Consequence |
| --- | --- |
| Cron CPU: Free platform allowance is 10 ms; Paid / Standard Usage Model allows 30 s (intervals < 1 hour) | The platform applies Free's allowance automatically; deployment configs omit custom `limits.cpu_ms`. Retries are bounded; no busy-waiting; no long-polling. D1 writes add CPU on the scheduled path. First natural Cron measured `cpuTimeMs` 9, within the 10 ms allowance, so the required plan is Workers Free. |
| Cron duration: 15 min | The Worker stays short-lived and never waits for a terminal ECS state. |
| Subrequests: 50 free / 10,000 paid | The run uses a small, bounded number of subrequests; the dashboard render performs none. |
| Cron expressions: 5 fields, UTC, `1 = Sunday … 7 = Saturday` | `*/10 * * * *` is used and is unambiguous. |
| Memory: 128 MB | Responses are small; no buffering of large bodies. |
| Simultaneous connections: 6 | Calls are sequential, not fanned out. |

The project stays on Workers Free. The Free CPU allowance is platform-applied, so
custom `limits.cpu_ms` is omitted from committed and generated configs. The first
natural production Cron measured `cpuTimeMs` 9, within the 10 ms allowance, so
Workers Free is the required plan (risk R8; `docs/operations/deployment.md` §7).
Paid is not required solely by that single-run observation. A custom CPU setting
may be considered only on Paid / Standard Usage Model after a later measurement
and an explicit owner choice.

## 12. Testing requirements

All tests are offline and deterministic. No test performs a live Alibaba Cloud mutation
and no test requires network access. All network I/O is mocked. **The existing P1 test
baseline (144 tests) is retained and MUST NOT be reduced.**

| Area | Required cases |
| --- | --- |
| Signing | Both official vectors byte-exact; encoding of space, `*`, `~`, `!`, `'`, `(`, `)`; ascending sort with `Signature` excluded; canonical header ordering; nonce uniqueness; timestamp format; wire-level verification with an independent implementation that discriminates |
| Transport | Success; API error code; HTTP ≥ 500; HTTP 429; transport throw; retry-then-success; retry exhaustion; 4xx not retried; status-authoritative classification |
| CDT | Multi-entry summation; single entry; `TrafficDetails` absent / null / non-array / empty; `Traffic` absent / null / `""` / non-numeric / `NaN` / negative; API error; malformed body; `BusinessRegionId` sent only when configured |
| Units | Byte→GB conversion; `threshold − ε` / `threshold` / `threshold + ε` |
| ECS | All five statuses; unknown status; instance absent; both mutations; each failure path; asynchronous post-state |
| Decision | Full action matrix in §6.3, including every `fail-safe` row; purity (no I/O) |
| Idempotency | No mutation when observed already equals desired, including transitional forms |
| Webhook | Configured and absent paths; success payload; each error stage; bearer present/absent; non-2xx; thrown error; control flow unaffected; one attempt per scheduled execution when configured |
| Config | Each validation failure in §2.4 |
| HTTP | `GET /health` succeeds and is inert; unknown route ⇒ 404; wrong method ⇒ 405 |
| **Auth** | Valid Basic; invalid Basic; malformed Basic; missing `ADMIN_TOKEN` fails closed; Bearer path; timing-safe comparison does not short-circuit |
| **Manual query** | CDT queried; ECS described; decision returned; **`StartInstance` never called**; **`StopInstance` never called**; no D1 write; no webhook |
| **D1** | Successful insert; bounded history; newest-first ordering with deterministic tiebreaker; unknown traffic stored as NULL not 0; sanitised errors; no secret stored; storage failure does not alter the control decision |
| **Dashboard** | Render contract: required fields present; HTML-escaped output; no secret echoed |
| **Redaction** | Secrets never appear in logs, payloads, rendered HTML, D1 rows, or error strings |

Dashboard tests are **semantic/render-contract tests**. Pixel snapshots and assertions
on CSS literals or layout are prohibited (PLAN §8.3 D2).

Tests MUST assert observable behaviour. Tests that assert implementation details —
field copies, mock echoes, source text, incidental defaults — MUST NOT be written, and
any existing test of that kind MUST be removed rather than re-pinned.

## 13. Acceptance criteria

| # | Criterion | Verified by |
| --- | --- | --- |
| A1 | CDT failure ⇒ zero ECS mutations, error report, one webhook attempt when configured, exit | CDT + pipeline tests |
| A2 | Missing/invalid traffic never becomes `0` | CDT validation tests |
| A3 | Desired equals observed ⇒ no mutation | Idempotency tests |
| A4 | Webhook failure cannot alter ECS control | Webhook isolation tests |
| A5 | No secret in logs, payloads, HTML, D1, or errors | Redaction tests |
| A6 | No HTTP route performs a mutation; `/api/query` is read-only | Manual-query + HTTP tests |
| A7 | Both official signature vectors reproduce exactly | Signing tests |
| A8 | Boundary semantics: `< threshold` running, `>= threshold` stopped | Decision tests |
| A9 | Every `fail-safe` row performs no mutation | Decision + ECS tests |
| A10 | CI passes with no credentials and no live calls | CI configuration |
| A11 | D1 write failure does not alter the control outcome | D1 isolation tests |
| A12 | Protected routes deny unauthenticated and malformed requests | Auth tests |
| A13 | `decision()` is pure and unit-testable without mocks | Decision purity tests |
| A14 | Decision reasons are persisted only when produced; earlier D1 rows remain NULL | Migration + history tests |
| A15 | Audit scope names every returned `TrafficDetails` entry and groups only actual CDT regions | Query + webhook + adapter tests |

## 14. Open questions

Q1's implementation choice is to sum every returned `TrafficDetails` entry and
expose its actual CDT business-region breakdown (§5.3). Its external meaning still
requires comparison with the CDT console before enforcement is trusted (A5). Q3's
identifier namespace remains empirically unconfirmed; ECS `REGION_ID` and CDT
`BusinessRegionId` stay separate fields. **Q4 (Cloudflare plan), Q5 (history retention), and Q6 (repository
visibility / branch protection)** are resolved by owner decision (2026-09-22): the
project stays on the Workers Free plan; its CPU allowance is platform-applied, and
the first natural Cron measured `cpuTimeMs` 9, so Workers Free remains the
required plan (§11, risk R8); `traffic_checks` is retained indefinitely with no
automatic deletion (§9.7); and the repository is public, so the `main` protection
ruleset is enabled
(PLAN §14.1, risk R11). Each resolved item has a stated default in the PLAN, so
implementation is unblocked while any remaining owner answer can still change behaviour
without code changes.

**Q2 (`StoppedMode`) is resolved** by owner decision: default `KeepCharging`,
configurable, with `StopCharging` implications documented in §6.4.
