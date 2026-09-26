/**
 * Minimal compatibility facade for the imported donor UI.
 *
 * The supported donor responses below are pure read-model mappings. They never
 * acquire credentials, execute controls, or write to D1. Remaining responses
 * deliberately fail closed without claiming unsupported features succeeded.
 */

import type { HistoryRow } from "../storage/read";
import type { Config } from "../config";
import { redact } from "../redact";

/** Explicit allowlist for the authenticated donor config read response. */
export interface DonorConfigResponse {
  readonly success: true;
  readonly mutation: false;
  readonly data: {
    readonly REGION_ID: string;
    readonly ECS_INSTANCE_ID: string;
    readonly TRAFFIC_THRESHOLD_GB: number;
    readonly CDT_ENDPOINT: string;
    readonly BUSINESS_REGION_ID: string | null;
    readonly SIGNATURE_VERSION: string;
    readonly STOPPED_MODE: string;
    readonly webhook_url_configured: boolean;
    readonly webhook_token_configured: boolean;
    readonly admin_token_configured: boolean;
    readonly aliyun_credentials_configured: boolean;
  };
}

/** Project validated config into donor-compatible fields without exposing secrets. */
export function adaptDonorConfig(config: Config): DonorConfigResponse {
  return {
    success: true,
    mutation: false,
    data: {
      REGION_ID: config.regionId,
      ECS_INSTANCE_ID: config.ecsInstanceId,
      TRAFFIC_THRESHOLD_GB: config.trafficThresholdGB,
      CDT_ENDPOINT: config.cdtEndpoint,
      BUSINESS_REGION_ID: config.businessRegionId ?? null,
      SIGNATURE_VERSION: config.signatureVersion,
      STOPPED_MODE: config.stoppedMode,
      webhook_url_configured: config.webhookUrl !== undefined,
      webhook_token_configured: config.webhookToken !== undefined,
      admin_token_configured: config.adminToken !== undefined,
      aliyun_credentials_configured: config.accessKeyId !== "" && config.accessKeySecret !== "",
    },
  };
}

export interface DonorRegionTraffic {
  readonly businessRegionId: string | null;
  readonly trafficBytes: number;
  readonly entryCount: number;
}

export interface DonorStatusEntry {
  /** Local singleton key for UI actions; it is not an ECS or account identifier. */
  readonly id: "configured-instance";
  readonly account: "Configured ECS instance";
  readonly regionName: "CDT";
  readonly flow_used: number | null;
  readonly flow_total: number | null;
  readonly percentageOfUse: number | null;
  readonly thresholdReached: boolean | null;
  readonly instanceStatus: string;
  readonly decision_desired: "running" | "stopped" | null;
  readonly decision_reason: string | null;
  readonly traffic_summation_scope: string | null;
  readonly traffic_by_business_region: readonly DonorRegionTraffic[];
}

export interface DonorStatusResponse {
  readonly success: boolean;
  readonly mutation: false;
  readonly data: readonly DonorStatusEntry[];
  readonly error?: string;
}

export interface DonorHistoryPoint {
  readonly time: string;
  readonly value: number;
}

export interface DonorDailyHistoryPoint {
  readonly date: string;
  readonly value: number;
}

export interface DonorHistoryResponse {
  readonly success: true;
  readonly mutation: false;
  readonly data: {
    readonly history_24h: readonly DonorHistoryPoint[];
    readonly history_30d: readonly DonorDailyHistoryPoint[];
    readonly decision_history: readonly {
      readonly time: string;
      readonly action: string | null;
      readonly reason: string | null;
    }[];
  };
}

const MAX_DONOR_HISTORY_ROWS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DonorLogEntry {
  readonly id: number;
  readonly time: string;
  readonly level: "error" | "info";
  readonly message: string;
  readonly trigger: string;
  readonly status: string;
  readonly traffic_gb: number | null;
  readonly threshold_gb: number;
  readonly action: string | null;
  readonly decision_reason: string | null;
  readonly error_stage: string | null;
  readonly error_message: string | null;
  readonly duration_ms: number | null;
}

export interface DonorLogsResponse {
  readonly success: true;
  readonly mutation: false;
  readonly data: readonly DonorLogEntry[];
}

/** Project bounded D1 observations into the donor's safe, read-only log view. */
export function adaptDonorLogs(rows: readonly HistoryRow[]): DonorLogsResponse {
  const newestFirst = [...rows]
    .sort((left, right) => {
      const byTime = Date.parse(right.checked_at) - Date.parse(left.checked_at);
      return Number.isNaN(byTime) || byTime === 0 ? right.id - left.id : byTime;
    })
    .slice(0, MAX_DONOR_HISTORY_ROWS);

  return {
    success: true,
    mutation: false,
    data: newestFirst.map((row) => ({
      id: row.id,
      time: row.checked_at,
      level: row.status === "error" ? "error" : "info",
      message: row.decision_reason ?? row.action ?? row.status,
      trigger: row.trigger,
      status: row.status,
      traffic_gb: row.traffic_gb,
      threshold_gb: row.threshold_gb,
      action: row.action,
      decision_reason: row.decision_reason,
      error_stage: row.error_stage,
      error_message: row.error_message === null ? null : redact(row.error_message),
      duration_ms: row.duration_ms,
    })),
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function donorEcsStatus(value: unknown): string {
  if (typeof value !== "string") return "Unknown";
  const normalized = value.toLowerCase();
  const known: ReadonlyMap<string, string> = new Map([
    ["running", "Running"],
    ["stopped", "Stopped"],
    ["starting", "Starting"],
    ["stopping", "Stopping"],
    ["unknown", "Unknown"],
  ]);
  return known.get(normalized) ?? "Unknown";
}

/** Map the existing live query result to the donor's one-card display contract. */
export function adaptDonorStatus(value: unknown): DonorStatusResponse {
  const query = recordOf(value);
  if (query?.status !== "success") {
    return {
      success: false,
      mutation: false,
      data: [],
      error: "Live status is unavailable.",
    };
  }

  const trafficGB = finiteNonNegative(query.trafficGB) ?? null;
  const candidateThresholdGB = finiteNonNegative(query.thresholdGB);
  const thresholdGB =
    candidateThresholdGB !== undefined && candidateThresholdGB > 0 ? candidateThresholdGB : null;
  const usableThreshold = thresholdGB !== null && thresholdGB > 0;
  const percentageOfUse =
    trafficGB !== null && usableThreshold ? (trafficGB / thresholdGB) * 100 : null;
  const thresholdReached = trafficGB !== null && usableThreshold ? trafficGB >= thresholdGB : null;
  const ecsStatus = donorEcsStatus(query.ecsStatus);
  const trafficAggregation = recordOf(query.trafficAggregation);
  const regionRows = Array.isArray(trafficAggregation?.byBusinessRegion)
    ? trafficAggregation.byBusinessRegion.flatMap((value) => {
        const row = recordOf(value);
        const trafficBytes = finiteNonNegative(row?.trafficBytes);
        const entryCount = finiteNonNegative(row?.entryCount);
        const businessRegionId =
          typeof row?.businessRegionId === "string" ? row.businessRegionId : null;
        if (trafficBytes === undefined || entryCount === undefined) return [];
        return [{ businessRegionId, trafficBytes, entryCount }];
      })
    : [];

  return {
    success: true,
    mutation: false,
    data: [
      {
        id: "configured-instance",
        account: "Configured ECS instance",
        regionName: "CDT",
        // The query already reports GB after the single bytes/1024^3 conversion.
        // Keep unknown values as null and never run a second conversion here.
        flow_used: trafficGB,
        flow_total: thresholdGB,
        percentageOfUse:
          percentageOfUse !== null && Number.isFinite(percentageOfUse) ? percentageOfUse : null,
        thresholdReached,
        instanceStatus: ecsStatus,
        decision_desired:
          query.desired === "running" || query.desired === "stopped" ? query.desired : null,
        decision_reason: typeof query.reason === "string" ? query.reason : null,
        traffic_summation_scope:
          trafficAggregation?.summationScope === "all TrafficDetails entries"
            ? trafficAggregation.summationScope
            : null,
        traffic_by_business_region: regionRows,
      },
    ],
  };
}

/**
 * Map the bounded newest-first D1 read to chart series. Traffic values are
 * snapshots from scheduled checks, not per-day totals; the daily series uses
 * the newest known snapshot for each UTC date and emits no missing dates.
 */
export function adaptDonorHistory(
  rows: readonly HistoryRow[],
  now = Date.now(),
): DonorHistoryResponse {
  const bounded = [...rows]
    .sort((left, right) => {
      const byTime = Date.parse(right.checked_at) - Date.parse(left.checked_at);
      return Number.isNaN(byTime) || byTime === 0 ? right.id - left.id : byTime;
    })
    .slice(0, MAX_DONOR_HISTORY_ROWS)
    .flatMap((row) => {
      const timestamp = Date.parse(row.checked_at);
      const value = finiteNonNegative(row.traffic_gb);
      if (!Number.isFinite(timestamp) || timestamp > now || value === undefined) return [];
      return [{ timestamp, iso: new Date(timestamp).toISOString(), value }];
    });

  const last24h = bounded
    .filter((point) => now - point.timestamp <= DAY_MS)
    .sort((left, right) => left.timestamp - right.timestamp)
    .map(({ iso, value }) => ({ time: iso, value }));

  const daily = new Map<string, DonorDailyHistoryPoint>();
  for (const point of bounded) {
    if (now - point.timestamp > 30 * DAY_MS) continue;
    const date = point.iso.slice(0, 10);
    // bounded rows are newest first, so the first known value is that day's
    // latest recorded snapshot. No zero-filled dates or summed control values.
    if (!daily.has(date)) daily.set(date, { date, value: point.value });
  }

  const decisionHistory = [...rows]
    .sort((left, right) => {
      const byTime = Date.parse(right.checked_at) - Date.parse(left.checked_at);
      return Number.isNaN(byTime) || byTime === 0 ? right.id - left.id : byTime;
    })
    .slice(0, 5)
    .map((row) => ({
      time: row.checked_at,
      action: row.action,
      reason: row.decision_reason,
    }));

  return {
    success: true,
    mutation: false,
    data: {
      history_24h: last24h,
      history_30d: [...daily.values()].sort((left, right) => left.date.localeCompare(right.date)),
      decision_history: decisionHistory,
    },
  };
}

type DonorActionCode = "FEATURE_NOT_IMPLEMENTED" | "BACKEND_NOT_AVAILABLE" | "ADAPTER_REQUIRED";

const ACTION_CODES: ReadonlyMap<string, DonorActionCode> = new Map([
  ["check_init", "BACKEND_NOT_AVAILABLE"],
  ["setup", "BACKEND_NOT_AVAILABLE"],
  ["control_instance", "FEATURE_NOT_IMPLEMENTED"],
  ["save_config", "BACKEND_NOT_AVAILABLE"],
  ["send_test_email", "BACKEND_NOT_AVAILABLE"],
  ["send_test_telegram", "BACKEND_NOT_AVAILABLE"],
  ["send_test_webhook", "BACKEND_NOT_AVAILABLE"],
  ["clear_logs", "FEATURE_NOT_IMPLEMENTED"],
  ["logout", "FEATURE_NOT_IMPLEMENTED"],
]);

const MESSAGES: Readonly<Record<DonorActionCode, string>> = {
  FEATURE_NOT_IMPLEMENTED: "This action is disabled and was not performed.",
  BACKEND_NOT_AVAILABLE: "This feature is not available in the Worker backend yet.",
  ADAPTER_REQUIRED: "This donor action has not been adapted to the Worker API yet.",
};

export interface DonorActionFailure {
  readonly success: false;
  readonly ok: false;
  readonly available: false;
  readonly mutation: false;
  readonly action: string;
  readonly code: DonorActionCode | "ACTION_NOT_AVAILABLE";
  readonly error: string;
  readonly message: string;
}

/** Return a stable HTTP 501 response; this function has no mutation dependencies. */
export function unsupportedDonorAction(action: string): {
  readonly status: 501;
  readonly headers: Record<string, string>;
  readonly body: string;
} {
  const knownCode = ACTION_CODES.get(action);
  const code = knownCode ?? "ACTION_NOT_AVAILABLE";
  const safeAction = /^[a-z0-9_]{1,64}$/.test(action) ? action : "unknown";
  const message =
    knownCode === undefined ? "This donor action is not available." : MESSAGES[knownCode];
  const body: DonorActionFailure = {
    success: false,
    ok: false,
    available: false,
    mutation: false,
    action: safeAction,
    code,
    error: message,
    message,
  };

  return {
    status: 501,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}
