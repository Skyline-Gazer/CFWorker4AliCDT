/**
 * Manual read-only query (SPEC §8.5, §10).
 *
 * Answers "what does the system see, and what would it decide" without ever
 * acting. The Cron Trigger remains the **only** ECS mutation authority in v1
 * (invariant I4): a manual mutation button would introduce a second authority and
 * defeat the threshold enforcement this project exists to provide.
 *
 * The read-only guarantee is **structural, not intentional**. `QueryDeps` has no
 * `startInstance`, no `stopInstance`, no history insert, and no webhook — so this
 * path cannot start mutating by wiring alone. Adding one would require widening
 * this interface, which is exactly the reviewable change the design wants.
 *
 * It shares the fail-closed traffic semantics of the scheduled path deliberately:
 * an operator refreshing the dashboard must see "unavailable" rather than a
 * fabricated `0`, because a `0` would display as "well under threshold" on a
 * screen used to make decisions.
 */

import type { EcsStatus, InstanceObservation, TrafficReading } from "../aliyun/api";
import { TrafficUnavailableError, trafficBytesToDecimalGb } from "../aliyun/api";
import { RpcError } from "../aliyun/rpc";
import { redact } from "../redact";
import { decide } from "../monitor/decision";
import type { DecisionAction } from "../monitor/decision";
import type { ErrorStage } from "../monitor/execute";

/** The subset of configuration the query needs. */
export interface QueryConfig {
  readonly trafficThresholdGB: number;
}

/**
 * Every effect the query may perform, injected.
 *
 * There are exactly two, and both are reads. The absence of a third is the
 * guarantee: see the module header.
 */
export interface QueryDeps {
  readonly getTraffic: () => Promise<TrafficReading | RpcError | TrafficUnavailableError>;
  readonly describeInstance: () => Promise<
    InstanceObservation | RpcError | TrafficUnavailableError
  >;
}

/** The query's answer. `mutation` is always `false`; it is stated, not implied. */
export interface QueryResult {
  readonly status: "success" | "error";
  readonly trafficGB: number | undefined;
  readonly thresholdGB: number;
  readonly ecsStatus: EcsStatus | undefined;
  readonly desired: "running" | "stopped" | undefined;
  readonly action: DecisionAction | undefined;
  readonly reason: string | undefined;
  /** Always `false`. Present so a client can assert it rather than infer it. */
  readonly mutation: false;
  readonly stage: ErrorStage | undefined;
  readonly error: string | undefined;
}

function isError(value: unknown): value is RpcError | TrafficUnavailableError {
  return value instanceof RpcError || value instanceof TrafficUnavailableError;
}

function errorOf(
  stage: ErrorStage,
  cause: RpcError | TrafficUnavailableError | Error,
): QueryResult {
  const message = cause instanceof Error ? cause.message : "unknown failure";
  return {
    status: "error",
    trafficGB: undefined,
    thresholdGB: 0,
    ecsStatus: undefined,
    desired: undefined,
    action: undefined,
    reason: undefined,
    mutation: false,
    stage,
    // Redacted: a remote validation error can echo a request header, and this
    // string is returned to an HTTP client.
    error: redact(message),
  };
}

/**
 * Perform a live, read-only query.
 *
 * Never throws: an unexpected failure becomes an `unexpected` error result, so a
 * route cannot leak a stack trace or an unredacted driver message.
 */
export async function runReadOnlyQuery(deps: QueryDeps, config: QueryConfig): Promise<QueryResult> {
  try {
    // 1. Query CDT. Failure aborts before the ECS call: no wasted subrequest, and
    //    no observation recorded against unknown traffic.
    const traffic = await deps.getTraffic();
    if (isError(traffic)) {
      return {
        ...errorOf("cdt-query", traffic),
        thresholdGB: config.trafficThresholdGB,
      };
    }

    let trafficGB: number;
    try {
      trafficGB = trafficBytesToDecimalGb(traffic.totalBytes);
    } catch (cause) {
      return {
        ...errorOf("cdt-query", cause instanceof Error ? cause : new Error("unusable total")),
        thresholdGB: config.trafficThresholdGB,
      };
    }

    // 2. Describe. A missing instance or a failed call aborts: absence is not
    //    evidence of state, exactly as on the scheduled path.
    const observation = await deps.describeInstance();
    if (isError(observation)) {
      return {
        ...errorOf("ecs-describe", observation),
        trafficGB,
        thresholdGB: config.trafficThresholdGB,
      };
    }

    // 3. Decide, using the same pure function as the scheduled path. Using the
    //    same function is what makes the manual answer a genuine prediction of
    //    what Cron would do, rather than a parallel reimplementation that could
    //    drift from it.
    const decision = decide({
      trafficGB,
      thresholdGB: config.trafficThresholdGB,
      observed: observation.status,
    });

    return {
      status: "success",
      trafficGB,
      thresholdGB: config.trafficThresholdGB,
      ecsStatus: observation.status,
      desired: decision.desired,
      action: decision.action,
      reason: decision.reason,
      // Stated rather than omitted: the client can assert it, and a future change
      // that tried to set it true would have to change this type.
      mutation: false,
      stage: undefined,
      error: undefined,
    };
  } catch (cause) {
    // A synchronous throw from an injected dependency, or a bug in this module.
    // Reported as `unexpected` rather than propagated.
    return {
      ...errorOf("unexpected", cause instanceof Error ? cause : new Error("unexpected failure")),
      thresholdGB: config.trafficThresholdGB,
    };
  }
}
