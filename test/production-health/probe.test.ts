import { describe, expect, it, vi } from "vitest";

import {
  probeHealth,
  type ProbeRequestInit,
  type ProbeResponse,
} from "../../scripts/production-health/probe.mjs";

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
