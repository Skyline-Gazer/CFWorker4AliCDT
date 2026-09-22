import { describe, expect, it } from "vitest";

import { decide } from "../../src/monitor/decision";
import type { DecideInput } from "../../src/monitor/decision";
import type { EcsStatus } from "../../src/aliyun/api";

/**
 * The decision engine.
 *
 * `decide()` is pure by design (SPEC §6.2): no I/O, no clock, no configuration,
 * no randomness. It is the component whose failure is most expensive and the
 * cheapest to test, so the matrix is asserted exhaustively rather than sampled.
 *
 * The threshold boundary is load-bearing: exactly at the threshold means
 * **stopped**. A one-sided mistake here leaves the instance running and
 * accruing cost, which is the failure this project exists to prevent.
 */

const THRESHOLD = 180;

function at(trafficGB: number, observed: EcsStatus): DecideInput {
  return { trafficGB, thresholdGB: THRESHOLD, observed };
}

/** The twelve rows of SPEC §6.3, as (desired, observed) → action. */
const MATRIX: readonly (readonly [EcsStatus, string, string, boolean])[] = [
  // observed, action, desired, mutates
  ["running", "none-running", "running", false],
  ["starting", "none-starting", "running", false],
  ["stopped", "start", "running", true],
  ["stopping", "fail-safe", "running", false],
  ["pending", "fail-safe", "running", false],
  ["unknown", "fail-safe", "running", false],
];

const STOP_MATRIX: readonly (readonly [EcsStatus, string, string, boolean])[] = [
  ["stopped", "none-stopped", "stopped", false],
  ["stopping", "none-stopping", "stopped", false],
  ["running", "stop", "stopped", true],
  ["starting", "fail-safe", "stopped", false],
  ["pending", "fail-safe", "stopped", false],
  ["unknown", "fail-safe", "stopped", false],
];

describe("decide — desired state (SPEC §6.2)", () => {
  it("desires running strictly below the threshold", () => {
    expect(decide(at(THRESHOLD - 1, "running")).desired).toBe("running");
    expect(decide(at(0, "running")).desired).toBe("running");
  });

  it("desires stopped exactly at the threshold", () => {
    // Boundary: `>= threshold` stops. A `<` vs `<=` mistake here is the most
    // expensive bug in the project.
    expect(decide(at(THRESHOLD, "running")).desired).toBe("stopped");
  });

  it("desires stopped above the threshold", () => {
    expect(decide(at(THRESHOLD + 1, "running")).desired).toBe("stopped");
  });

  it("uses values exact in binary floating point at the boundary", () => {
    // 180.5 and 179.5 are exactly representable, so the assertions test the
    // comparison rather than representation error.
    expect(decide(at(179.5, "running")).desired).toBe("running");
    expect(decide(at(180.5, "running")).desired).toBe("stopped");
    expect(decide(at(180, "running")).desired).toBe("stopped");
  });
});

describe("decide — action matrix under threshold (SPEC §6.3)", () => {
  it.each(MATRIX)(
    "traffic below threshold, observed %s → %s",
    (observed, action, desired, mutates) => {
      const result = decide(at(THRESHOLD - 1, observed));
      expect(result.action).toBe(action);
      expect(result.desired).toBe(desired);
      expect(result.mutation).toBe(mutates);
    },
  );
});

describe("decide — action matrix at/above threshold (SPEC §6.3)", () => {
  it.each(STOP_MATRIX)(
    "traffic at threshold, observed %s → %s",
    (observed, action, desired, mutates) => {
      const result = decide(at(THRESHOLD, observed));
      expect(result.action).toBe(action);
      expect(result.desired).toBe(desired);
      expect(result.mutation).toBe(mutates);
    },
  );
});

describe("decide — at most one mutation", () => {
  it("marks exactly the two control actions as mutating", () => {
    const mutating = new Set<string>();
    for (const observed of [
      "running",
      "starting",
      "stopping",
      "stopped",
      "pending",
      "unknown",
    ] as const) {
      for (const traffic of [THRESHOLD - 1, THRESHOLD]) {
        const result = decide(at(traffic, observed));
        if (result.mutation) mutating.add(result.action);
      }
    }
    expect([...mutating].sort()).toEqual(["start", "stop"]);
  });

  it("never marks a no-op or fail-safe row as mutating", () => {
    for (const action of [
      "none-running",
      "none-starting",
      "none-stopped",
      "none-stopping",
      "fail-safe",
    ]) {
      for (const observed of [
        "running",
        "starting",
        "stopping",
        "stopped",
        "pending",
        "unknown",
      ] as const) {
        for (const traffic of [THRESHOLD - 1, THRESHOLD]) {
          const result = decide(at(traffic, observed));
          if (result.action === action) expect(result.mutation).toBe(false);
        }
      }
    }
  });
});

describe("decide — invalid input fails safe (SPEC §6.3, §6.5)", () => {
  const invalid: readonly (readonly [string, DecideInput])[] = [
    ["NaN traffic", at(Number.NaN, "running")],
    ["Infinite traffic", at(Number.POSITIVE_INFINITY, "running")],
    ["negative traffic", at(-1, "running")],
    ["NaN threshold", { trafficGB: 10, thresholdGB: Number.NaN, observed: "running" }],
    ["negative threshold", { trafficGB: 10, thresholdGB: -1, observed: "running" }],
    ["zero threshold", { trafficGB: 10, thresholdGB: 0, observed: "running" }],
    [
      "Infinite threshold",
      { trafficGB: 10, thresholdGB: Number.POSITIVE_INFINITY, observed: "running" },
    ],
  ];

  it.each(invalid)("%s produces fail-safe with no mutation", (_label, input) => {
    const result = decide(input);
    expect(result.action).toBe("fail-safe");
    expect(result.mutation).toBe(false);
  });

  it("fails safe on an unrecognised observed status rather than guessing", () => {
    const result = decide({ trafficGB: 1, thresholdGB: THRESHOLD, observed: "unknown" });
    expect(result.action).toBe("fail-safe");
    expect(result.mutation).toBe(false);
  });
});

describe("decide — purity (SPEC §6.2)", () => {
  it("returns an identical result for identical inputs across repeated calls", () => {
    const input = at(THRESHOLD - 1, "stopped");
    const first = decide(input);
    const second = decide(input);
    expect(second).toEqual(first);
    expect(decide({ ...input })).toEqual(first);
  });

  it("does not mutate its input", () => {
    const input = at(THRESHOLD - 1, "stopped");
    const snapshot = { ...input };
    decide(input);
    expect(input).toEqual(snapshot);
  });

  it("carries a human-readable reason for every outcome", () => {
    for (const observed of [
      "running",
      "starting",
      "stopping",
      "stopped",
      "pending",
      "unknown",
    ] as const) {
      for (const traffic of [THRESHOLD - 1, THRESHOLD]) {
        const result = decide(at(traffic, observed));
        expect(typeof result.reason).toBe("string");
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
