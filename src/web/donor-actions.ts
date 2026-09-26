/**
 * Minimal compatibility facade for the imported donor UI.
 *
 * The supported donor responses below are pure read-model mappings. They never
 * acquire credentials, execute controls, or write to D1. Remaining responses
 * deliberately fail closed without claiming unsupported features succeeded.
 */

import type { HistoryRow } from "../storage/read";

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
  };
}

const MAX_DONOR_HISTORY_ROWS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

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

  return {
    success: true,
    mutation: false,
    data: {
      history_24h: last24h,
      history_30d: [...daily.values()].sort((left, right) => left.date.localeCompare(right.date)),
    },
  };
}

type DonorActionCode = "FEATURE_NOT_IMPLEMENTED" | "BACKEND_NOT_AVAILABLE" | "ADAPTER_REQUIRED";

const ACTION_CODES: ReadonlyMap<string, DonorActionCode> = new Map([
  ["check_init", "BACKEND_NOT_AVAILABLE"],
  ["setup", "BACKEND_NOT_AVAILABLE"],
  ["control_instance", "FEATURE_NOT_IMPLEMENTED"],
  ["get_config", "BACKEND_NOT_AVAILABLE"],
  ["save_config", "BACKEND_NOT_AVAILABLE"],
  ["send_test_email", "BACKEND_NOT_AVAILABLE"],
  ["send_test_telegram", "BACKEND_NOT_AVAILABLE"],
  ["send_test_webhook", "BACKEND_NOT_AVAILABLE"],
  ["get_logs", "BACKEND_NOT_AVAILABLE"],
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
