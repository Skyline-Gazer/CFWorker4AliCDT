/**
 * D1 monitoring history — the scheduled-run write path (SPEC §9).
 *
 * Three normative properties shape this module.
 *
 * **Failure isolation (SPEC §9.6, A11).** A D1 failure must not reverse, alter,
 * or block an ECS control result. `recordRun` therefore *resolves* on every
 * failure — it never rejects — and reports the outcome as a `storageOk` field.
 * A rejection would propagate into the scheduled handler, where it is
 * indistinguishable from a control failure.
 *
 * **A row must not describe its own insert.** `storageOk` is returned to the
 * caller rather than written into the row: a field recording whether the insert
 * succeeded cannot exist before the insert it describes has happened.
 *
 * **Unknown traffic persists as NULL.** SPEC §5.4's invariant applies to storage
 * as much as to control. A row is more durable than a log line, so a fabricated
 * `0` here would outlive the bug that produced it.
 */

import type { DecisionAction } from "../monitor/decision";
import type { ErrorStage } from "../monitor/execute";
import { redact } from "../notify/webhook";

/** One row of `traffic_checks`. `null` is the storage form of "unknown". */
export interface RowInsert {
  readonly checked_at: string;
  readonly trigger: "scheduled";
  readonly status: "success" | "error";
  readonly traffic_gb: number | null;
  readonly threshold_gb: number;
  readonly usage_percent: number | null;
  readonly remaining_gb: number | null;
  readonly ecs_status_before: string | null;
  readonly desired_ecs_state: string | null;
  readonly action: string | null;
  readonly ecs_status_after: string | null;
  readonly control_ok: number;
  readonly webhook_attempted: number;
  readonly webhook_ok: number | null;
  readonly error_stage: string | null;
  readonly error_message: string | null;
  readonly duration_ms: number;
}

/**
 * The report shape this module records.
 *
 * Structurally a subset of `RunReport` plus its webhook-delivery outcome, minus
 * the fields D1 has no column for (`instanceId`, `region`). Kept as its own
 * interface so a caller must state deliberately that it is recording history.
 */
export interface HistoryReport {
  readonly status: "success" | "error";
  readonly trafficGB: number | undefined;
  readonly thresholdGB: number;
  readonly ecsStatusBefore: string | undefined;
  readonly ecsStatusAfter: string | undefined;
  readonly desired: "running" | "stopped" | undefined;
  readonly action: DecisionAction | undefined;
  readonly stoppedModeRequested: "StopCharging" | "KeepCharging" | undefined;
  readonly instanceId: string;
  readonly region: string;
  readonly time: string;
  readonly durationMs: number;
  readonly stage: ErrorStage | undefined;
  readonly error: string | undefined;
  readonly webhookAttempted: boolean;
  readonly webhookOk: boolean | undefined;
}

export interface RecordDeps {
  /** Injected for tests. A production caller supplies a D1-bound insert. */
  readonly insert: (row: RowInsert) => Promise<void>;
}

export interface RecordResult {
  /** `true` only after the insert actually resolved. Never stored in the row. */
  readonly storageOk: boolean;
  /** A short, sanitised description of the failure, when there was one. */
  readonly error: string | undefined;
}

/** SQLite stores booleans as 0/1. */
function bool(value: boolean): number {
  return value ? 1 : 0;
}

/** Absent values become SQL NULL rather than a coerced default. */
function nullish<T>(value: T | undefined): T | null {
  return value ?? null;
}

/**
 * Was the *control* outcome successful?
 *
 * A run that aborted before touching ECS (`config`, `cdt-query`,
 * `ecs-describe`) is not a control failure: control was never exercised, and
 * recording it as one would misattribute the cause. Only a failed control call
 * itself (`ecs-start`, `ecs-stop`) is a control failure. `webhook` and
 * `unexpected` are not control outcomes either.
 */
export function controlOk(report: HistoryReport): boolean {
  if (report.status === "success") return true;
  return report.stage !== "ecs-start" && report.stage !== "ecs-stop";
}

/**
 * Map a run report onto the SPEC §9.3 columns.
 *
 * Pure and synchronous: it performs no I/O, so it can be asserted directly
 * against the schema without a database.
 */
export function buildRow(report: HistoryReport): RowInsert {
  // Unknown traffic yields NULL derived values too. Computing "remaining" from a
  // fabricated zero would read as a full allowance remaining, which is exactly
  // the inference the fail-safe model forbids.
  const trafficKnown = report.trafficGB !== undefined && Number.isFinite(report.trafficGB);
  const trafficGB = trafficKnown ? report.trafficGB : undefined;

  const usagePercent = trafficGB === undefined ? null : (trafficGB / report.thresholdGB) * 100;
  const remainingGB = trafficGB === undefined ? null : report.thresholdGB - trafficGB;

  return {
    checked_at: report.time,
    trigger: "scheduled",
    status: report.status,
    traffic_gb: nullish(trafficGB),
    threshold_gb: report.thresholdGB,
    usage_percent: usagePercent,
    remaining_gb: remainingGB,
    ecs_status_before: nullish(report.ecsStatusBefore),
    desired_ecs_state: nullish(report.desired),
    action: nullish(report.action),
    ecs_status_after: nullish(report.ecsStatusAfter),
    control_ok: bool(controlOk(report)),
    webhook_attempted: bool(report.webhookAttempted),
    webhook_ok: report.webhookOk === undefined ? null : bool(report.webhookOk),
    error_stage: nullish(report.stage),
    // Sanitised before it is stored. A D1 row is the most durable destination in
    // the project, so this is the last place a leaked credential could be
    // removed rather than merely hoped about (SPEC §9.4, §7.5).
    error_message: report.error === undefined ? null : redact(report.error),
    duration_ms: report.durationMs,
  };
}

/**
 * Record one scheduled execution.
 *
 * Resolves in every case. A D1 failure is logged locally and reported through
 * `storageOk`, because the write path has no other way to report its own
 * failure and must not surface one to the control path.
 */
export async function recordRun(report: HistoryReport, deps: RecordDeps): Promise<RecordResult> {
  const row = buildRow(report);
  try {
    await deps.insert(row);
    // `storageOk` is produced *after* the insert resolves. It is deliberately
    // not part of `row`: see the module header.
    return { storageOk: true, error: undefined };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown storage failure";
    // Logged locally: a D1 row cannot report the failure of its own insert.
    // Redacted because the driver's message can echo the failed statement,
    // which may carry a bound parameter.
    console.warn(`[storage] history write failed (${redact(message)})`);
    return { storageOk: false, error: redact(message) };
  }
}
