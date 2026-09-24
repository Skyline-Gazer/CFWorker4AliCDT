import { describe, expect, it } from "vitest";

import { runPipeline } from "../../src/monitor/execute";
import type { PipelineDeps } from "../../src/monitor/execute";
import { RpcError } from "../../src/aliyun/rpc";
import { TrafficUnavailableError } from "../../src/aliyun/api";

/**
 * The run pipeline and fail-safe gate.
 *
 * The central invariant: **inability to obtain traffic results in zero ECS
 * mutations.** Every abort path is asserted to produce zero mutations, not just
 * a classified error — the mutation count is the assertion that matters.
 *
 * At-most-one-mutation is enforced structurally rather than by convention, so a
 * dependency that would allow a second call cannot be called twice.
 */

interface Harness {
  readonly deps: PipelineDeps;
  readonly starts: number;
  readonly stops: number;
  readonly describes: number;
  readonly cdtCalls: number;
}

/**
 * Build a pipeline with scripted upstream behaviour.
 *
 * Counting wraps the (possibly overridden) implementation rather than living
 * inside the default, so a test that scripts a failing upstream still gets an
 * accurate call count. The counts are the assertion that matters: every abort
 * path must show zero mutations.
 */
function harness(overrides: Partial<PipelineDeps> = {}): Harness {
  const counters = { starts: 0, stops: 0, describes: 0, cdtCalls: 0 };

  const defaults: PipelineDeps = {
    getTraffic: () => Promise.resolve({ totalBytes: 1_000_000_000, entries: [] }),
    describeInstance: () => Promise.resolve({ instanceId: "i-abc", status: "running" }),
    startInstance: () => Promise.resolve({ requested: true }),
    stopInstance: () => Promise.resolve({ requested: true }),
    notify: () => Promise.resolve({ ok: true }),
    now: () => Date.parse("2026-09-22T00:00:00Z"),
  };

  const deps: PipelineDeps = {
    getTraffic: () => {
      counters.cdtCalls += 1;
      return (overrides.getTraffic ?? defaults.getTraffic)();
    },
    describeInstance: () => {
      counters.describes += 1;
      return (overrides.describeInstance ?? defaults.describeInstance)();
    },
    startInstance: () => {
      counters.starts += 1;
      return (overrides.startInstance ?? defaults.startInstance)();
    },
    stopInstance: (stoppedMode) => {
      counters.stops += 1;
      return (overrides.stopInstance ?? defaults.stopInstance)(stoppedMode);
    },
    notify: overrides.notify ?? defaults.notify,
    now: overrides.now ?? defaults.now,
  };

  return {
    deps,
    get starts() {
      return counters.starts;
    },
    get stops() {
      return counters.stops;
    },
    get describes() {
      return counters.describes;
    },
    get cdtCalls() {
      return counters.cdtCalls;
    },
  };
}

const CONFIG = {
  trafficThresholdGB: 180,
  ecsInstanceId: "i-abc",
  regionId: "cn-hongkong",
  stoppedMode: "KeepCharging" as const,
};

describe("runPipeline — no-op runs", () => {
  it("issues no mutation when the observed state already matches", async () => {
    const h = harness();
    const report = await runPipeline(h.deps, CONFIG);
    expect(report.status).toBe("success");
    expect(report.action).toBe("none-running");
    expect(h.starts).toBe(0);
    expect(h.stops).toBe(0);
  });

  it("still reports on a no-op run when a notifier is configured", async () => {
    let notified = 0;
    const h = harness({
      notify: () => {
        notified += 1;
        return Promise.resolve({ ok: true });
      },
    });
    await runPipeline(h.deps, CONFIG);
    expect(notified).toBe(1);
  });
});

describe("runPipeline — at most one mutation", () => {
  it("issues exactly one StartInstance when a start is required", async () => {
    const h = harness({
      describeInstance: () => Promise.resolve({ instanceId: "i-abc", status: "stopped" }),
    });
    const report = await runPipeline(h.deps, CONFIG);
    expect(report.action).toBe("start");
    expect(h.starts).toBe(1);
    expect(h.stops).toBe(0);
  });

  it("issues exactly one StopInstance when a stop is required", async () => {
    const h = harness({
      getTraffic: () => Promise.resolve({ totalBytes: 180_000_000_000, entries: [] }),
    });
    const report = await runPipeline(h.deps, CONFIG);
    expect(report.action).toBe("stop");
    expect(h.stops).toBe(1);
    expect(h.starts).toBe(0);
  });

  it("performs one immediate follow-up describe, not a poll", async () => {
    const h = harness({
      describeInstance: () => Promise.resolve({ instanceId: "i-abc", status: "stopped" }),
    });
    const report = await runPipeline(h.deps, CONFIG);
    // One initial describe + exactly one follow-up.
    expect(h.describes).toBe(2);
    expect(report.ecsStatusAfter).toBeDefined();
  });

  it("does not describe twice when no mutation is issued", async () => {
    const h = harness();
    await runPipeline(h.deps, CONFIG);
    expect(h.describes).toBe(1);
  });
});

describe("runPipeline — asynchronous post-state", () => {
  it("accepts a transitional post-state without waiting or re-describing", async () => {
    let calls = 0;
    const h = harness({
      describeInstance: () => {
        calls += 1;
        return Promise.resolve({
          instanceId: "i-abc",
          status: calls === 1 ? "stopped" : "starting",
        });
      },
    });
    const report = await runPipeline(h.deps, CONFIG);
    expect(report.ecsStatusAfter).toBe("starting");
    expect(calls).toBe(2);
  });
});

describe("runPipeline — fail-closed: zero mutations on every abort path", () => {
  const aborts: readonly (readonly [string, string, Partial<PipelineDeps>])[] = [
    [
      "CDT transport failure",
      "cdt-query",
      { getTraffic: () => Promise.resolve(new RpcError("transport", "boom")) },
    ],
    [
      "CDT unavailable traffic",
      "cdt-query",
      { getTraffic: () => Promise.resolve(new TrafficUnavailableError("no TrafficDetails")) },
    ],
    [
      "ECS describe failure",
      "ecs-describe",
      { describeInstance: () => Promise.resolve(new RpcError("client", "denied", 403)) },
    ],
    [
      "instance absent from describe",
      "ecs-describe",
      { describeInstance: () => Promise.resolve(new TrafficUnavailableError("missing")) },
    ],
  ];

  it.each(aborts)("%s aborts with stage %s and zero mutations", async (_label, stage, deps) => {
    const h = harness(deps);
    const report = await runPipeline(h.deps, CONFIG);
    expect(report.status).toBe("error");
    expect(report.stage).toBe(stage);
    expect(h.starts).toBe(0);
    expect(h.stops).toBe(0);
  });

  it("aborts with no mutation when the decision is fail-safe", async () => {
    const h = harness({
      describeInstance: () => Promise.resolve({ instanceId: "i-abc", status: "stopping" }),
    });
    const report = await runPipeline(h.deps, CONFIG);
    expect(report.status).toBe("error");
    expect(report.action).toBe("fail-safe");
    expect(h.starts).toBe(0);
    expect(h.stops).toBe(0);
  });

  it("never issues a mutation when traffic could not be established", async () => {
    // The invariant, stated as the assertion that matters: not "an error was
    // reported" but "nothing was started or stopped".
    const h = harness({
      getTraffic: () => Promise.resolve(new TrafficUnavailableError("empty TrafficDetails")),
    });
    await runPipeline(h.deps, CONFIG);
    expect(h.starts + h.stops).toBe(0);
    expect(h.describes).toBe(0);
  });
});

describe("runPipeline — mutation failure", () => {
  it("reports ecs-start and does not retry the mutation", async () => {
    const h = harness({
      describeInstance: () => Promise.resolve({ instanceId: "i-abc", status: "stopped" }),
      startInstance: () => Promise.resolve(new RpcError("client", "IncorrectInstanceStatus", 403)),
    });
    const report = await runPipeline(h.deps, CONFIG);
    expect(report.status).toBe("error");
    expect(report.stage).toBe("ecs-start");
    expect(h.starts).toBe(1);
  });

  it("reports ecs-stop on a rejected stop", async () => {
    const h = harness({
      getTraffic: () => Promise.resolve({ totalBytes: 200_000_000_000, entries: [] }),
      stopInstance: () => Promise.resolve(new RpcError("client", "rejected", 400)),
    });
    const report = await runPipeline(h.deps, CONFIG);
    expect(report.status).toBe("error");
    expect(report.stage).toBe("ecs-stop");
    expect(h.stops).toBe(1);
  });
});

describe("runPipeline — webhook isolation (SPEC §7.1)", () => {
  it("does not attempt a webhook when no notifier is configured", async () => {
    const h = harness();
    const report = await runPipeline({ ...h.deps, notify: undefined }, CONFIG);
    expect(report.status).toBe("success");
    expect(report.webhookAttempted).toBe(false);
    expect(report.webhookOk).toBeUndefined();
    expect(h.starts + h.stops).toBe(0);
  });

  it("a webhook failure does not change the control outcome", async () => {
    const h = harness({
      notify: () => Promise.resolve({ ok: false }),
    });
    const report = await runPipeline(h.deps, CONFIG);
    expect(report.status).toBe("success");
    expect(report.action).toBe("none-running");
  });

  it("a throwing webhook cannot throw into the control path", async () => {
    const h = harness({
      notify: () => Promise.reject(new Error("webhook exploded")),
    });
    const report = await runPipeline(h.deps, CONFIG);
    expect(report.status).toBe("success");
    expect(h.starts + h.stops).toBe(0);
  });

  it("a webhook failure does not cancel or reverse an issued mutation", async () => {
    const h = harness({
      describeInstance: () => Promise.resolve({ instanceId: "i-abc", status: "stopped" }),
      notify: () => Promise.reject(new Error("webhook exploded")),
    });
    const report = await runPipeline(h.deps, CONFIG);
    expect(report.action).toBe("start");
    expect(h.starts).toBe(1);
  });
});

describe("runPipeline — stopped mode consistency (SPEC §7.3)", () => {
  it("passes the configured mode to stopInstance, matching what the report claims", async () => {
    // The report records the mode that was *requested in the request*. If the
    // pipeline recorded one mode while the call carried another, the report
    // would misdescribe what was sent — and the mode is the one field an
    // operator uses to reason about billing behaviour (SPEC §6.4).
    const seen: string[] = [];
    const h = harness({
      getTraffic: () => Promise.resolve({ totalBytes: 200_000_000_000, entries: [] }),
      stopInstance: (stoppedMode) => {
        seen.push(stoppedMode);
        return Promise.resolve({ requested: true });
      },
    });
    const report = await runPipeline(h.deps, { ...CONFIG, stoppedMode: "StopCharging" });
    expect(seen).toEqual(["StopCharging"]);
    expect(report.stoppedModeRequested).toBe("StopCharging");
  });

  it("does not pass a mode when no stop is issued", async () => {
    const seen: string[] = [];
    const h = harness({
      stopInstance: (stoppedMode) => {
        seen.push(stoppedMode);
        return Promise.resolve({ requested: true });
      },
    });
    await runPipeline(h.deps, CONFIG);
    expect(seen).toEqual([]);
  });
});

describe("runPipeline — report shape", () => {
  it("records the fields the success payload needs (SPEC §7.3)", async () => {
    const h = harness();
    const report = await runPipeline(h.deps, CONFIG);
    expect(report).toMatchObject({
      status: "success",
      trafficGB: 1,
      thresholdGB: 180,
      ecsStatusBefore: "running",
      action: "none-running",
      instanceId: "i-abc",
      region: "cn-hongkong",
    });
    expect(typeof report.durationMs).toBe("number");
    expect(report.time).toBe("2026-09-22T00:00:00Z");
  });

  it("records stoppedModeRequested only when a stop was issued (SPEC §7.3)", async () => {
    const stopping = harness({
      getTraffic: () => Promise.resolve({ totalBytes: 200_000_000_000, entries: [] }),
    });
    const stopped = await runPipeline(stopping.deps, CONFIG);
    expect(stopped.stoppedModeRequested).toBe("KeepCharging");

    const noop = harness();
    const noopReport = await runPipeline(noop.deps, CONFIG);
    expect(noopReport.stoppedModeRequested).toBeUndefined();
  });
});
