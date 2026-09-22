import { describe, expect, it } from "vitest";

import { buildPayload, notify } from "../../src/notify/webhook";
import type { NotifyOptions, RunReportLike } from "../../src/notify/webhook";
import type { FetchLike } from "../../src/aliyun/rpc";

/**
 * Run reporting webhook (SPEC §7).
 *
 * Two things carry the weight here. The payloads must match SPEC §7.3/§7.4
 * field-for-field, including which fields are *absent* — an absent
 * `stoppedModeRequested` means "no stop was requested", and reporting it on a
 * no-op would misdescribe the run. And a webhook failure must be provably
 * incapable of affecting control (SPEC §7.1).
 */

const SUCCESS: RunReportLike = {
  status: "success",
  trafficGB: 123.45,
  thresholdGB: 180,
  ecsStatusBefore: "running",
  ecsStatusAfter: "stopped",
  desired: "stopped",
  action: "stop",
  stoppedModeRequested: "KeepCharging",
  instanceId: "i-abc123",
  region: "cn-hongkong",
  time: "2026-09-22T00:00:00Z",
  durationMs: 812,
};

const ERROR: RunReportLike = {
  ...SUCCESS,
  status: "error",
  stage: "cdt-query",
  error: "CDT response had no TrafficDetails",
  trafficGB: undefined,
  ecsStatusBefore: undefined,
  ecsStatusAfter: undefined,
  desired: undefined,
  action: undefined,
  stoppedModeRequested: undefined,
  durationMs: 340,
};

function capture(): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  return { fetch, calls };
}

function bodyOf(call: { init: RequestInit } | undefined): Record<string, unknown> {
  const body = call?.init.body;
  if (typeof body !== "string") throw new Error("expected a string body");
  return JSON.parse(body) as Record<string, unknown>;
}

const OPTIONS: NotifyOptions = {
  webhookUrl: "https://hooks.example.test/run",
  webhookToken: undefined,
};

describe("buildPayload — success (SPEC §7.3)", () => {
  it("matches the documented success shape", () => {
    expect(buildPayload(SUCCESS)).toEqual({
      status: "success",
      trafficGB: 123.45,
      thresholdGB: 180,
      ecsStatusBefore: "running",
      ecsStatusAfter: "stopped",
      action: "stop",
      stoppedModeRequested: "KeepCharging",
      instanceId: "i-abc123",
      region: "cn-hongkong",
      time: "2026-09-22T00:00:00Z",
      durationMs: 812,
    });
  });

  it("omits stoppedModeRequested when no stop was issued", () => {
    const payload = buildPayload({
      ...SUCCESS,
      action: "none-running",
      stoppedModeRequested: undefined,
    });
    expect(payload).not.toHaveProperty("stoppedModeRequested");
  });

  it("omits error and stage on a success payload", () => {
    const payload = buildPayload(SUCCESS);
    expect(payload).not.toHaveProperty("error");
    expect(payload).not.toHaveProperty("stage");
  });

  it("reports the mode as requested, never as applied", () => {
    const payload = buildPayload(SUCCESS);
    expect(payload).toMatchObject({ stoppedModeRequested: "KeepCharging" });
    expect(payload).not.toHaveProperty("stoppedModeApplied");
    expect(payload).not.toHaveProperty("stoppedMode");
  });

  it("keeps a transitional post-state as observed", () => {
    // `starting` is a valid observation from the single follow-up describe; the
    // payload must not "correct" it to the terminal state.
    const payload = buildPayload({ ...SUCCESS, ecsStatusAfter: "starting" });
    expect(payload).toMatchObject({ ecsStatusAfter: "starting" });
  });
});

describe("buildPayload — error (SPEC §7.4)", () => {
  it("matches the documented error shape", () => {
    expect(buildPayload(ERROR)).toEqual({
      status: "error",
      stage: "cdt-query",
      error: "CDT response had no TrafficDetails",
      thresholdGB: 180,
      instanceId: "i-abc123",
      region: "cn-hongkong",
      time: "2026-09-22T00:00:00Z",
      durationMs: 340,
    });
  });

  it("omits success-only fields on an error payload", () => {
    const payload = buildPayload(ERROR);
    for (const field of [
      "trafficGB",
      "ecsStatusBefore",
      "ecsStatusAfter",
      "action",
      "stoppedModeRequested",
    ]) {
      expect(payload).not.toHaveProperty(field);
    }
  });
});

describe("buildPayload — secret hygiene (SPEC §7.5)", () => {
  it("redacts a credential-looking value from an error message", () => {
    const payload = buildPayload({
      ...ERROR,
      error: "AccessKeyId=LTAI5tSecretValue&Signature=abc failed",
    });
    expect(JSON.stringify(payload)).not.toContain("LTAI5tSecretValue");
  });

  it("redacts a bearer token from an error message", () => {
    const payload = buildPayload({
      ...ERROR,
      error: "Authorization: Bearer sk-live-abcdef123456 was rejected",
    });
    expect(JSON.stringify(payload)).not.toContain("sk-live-abcdef123456");
  });
});

describe("notify — delivery (SPEC §7.7)", () => {
  it("POSTs JSON to the configured URL", async () => {
    const { fetch, calls } = capture();
    await notify(OPTIONS, SUCCESS, { fetch });
    expect(calls[0]?.url).toBe("https://hooks.example.test/run");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("reports success on a 2xx", async () => {
    const { fetch } = capture();
    const result = await notify(OPTIONS, SUCCESS, { fetch });
    expect(result.ok).toBe(true);
  });

  it("reports failure on a non-2xx without throwing", async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response("nope", { status: 500 }));
    const result = await notify(OPTIONS, SUCCESS, { fetch });
    expect(result.ok).toBe(false);
  });

  it("reports failure when the transport throws, without throwing", async () => {
    const fetch: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));
    const result = await notify(OPTIONS, SUCCESS, { fetch });
    expect(result.ok).toBe(false);
  });

  it("bounds the request with a timeout so a hang cannot consume the invocation", async () => {
    let sawSignal = false;
    const fetch: FetchLike = (_url, init) => {
      sawSignal = init.signal !== undefined && init.signal !== null;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    await notify(OPTIONS, SUCCESS, { fetch });
    expect(sawSignal).toBe(true);
  });
});

describe("notify — authentication (SPEC §7.6)", () => {
  it("sends no Authorization header when no token is configured", async () => {
    const { fetch, calls } = capture();
    await notify(OPTIONS, SUCCESS, { fetch });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("sends a Bearer header exactly when a token is configured", async () => {
    const { fetch, calls } = capture();
    await notify({ ...OPTIONS, webhookToken: "tok123" }, SUCCESS, { fetch });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok123");
  });

  it("never includes the token in the payload body", async () => {
    const { fetch, calls } = capture();
    await notify({ ...OPTIONS, webhookToken: "tok123" }, SUCCESS, { fetch });
    const body = calls[0]?.init.body;
    expect(typeof body).toBe("string");
    expect(body as string).not.toContain("tok123");
  });

  it("does not leak the token into a failure result", async () => {
    const fetch: FetchLike = () => Promise.reject(new Error("failed for Bearer tok123"));
    const result = await notify({ ...OPTIONS, webhookToken: "tok123" }, SUCCESS, { fetch });
    expect(JSON.stringify(result)).not.toContain("tok123");
  });
});

describe("notify — cadence (SPEC §7.2)", () => {
  it("sends on a no-op run", async () => {
    const { fetch, calls } = capture();
    await notify(
      OPTIONS,
      { ...SUCCESS, action: "none-running", stoppedModeRequested: undefined },
      {
        fetch,
      },
    );
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]).action).toBe("none-running");
  });

  it("sends on an error run", async () => {
    const { fetch, calls } = capture();
    await notify(OPTIONS, ERROR, { fetch });
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]).status).toBe("error");
  });
});
