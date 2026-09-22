/**
 * The decision engine.
 *
 * `decide()` is **pure** (SPEC §6.2): it performs no I/O, reads no clock, reads no
 * configuration, and reads no database. It takes the traffic total, the
 * threshold, and the observed ECS status, and returns the desired state, the
 * chosen action, and a reason.
 *
 * Purity is a design requirement rather than a stylistic preference. This is the
 * component whose failure is most expensive, and a pure function can be tested
 * exhaustively against the full action matrix with no mocks. It also cannot
 * accidentally issue a mutation, because it has no way to issue one.
 *
 * The central invariant this function protects:
 *
 *   Inability to establish the traffic value is never evidence that the traffic
 *   value is zero.
 *
 * Every input it cannot trust produces `fail-safe`, never a guess. A false abort
 * costs one monitoring interval; a false "under threshold" costs money and cannot
 * be undone retroactively (PLAN §7).
 */

import type { EcsStatus } from "../aliyun/api";

/** The desired instance state, derived only from the traffic figure. */
export type DesiredState = "running" | "stopped";

/**
 * The action the pipeline should take.
 *
 * The `none-*` actions are no-ops: the observed state already reflects the
 * desired state, including its transitional form. Re-issuing a command in that
 * case is prohibited (SPEC §6.3), because a repeated Start or Stop against a
 * transitional instance risks acting on a stale reading.
 *
 * `fail-safe` aborts the run with an error and **no** mutation.
 */
export type DecisionAction =
  | "none-running"
  | "none-starting"
  | "none-stopped"
  | "none-stopping"
  | "start"
  | "stop"
  | "fail-safe";

export interface DecideInput {
  /** Total traffic in decimal GB. */
  readonly trafficGB: number;
  /** Configured threshold in decimal GB. */
  readonly thresholdGB: number;
  readonly observed: EcsStatus;
}

export interface Decision {
  readonly desired: DesiredState;
  readonly action: DecisionAction;
  /** `true` only for `start` and `stop`. Everything else issues no command. */
  readonly mutation: boolean;
  readonly reason: string;
}

/**
 * The action matrix from SPEC §6.3, as `desired` → `observed` → action.
 *
 * Written out in full rather than derived. A derived rule would have to encode
 * the `fail-safe` rows as exceptions, and an exception that is easy to reason
 * about once is easy to lose in a refactor. As a table, every row is reviewable
 * against the specification at a glance, and the type system checks that the map
 * is exhaustive over both desired states.
 */
const MATRIX: Record<DesiredState, Record<EcsStatus, DecisionAction>> = {
  running: {
    running: "none-running",
    starting: "none-starting",
    stopped: "start",
    // No safe transition exists from a transitional or unrecognised state
    // toward `running`: `stopping` is on its way down, and `pending`/`unknown`
    // tell us nothing. Abort rather than invent one.
    stopping: "fail-safe",
    pending: "fail-safe",
    unknown: "fail-safe",
  },
  stopped: {
    stopped: "none-stopped",
    stopping: "none-stopping",
    running: "stop",
    starting: "fail-safe",
    pending: "fail-safe",
    unknown: "fail-safe",
  },
};

const MUTATING: Record<DecisionAction, boolean> = {
  "none-running": false,
  "none-starting": false,
  "none-stopped": false,
  "none-stopping": false,
  start: true,
  stop: true,
  "fail-safe": false,
};

function isUsableThreshold(thresholdGB: number): boolean {
  return Number.isFinite(thresholdGB) && thresholdGB > 0;
}

function isUsableTraffic(trafficGB: number): boolean {
  // A non-finite or negative figure is not a reading. `NaN` in particular must
  // never reach a comparison: `NaN >= x` and `NaN < x` are both false, so a
  // naive implementation would fall through to whichever branch it wrote last.
  return Number.isFinite(trafficGB) && trafficGB >= 0;
}

function failSafe(reason: string): Decision {
  return { desired: "running", action: "fail-safe", mutation: false, reason };
}

/**
 * Map (traffic, threshold, observed status) to exactly one action.
 *
 * Pure: no I/O, no clock, no configuration, no randomness.
 */
export function decide(input: DecideInput): Decision {
  const { trafficGB, thresholdGB, observed } = input;

  if (!isUsableThreshold(thresholdGB)) {
    return failSafe(
      `Threshold is not a usable positive number (received a ${typeof thresholdGB} that is not finite and > 0)`,
    );
  }
  if (!isUsableTraffic(trafficGB)) {
    return failSafe(
      `Traffic is not a usable non-negative finite number (received a ${typeof trafficGB} that is not finite and >= 0)`,
    );
  }

  // Boundary semantics: exactly at the threshold means `stopped` (SPEC §6.2).
  // A `<` here rather than `>=` would leave the instance running past its
  // allowance, which is the failure mode this project exists to prevent.
  const desired: DesiredState = trafficGB < thresholdGB ? "running" : "stopped";
  const action = MATRIX[desired][observed];

  return {
    desired,
    action,
    mutation: MUTATING[action],
    reason: reasonFor(desired, observed, action, trafficGB, thresholdGB),
  };
}

function reasonFor(
  desired: DesiredState,
  observed: EcsStatus,
  action: DecisionAction,
  trafficGB: number,
  thresholdGB: number,
): string {
  const comparison =
    desired === "running"
      ? `traffic ${trafficGB} GB is below threshold ${thresholdGB} GB`
      : `traffic ${trafficGB} GB has reached threshold ${thresholdGB} GB`;

  if (action === "fail-safe") {
    return `Fail-safe: ${comparison}, but the instance is observed as "${observed}", which has no safe transition toward "${desired}"`;
  }
  if (action === "start" || action === "stop") {
    return `${comparison}; instance is "${observed}", so a ${action} is required`;
  }
  return `${comparison}; instance is already "${observed}", so no action is required`;
}
