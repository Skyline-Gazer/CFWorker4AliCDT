import { describe, expect, it, vi } from "vitest";

import {
  probeCron,
  probeHealth,
  type ProbeRequestInit,
  type ProbeResponse,
} from "../../scripts/production-health/probe.mjs";
import { probeProductionHealth } from "../../scripts/production-health/run-probe.mjs";

function response(status: number, body: unknown): ProbeResponse {
  return {
    status,
    json: () => Promise.resolve(body),
  };
}

function clock() {
  let value = Date.UTC(2026, 8, 29, 0, 0, 0);
  return () => {
    value += 3;
    return value;
  };
}

describe("production HTTP health probe", () => {
  it("accepts the expected HTTP 200 health contract", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(response(200, { status: "ok", service: "cfworker4alicdt" })),
    );
    const result = await probeHealth({ fetchImpl, now: clock(), delay: () => Promise.resolve() });

    expect(result.ok).toBe(true);
    expect(result.http_status).toBe(200);
    expect(result.failure_reason).toBeNull();
    expect(result.attempts).toBe(1);
    expect(result.probe_url).toBe("https://cdt.q9m3.com/health");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports an HTTP 500 as a failed health check", async () => {
    const result = await probeHealth({
      fetchImpl: () => Promise.resolve(response(500, {})),
      now: clock(),
      maxAttempts: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.http_status).toBe(500);
    expect(result.failure_reason).toContain("500");
  });

  it("bounds each attempt and reports a timeout", async () => {
    // Reject on abort to model fetch honoring the injected timeout.
    const fetchImpl = (_url: string, init: ProbeRequestInit) =>
      new Promise<ProbeResponse>((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    const result = await probeHealth({
      fetchImpl,
      now: clock(),
      timeoutMs: 5,
      maxAttempts: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.http_status).toBeNull();
    expect(result.failure_reason).toContain("timed out");
  });

  it("rejects invalid JSON and a JSON object with the wrong fields", async () => {
    const invalidJson = await probeHealth({
      fetchImpl: () =>
        Promise.resolve({
          status: 200,
          json: () => Promise.reject(new Error("private body")),
        }),
      now: clock(),
      maxAttempts: 1,
    });
    const wrongFields = await probeHealth({
      fetchImpl: () => Promise.resolve(response(200, { status: "ok", service: "other-service" })),
      now: clock(),
      maxAttempts: 1,
    });

    expect(invalidJson.ok).toBe(false);
    expect(invalidJson.failure_reason).toContain("valid JSON");
    expect(invalidJson.failure_reason).not.toContain("private body");
    expect(wrongFields.ok).toBe(false);
    expect(wrongFields.failure_reason).toContain("expected contract");
  });

  it("recovers from a transient failure within the configured retries", async () => {
    const fetchImpl = vi
      .fn<() => Promise<ProbeResponse>>()
      .mockRejectedValueOnce(new Error("transport detail"))
      .mockResolvedValueOnce(response(200, { status: "ok", service: "cfworker4alicdt" }));
    const delay = vi.fn(() => Promise.resolve());
    const result = await probeHealth({ fetchImpl, now: clock(), delay, maxAttempts: 3 });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.failure_reason).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it("keeps Cron health UNKNOWN when HTTP health succeeds without Cron telemetry", async () => {
    const result = await probeHealth({
      fetchImpl: () => Promise.resolve(response(200, { status: "ok", service: "cfworker4alicdt" })),
      now: clock(),
    });

    expect(result.ok).toBe(true);
    expect(result.cron_health).toBe("UNKNOWN");
  });

  it("does not call a URL containing credentials or query parameters", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(response(200, { status: "ok", service: "cfworker4alicdt" })),
    );
    const result = await probeHealth({
      url: "https://user:pass@example.com/health?ADMIN_TOKEN=fixture-secret",
      fetchImpl,
      now: clock(),
    });

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("allows a configurable HTTPS health path without copying custom paths into artifacts", async () => {
    let requestedUrl = "";
    const result = await probeHealth({
      url: "https://health.example.test/private-monitor-token",
      fetchImpl: (url) => {
        requestedUrl = url;
        return Promise.resolve(response(200, { status: "ok", service: "cfworker4alicdt" }));
      },
      now: clock(),
    });

    expect(result.ok).toBe(true);
    expect(requestedUrl).toBe("https://health.example.test/private-monitor-token");
    expect(result.probe_url).toBe("https://health.example.test/[path-redacted]");
    expect(JSON.stringify(result)).not.toContain("private-monitor-token");
  });
});

const cronSnapshot = (overrides: Record<string, unknown> = {}) => ({
  observation_ts: "2026-09-29T00:17:00.000Z",
  last_execution_ts: "2026-09-29T00:12:00.000Z",
  last_success_ts: "2026-09-29T00:12:00.000Z",
  latest_status: "success",
  recent_success_count: 2,
  recent_failure_count: 0,
  failure_classification: null,
  cron_health: "HEALTHY",
  telemetry_available: true,
  ...overrides,
});

describe("production Cron telemetry probe", () => {
  it("sends the dedicated token only as a Bearer header and validates the response", async () => {
    const monitorToken = "actions-monitor-fixture-token";
    let requestedUrl = "";
    let authorizationHeader = "";
    const result = await probeCron({
      token: monitorToken,
      fetchImpl: (url, init) => {
        requestedUrl = url;
        authorizationHeader = init.headers.authorization ?? "";
        return Promise.resolve(response(200, cronSnapshot()));
      },
      maxAttempts: 1,
    });

    expect(requestedUrl).toBe("https://cdt.q9m3.com/api/monitor/cron");
    expect(authorizationHeader).toBe(`Bearer ${monitorToken}`);
    expect(result).toMatchObject({
      cron_health: "HEALTHY",
      cron_ok: true,
      cron_telemetry_available: true,
      cron_recent_success_count: 2,
      cron_probe_attempts: 1,
    });
    expect(JSON.stringify(result)).not.toContain(monitorToken);
  });

  it("rejects an invalid Cron health enum without persisting the response body", async () => {
    const result = await probeCron({
      token: "actions-monitor-fixture-token",
      fetchImpl: () => Promise.resolve(response(200, cronSnapshot({ cron_health: "SECRET" }))),
      maxAttempts: 1,
    });

    expect(result.cron_ok).toBe(false);
    expect(result.cron_telemetry_available).toBe(false);
    expect(result.cron_failure_reason).toContain("expected contract");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("degrades gracefully without a token while still probing HTTP", async () => {
    const fetchImpl = vi.fn((_url: string) =>
      Promise.resolve(response(200, { status: "ok", service: "cfworker4alicdt" })),
    );
    const result = await probeProductionHealth({
      monitorToken: "",
      fetchImpl,
      now: clock(),
      maxAttempts: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.http_ok).toBe(true);
    expect(result.cron_health).toBe("UNKNOWN");
    expect(result.cron_telemetry_available).toBe(false);
    expect(result.cron_failure_reason).toBe("MONITOR_TOKEN_MISSING");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://cdt.q9m3.com/health");
  });

  it("records HTTP success and Cron unhealthy state independently", async () => {
    const result = await probeProductionHealth({
      monitorToken: "actions-monitor-fixture-token",
      fetchImpl: (url) =>
        Promise.resolve(
          url.endsWith("/health")
            ? response(200, { status: "ok", service: "cfworker4alicdt" })
            : response(
                200,
                cronSnapshot({
                  cron_health: "UNHEALTHY",
                  latest_status: "error",
                  recent_failure_count: 3,
                  failure_classification: "CDT_QUERY",
                }),
              ),
        ),
      now: clock(),
      maxAttempts: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.http_ok).toBe(true);
    expect(result.cron_health).toBe("UNHEALTHY");
    expect(result.cron_ok).toBe(false);
    expect(result.cron_telemetry_available).toBe(true);
    expect(result.cron_failure_classification).toBe("CDT_QUERY");
  });
});
