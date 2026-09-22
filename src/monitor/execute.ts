/**
 * The run pipeline and fail-safe gate (SPEC §10).
 *
 * This is where the project's central invariant is enforced:
 *
 *   **Inability to obtain traffic results in zero ECS mutations.**
 *
 * Two structural choices make that hold rather than merely be intended.
 *
 * **At most one mutation is expressed as a single `issueMutation()` helper.**
 * The pipeline never calls a start or stop directly. There is one call site, so
 * "at most one mutation per run" is a property of the shape of the code rather
 * than a rule a future edit has to remember.
 *
 * **Notification is a side channel that cannot throw into control.** Every
 * `notify` call is wrapped, and the report is assembled before it is dispatched,
 * so a webhook failure cannot alter what was recorded or what was done.
 */

import type { Config } from "../config";
import type { EcsStatus, InstanceObservation, TrafficReading } from "../aliyun/api";
import { TrafficUnavailableError, trafficBytesToDecimalGb } from "../aliyun/api";
import { RpcError } from "../aliyun/rpc";
import { decide } from "./decision";
import type { Decision, DecisionAction } from "./decision";

/** Error stages, per SPEC §7.4. */
export type ErrorStage =
  "config" | "cdt-query" | "ecs-describe" | "ecs-start" | "ecs-stop" | "webhook" | "unexpected";

/** The subset of `Config` the pipeline needs. Keeps the pipeline testable. */
export type PipelineConfig = Pick<
  Config,
  "trafficThresholdGB" | "ecsInstanceId" | "regionId" | "stoppedMode"
>;

/**
 * Every effect the pipeline performs, injected.
 *
 * Injection is what makes the fail-safe paths assertable: a test can make the
 * CDT query fail and then assert that the mutation counters are zero, without a
 * network stub or a module mock.
 */
export interface PipelineDeps {
  /** Resolves to a reading, or to the error explaining why none exists. */
  readonly getTraffic: () => Promise<TrafficReading | RpcError | TrafficUnavailableError>;
  readonly describeInstance: () => Promise<
    InstanceObservation | RpcError | TrafficUnavailableError
  >;
  readonly startInstance: () => Promise<{ readonly requested: true } | RpcError>;
  /**
   * Request a stop. The mode is passed to the call site so the report's
   * `stoppedModeRequested` is derived from what was actually sent, never from a
   * separate copy that could diverge (SPEC §7.3, §6.4).
   */
  readonly stopInstance: (
    stoppedMode: "StopCharging" | "KeepCharging",
  ) => Promise<{ readonly requested: true } | RpcError>;
  /** Reporting side channel. Its result never affects control (SPEC §7.1). */
  readonly notify: (report: RunReport) => Promise<{ readonly ok: boolean }>;
  readonly now: () => number;
}

/** The run's identity, shared by every report. */
interface ReportBase {
  readonly thresholdGB: number;
  readonly instanceId: string;
  readonly region: string;
}

/**
 * The outcome-specific part of a report.
 *
 * Fields a given path may legitimately not know are optional; `finish` fills
 * them with explicit `undefined`/success defaults so the assembled report has a
 * single, stable shape regardless of which path produced it.
 */
interface ReportOutcome {
  readonly status: "success" | "error";
  readonly trafficGB: number | undefined;
  readonly ecsStatusBefore?: EcsStatus | undefined;
  readonly stage?: ErrorStage | undefined;
  readonly error?: string | undefined;
  readonly ecsStatusAfter?: EcsStatus | undefined;
  readonly desired?: "running" | "stopped" | undefined;
  readonly action?: DecisionAction | undefined;
  readonly stoppedModeRequested?: "StopCharging" | "KeepCharging" | undefined;
}
export interface RunReport {
  readonly status: "success" | "error";
  readonly trafficGB: number | undefined;
  readonly thresholdGB: number;
  readonly ecsStatusBefore: EcsStatus | undefined;
  readonly ecsStatusAfter: EcsStatus | undefined;
  readonly desired: "running" | "stopped" | undefined;
  readonly action: DecisionAction | undefined;
  readonly stoppedModeRequested: "StopCharging" | "KeepCharging" | undefined;
  readonly instanceId: string;
  readonly region: string;
  readonly time: string;
  readonly durationMs: number;
  readonly stage: ErrorStage | undefined;
  readonly error: string | undefined;
  /** Whether the webhook was attempted, and whether it succeeded. */
  readonly webhookAttempted: boolean;
  readonly webhookOk: boolean | undefined;
}

function isError(value: unknown): value is RpcError | TrafficUnavailableError {
  return value instanceof RpcError || value instanceof TrafficUnavailableError;
}

/** A message safe for a payload or a log line. Remote text is already redacted. */
function describeError(value: RpcError | TrafficUnavailableError): string {
  return value instanceof RpcError ? value.message : value.message;
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Dispatch the webhook without letting it affect control (SPEC §7.1).
 *
 * Returns whether it succeeded; never throws. The report is already assembled by
 * the caller, so a failure here cannot change what was recorded.
 */
async function safeNotify(
  notify: PipelineDeps["notify"],
  report: RunReport,
): Promise<{ attempted: boolean; ok: boolean | undefined }> {
  try {
    const result = await notify(report);
    return { attempted: true, ok: result.ok };
  } catch {
    // A throwing reporter is a webhook failure, not a run failure.
    return { attempted: true, ok: false };
  }
}

/**
 * Execute one monitoring run.
 *
 * Order is normative (SPEC §10): validate configuration, query CDT, describe the
 * instance, decide, gate on `fail-safe`, issue at most one mutation, perform one
 * follow-up describe, then report.
 *
 * Never throws: every failure becomes a classified error report, so a caller
 * cannot accidentally let an operational error escape as an exception.
 */
export async function runPipeline(deps: PipelineDeps, config: PipelineConfig): Promise<RunReport> {
  const startedAt = deps.now();

  const base = {
    thresholdGB: config.trafficThresholdGB,
    instanceId: config.ecsInstanceId,
    region: config.regionId,
  };

  // 1. Configuration is validated by the caller before this point; an invalid
  //    config never reaches here (loadConfig returns a value, not a throw).

  // 2. Query CDT. A failure or an unavailable reading aborts with zero
  //    mutations: unavailable traffic is never treated as zero.
  const traffic = await deps.getTraffic();
  if (isError(traffic)) {
    return finish(deps, startedAt, base, {
      status: "error",
      stage: "cdt-query",
      error: describeError(traffic),
      trafficGB: undefined,
    });
  }

  let trafficGB: number;
  try {
    trafficGB = trafficBytesToDecimalGb(traffic.totalBytes);
  } catch (cause) {
    // A non-finite or negative total cannot be compared against a threshold.
    return finish(deps, startedAt, base, {
      status: "error",
      stage: "cdt-query",
      error: cause instanceof Error ? cause.message : "Traffic total was unusable",
      trafficGB: undefined,
    });
  }

  // 3. Describe the instance. A failure, or an instance absent from the
  //    response, aborts: absence is not evidence of state.
  const observation = await deps.describeInstance();
  if (isError(observation)) {
    return finish(deps, startedAt, base, {
      status: "error",
      stage: "ecs-describe",
      error: describeError(observation),
      trafficGB,
    });
  }

  // 4. Decide. Pure: no I/O.
  const decision: Decision = decide({
    trafficGB,
    thresholdGB: config.trafficThresholdGB,
    observed: observation.status,
  });

  // 5. Gate on fail-safe: abort with an error and no mutation. Issuing a
  //    command against an unrecognised state risks acting on a stale reading.
  if (decision.action === "fail-safe") {
    return finish(deps, startedAt, base, {
      status: "error",
      stage: "ecs-describe",
      error: decision.reason,
      trafficGB,
      ecsStatusBefore: observation.status,
      desired: decision.desired,
      action: decision.action,
    });
  }

  // 6/7. At most one mutation, through the single call site below.
  if (decision.mutation) {
    const outcome = await issueMutation(deps, decision, config);
    if (outcome.error !== undefined) {
      return finish(deps, startedAt, base, {
        status: "error",
        stage: outcome.error.stage,
        error: outcome.error.message,
        trafficGB,
        ecsStatusBefore: observation.status,
        desired: decision.desired,
        action: decision.action,
        stoppedModeRequested: decision.action === "stop" ? config.stoppedMode : undefined,
      });
    }

    // 8. Exactly one immediate follow-up describe. A transitional result is a
    //    valid observation and is never polled or repeated.
    const after = await deps.describeInstance();
    const ecsStatusAfter = isError(after) ? undefined : after.status;

    return finish(deps, startedAt, base, {
      status: "success",
      trafficGB,
      ecsStatusBefore: observation.status,
      ecsStatusAfter,
      desired: decision.desired,
      action: decision.action,
      stoppedModeRequested: decision.action === "stop" ? config.stoppedMode : undefined,
    });
  }

  // No mutation required. No follow-up describe: the observed state is already
  // the answer, and an extra call is an extra subrequest against the budget.
  return finish(deps, startedAt, base, {
    status: "success",
    trafficGB,
    ecsStatusBefore: observation.status,
    ecsStatusAfter: observation.status,
    desired: decision.desired,
    action: decision.action,
  });
}

/**
 * The single place a mutation is issued.
 *
 * Routing both control actions through one helper is what makes "at most one
 * mutation per run" structural: the pipeline has exactly one call site, so a
 * second mutation would require a second, visible call to this function.
 */
async function issueMutation(
  deps: PipelineDeps,
  decision: Decision,
  config: PipelineConfig,
): Promise<{ error: { stage: ErrorStage; message: string } | undefined }> {
  if (decision.action === "start") {
    const result = await deps.startInstance();
    return isError(result)
      ? { error: { stage: "ecs-start", message: describeError(result) } }
      : { error: undefined };
  }
  if (decision.action === "stop") {
    // The configured mode is passed to the call, so what is sent and what the
    // report records are the same value. It is reported as *requested*, never
    // as applied: Alibaba returns success when the mode is unsupported and
    // silently ignores it (SPEC §6.4).
    const result = await deps.stopInstance(config.stoppedMode);
    return isError(result)
      ? { error: { stage: "ecs-stop", message: describeError(result) } }
      : { error: undefined };
  }
  // Only `start` and `stop` carry `mutation: true` (asserted by decision tests).
  return { error: undefined };
}

/** Assemble the report, dispatch the webhook, and return the report unchanged. */
async function finish(
  deps: PipelineDeps,
  startedAt: number,
  base: ReportBase,
  outcome: ReportOutcome,
): Promise<RunReport> {
  const finishedAt = deps.now();
  const draft: RunReport = {
    ...base,
    ...outcome,
    ecsStatusBefore: outcome.ecsStatusBefore,
    stage: outcome.stage,
    error: outcome.error,
    ecsStatusAfter: outcome.ecsStatusAfter,
    desired: outcome.desired,
    action: outcome.action,
    stoppedModeRequested: outcome.stoppedModeRequested,
    time: isoUtc(finishedAt),
    durationMs: finishedAt - startedAt,
    webhookAttempted: false,
    webhookOk: undefined,
  };

  // The report is fully assembled before dispatch, so the webhook cannot change
  // it. `safeNotify` cannot throw.
  const delivery = await safeNotify(deps.notify, draft);
  return { ...draft, webhookAttempted: delivery.attempted, webhookOk: delivery.ok };
}
