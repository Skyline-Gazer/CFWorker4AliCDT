import { describe, expect, it } from "vitest";

import {
  describeInstance,
  listCdtInternetTraffic,
  normaliseEcsStatus,
  reduceTraffic,
  startInstance,
  stopInstance,
  trafficBytesToDecimalGb,
  TrafficUnavailableError,
} from "../../src/aliyun/api";
import type { ApiContext } from "../../src/aliyun/api";
import type { FetchLike } from "../../src/aliyun/rpc";
import { RpcError } from "../../src/aliyun/rpc";

/**
 * Typed operation tests.
 *
 * The reductions and normalisations here decide whether an instance is mutated,
 * so the fail-closed cases carry the weight: every one of them must refuse to
 * produce a number rather than defaulting to zero.
 */

const CONTEXT: ApiContext = {
  accessKeyId: "AKID",
  accessKeySecret: "SECRET",
  now: () => Date.parse("2026-09-20T08:00:00Z"),
  nonce: () => "0".repeat(32),
};

function stubFetch(responses: readonly (Response | Error)[]): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next!.clone());
  };
  return { fetch: fetchImpl, calls };
}

/** The body as a string. `RequestInit.body` is `BodyInit | null`; every call
 * here sets a string, so narrow once rather than widening at each assertion. */
function sentBody(call: { init: RequestInit } | undefined): string {
  const body = call?.init.body;
  if (typeof body !== "string") throw new Error("expected a string request body");
  return body;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("normaliseEcsStatus", () => {
  it.each([
    ["Running", "running"],
    ["Stopped", "stopped"],
    ["Starting", "starting"],
    ["Stopping", "stopping"],
    ["Pending", "pending"],
  ])("maps %s to %s", (input, expected) => {
    expect(normaliseEcsStatus(input)).toBe(expected);
  });

  it.each([[undefined], [null], [""], ["running"], ["Failed"], [7], [{}], [[]]])(
    "maps unrecognised value %p to unknown",
    (input) => {
      // Any of these reaching the decision step must produce a fail-safe, not a
      // benign default.
      expect(normaliseEcsStatus(input)).toBe("unknown");
    },
  );
});

describe("reduceTraffic", () => {
  it("sums a single entry", () => {
    expect(reduceTraffic({ TrafficDetails: [{ Traffic: 4_000_000_000 }] }).totalBytes).toBe(
      4_000_000_000,
    );
  });

  it("sums every entry, including mixed regions and ISPs", () => {
    const reading = reduceTraffic({
      TrafficDetails: [
        { BusinessRegionId: "cn-hongkong", ISPType: "CMI", Traffic: 100 },
        { BusinessRegionId: "cn-hongkong", ISPType: "CT", Traffic: 250 },
        { BusinessRegionId: "cn-beijing", Traffic: 3 },
      ],
    });
    expect(reading.totalBytes).toBe(353);
    expect(reading.entries).toHaveLength(3);
  });

  it("retains the per-region breakdown for auditing", () => {
    const reading = reduceTraffic({
      TrafficDetails: [{ BusinessRegionId: "cn-hongkong", ISPType: "CMI", Traffic: 42 }],
    });
    expect(reading.entries[0]).toEqual({
      businessRegionId: "cn-hongkong",
      ispType: "CMI",
      bytes: 42,
    });
  });

  it("accepts zero as a genuine reading", () => {
    // Zero from a present, valid entry is a fact, unlike an empty array.
    expect(reduceTraffic({ TrafficDetails: [{ Traffic: 0 }] }).totalBytes).toBe(0);
  });

  it("accepts a numeric string, since the field type is not guaranteed", () => {
    expect(reduceTraffic({ TrafficDetails: [{ Traffic: "12345" }] }).totalBytes).toBe(12345);
  });

  it("tolerates additional unknown fields and a missing RequestId", () => {
    const reading = reduceTraffic({
      Extra: { nested: true },
      TrafficDetails: [
        { NewField: "x", Traffic: 5, TrafficTierDetails: [{ Tier: 1 }], ProductTrafficDetails: [] },
      ],
    });
    expect(reading.totalBytes).toBe(5);
  });

  describe("fails closed", () => {
    const invalid: readonly [string, unknown][] = [
      ["TrafficDetails absent", {}],
      ["TrafficDetails null", { TrafficDetails: null }],
      ["TrafficDetails not an array", { TrafficDetails: { Traffic: 1 } }],
      ["TrafficDetails a string", { TrafficDetails: "100" }],
      ["TrafficDetails empty", { TrafficDetails: [] }],
      ["Traffic absent", { TrafficDetails: [{}] }],
      ["Traffic null", { TrafficDetails: [{ Traffic: null }] }],
      ["Traffic empty string", { TrafficDetails: [{ Traffic: "" }] }],
      ["Traffic whitespace", { TrafficDetails: [{ Traffic: "   " }] }],
      ["Traffic non-numeric string", { TrafficDetails: [{ Traffic: "many" }] }],
      ["Traffic NaN", { TrafficDetails: [{ Traffic: Number.NaN }] }],
      ["Traffic Infinity", { TrafficDetails: [{ Traffic: Number.POSITIVE_INFINITY }] }],
      ["Traffic negative", { TrafficDetails: [{ Traffic: -1 }] }],
      ["Traffic a boolean", { TrafficDetails: [{ Traffic: true }] }],
      ["Traffic an object", { TrafficDetails: [{ Traffic: {} }] }],
      ["entry is a string", { TrafficDetails: ["100"] }],
      ["entry is null", { TrafficDetails: [null] }],
      [
        "one entry invalid among valid ones",
        { TrafficDetails: [{ Traffic: 1 }, { Traffic: "x" }] },
      ],
      ["body is not an object", "nope"],
      ["body is an array", [1, 2, 3]],
      ["body is null", null],
    ];

    it.each(invalid)("rejects %s", (_label, input) => {
      expect(() => reduceTraffic(input)).toThrow(TrafficUnavailableError);
    });

    it("rejects one invalid entry among valid ones rather than summing the rest", () => {
      // The dangerous partial case: silently dropping the bad entry would
      // under-report traffic and could start an instance that should stop.
      expect(() =>
        reduceTraffic({ TrafficDetails: [{ Traffic: 900 }, { Traffic: "bad" }] }),
      ).toThrow(TrafficUnavailableError);
    });
  });
});

describe("trafficBytesToDecimalGb", () => {
  // The threshold is expressed in decimal GB (10^9 bytes), a deliberate
  // divergence from the 1024^3 GiB used by the prior script and both reference
  // implementations (PLAN R5, SPEC §3). These tests pin the decimal divisor and
  // the exact boundary behaviour.

  it("converts exact decimal-GB multiples", () => {
    expect(trafficBytesToDecimalGb(1_000_000_000)).toBe(1);
    expect(trafficBytesToDecimalGb(180_000_000_000)).toBe(180);
    expect(trafficBytesToDecimalGb(0)).toBe(0);
  });

  it("divides by 1e9, never by 1024^3", () => {
    // A GiB divisor would yield ~0.931 for exactly 1e9 bytes. Asserting the
    // decimal result makes a silent switch to 1024^3 fail here.
    expect(trafficBytesToDecimalGb(1_000_000_000)).toBe(1);
    expect(trafficBytesToDecimalGb(1_000_000_000)).not.toBeCloseTo(1_000_000_000 / 1024 ** 3, 5);
    expect(trafficBytesToDecimalGb(107_374_182_400)).not.toBe(100);
  });

  it("is exact at the threshold boundary inputs chosen by the decision tests", () => {
    // The boundary values used by the P4 action matrix must be exact in binary
    // floating point so threshold tests assert real behaviour, not FP noise.
    for (const gb of [0, 1, 2, 100, 180]) {
      expect(trafficBytesToDecimalGb(gb * 1_000_000_000)).toBe(gb);
    }
  });

  it("converts a partial gigabyte proportionally", () => {
    expect(trafficBytesToDecimalGb(500_000_000)).toBe(0.5);
    expect(trafficBytesToDecimalGb(1)).toBe(1e-9);
  });

  it("rejects value that is not a finite non-negative number", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      expect(() => trafficBytesToDecimalGb(bad)).toThrow(TrafficUnavailableError);
    }
  });
});

describe("TrafficReading — unit conversion (SPEC §3)", () => {
  it("exposes the reading in decimal GB alongside bytes", () => {
    const reading = reduceTraffic({ TrafficDetails: [{ Traffic: 180_000_000_000 }] });
    expect(reading.totalBytes).toBe(180_000_000_000);
    expect(trafficBytesToDecimalGb(reading.totalBytes)).toBe(180);
  });

  it("keeps summation in integer space: no per-entry rounding to GB", () => {
    // Three × 333_333_333 bytes = 999_999_999 bytes ≈ 0.999999999 GB. Converting
    // per entry then summing would drift; summing bytes then converting does not.
    const reading = reduceTraffic({
      TrafficDetails: [
        { Traffic: 333_333_333 },
        { Traffic: 333_333_333 },
        { Traffic: 333_333_333 },
      ],
    });
    expect(reading.totalBytes).toBe(999_999_999);
    expect(trafficBytesToDecimalGb(reading.totalBytes)).toBeCloseTo(0.999999999, 9);
  });

  it("never converts unknown traffic to zero", () => {
    // An unavailable reading throws before any conversion can occur.
    expect(() => reduceTraffic({ TrafficDetails: [] })).toThrow(TrafficUnavailableError);
  });
});

describe("listCdtInternetTraffic", () => {
  it("calls the CDT endpoint with the documented version and action", async () => {
    const { fetch, calls } = stubFetch([json({ TrafficDetails: [{ Traffic: 7 }] })]);
    await listCdtInternetTraffic({ ...CONTEXT, endpoint: "cdt.aliyuncs.com", fetch });
    expect(calls[0]?.url).toBe("https://cdt.aliyuncs.com/");
    expect(sentBody(calls[0])).toContain("Action=ListCdtInternetTraffic");
    expect(sentBody(calls[0])).toContain("Version=2021-08-13");
  });

  it("omits BusinessRegionId when not configured", async () => {
    const { fetch, calls } = stubFetch([json({ TrafficDetails: [{ Traffic: 7 }] })]);
    await listCdtInternetTraffic({ ...CONTEXT, endpoint: "cdt.aliyuncs.com", fetch });
    expect(sentBody(calls[0])).not.toContain("BusinessRegionId");
  });

  it("omits BusinessRegionId when empty", async () => {
    const { fetch, calls } = stubFetch([json({ TrafficDetails: [{ Traffic: 7 }] })]);
    await listCdtInternetTraffic({
      ...CONTEXT,
      endpoint: "cdt.aliyuncs.com",
      businessRegionId: "",
      fetch,
    });
    expect(sentBody(calls[0])).not.toContain("BusinessRegionId");
  });

  it("sends BusinessRegionId when configured", async () => {
    const { fetch, calls } = stubFetch([json({ TrafficDetails: [{ Traffic: 7 }] })]);
    await listCdtInternetTraffic({
      ...CONTEXT,
      endpoint: "cdt.aliyuncs.com",
      businessRegionId: "cn-hongkong",
      fetch,
    });
    expect(sentBody(calls[0])).toContain("BusinessRegionId=cn-hongkong");
  });

  it("never sends pagination parameters", async () => {
    // The operation has none; sending them would imply an expectation the API
    // does not honour. SPEC §5.1.
    const { fetch, calls } = stubFetch([json({ TrafficDetails: [{ Traffic: 7 }] })]);
    await listCdtInternetTraffic({ ...CONTEXT, endpoint: "cdt.aliyuncs.com", fetch });
    const body = sentBody(calls[0]);
    expect(body).not.toMatch(/Page|PageSize|NextToken|MaxResults/i);
  });

  it("returns a reading on success", async () => {
    const { fetch } = stubFetch([json({ TrafficDetails: [{ Traffic: 1 }, { Traffic: 2 }] })]);
    const result = await listCdtInternetTraffic({
      ...CONTEXT,
      endpoint: "cdt.aliyuncs.com",
      fetch,
    });
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toMatchObject({ totalBytes: 3 });
  });

  it("returns the transport error rather than a reading on API failure", async () => {
    const { fetch } = stubFetch([json({ Code: "InvalidParameter" }, 400)]);
    const result = await listCdtInternetTraffic({
      ...CONTEXT,
      endpoint: "cdt.aliyuncs.com",
      fetch,
    });
    expect(result).toBeInstanceOf(RpcError);
  });

  it("returns an error rather than zero when the body is unusable", async () => {
    // The central invariant: unavailable traffic is never reported as zero.
    const { fetch } = stubFetch([json({})]);
    const result = await listCdtInternetTraffic({
      ...CONTEXT,
      endpoint: "cdt.aliyuncs.com",
      fetch,
    });
    expect(result).toBeInstanceOf(TrafficUnavailableError);
    expect(result).not.toMatchObject({ totalBytes: 0 });
  });
});

describe("describeInstance", () => {
  const OPTIONS = { ...CONTEXT, regionId: "cn-hongkong", instanceId: "i-abc" };

  it("targets the region-specific ECS endpoint", async () => {
    const { fetch, calls } = stubFetch([
      json({ Instances: { Instance: [{ InstanceId: "i-abc", Status: "Running" }] } }),
    ]);
    await describeInstance({ ...OPTIONS, fetch });
    expect(calls[0]?.url).toBe("https://ecs.cn-hongkong.aliyuncs.com/");
    expect(sentBody(calls[0])).toContain("Action=DescribeInstances");
    expect(sentBody(calls[0])).toContain("Version=2014-05-26");
  });

  it("passes the instance id as a JSON array string", async () => {
    const { fetch, calls } = stubFetch([
      json({ Instances: { Instance: [{ InstanceId: "i-abc", Status: "Running" }] } }),
    ]);
    await describeInstance({ ...OPTIONS, fetch });
    expect(sentBody(calls[0])).toContain(`InstanceIds=${encodeURIComponent('["i-abc"]')}`);
  });

  it("observes a running instance", async () => {
    const { fetch } = stubFetch([
      json({ Instances: { Instance: [{ InstanceId: "i-abc", Status: "Running" }] } }),
    ]);
    expect(await describeInstance({ ...OPTIONS, fetch })).toMatchObject({ status: "running" });
  });

  it("accepts a single instance object rather than an array", async () => {
    const { fetch } = stubFetch([
      json({ Instances: { Instance: { InstanceId: "i-abc", Status: "Stopped" } } }),
    ]);
    expect(await describeInstance({ ...OPTIONS, fetch })).toMatchObject({ status: "stopped" });
  });

  it("selects the managed instance from a list containing others", async () => {
    const { fetch } = stubFetch([
      json({
        Instances: {
          Instance: [
            { InstanceId: "i-other", Status: "Running" },
            { InstanceId: "i-abc", Status: "Stopped" },
          ],
        },
      }),
    ]);
    expect(await describeInstance({ ...OPTIONS, fetch })).toMatchObject({
      instanceId: "i-abc",
      status: "stopped",
    });
  });

  it("normalises an unrecognised status to unknown", async () => {
    const { fetch } = stubFetch([
      json({ Instances: { Instance: [{ InstanceId: "i-abc", Status: "Migrating" }] } }),
    ]);
    expect(await describeInstance({ ...OPTIONS, fetch })).toMatchObject({ status: "unknown" });
  });

  it("reports a missing instance as an error, not as stopped", async () => {
    // Absence is not evidence of state. Acting on it would start or stop an
    // instance based on a reading that does not exist.
    const { fetch } = stubFetch([json({ Instances: { Instance: [] } })]);
    const result = await describeInstance({ ...OPTIONS, fetch });
    expect(result).toBeInstanceOf(TrafficUnavailableError);
    expect(result).not.toMatchObject({ status: "stopped" });
  });

  it("reports a missing Instances container as an error", async () => {
    const { fetch } = stubFetch([json({ RequestId: "x" })]);
    expect(await describeInstance({ ...OPTIONS, fetch })).toBeInstanceOf(TrafficUnavailableError);
  });

  it("reports an instance whose id does not match as an error", async () => {
    const { fetch } = stubFetch([
      json({ Instances: { Instance: [{ InstanceId: "i-other", Status: "Running" }] } }),
    ]);
    expect(await describeInstance({ ...OPTIONS, fetch })).toBeInstanceOf(TrafficUnavailableError);
  });

  it("returns the transport error on API failure", async () => {
    const { fetch } = stubFetch([json({ Code: "InvalidInstanceId" }, 400)]);
    expect(await describeInstance({ ...OPTIONS, fetch })).toBeInstanceOf(RpcError);
  });
});

describe("startInstance", () => {
  const OPTIONS = { ...CONTEXT, regionId: "cn-hongkong", instanceId: "i-abc" };

  it("sends InstanceId and nothing destructive", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "ok" })]);
    await startInstance({ ...OPTIONS, fetch });
    const body = sentBody(calls[0]);
    expect(body).toContain("Action=StartInstance");
    expect(body).toContain("InstanceId=i-abc");
    expect(body).not.toContain("ForceStop");
    expect(body).not.toContain("StoppedMode");
  });

  it("reports the request as made", async () => {
    const { fetch } = stubFetch([json({ Code: "ok" })]);
    expect(await startInstance({ ...OPTIONS, fetch })).toEqual({ requested: true });
  });

  it("does not retry a 4xx, so a rejected start is not repeated", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "OperationDenied.NoStock" }, 403)]);
    const result = await startInstance({ ...OPTIONS, fetch });
    expect(result).toBeInstanceOf(RpcError);
    expect(calls).toHaveLength(1);
  });
});

describe("stopInstance", () => {
  const OPTIONS = { ...CONTEXT, regionId: "cn-hongkong", instanceId: "i-abc" } as const;

  it("pins ForceStop to false", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "ok" })]);
    await stopInstance({ ...OPTIONS, stoppedMode: "KeepCharging", fetch });
    expect(sentBody(calls[0])).toContain("ForceStop=false");
  });

  it("sends the configured StoppedMode", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "ok" })]);
    await stopInstance({ ...OPTIONS, stoppedMode: "KeepCharging", fetch });
    expect(sentBody(calls[0])).toContain("StoppedMode=KeepCharging");
  });

  it("sends StopCharging when configured, without changing anything else", async () => {
    const { fetch, calls } = stubFetch([json({ Code: "ok" })]);
    await stopInstance({ ...OPTIONS, stoppedMode: "StopCharging", fetch });
    expect(sentBody(calls[0])).toContain("StoppedMode=StopCharging");
    expect(sentBody(calls[0])).toContain("ForceStop=false");
  });

  it("reports the request as made, not as applied", async () => {
    // Alibaba returns success even when StoppedMode is unsupported and silently
    // ignored, so the result must not claim the mode took effect. SPEC §6.4.
    const { fetch } = stubFetch([json({ Code: "ok" })]);
    const result = await stopInstance({ ...OPTIONS, stoppedMode: "KeepCharging", fetch });
    expect(result).toEqual({ requested: true });
    expect(result).not.toMatchObject({ applied: true, stopped: true });
  });

  it("returns the transport error when the stop is rejected", async () => {
    const { fetch } = stubFetch([json({ Code: "IncorrectInstanceStatus" }, 400)]);
    expect(await stopInstance({ ...OPTIONS, stoppedMode: "KeepCharging", fetch })).toBeInstanceOf(
      RpcError,
    );
  });
});
