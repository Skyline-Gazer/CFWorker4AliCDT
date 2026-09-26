import { describe, expect, it } from "vitest";

import { adaptDonorHistory, adaptDonorStatus } from "../../src/web/donor-actions";
import type { HistoryRow } from "../../src/storage/read";

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: 1,
    checked_at: "2026-09-26T11:00:00.000Z",
    trigger: "scheduled",
    status: "success",
    traffic_gb: 1.25,
    threshold_gb: 180,
    usage_percent: 0.6944,
    remaining_gb: 178.75,
    ecs_status_before: "Running",
    desired_ecs_state: "running",
    action: "none-running",
    ecs_status_after: "Running",
    control_ok: 1,
    webhook_attempted: 0,
    webhook_ok: null,
    error_stage: null,
    error_message: null,
    duration_ms: 42,
    ...overrides,
  };
}

describe("adaptDonorStatus — singleton read-model mapping", () => {
  it("maps the already-converted live query without inventing accounts", () => {
    const result = adaptDonorStatus({
      status: "success",
      trafficGB: 12.5,
      thresholdGB: 20,
      ecsStatus: "Running",
      desired: "running",
      action: "none-running",
      mutation: false,
    });

    expect(result).toMatchObject({ success: true, mutation: false });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      id: "configured-instance",
      flow_used: 12.5,
      flow_total: 20,
      percentageOfUse: 62.5,
      thresholdReached: false,
      instanceStatus: "Running",
    });
    expect(result.data[0]).not.toHaveProperty("accounts");
    expect(JSON.stringify(result)).not.toContain("ADMIN_TOKEN");
  });

  it("keeps unavailable query values unknown and does not fabricate a status row", () => {
    const result = adaptDonorStatus({
      status: "error",
      trafficGB: undefined,
      thresholdGB: 180,
      ecsStatus: undefined,
      mutation: false,
    });

    expect(result).toMatchObject({ success: false, mutation: false, data: [] });
    expect(result.error).toBeTruthy();
  });

  it("passes trafficGB through as GB instead of converting a second time", () => {
    const result = adaptDonorStatus({
      status: "success",
      trafficGB: 1,
      thresholdGB: 180,
      ecsStatus: "Stopped",
      mutation: false,
    });

    expect(result.data[0]?.flow_used).toBe(1);
  });

  it("keeps missing values unknown in the configured singleton", () => {
    const result = adaptDonorStatus({
      status: "success",
      trafficGB: undefined,
      thresholdGB: undefined,
      ecsStatus: undefined,
      mutation: false,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      flow_used: null,
      flow_total: null,
      percentageOfUse: null,
      thresholdReached: null,
      instanceStatus: "Unknown",
    });
  });
});

describe("adaptDonorHistory — bounded honest chart series", () => {
  const now = Date.parse("2026-09-26T12:00:00.000Z");

  it("maps only real traffic points into chronological ECharts series", () => {
    const result = adaptDonorHistory(
      [
        row({ id: 3, checked_at: "2026-09-26T11:50:00.000Z", traffic_gb: 3 }),
        row({ id: 2, checked_at: "2026-09-26T11:40:00.000Z", traffic_gb: null }),
        row({ id: 1, checked_at: "2026-09-26T11:30:00.000Z", traffic_gb: 1 }),
      ],
      now,
    );

    expect(result).toMatchObject({ success: true, mutation: false });
    expect(result.data.history_24h).toEqual([
      { time: "2026-09-26T11:30:00.000Z", value: 1 },
      { time: "2026-09-26T11:50:00.000Z", value: 3 },
    ]);
    expect(result.data.history_30d).toEqual([{ date: "2026-09-26", value: 3 }]);
  });

  it("limits the adapter to the newest 200 rows", () => {
    const rows = Array.from({ length: 205 }, (_, index) =>
      row({
        id: 205 - index,
        checked_at: new Date(now - index * 60_000).toISOString(),
        traffic_gb: 205 - index,
      }),
    );

    const result = adaptDonorHistory(rows, now);

    expect(result.data.history_24h).toHaveLength(200);
    expect(result.data.history_24h[0]?.value).toBe(6);
    expect(result.data.history_24h.at(-1)?.value).toBe(205);
  });

  it("returns stable empty series for empty or all-unknown history", () => {
    const empty = adaptDonorHistory([], now);
    const unknown = adaptDonorHistory(
      [row({ traffic_gb: null }), row({ id: 2, traffic_gb: Number.NaN })],
      now,
    );

    expect(empty).toEqual({
      success: true,
      mutation: false,
      data: { history_24h: [], history_30d: [] },
    });
    expect(unknown.data).toEqual({ history_24h: [], history_30d: [] });
  });

  it("omits rows outside the supported 24-hour and 30-day windows", () => {
    const result = adaptDonorHistory(
      [
        row({ id: 3, checked_at: "2026-09-25T10:00:00.000Z", traffic_gb: 3 }),
        row({ id: 2, checked_at: "2026-09-20T12:00:00.000Z", traffic_gb: 2 }),
        row({ id: 1, checked_at: "2026-08-20T12:00:00.000Z", traffic_gb: 1 }),
      ],
      now,
    );

    expect(result.data.history_24h).toEqual([]);
    expect(result.data.history_30d).toEqual([
      { date: "2026-09-20", value: 2 },
      { date: "2026-09-25", value: 3 },
    ]);
  });
});
