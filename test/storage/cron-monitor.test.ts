import { describe, expect, it, vi } from "vitest";

import {
  CRON_MONITOR_FRESHNESS_MINUTES,
  CRON_MONITOR_ROW_LIMIT,
  readCronMonitor,
  summarizeCronHistory,
  type CronHistoryRow,
} from "../../src/storage/cron-monitor";

const NOW = Date.UTC(2026, 8, 29, 0, 0, 0);

function row(
  minutesAgo: number,
  status: string,
  error_stage: string | null = null,
): CronHistoryRow {
  return {
    checked_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
    status,
    error_stage,
  };
}

describe("Cron history monitoring projection", () => {
  it("marks a recent successful execution HEALTHY", () => {
    const result = summarizeCronHistory([row(8, "success")], NOW);

    expect(result.cron_health).toBe("HEALTHY");
    expect(result.telemetry_available).toBe(true);
    expect(result.last_execution_ts).toBe(row(8, "success").checked_at);
    expect(result.last_success_ts).toBe(row(8, "success").checked_at);
    expect(result.recent_success_count).toBe(1);
    expect(result.recent_failure_count).toBe(0);
    expect(result.freshness_threshold_minutes).toBe(CRON_MONITOR_FRESHNESS_MINUTES);
  });

  it("degrades a stale success until it is over twice the freshness threshold", () => {
    expect(summarizeCronHistory([row(40, "success")], NOW).cron_health).toBe("DEGRADED");
    expect(summarizeCronHistory([row(60, "success")], NOW).cron_health).toBe("UNHEALTHY");
  });

  it("degrades a fresh latest failure and marks a stale latest failure unhealthy", () => {
    const freshFailure = summarizeCronHistory(
      [row(6, "error", "ecs-stop"), row(15, "success")],
      NOW,
    );
    const staleFailure = summarizeCronHistory(
      [row(30, "error", "ecs-stop"), row(40, "success")],
      NOW,
    );

    expect(freshFailure.cron_health).toBe("DEGRADED");
    expect(freshFailure.failure_classification).toBe("ECS_STOP");
    expect(staleFailure.cron_health).toBe("UNHEALTHY");
    expect(staleFailure.failure_classification).toBe("ECS_STOP");
  });

  it("marks recent failures UNHEALTHY when the last success is over 50 minutes old", () => {
    const result = summarizeCronHistory([row(6, "error", "cdt-query"), row(70, "success")], NOW);

    expect(result.cron_health).toBe("UNHEALTHY");
    expect(result.last_success_ts).toBe(row(70, "success").checked_at);
  });

  it("degrades mixed recent history and classifies the latest failure stage", () => {
    const result = summarizeCronHistory(
      [row(3, "success"), row(9, "error", "cdt-query"), row(16, "success")],
      NOW,
    );

    expect(result.cron_health).toBe("DEGRADED");
    expect(result.latest_status).toBe("success");
    expect(result.recent_success_count).toBe(2);
    expect(result.recent_failure_count).toBe(1);
    expect(result.failure_classification).toBe("CDT_QUERY");
  });

  it("degrades a fresh latest success when an unknown-status row remains in lookback", () => {
    const result = summarizeCronHistory(
      [row(5, "success"), row(12, "weird-status"), row(20, "success")],
      NOW,
    );

    expect(result.cron_health).toBe("DEGRADED");
    expect(result.latest_status).toBe("success");
    expect(result.recent_failure_count).toBe(0);
  });

  it("degrades when the latest usable row itself has an unknown status", () => {
    const result = summarizeCronHistory([row(4, "pending-like"), row(15, "success")], NOW);

    expect(result.cron_health).toBe("DEGRADED");
    expect(result.latest_status).toBe("unknown");
  });

  it("returns UNKNOWN with telemetry available for empty history", () => {
    const result = summarizeCronHistory([], NOW);

    expect(result.cron_health).toBe("UNKNOWN");
    expect(result.telemetry_available).toBe(true);
    expect(result.last_execution_ts).toBeNull();
    expect(result.last_success_ts).toBeNull();
    expect(result.latest_status).toBeNull();
  });

  it("ignores invalid and future timestamps without crashing or changing the latest row", () => {
    const result = summarizeCronHistory(
      [
        { checked_at: "not-a-date", status: "error", error_stage: "ecs-start" },
        { checked_at: "2026-02-30T00:00:00.000Z", status: "error", error_stage: "config" },
        {
          checked_at: new Date(NOW + 60_000).toISOString(),
          status: "error",
          error_stage: "webhook",
        },
        row(4, "success"),
      ],
      NOW,
    );

    expect(result.latest_status).toBe("success");
    expect(result.cron_health).toBe("HEALTHY");
    expect(result.failure_classification).toBeNull();
  });

  it("treats an unknown error stage as UNCLASSIFIED", () => {
    const result = summarizeCronHistory([row(3, "error", "private-driver-detail")], NOW);

    expect(result.failure_classification).toBe("UNCLASSIFIED");
    expect(JSON.stringify(result)).not.toContain("private-driver-detail");
  });

  it("uses a narrow, bounded SELECT and sanitizes D1 query failures", async () => {
    const query = vi.fn((_sql: string, _params: readonly unknown[]) =>
      Promise.reject(new Error("private D1 driver detail")),
    );
    const result = await readCronMonitor({ query }, NOW);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain("SELECT checked_at, status, error_stage");
    expect(sql).toContain("ORDER BY checked_at DESC, id DESC");
    expect(sql).toContain("LIMIT ?");
    expect(sql).not.toMatch(/error_message|instance|traffic_gb|SELECT \*/i);
    expect(params).toEqual([CRON_MONITOR_ROW_LIMIT]);
    expect(result.cron_health).toBe("UNKNOWN");
    expect(result.telemetry_available).toBe(false);
    expect(result.telemetry_error).toBe("D1_QUERY_FAILED");
    expect(JSON.stringify(result)).not.toContain("private D1 driver detail");
  });
});
