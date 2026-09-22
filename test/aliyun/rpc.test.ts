import { describe, expect, it } from "vitest";

import { callRpc, isRetryable, redact, RpcError } from "../../src/aliyun/rpc";
import type { CallRpcOptions, FetchLike } from "../../src/aliyun/rpc";

/**
 * Transport boundary tests.
 *
 * These pin the classification contract, because the entire fail-safe invariant
 * rests on it: a failure that is misreported as success, or as an empty result,
 * would cause a destructive action on unknown state.
 */

const BASE: Omit<CallRpcOptions, "fetch"> = {
  endpoint: "cdt.aliyuncs.com",
  action: "ListCdtInternetTraffic",
  version: "2021-08-13",
  accessKeyId: "AKID",
  accessKeySecret: "SECRET",
  now: () => Date.parse("2026-09-20T08:00:00Z"),
  nonce: () => "0".repeat(32),
};

/** Capture every request and replay a scripted sequence of responses. */
function stubFetch(responses: readonly (Response | Error)[]): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next!.clone());
  };
  return { fetch: fetchImpl, calls };
}

/** The body as a string. `RequestInit.body` is `BodyInit | null`; every call
 * here sets a string, so narrow once rather than widening at each assertion. */
function sentBody(call: { init: RequestInit } | undefined): string {
  const body = call?.init.body;
  if (typeof body !== "string") throw new Error("expected a string request body");
  return body;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("callRpc — success determination", () => {
  it("accepts a 2xx with a usable body and no Code", async () => {
    const { fetch } = stubFetch([json({ TrafficDetails: [] })]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it.each(["ok", "200", "success", "OK", "Success"])("accepts Code=%s as success", async (code) => {
    const { fetch } = stubFetch([json({ Code: code })]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(true);
  });

  it("accepts a numeric Code equal to the HTTP status", async () => {
    const { fetch } = stubFetch([json({ Code: 200 })]);
    expect((await callRpc({ ...BASE, fetch })).ok).toBe(true);
  });

  it("returns the parsed body as data", async () => {
    const payload = { TrafficDetails: [{ Traffic: 123 }] };
    const { fetch } = stubFetch([json(payload)]);
    const result = await callRpc<typeof payload>({ ...BASE, fetch });
    expect(result.ok && result.data).toEqual(payload);
  });
});

describe("callRpc — request construction", () => {
  it("POSTs to the endpoint root", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "ok" })]);
    await callRpc({ ...BASE, fetch });
    expect(calls[0]?.url).toBe("https://cdt.aliyuncs.com/");
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("sends form-encoded parameters in the body, sorted, alongside Action and Version", async () => {
    // Action and Version travel in the payload, not only in the x-acs-* headers.
    const { fetch, calls } = stubFetch([json({ Code: "ok" })]);
    await callRpc({ ...BASE, fetch, parameters: { B: "2", A: "1" } });
    expect(sentBody(calls[0])).toBe("A=1&Action=ListCdtInternetTraffic&B=2&Version=2021-08-13");
  });

  it("percent-encodes parameter values", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "ok" })]);
    await callRpc({ ...BASE, fetch, parameters: { InstanceId: "i a/b" } });
    expect(sentBody(calls[0])).toContain("InstanceId=i%20a%2Fb");
  });

  it("sends Action and Version as form parameters as well as signed headers", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "ok" })]);
    await callRpc({ ...BASE, fetch });
    const body = sentBody(calls[0]);
    expect(body).toContain("Action=ListCdtInternetTraffic");
    expect(body).toContain("Version=2021-08-13");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-acs-action"]).toBe("ListCdtInternetTraffic");
    expect(headers["x-acs-version"]).toBe("2021-08-13");
  });

  it("declares the content type it signs", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "ok" })]);
    await callRpc({ ...BASE, fetch, parameters: { A: "1" } });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("signs the request, sending an Authorization header", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "ok" })]);
    await callRpc({ ...BASE, fetch });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      /^ACS3-HMAC-SHA256 Credential=AKID,SignedHeaders=.+,Signature=[0-9a-f]{64}$/,
    );
  });

  it("uses V2 when asked", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "ok" })]);
    await callRpc({ ...BASE, fetch, signatureVersion: "v2" });
    expect(calls[0]?.url).toContain("SignatureMethod=HMAC-SHA1");
  });
});

describe("callRpc — error classification", () => {
  const cases: readonly [string, Response, string, boolean][] = [
    ["HTTP 400", json({ Code: "InvalidParameter" }, 400), "client", false],
    ["HTTP 403", json({ Code: "Forbidden" }, 403), "client", false],
    ["HTTP 404", json({ Code: "InvalidAction" }, 404), "client", false],
    ["HTTP 429", json({ Code: "Throttling" }, 429), "throttle", true],
    ["HTTP 500", json({ Code: "InternalError" }, 500), "server", true],
    ["HTTP 503", json({ Code: "ServiceUnavailable" }, 503), "server", true],
    ["2xx with API error code", json({ Code: "InvalidInstanceId" }), "api", false],
    ["2xx with throttling code", json({ Code: "Throttling.User" }), "throttle", true],
  ];

  it.each(cases)("classifies %s", async (_label, response, kind, retryable) => {
    const { fetch } = stubFetch([response]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe(kind);
    expect(result.error.retryable).toBe(retryable);
    expect(isRetryable(result.error.kind)).toBe(retryable);
  });

  it("classifies a transport throw as retryable transport failure", async () => {
    const { fetch } = stubFetch([new Error("ECONNRESET"), new Error("ECONNRESET")]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("transport");
    expect(result.error.status).toBeUndefined();
  });

  it("classifies an unparseable 2xx body as a non-retryable parse failure", async () => {
    const { fetch } = stubFetch([new Response("<html>gateway</html>", { status: 200 })]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("parse");
    expect(result.error.retryable).toBe(false);
  });

  it("treats an empty 2xx body as a parse failure, never as empty success", async () => {
    // The dangerous case: an empty body must not become `{}` and then a
    // zero-traffic reading.
    const { fetch } = stubFetch([new Response("", { status: 200 })]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("parse");
  });
});

describe("callRpc — retry behaviour", () => {
  it("retries a 500 once and succeeds on the second attempt", async () => {
    const { fetch, calls } = stubFetch([
      json({ Code: "InternalError" }, 500),
      json({ Code: "ok" }),
    ]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("retries a transport throw once and succeeds", async () => {
    const { fetch, calls } = stubFetch([new Error("socket hang up"), json({ Code: "ok" })]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gives up after the second failure and reports two attempts", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "InternalError" }, 500)]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a 4xx validation error", async () => {
    // A retry here wastes the Cron budget and cannot succeed.
    const { fetch, calls } = stubFetch([json({ Code: "InvalidParameter" }, 400)]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a 2xx API error code", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "InvalidInstanceId" })]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("retries a 2xx body carrying a throttling code", async () => {
    // SPEC §4.6 makes a throttle-style code retryable regardless of HTTP
    // status. Alibaba returns these with a 2xx often enough that only keying
    // on status would classify them as retryable yet never actually retry.
    const { fetch, calls } = stubFetch([json({ Code: "Throttling.User" }), json({ Code: "ok" })]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gives up after two 2xx throttle responses", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "Throttling.User" })]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("throttle");
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a parse failure", async () => {
    const { fetch, calls } = stubFetch([new Response("not json", { status: 200 })]);
    await callRpc({ ...BASE, fetch });
    expect(calls).toHaveLength(1);
  });

  it("issues a distinct nonce per attempt", async () => {
    let counter = 0;
    const { fetch, calls } = stubFetch([
      json({ Code: "InternalError" }, 500),
      json({ Code: "ok" }),
    ]);
    await callRpc({
      ...BASE,
      fetch,
      nonce: () => String(counter++).padStart(32, "0"),
    });
    const headers = calls.map(
      (c) => (c.init.headers as Record<string, string>)["x-acs-signature-nonce"],
    );
    expect(headers[0]).not.toBe(headers[1]);
  });
});

describe("redact", () => {
  it("removes an AccessKeyId from remote text", () => {
    expect(redact("AccessKeyId=LTAI5tSecret&RegionId=cn-hongkong")).not.toContain("LTAI5tSecret");
  });

  it("removes a Signature from remote text", () => {
    const text = "Signature=9NaGiOspFP5UPcwX8Iwt2YJXXuk=";
    expect(redact(text)).toBe("Signature=[REDACTED]");
  });

  it("removes a JSON-encoded secret field", () => {
    // The replacement is bare: the key's closing quote and the value's opening
    // quote are consumed together, so no stray quotes remain around the marker.
    expect(redact('{"AccessKeySecret":"abcdef","Message":"hi"}')).toBe(
      '{"AccessKeySecret":[REDACTED],"Message":"hi"}',
    );
  });

  it("removes a bare long opaque token", () => {
    expect(redact(`token ${"a".repeat(48)} here`)).toContain("[REDACTED]");
  });

  it("leaves ordinary error text readable", () => {
    expect(redact("InvalidInstanceId: the specified instance does not exist")).toBe(
      "InvalidInstanceId: the specified instance does not exist",
    );
  });
});

describe("RpcError", () => {
  it("never carries the secret through its message", async () => {
    const { fetch } = stubFetch([
      json({ Code: "InvalidParameter", Message: "AccessKeySecret=SECRET is invalid" }, 400),
    ]);
    const result = await callRpc({ ...BASE, fetch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain("SECRET");
  });

  it("exposes a retryable flag consistent with isRetryable", () => {
    for (const kind of ["transport", "throttle", "server", "client", "api", "parse"] as const) {
      expect(new RpcError(kind, "x").retryable).toBe(isRetryable(kind));
    }
  });
});
