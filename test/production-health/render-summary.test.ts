import { describe, expect, it } from "vitest";

import { renderSummary } from "../../scripts/production-health/render-summary.mjs";
import type { ProbeResult } from "../../scripts/production-health/probe.mjs";

describe("production health summary", () => {
  it("renders HTTP and Cron state independently", () => {
    const result: ProbeResult = {
      timestamp: "2026-09-29T00:17:00.000Z",
      http_status: 200,
      latency_ms: 35,
      ok: true,
      failure_reason: null,
      probe_url: "https://cdt.q9m3.com/health",
      http_ok: true,
      cron_health: "DEGRADED",
      cron_ok: false,
      cron_telemetry_available: true,
      cron_failure_reason: "Cron health DEGRADED",
      cron_probe_url: "https://cdt.q9m3.com/api/monitor/cron",
      cron_probe_attempts: 2,
      cron_last_execution_ts: "2026-09-29T00:12:00.000Z",
      cron_last_success_ts: "2026-09-29T00:02:00.000Z",
      cron_recent_success_count: 1,
      cron_recent_failure_count: 1,
      cron_failure_classification: "CDT_QUERY",
      attempts: 1,
      expected_status: 200,
      expected_body_status: "ok",
      expected_service: "cfworker4alicdt",
    };
    const summary = renderSummary(result);

    expect(summary).toContain("### HTTP `/health`");
    expect(summary).toContain("| HTTP health | OK |");
    expect(summary).toContain("### Cron telemetry");
    expect(summary).toContain("| Cron health | DEGRADED |");
    expect(summary).toContain("| Recent failures | 1 |");
  });

  it("does not render credential-shaped values", () => {
    const summary = renderSummary({
      timestamp: "2026-09-29T00:17:00.000Z",
      http_status: 200,
      latency_ms: 35,
      ok: true,
      failure_reason: null,
      probe_url: "https://cdt.q9m3.com/health",
      cron_health: "UNKNOWN",
      cron_failure_reason: "Authorization: Bearer private-monitor-fixture",
      attempts: 1,
      expected_status: 200,
      expected_body_status: "ok",
      expected_service: "cfworker4alicdt",
    });

    expect(summary).not.toContain("private-monitor-fixture");
    expect(summary).toContain("Authorization: [REDACTED]");
  });
});
