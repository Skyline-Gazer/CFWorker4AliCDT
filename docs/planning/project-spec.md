# CFWorker4AliCDT — Project Specification

> Status: **Draft for owner review.** Companion to [project-plan.md](./project-plan.md).
> Normative language: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.
> Where this SPEC and the PLAN disagree, the SPEC governs behaviour.

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
| `WEBHOOK_URL` | Yes | Absolute `https://` URL receiving run reports. |
| `WEBHOOK_TOKEN` | No | If present, sent as `Authorization: Bearer <token>`. |

Declared in the Wrangler configuration under `secrets.required`, so a deploy with a
missing secret **fails** rather than shipping a Worker that cannot authenticate.

### 2.2 Plain bindings (Wrangler `vars`)

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `REGION_ID` | Yes | — | ECS region, e.g. `cn-hongkong`. Used to build `ecs.<REGION_ID>.aliyuncs.com`. |
| `ECS_INSTANCE_ID` | Yes | — | The single managed instance, e.g. `i-xxxxxxxx`. |
| `TRAFFIC_THRESHOLD_GB` | No | `180` | Threshold in **decimal GB**. |
| `CDT_ENDPOINT` | No | `cdt.aliyuncs.com` | CDT API host. Configuration, not a constant (risk R2). |
| `BUSINESS_REGION_ID` | No | unset | If set, CDT `BusinessRegionId`. See §5.3. |
| `SIGNATURE_VERSION` | No | `v3` | `v3` or `v2`. See §4. |
| `STOPPED_MODE` | No | unset | `StopCharging`, `KeepCharging`, or unset. See §6.4. |

### 2.3 Validation

Configuration is validated **before any network call**. A failure here:

- performs **no** ECS mutation,
- dispatches an error webhook with `stage: "config"`,
- causes the run to exit.

Validation rules:

| Condition | Result |
| --- | --- |
| Any required binding absent or empty | config error |
| `TRAFFIC_THRESHOLD_GB` not a finite number | config error |
| `TRAFFIC_THRESHOLD_GB` ≤ 0 | config error |
| `WEBHOOK_URL` not an absolute `https://` URL | config error |
| `REGION_ID` or `ECS_INSTANCE_ID` absent | config error |
| `SIGNATURE_VERSION` not in {`v2`, `v3`} | config error |
| `STOPPED_MODE` not in {`StopCharging`, `KeepCharging`} and not unset | config error |

Validation **MUST NOT** echo the offending value when that value came from a secret
binding. Non-secret bindings MAY be named in the error.

## 3. Traffic units

The threshold is expressed in **decimal gigabytes**, defined as exactly
$10^9$ bytes ($1000^3$).

$$\text{trafficGB} = \frac{\text{trafficBytes}}{10^{9}}$$

**This is a deliberate behavioural divergence.** The originating script and both
independent reference implementations divide by $1024^3$ (GiB). Under this SPEC,
$180$ GB is $167.6$ GiB, so for the same raw byte count enforcement trips **earlier**
than those implementations would. This divergence MUST be documented in the README and
MUST NOT be silently inherited or "corrected" back.

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

Both fixtures were verified byte-exact against `crypto.subtle` during research.

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

Retries MUST be bounded by a small constant and MUST use backoff. An unbounded or
long retry loop is prohibited: the Cron invocation has a finite CPU and duration
budget (§11).

### 4.7 Success determination

A response is successful only if the transport succeeded, the body parsed, and the
API reported success. Alibaba signals success either by a 2xx with a usable body or by
a `Code` value of `ok`, `200`, or `success`. Any other `Code` is an error and its
`Message` MUST be surfaced (sanitised).

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
reflects what the API returned. The per-region breakdown SHOULD be included in the
webhook payload so the summation scope remains auditable (PLAN Q1).

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

`StoppedMode` is sent only when `STOPPED_MODE` is configured. When unset, the request
omits it and the instance's account/console configuration governs. Implementers MUST
record that if the instance does not support economical mode, Alibaba **returns no
error** and stops the instance under the priority mode instead — the configured mode is
silently ignored. `StoppedMode` is therefore never assumed to have taken effect.

### 6.5 Hierarchy of authority

CDT failure and ECS describe failure both abort before any mutation. A failure to
*observe* is never resolved by *acting*.

## 7. Webhook reporting

### 7.1 Independence

The webhook is logically independent of ECS control. A webhook failure MUST NOT
cancel, reverse, or trigger an ECS operation, change the decision, or cause an unsafe
fallback. Notification is a reporting side channel, never a control input. Webhook
dispatch MUST NOT be able to throw into the control path.

### 7.2 Cadence

A webhook is sent on **every** scheduled run — success, no-op, or error — per the
owner's decision.

### 7.3 Success payload

```jsonc
{
  "status": "success",
  "trafficGB": 123.45,
  "thresholdGB": 180,
  "ecsStatusBefore": "running",
  "ecsStatusAfter": "stopped",
  "action": "stop",
  "instanceId": "i-xxxxxxxx",
  "region": "cn-hongkong",
  "time": "2026-09-20T15:20:58Z",
  "durationMs": 812
}
```

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

`stage` ∈ {`config`, `cdt-query`, `ecs-describe`, `ecs-start`, `ecs-stop`,
`webhook`, `unexpected`}.

For `stage: "webhook"` the webhook cannot report its own failure; the failure is
logged locally and the payload is not sent.

### 7.5 Secret hygiene

No AccessKey ID, AccessKey secret, webhook token, `Authorization` header, or
secret-bearing URL is ever included in a payload, a log line, or an error string. When
`stage` is `config` or `webhook`, messages are composed from literals rather than
interpolating binding values. Error text originating from a remote service is
sanitised before dispatch.

### 7.6 Authentication

When `WEBHOOK_TOKEN` is set, each request carries
`Authorization: Bearer <token>`. The token is never logged.

### 7.7 Delivery

`WEBHOOK_URL` is called with `POST` and `content-type: application/json`. Any
non-2xx status or thrown error is a webhook failure: it is logged, classified under
`stage: "webhook"`, and has no other effect.

## 8. HTTP surface

`GET /health` returns `200` with a small JSON body indicating liveness. It performs no
privileged work, reads no Alibaba API, mutates nothing, and reveals no configuration
beyond liveness.

Every other path and method is refused. **No HTTP route can start, stop, reboot, or
otherwise control an ECS instance.** Control exists only on the Cron Trigger path,
which is not reachable over HTTP.

## 9. Logging

Every run logs a structured start, the observed traffic in bytes and GB, the observed
and desired states, the chosen action, the resulting state, and the duration. Errors
log the stage and a sanitised message.

Logs MUST NOT contain credentials, tokens, `Authorization` headers, or full URLs
carrying secrets. Workers Logs are persisted by default, so this is a correctness
requirement, not a preference.

## 10. Run pipeline

```
1. Validate configuration.            Failure ⇒ webhook(config), exit. No mutation.
2. Query CDT.                         Failure/invalid ⇒ webhook(cdt-query), exit. No mutation.
3. Describe the instance.             Failure ⇒ webhook(ecs-describe), exit. No mutation.
4. Decide desired state from §6.2.
5. If action is fail-safe:            webhook(error), exit. No mutation.
6. If action is none-*:               no mutation.
7. Otherwise issue exactly one mutation (start or stop).
   Mutation failure ⇒ webhook(ecs-start|ecs-stop), exit.
8. One immediate follow-up describe for ecsStatusAfter.
   A failure here does not undo the mutation and is reported as observed.
9. Dispatch the success webhook.      Failure ⇒ log only. Never affects control.
```

Any unhandled error maps to `stage: "unexpected"`, dispatches an error webhook, and
performs no mutation.

## 11. Runtime constraints

| Constraint | Consequence |
| --- | --- |
| Cron CPU: 10 ms free / 30 s paid (intervals < 1 hour) | Retries are bounded; no busy-waiting; no long-polling. |
| Cron duration: 15 min | Not a binding constraint for this design, but the Worker stays short-lived and never waits for a terminal ECS state. |
| Subrequests: 50 free / 10,000 paid | The run uses a small, bounded number of subrequests. |
| Cron expressions: 5 fields, UTC, `1 = Sunday … 7 = Saturday` | `*/10 * * * *` is used and is unambiguous. |
| Memory: 128 MB | Responses are small; no buffering of large bodies. |
| Simultaneous connections: 6 | Calls are sequential, not fanned out. |

The required Cloudflare plan MUST be stated in the deployment documentation once real
CPU usage is measured (risk R8).

## 12. Testing requirements

All tests are offline and deterministic. No test performs a live Alibaba Cloud
mutation, and no test requires network access. All network I/O is mocked.

| Area | Required cases |
| --- | --- |
| Signing | Both official vectors byte-exact; encoding of space, `*`, `~`, `!`, `'`, `(`, `)`; ascending sort with `Signature` excluded; canonical header ordering; nonce uniqueness; timestamp format |
| Transport | Success; API error code; HTTP ≥ 500; HTTP 429; transport throw; retry-then-success; retry exhaustion; 4xx not retried |
| CDT | Multi-entry summation; single entry; `TrafficDetails` absent / null / non-array / empty; `Traffic` absent / null / `""` / non-numeric / `NaN` / negative; API error; malformed body; `BusinessRegionId` sent only when configured |
| Units | Byte→GB conversion; `threshold − ε` / `threshold` / `threshold + ε` |
| ECS | All five statuses; unknown status; instance absent; both mutations; each failure path; asynchronous post-state |
| Decision | Full action matrix in §6.3, including every `fail-safe` row |
| Idempotency | No mutation when observed already equals desired, including transitional forms |
| Webhook | Success payload; each error stage; bearer present/absent; non-2xx; thrown error; control flow unaffected |
| Config | Each validation failure in §2.3 |
| HTTP | `GET /health` succeeds and is inert; all other paths/methods refused |
| Redaction | Secrets never appear in logs, payloads, or error strings |

Tests MUST assert observable behaviour. Tests that assert implementation details —
field copies, mock echoes, source text, incidental defaults — MUST NOT be written, and
any existing test of that kind MUST be removed rather than re-pinned.

## 13. Acceptance criteria

| # | Criterion | Verified by |
| --- | --- | --- |
| A1 | CDT failure ⇒ zero ECS mutations, error webhook, exit | CDT + pipeline tests |
| A2 | Missing/invalid traffic never becomes `0` | CDT validation tests |
| A3 | Desired equals observed ⇒ no mutation | Idempotency tests |
| A4 | Webhook failure cannot alter ECS control | Webhook isolation tests |
| A5 | No secret in logs, payloads, or errors | Redaction tests |
| A6 | Only `GET /health` is served; no control endpoint | HTTP tests |
| A7 | Both official signature vectors reproduce exactly | Signing tests |
| A8 | Boundary semantics: `< threshold` running, `>= threshold` stopped | Decision tests |
| A9 | Every `fail-safe` row performs no mutation | Decision + ECS tests |
| A10 | CI passes with no credentials and no live calls | CI configuration |

## 14. Open questions

Q1–Q4 from the PLAN remain open and are resolved by configuration defaults rather than
by assumptions baked into code: summation scope (Q1), `StoppedMode` (Q2), region
identifier namespace (Q3), Cloudflare plan (Q4). Each has a stated default in §2.2,
§5.3, and §6.4, so implementation is unblocked while the owner's answers can still
change behaviour without code changes.
