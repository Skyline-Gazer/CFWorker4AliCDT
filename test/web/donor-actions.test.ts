import { describe, expect, it } from "vitest";

import { adaptDonorConfig, adaptDonorHistory, adaptDonorStatus } from "../../src/web/donor-actions";
import { loadConfig } from "../../src/config";
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
    decision_reason: null,
    duration_ms: 42,
    ...overrides,
  };
}

describe("adaptDonorConfig — safe allowlist", () => {
  it("returns configured values and presence booleans without secret material", () => {
    const parsed = loadConfig({
      ALIYUN_ACCESS_KEY_ID: "private-access-id",
      ALIYUN_ACCESS_KEY_SECRET: "private-access-secret",
      ADMIN_TOKEN: "private-admin-token",
      WEBHOOK_URL: "https://hooks.example/private?token=private-url-token",
      WEBHOOK_TOKEN: "private-webhook-token",
      REGION_ID: "cn-hongkong",
      ECS_INSTANCE_ID: "i-0123456789abcdef0",
      TRAFFIC_THRESHOLD_GB: "24",
      CDT_ENDPOINT: "cdt.example.aliyun.com",
      BUSINESS_REGION_ID: "cn-hongkong",
      SIGNATURE_VERSION: "v2",
      STOPPED_MODE: "StopCharging",
    });
    if (!parsed.ok) throw new Error("fixture config should validate");

    const result = adaptDonorConfig(parsed.config);
    expect(result).toEqual({
      success: true,
      mutation: false,
      data: {
        REGION_ID: "cn-hongkong",
        ECS_INSTANCE_ID: "i-0123456789abcdef0",
        TRAFFIC_THRESHOLD_GB: 24,
        CDT_ENDPOINT: "cdt.example.aliyun.com",
        BUSINESS_REGION_ID: "cn-hongkong",
        SIGNATURE_VERSION: "v2",
        STOPPED_MODE: "StopCharging",
        webhook_url_configured: true,
        webhook_token_configured: true,
        admin_token_configured: true,
        aliyun_credentials_configured: true,
      },
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      "private-access-id",
      "private-access-secret",
      "private-admin-token",
      "private-url-token",
      "private-webhook-token",
      "https://hooks.example/private",
    ])
      expect(serialized).not.toContain(secret);
    expect(Object.keys(result.data).sort()).toEqual(
      [
        "BUSINESS_REGION_ID",
        "CDT_ENDPOINT",
        "ECS_INSTANCE_ID",
        "REGION_ID",
        "SIGNATURE_VERSION",
        "STOPPED_MODE",
        "TRAFFIC_THRESHOLD_GB",
        "admin_token_configured",
        "aliyun_credentials_configured",
        "webhook_token_configured",
        "webhook_url_configured",
      ].sort(),
    );
  });

  it("returns null for unset business region and reports absent optional secrets", () => {
    const parsed = loadConfig({
      ALIYUN_ACCESS_KEY_ID: "id",
      ALIYUN_ACCESS_KEY_SECRET: "secret",
      REGION_ID: "cn-hongkong",
      ECS_INSTANCE_ID: "i-0123456789abcdef0",
    });
    if (!parsed.ok) throw new Error("fixture config should validate");
    expect(adaptDonorConfig(parsed.config).data).toMatchObject({
      BUSINESS_REGION_ID: null,
      webhook_url_configured: false,
      webhook_token_configured: false,
      admin_token_configured: false,
      aliyun_credentials_configured: true,
    });
  });
});

describe("adaptDonorStatus — singleton read-model mapping", () => {
  it("maps the already-converted live query without inventing accounts", () => {
    const result = adaptDonorStatus({
      status: "success",
      trafficGB: 12.5,
      thresholdGB: 20,
      ecsStatus: "Running",
      desired: "running",
      action: "none-running",
      reason:
        'traffic 12.5 GB is below threshold 20 GB; instance is already "running", so no action is required',
      trafficAggregation: {
        unit: "bytes",
        summationScope: "all TrafficDetails entries",
        totalBytes: 12.5 * 1024 ** 3,
        entries: [
          { businessRegionId: "cn-hongkong", ispType: "CMI", trafficBytes: 6 * 1024 ** 3 },
          { businessRegionId: "cn-beijing", ispType: null, trafficBytes: 6.5 * 1024 ** 3 },
        ],
        byBusinessRegion: [
          { businessRegionId: "cn-hongkong", trafficBytes: 6 * 1024 ** 3, entryCount: 1 },
          { businessRegionId: "cn-beijing", trafficBytes: 6.5 * 1024 ** 3, entryCount: 1 },
        ],
      },
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
      decision_desired: "running",
      decision_reason:
        'traffic 12.5 GB is below threshold 20 GB; instance is already "running", so no action is required',
      traffic_summation_scope: "all TrafficDetails entries",
      traffic_by_business_region: [
        { businessRegionId: "cn-hongkong", trafficBytes: 6 * 1024 ** 3, entryCount: 1 },
        { businessRegionId: "cn-beijing", trafficBytes: 6.5 * 1024 ** 3, entryCount: 1 },
      ],
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
      decision_desired: null,
      decision_reason: null,
      traffic_summation_scope: null,
      traffic_by_business_region: [],
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

  it("exposes recent scheduled reasons and preserves unknown reasons as null", () => {
    const result = adaptDonorHistory(
      [
        row({
          checked_at: "2026-09-26T11:10:00.000Z",
          decision_reason: "observed decision reason",
        }),
        row({ id: 2, checked_at: "2026-09-26T11:00:00.000Z", decision_reason: null, action: null }),
      ],
      now,
    );
    expect(result.data.decision_history).toEqual([
      {
        time: "2026-09-26T11:10:00.000Z",
        action: "none-running",
        reason: "observed decision reason",
      },
      { time: "2026-09-26T11:00:00.000Z", action: null, reason: null },
    ]);
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
      data: { history_24h: [], history_30d: [], decision_history: [] },
    });
    expect(unknown.data).toMatchObject({ history_24h: [], history_30d: [] });
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
