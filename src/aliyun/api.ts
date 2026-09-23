import { z } from "zod";

import type { CallRpcOptions, FetchLike, RpcError } from "./rpc";
import { callRpc } from "./rpc";
import type { SignatureVersion } from "./signing";

/**
 * Typed Alibaba Cloud operations used by one run.
 *
 * Every response is parsed rather than asserted. `ListCdtInternetTraffic` is an
 * undocumented operation, so its shape is owned by this project and treated as
 * fully optional; a value that cannot be established is an error, never a
 * default. Getting that wrong is the difference between enforcing a threshold
 * and mutating an instance based on a fabricated zero.
 */

export const CDT_API_VERSION = "2021-08-13";
export const ECS_API_VERSION = "2014-05-26";

/** Normalised instance status. SPEC §6.1. */
export type EcsStatus = "running" | "starting" | "stopping" | "stopped" | "pending" | "unknown";

/**
 * Mapping from the API's `Status` values. Absent, non-string, and unrecognised
 * values all normalise to `unknown`, which is a fail-safe trigger rather than a
 * benign default.
 */
const ECS_STATUS_BY_API: Record<string, EcsStatus> = {
  Running: "running",
  Starting: "starting",
  Stopping: "stopping",
  Stopped: "stopped",
  Pending: "pending",
};

export function normaliseEcsStatus(value: unknown): EcsStatus {
  if (typeof value !== "string") return "unknown";
  return ECS_STATUS_BY_API[value] ?? "unknown";
}

/**
 * One entry of `TrafficDetails`.
 *
 * All fields optional and unknown-tolerant, per SPEC §5.2. `Traffic` is
 * validated separately rather than by the schema so that a present-but-invalid
 * value is reported precisely, instead of collapsing into "field absent".
 */
const TrafficDetail = z
  .object({
    BusinessRegionId: z.string().optional(),
    ISPType: z.string().optional(),
    Traffic: z.unknown().optional(),
  })
  .passthrough();

const CdtResponse = z
  .object({
    RequestId: z.string().optional(),
    TrafficDetails: z.unknown().optional(),
  })
  .passthrough();

/** Per-region breakdown, retained so the summation scope stays auditable. */
export interface TrafficBreakdownEntry {
  readonly businessRegionId: string | undefined;
  readonly ispType: string | undefined;
  readonly bytes: number | undefined;
}

export interface TrafficReading {
  /**
   * Sum over every `TrafficDetails` entry, in the unit the API reports.
   *
   * **ASSUMPTION (PLAN R4, SPEC §3):** this is treated as **bytes**. No Alibaba
   * prose source states the unit — it is inferred from the SDK's `long` typing
   * and from independent implementations. The unit MUST be verified against the
   * Alibaba console before enforcement is trusted. It is never implicit: the
   * byte→GB boundary is crossed in exactly one named function
   * (`trafficBytesToDecimalGb`), so a corrected unit changes one line.
   */
  readonly totalBytes: number;
  readonly entries: readonly TrafficBreakdownEntry[];
}

/**
 * Bytes in one decimal gigabyte, per SPEC §3.
 *
 * **ASSUMPTION (PLAN R4):** the divisor assumes `Traffic` is reported in bytes.
 * See `TrafficReading.totalBytes` — the unit is SDK-derived, not documented.
 *
 * Decimal (`1000^3`), **not** binary (`1024^3`). This is a deliberate divergence
 * from the originating script and both independent reference implementations:
 * 180 GB decimal is 167.6 GiB, so enforcement trips earlier for the same byte
 * count. The divergence MUST NOT be silently "corrected" back to `1024^3`
 * (PLAN R5).
 */
export const BYTES_PER_DECIMAL_GB = 1_000_000_000;

/**
 * Convert a byte total to decimal GB (SPEC §3).
 *
 * The **only** place the byte→GB boundary is crossed. Summation stays in integer
 * byte space and conversion happens exactly once, at the end, so no per-entry
 * rounding can drift the total.
 *
 * Throws `TrafficUnavailableError` for a non-finite or negative input rather
 * than returning a number: `NaN / 1e9` is still `NaN`, and a caller that
 * compared `NaN` against a threshold would take the "under threshold" branch.
 * Unavailable traffic must never become a value that can be compared.
 */
export function trafficBytesToDecimalGb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new TrafficUnavailableError("Traffic bytes were not a finite non-negative number");
  }
  return bytes / BYTES_PER_DECIMAL_GB;
}

/**
 * Why a reading could not be established.
 *
 * Distinct from a numeric result: callers must branch on this rather than
 * substituting a default.
 */
export class TrafficUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrafficUnavailableError";
  }
}

/**
 * Coerce a `Traffic` field to a finite non-negative number.
 *
 * The API returns `Traffic` as a long, but an undocumented endpoint that may
 * return it as a string is exactly the case this guards. `""`, `null`, and
 * non-numeric strings are rejected rather than treated as zero.
 */
function toTrafficBytes(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * Reduce a CDT response to a single byte total. SPEC §5.3, validated per §5.4.
 *
 * Throws `TrafficUnavailableError` for every invalid case rather than returning
 * `0`, including an empty `TrafficDetails` array: zero traffic and unavailable
 * traffic are different facts, and only one of them is safe to infer.
 */
export function reduceTraffic(response: unknown): TrafficReading {
  const parsed = CdtResponse.safeParse(response);
  if (!parsed.success) {
    throw new TrafficUnavailableError("CDT response was not a JSON object");
  }

  const details = parsed.data.TrafficDetails;
  if (details === undefined || details === null) {
    throw new TrafficUnavailableError("CDT response had no TrafficDetails");
  }
  if (!Array.isArray(details)) {
    throw new TrafficUnavailableError("CDT TrafficDetails was not an array");
  }
  if (details.length === 0) {
    // Fail closed: see SPEC §5.5. A legitimately zero-traffic account is
    // expected to still report its regions.
    throw new TrafficUnavailableError("CDT TrafficDetails was empty");
  }

  const entries: TrafficBreakdownEntry[] = [];
  let total = 0;

  for (const raw of details) {
    const entry = TrafficDetail.safeParse(raw);
    if (!entry.success) {
      throw new TrafficUnavailableError("CDT TrafficDetails contained a non-object entry");
    }
    const bytes = toTrafficBytes(entry.data.Traffic);
    if (bytes === undefined) {
      throw new TrafficUnavailableError(
        "CDT TrafficDetails entry had a missing, non-numeric, or negative Traffic value",
      );
    }
    total += bytes;
    entries.push({
      businessRegionId: entry.data.BusinessRegionId,
      ispType: entry.data.ISPType,
      bytes,
    });
  }

  if (!Number.isFinite(total) || total < 0) {
    throw new TrafficUnavailableError("CDT traffic total was not a finite non-negative number");
  }

  return { totalBytes: total, entries };
}

/** Options shared by every operation. */
export interface ApiContext {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  /**
   * Signature generation to use. Defaults to V3.
   *
   * Threaded through to `callRpc` because SPEC §4.1 requires the method be
   * selectable by configuration: the target CDT operation is undocumented, so
   * the accepted signature generation cannot be confirmed from documentation and
   * switching to V2 must be a configuration change rather than a refactor.
   * Without this, `SIGNATURE_VERSION` validated successfully and then had no
   * effect — it was silently ignored.
   */
  readonly signatureVersion?: SignatureVersion | undefined;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike | undefined;
  readonly now?: (() => number) | undefined;
  readonly nonce?: (() => string) | undefined;
}

function rpcOptions(
  context: ApiContext,
  endpoint: string,
  action: string,
  version: string,
  parameters: Readonly<Record<string, string>>,
): CallRpcOptions {
  return {
    endpoint,
    action,
    version,
    accessKeyId: context.accessKeyId,
    accessKeySecret: context.accessKeySecret,
    // Threaded through so a configured signature generation actually takes
    // effect; omitting it made SIGNATURE_VERSION a validated no-op (SPEC §4.1).
    // Spread rather than assigned because `exactOptionalPropertyTypes` treats an
    // explicit `undefined` as different from an absent key.
    ...(context.signatureVersion === undefined
      ? {}
      : { signatureVersion: context.signatureVersion }),
    parameters,
    fetch: context.fetch,
    now: context.now,
    nonce: context.nonce,
  };
}

export interface ListTrafficOptions extends ApiContext {
  readonly endpoint: string;
  /** Sent only when configured; never used to filter the response. SPEC §5.1. */
  readonly businessRegionId?: string | undefined;
}

/**
 * Query CDT internet traffic for the account.
 *
 * `BusinessRegionId` is a request parameter, not a client-side filter: the sum
 * always reflects what the API returned. SPEC §5.1.
 *
 * Validation failures are returned, not thrown: a `TrafficUnavailableError` in
 * the result is the signal that traffic could not be established, and every
 * caller must handle it by aborting rather than by substituting a value.
 */
export async function listCdtInternetTraffic(
  options: ListTrafficOptions,
): Promise<TrafficReading | RpcError | TrafficUnavailableError> {
  const parameters: Record<string, string> = {};
  if (options.businessRegionId !== undefined && options.businessRegionId !== "") {
    parameters.BusinessRegionId = options.businessRegionId;
  }

  const result = await callRpc(
    rpcOptions(options, options.endpoint, "ListCdtInternetTraffic", CDT_API_VERSION, parameters),
  );
  if (!result.ok) return result.error;
  try {
    return reduceTraffic(result.data);
  } catch (cause) {
    if (cause instanceof TrafficUnavailableError) return cause;
    throw cause;
  }
}

const EcsInstance = z
  .object({
    InstanceId: z.string().optional(),
    Status: z.unknown().optional(),
  })
  .passthrough();

const DescribeInstancesResponse = z
  .object({
    Instances: z.object({ Instance: z.unknown().optional() }).passthrough().optional(),
  })
  .passthrough();

/** A described instance. `status` is `unknown` when it could not be established. */
export interface InstanceObservation {
  readonly instanceId: string;
  readonly status: EcsStatus;
}

export interface DescribeInstanceOptions extends ApiContext {
  readonly regionId: string;
  readonly instanceId: string;
}

/**
 * Describe the managed instance. SPEC §6.1.
 *
 * A missing instance is an error, not a `stopped` reading: absence is not
 * evidence of state, and acting on it would be exactly the class of guess the
 * fail-safe rule exists to prevent.
 */
export async function describeInstance(
  options: DescribeInstanceOptions,
): Promise<InstanceObservation | RpcError | TrafficUnavailableError> {
  const result = await callRpc(
    rpcOptions(
      options,
      `ecs.${options.regionId}.aliyuncs.com`,
      "DescribeInstances",
      ECS_API_VERSION,
      {
        InstanceIds: JSON.stringify([options.instanceId]),
        RegionId: options.regionId,
      },
    ),
  );
  if (!result.ok) return result.error;

  const parsed = DescribeInstancesResponse.safeParse(result.data);
  if (!parsed.success) {
    return new TrafficUnavailableError("DescribeInstances response was not a JSON object");
  }

  const raw = parsed.data.Instances?.Instance;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];

  for (const candidate of list) {
    const instance = EcsInstance.safeParse(candidate);
    if (!instance.success) continue;
    if (instance.data.InstanceId !== options.instanceId) continue;
    return {
      instanceId: options.instanceId,
      status: normaliseEcsStatus(instance.data.Status),
    };
  }

  // Present in neither form: the managed instance could not be observed.
  return new TrafficUnavailableError(
    `DescribeInstances did not return instance ${options.instanceId}`,
  );
}

/** Options for a mutating call. */
export interface MutateInstanceOptions extends ApiContext {
  readonly regionId: string;
  readonly instanceId: string;
}

export interface StartInstanceOptions extends MutateInstanceOptions {
  /** Stop mode request is not sent on start; present for symmetry of call sites. */
  readonly stoppedMode?: never;
}

/**
 * Request a start. SPEC §6.3.
 *
 * The caller is responsible for having observed a `stopped` instance first;
 * this function performs no checking and no retry beyond `callRpc`'s transport
 * rule.
 */
export async function startInstance(
  options: StartInstanceOptions,
): Promise<{ readonly requested: true } | RpcError> {
  const result = await callRpc(
    rpcOptions(options, `ecs.${options.regionId}.aliyuncs.com`, "StartInstance", ECS_API_VERSION, {
      InstanceId: options.instanceId,
    }),
  );
  return result.ok ? { requested: true } : result.error;
}

export interface StopInstanceOptions extends MutateInstanceOptions {
  /**
   * Sent on every stop request. Never treated as evidence that the mode took
   * effect: Alibaba returns no error when an instance does not support
   * economical mode and silently stops under its priority mode instead.
   * SPEC §6.4.
   */
  readonly stoppedMode: "KeepCharging" | "StopCharging";
}

/**
 * Request a stop. SPEC §6.3, §6.4.
 *
 * `ForceStop` is pinned to `false` and is not a parameter: force-stopping risks
 * filesystem corruption, and exposing the flag would invite setting it.
 */
export async function stopInstance(
  options: StopInstanceOptions,
): Promise<{ readonly requested: true } | RpcError> {
  const result = await callRpc(
    rpcOptions(options, `ecs.${options.regionId}.aliyuncs.com`, "StopInstance", ECS_API_VERSION, {
      ForceStop: "false",
      InstanceId: options.instanceId,
      StoppedMode: options.stoppedMode,
    }),
  );
  return result.ok ? { requested: true } : result.error;
}
