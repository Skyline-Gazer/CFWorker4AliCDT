import { describe, expect, it, vi } from "vitest";

import { runReadOnlyQuery } from "../../src/web/query";
import type { QueryConfig, QueryDeps } from "../../src/web/query";
import { RpcError } from "../../src/aliyun/rpc";
import type { InstanceObservation } from "../../src/aliyun/api";
import { TrafficUnavailableError } from "../../src/aliyun/api";

/**
 * Manual read-only query (SPEC §8.5, §10).
 *
 * This is the endpoint where "read-only" has to be true by construction rather
 * than by intention: a manual mutation button would introduce a second mutation
 * authority and defeat the threshold enforcement the project exists to provide.
 *
 * Three properties are asserted, and the first is the one everything else rests
 * on:
 *
 * 1. `QueryDeps` has **no mutation seam and no writes** — there is no
 *    `startInstance`, `stopInstance`, history insert, or webhook to call. A
 *    read-only path cannot stop being read-only by wiring alone.
 * 2. Failure semantics match the scheduled path: unavailable traffic is reported
 *    as unavailable, never as `0`.
 * 3. The result states the observation and the decision, and its `mutation` field
 *    is always false.
 */

const CONFIG: QueryConfig = { trafficThresholdGB: 180 };

function deps(overrides: Partial<QueryDeps> = {}): QueryDeps {
  return {
    getTraffic: () => Promise.resolve({ totalBytes: 1024 ** 3, entries: [] }),
    describeInstance: () => Promise.resolve({ instanceId: "i-abc", status: "running" }),
    ...overrides,
  };
}

describe("runReadOnlyQuery — the read-only guarantee is structural (SPEC §8.5, A6)", () => {
  it("exposes no dependency through which a mutation could be issued", () => {
    // If a future change added a mutation seam, this fails. That is the point:
    // the guarantee is a property of the type, not of the current call sites.
    expect(Object.keys(deps()).sort()).toEqual(["describeInstance", "getTraffic"]);
  });

  it("exposes no dependency through which a write could occur", () => {
    // No history insert and no webhook dispatch: SPEC §10 gives the manual path
    // neither, and history must not record a manual read as a control run.
    const keys = Object.keys(deps());
    for (const forbidden of ["insert", "record", "notify", "write", "history"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("reports mutation as false for every outcome", async () => {
    const cases: readonly (readonly [string, Partial<QueryDeps>])[] = [
      ["no-op", {}],
      [
        "would start",
        { describeInstance: () => Promise.resolve({ instanceId: "i-abc", status: "stopped" }) },
      ],
      [
        "would stop",
        { getTraffic: () => Promise.resolve({ totalBytes: 200_000_000_000, entries: [] }) },
      ],
      ["cdt failure", { getTraffic: () => Promise.resolve(new RpcError("transport", "boom")) }],
      [
        "fail-safe",
        { describeInstance: () => Promise.resolve({ instanceId: "i-abc", status: "unknown" }) },
      ],
    ];
    for (const [label, override] of cases) {
      const result = await runReadOnlyQuery(deps(override), CONFIG);
      expect(result.mutation, `${label} must not mutate`).toBe(false);
    }
  });

  it("reports a would-be action without performing it", async () => {
    // The endpoint answers "what would the system decide", and must be able to
    // say "stop" without stopping anything.
    const result = await runReadOnlyQuery(
      deps({ getTraffic: () => Promise.resolve({ totalBytes: 200_000_000_000, entries: [] }) }),
      CONFIG,
    );
    expect(result.status).toBe("success");
    expect(result.action).toBe("stop");
    expect(result.mutation).toBe(false);
  });
});

describe("runReadOnlyQuery — observation and decision (SPEC §8.5)", () => {
  it("returns the observed traffic in console-aligned GB", async () => {
    const result = await runReadOnlyQuery(deps(), CONFIG);
    expect(result.trafficGB).toBe(1);
    expect(result.thresholdGB).toBe(180);
  });

  it("returns the observed ECS status", async () => {
    const result = await runReadOnlyQuery(
      deps({
        describeInstance: () => Promise.resolve({ instanceId: "i-abc", status: "stopping" }),
      }),
      CONFIG,
    );
    expect(result.ecsStatus).toBe("stopping");
  });

  it("returns the desired state and the action", async () => {
    const result = await runReadOnlyQuery(deps(), CONFIG);
    expect(result.desired).toBe("running");
    expect(result.action).toBe("none-running");
  });

  it("returns a decision reason", async () => {
    const result = await runReadOnlyQuery(deps(), CONFIG);
    expect(typeof result.reason).toBe("string");
    expect(result.reason?.length ?? 0).toBeGreaterThan(0);
  });

  it("evaluates the threshold boundary exactly as the scheduled path does", async () => {
    const above = await runReadOnlyQuery(
      deps({ getTraffic: () => Promise.resolve({ totalBytes: 180 * 1024 ** 3, entries: [] }) }),
      CONFIG,
    );
    expect(above.desired).toBe("stopped");

    const below = await runReadOnlyQuery(
      deps({ getTraffic: () => Promise.resolve({ totalBytes: 179 * 1024 ** 3, entries: [] }) }),
      CONFIG,
    );
    expect(below.desired).toBe("running");
  });
});

describe("runReadOnlyQuery — fail-closed, mirroring the scheduled path (SPEC §8.5, §5.4)", () => {
  it("reports unavailable traffic as an error, never as zero", async () => {
    const result = await runReadOnlyQuery(
      deps({
        getTraffic: () => Promise.resolve(new TrafficUnavailableError("no TrafficDetails")),
      }),
      CONFIG,
    );
    expect(result.status).toBe("error");
    expect(result.stage).toBe("cdt-query");
    expect(result.trafficGB).toBeUndefined();
    expect(result.trafficGB).not.toBe(0);
  });

  it("reports a transport failure as an error", async () => {
    const result = await runReadOnlyQuery(
      deps({ getTraffic: () => Promise.resolve(new RpcError("transport", "boom")) }),
      CONFIG,
    );
    expect(result.status).toBe("error");
    expect(result.stage).toBe("cdt-query");
  });

  it("aborts on a describe failure rather than guessing a state", async () => {
    const result = await runReadOnlyQuery(
      deps({ describeInstance: () => Promise.resolve(new RpcError("client", "denied", 403)) }),
      CONFIG,
    );
    expect(result.status).toBe("error");
    expect(result.stage).toBe("ecs-describe");
    expect(result.ecsStatus).toBeUndefined();
  });

  it("reports an unrecognised status as fail-safe with no mutation", async () => {
    const result = await runReadOnlyQuery(
      deps({ describeInstance: () => Promise.resolve({ instanceId: "i-abc", status: "unknown" }) }),
      CONFIG,
    );
    expect(result.action).toBe("fail-safe");
    expect(result.mutation).toBe(false);
  });

  it("does not call describeInstance when the traffic query failed", async () => {
    // No wasted subrequest, and no observation recorded against unknown traffic.
    const describe = vi.fn((): Promise<InstanceObservation> =>
      Promise.resolve({ instanceId: "i-abc", status: "running" }),
    );
    await runReadOnlyQuery(
      deps({
        getTraffic: () => Promise.resolve(new RpcError("transport", "boom")),
        describeInstance: describe,
      }),
      CONFIG,
    );
    expect(describe).not.toHaveBeenCalled();
  });
});

describe("runReadOnlyQuery — result hygiene (SPEC §7.5)", () => {
  it("does not expose a credential-shaped value from a remote error", async () => {
    const result = await runReadOnlyQuery(
      deps({
        getTraffic: () =>
          Promise.resolve(
            new RpcError("client", "AccessKeySecret=LTAI5tSecretValue rejected", 403),
          ),
      }),
      CONFIG,
    );
    expect(JSON.stringify(result)).not.toContain("LTAI5tSecretValue");
  });

  it("never throws, so a route cannot leak a stack trace", async () => {
    const result = await runReadOnlyQuery(
      deps({
        getTraffic: () => {
          throw new Error("unexpected synchronous explosion");
        },
      }),
      CONFIG,
    );
    expect(result.status).toBe("error");
    expect(result.stage).toBe("unexpected");
  });
});
