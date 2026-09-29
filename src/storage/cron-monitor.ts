/**
 * Bounded, read-only projection of scheduled-run history for Cron monitoring.
 *
 * This deliberately selects only timestamps, status, and the allowlisted error
 * stage. Raw error messages, traffic figures, and instance details never enter
 * this monitoring response.
 */

export interface CronHistoryRow {
  readonly checked_at: string;
  readonly status: string;
  readonly error_stage: string | null;
}

export type CronHealth = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
export type CronLatestStatus = "success" | "error" | "unknown" | null;
export type CronFailureClassification =
  | "CONFIGURATION"
  | "CDT_QUERY"
  | "ECS_DESCRIBE"
  | "ECS_START"
  | "ECS_STOP"
  | "WEBHOOK"
  | "UNEXPECTED"
  | "UNCLASSIFIED";

export interface CronMonitorSnapshot {
  readonly observation_ts: string;
  readonly last_execution_ts: string | null;
  readonly last_success_ts: string | null;
  readonly latest_status: CronLatestStatus;
  readonly recent_success_count: number;
  readonly recent_failure_count: number;
  readonly failure_classification: CronFailureClassification | null;
  readonly cron_health: CronHealth;
  readonly telemetry_available: boolean;
  readonly freshness_threshold_minutes: number;
  readonly lookback_minutes: number;
  readonly telemetry_error?: "D1_UNAVAILABLE" | "D1_QUERY_FAILED";
}

export interface CronMonitorReadDeps {
  readonly query: (
    sql: string,
    params: readonly unknown[],
  ) => CronHistoryRow[] | Promise<CronHistoryRow[]>;
}

export const CRON_MONITOR_FRESHNESS_MINUTES = 25;
export const CRON_MONITOR_LOOKBACK_MINUTES = 24 * 60;
export const CRON_MONITOR_ROW_LIMIT = 200;

/** The selected columns are intentionally too narrow to expose sensitive rows. */
export function cronMonitorQuery(): string {
  return `SELECT checked_at, status, error_stage
          FROM traffic_checks
          ORDER BY checked_at DESC, id DESC
          LIMIT ?`;
}

const FAILURE_CLASSES: Readonly<Record<string, CronFailureClassification>> = {
  config: "CONFIGURATION",
  "cdt-query": "CDT_QUERY",
  "ecs-describe": "ECS_DESCRIBE",
  "ecs-start": "ECS_START",
  "ecs-stop": "ECS_STOP",
  webhook: "WEBHOOK",
  unexpected: "UNEXPECTED",
};

function parseTimestamp(value: string, now: number): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now) return undefined;

  // Date.parse accepts some invalid calendar dates by normalising them. Compare
  // the UTC second back to the input so those rows are ignored as unusable.
  const wholeSecond = new Date(parsed).toISOString().slice(0, 19);
  if (wholeSecond !== value.slice(0, 19)) return undefined;
  return parsed;
}

function classification(stage: string | null): CronFailureClassification {
  if (stage === null) return "UNCLASSIFIED";
  return FAILURE_CLASSES[stage] ?? "UNCLASSIFIED";
}

function failedSnapshot(
  now: number,
  telemetryError: "D1_UNAVAILABLE" | "D1_QUERY_FAILED",
): CronMonitorSnapshot {
  return {
    observation_ts: new Date(now).toISOString(),
    last_execution_ts: null,
    last_success_ts: null,
    latest_status: null,
    recent_success_count: 0,
    recent_failure_count: 0,
    failure_classification: null,
    cron_health: "UNKNOWN",
    telemetry_available: false,
    freshness_threshold_minutes: CRON_MONITOR_FRESHNESS_MINUTES,
    lookback_minutes: CRON_MONITOR_LOOKBACK_MINUTES,
    telemetry_error: telemetryError,
  };
}

/** Sanitized response for a missing D1 binding; it never includes driver text. */
export function unavailableCronMonitor(now = Date.now()): CronMonitorSnapshot {
  return failedSnapshot(now, "D1_UNAVAILABLE");
}

/**
 * Summarize a bounded history result. Invalid/future timestamps are ignored.
 * Health policy: a fresh latest success with no failures in the 24-hour window
 * is HEALTHY; fresh activity with a failure or unknown row is DEGRADED; a
 * success stale by more than 25 minutes is DEGRADED until it is older than 50
 * minutes; a stale latest error or no success for over 50 minutes is UNHEALTHY.
 */
export function summarizeCronHistory(
  rows: readonly CronHistoryRow[],
  now = Date.now(),
): CronMonitorSnapshot {
  const observationTime = Number.isFinite(now) ? now : Date.now();
  const usable = rows
    .map((row) => {
      const timestamp = parseTimestamp(row.checked_at, observationTime);
      if (timestamp === undefined) return undefined;
      const status: CronLatestStatus =
        row.status === "success" || row.status === "error" ? row.status : "unknown";
      return { timestamp, status, stage: row.error_stage };
    })
    .filter((row): row is NonNullable<typeof row> => row !== undefined)
    .sort((left, right) => right.timestamp - left.timestamp);

  const latest = usable[0];
  if (latest === undefined) {
    return {
      observation_ts: new Date(observationTime).toISOString(),
      last_execution_ts: null,
      last_success_ts: null,
      latest_status: null,
      recent_success_count: 0,
      recent_failure_count: 0,
      failure_classification: null,
      cron_health: "UNKNOWN",
      telemetry_available: true,
      freshness_threshold_minutes: CRON_MONITOR_FRESHNESS_MINUTES,
      lookback_minutes: CRON_MONITOR_LOOKBACK_MINUTES,
    };
  }

  const lookbackMs = CRON_MONITOR_LOOKBACK_MINUTES * 60_000;
  const freshnessMs = CRON_MONITOR_FRESHNESS_MINUTES * 60_000;
  const recent = usable.filter((row) => observationTime - row.timestamp <= lookbackMs);
  const recentSuccessCount = recent.filter((row) => row.status === "success").length;
  const recentFailures = recent.filter((row) => row.status === "error");
  const lastSuccess = usable.find((row) => row.status === "success");
  const latestAge = observationTime - latest.timestamp;
  const successAge =
    lastSuccess === undefined ? Number.POSITIVE_INFINITY : observationTime - lastSuccess.timestamp;

  let health: CronHealth;
  if (latest.status === "success" && latestAge <= freshnessMs && recentFailures.length === 0) {
    health = "HEALTHY";
  } else if (successAge > freshnessMs * 2) {
    health = "UNHEALTHY";
  } else if (latest.status === "error") {
    health = latestAge <= freshnessMs ? "DEGRADED" : "UNHEALTHY";
  } else if (latestAge <= freshnessMs * 2 && successAge <= freshnessMs * 2) {
    health = "DEGRADED";
  } else {
    health = "DEGRADED";
  }

  return {
    observation_ts: new Date(observationTime).toISOString(),
    last_execution_ts: new Date(latest.timestamp).toISOString(),
    last_success_ts:
      lastSuccess === undefined ? null : new Date(lastSuccess.timestamp).toISOString(),
    latest_status: latest.status,
    recent_success_count: recentSuccessCount,
    recent_failure_count: recentFailures.length,
    failure_classification:
      recentFailures.length === 0 ? null : classification(recentFailures[0]?.stage ?? null),
    cron_health: health,
    telemetry_available: true,
    freshness_threshold_minutes: CRON_MONITOR_FRESHNESS_MINUTES,
    lookback_minutes: CRON_MONITOR_LOOKBACK_MINUTES,
  };
}

/** D1 failures resolve to a sanitized UNKNOWN snapshot, never a driver error. */
export async function readCronMonitor(
  deps: CronMonitorReadDeps,
  now = Date.now(),
): Promise<CronMonitorSnapshot> {
  try {
    const rows = await deps.query(cronMonitorQuery(), [CRON_MONITOR_ROW_LIMIT]);
    return summarizeCronHistory(rows, now);
  } catch {
    return failedSnapshot(now, "D1_QUERY_FAILED");
  }
}
