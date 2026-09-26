/**
 * Configuration parsing and validation (SPEC §2).
 *
 * Two properties drive the shape of this module.
 *
 * **Fail closed, before any Alibaba call.** Every rule here exists because its
 * violation would otherwise reach a comparison or a request. A
 * `TRAFFIC_THRESHOLD_GB` that silently became `NaN` produces a comparison that
 * is always false; a coerced `0` produces one that is always true. Neither is
 * observable at the call site.
 *
 * **Redaction is structural, not per call site.** Errors are built from a
 * binding *name* and a rule description, never from the binding's value. There
 * is no helper an author can forget to call: `ConfigError.message` is assembled
 * from literals and names, so a secret value has no path into it. Workers Logs
 * persist by default, which makes this a correctness requirement (PLAN R9).
 */

import type { EcsStatus } from "./aliyun/api";
import type { SignatureVersion } from "./aliyun/signing";

/** Stop mode sent on every stop request. SPEC §6.4. */
export type StoppedMode = "StopCharging" | "KeepCharging";

/**
 * The raw binding surface, as Wrangler supplies it.
 *
 * Every field is optional: Wrangler gives no compile-time guarantee that a
 * declared binding is present, so absence is a runtime condition this module
 * exists to detect.
 */
export interface RawEnv {
  readonly ALIYUN_ACCESS_KEY_ID?: string | undefined;
  readonly ALIYUN_ACCESS_KEY_SECRET?: string | undefined;
  readonly WEBHOOK_URL?: string | undefined;
  readonly WEBHOOK_TOKEN?: string | undefined;
  readonly REGION_ID?: string | undefined;
  readonly ECS_INSTANCE_ID?: string | undefined;
  readonly TRAFFIC_THRESHOLD_GB?: string | undefined;
  readonly CDT_ENDPOINT?: string | undefined;
  readonly BUSINESS_REGION_ID?: string | undefined;
  readonly SIGNATURE_VERSION?: string | undefined;
  readonly STOPPED_MODE?: string | undefined;
  readonly ADMIN_USER?: string | undefined;
  readonly ADMIN_TOKEN?: string | undefined;
  readonly ENABLE_BILLING?: string | undefined;
}

/** Validated, typed configuration. Absent optional values are `undefined`. */
export interface Config {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly webhookUrl: string | undefined;
  readonly webhookToken: string | undefined;
  readonly regionId: string;
  readonly ecsInstanceId: string;
  readonly trafficThresholdGB: number;
  readonly cdtEndpoint: string;
  readonly businessRegionId: string | undefined;
  readonly signatureVersion: SignatureVersion;
  readonly stoppedMode: StoppedMode;
  readonly adminUser: string;
  readonly adminToken: string | undefined;
  readonly enableBilling: boolean;
}

/**
 * A configuration failure.
 *
 * `stage` is fixed to `config` so the pipeline can classify it without
 * inspecting the message. `message` names the offending binding at most, and
 * never contains a value from a secret binding (SPEC §2.4).
 */
export interface ConfigError {
  readonly stage: "config";
  readonly message: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly error: ConfigError };

const DEFAULT_THRESHOLD_GB = 180;
const DEFAULT_CDT_ENDPOINT = "cdt.aliyuncs.com";
const DEFAULT_SIGNATURE_VERSION: SignatureVersion = "v3";
const DEFAULT_STOPPED_MODE: StoppedMode = "KeepCharging";
const DEFAULT_ADMIN_USER = "admin";

function error(message: string): ConfigResult {
  return { ok: false, error: { stage: "config", message } };
}

/** A binding is present only when it is a non-empty, non-whitespace string. */
function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The five secret bindings, by name only.
 *
 * Kept as a list so that a validation message can never be built from their
 * values even accidentally: callers pass the name, and the value is never in
 * scope at the point the message is assembled.
 */
const SECRET_BINDINGS = [
  "ALIYUN_ACCESS_KEY_ID",
  "ALIYUN_ACCESS_KEY_SECRET",
  "WEBHOOK_URL",
  "WEBHOOK_TOKEN",
  "ADMIN_TOKEN",
] as const;

/** Exposed so tests can assert the redaction boundary covers every secret. */
export const SECRET_BINDING_NAMES: readonly string[] = SECRET_BINDINGS;

function isAbsoluteHttpsUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname !== "";
}

/**
 * Parse and validate the Worker environment.
 *
 * Never throws: a configuration failure is a value, not an exception, so the
 * caller cannot accidentally treat a misconfiguration as an operational error
 * and continue.
 */
export function loadConfig(env: RawEnv): ConfigResult {
  // Required bindings. The message names the binding; the value is never read.
  const required: readonly (readonly [string, string | undefined])[] = [
    ["ALIYUN_ACCESS_KEY_ID", env.ALIYUN_ACCESS_KEY_ID],
    ["ALIYUN_ACCESS_KEY_SECRET", env.ALIYUN_ACCESS_KEY_SECRET],
    ["REGION_ID", env.REGION_ID],
    ["ECS_INSTANCE_ID", env.ECS_INSTANCE_ID],
  ];
  for (const [name, value] of required) {
    if (!present(value)) {
      return error(`Required binding ${name} is absent or empty`);
    }
  }

  // Narrowed by the loop above; TypeScript cannot see that, so re-check.
  const accessKeyId = env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = env.ALIYUN_ACCESS_KEY_SECRET;
  const regionId = env.REGION_ID;
  const ecsInstanceId = env.ECS_INSTANCE_ID;
  if (
    !present(accessKeyId) ||
    !present(accessKeySecret) ||
    !present(regionId) ||
    !present(ecsInstanceId)
  ) {
    return error("A required binding was absent or empty");
  }

  const webhookUrl = present(env.WEBHOOK_URL) ? env.WEBHOOK_URL : undefined;
  const webhookToken = present(env.WEBHOOK_TOKEN) ? env.WEBHOOK_TOKEN : undefined;
  if (webhookToken !== undefined && webhookUrl === undefined) {
    return error("WEBHOOK_TOKEN requires WEBHOOK_URL; configure both bindings or neither");
  }

  if (webhookUrl !== undefined && !isAbsoluteHttpsUrl(webhookUrl)) {
    // The URL may carry a token, so it is deliberately not echoed.
    return error("WEBHOOK_URL must be an absolute https:// URL");
  }

  const thresholdRaw = env.TRAFFIC_THRESHOLD_GB;
  let trafficThresholdGB = DEFAULT_THRESHOLD_GB;
  if (present(thresholdRaw)) {
    const parsed = Number(thresholdRaw.trim());
    // `Number("")` is 0 and `Number(" ")` is 0, so an empty string would slip
    // through as a valid zero threshold without the `present` check above.
    if (!Number.isFinite(parsed)) {
      return error("TRAFFIC_THRESHOLD_GB must be a finite number");
    }
    if (parsed <= 0) {
      return error("TRAFFIC_THRESHOLD_GB must be greater than zero");
    }
    trafficThresholdGB = parsed;
  }

  const signatureRaw = env.SIGNATURE_VERSION;
  let signatureVersion = DEFAULT_SIGNATURE_VERSION;
  if (present(signatureRaw)) {
    if (signatureRaw !== "v2" && signatureRaw !== "v3") {
      return error("SIGNATURE_VERSION must be one of: v2, v3");
    }
    signatureVersion = signatureRaw;
  }

  const stoppedModeRaw = env.STOPPED_MODE;
  let stoppedMode = DEFAULT_STOPPED_MODE;
  if (present(stoppedModeRaw)) {
    if (stoppedModeRaw !== "StopCharging" && stoppedModeRaw !== "KeepCharging") {
      return error("STOPPED_MODE must be one of: StopCharging, KeepCharging");
    }
    stoppedMode = stoppedModeRaw;
  }

  return {
    ok: true,
    config: {
      accessKeyId,
      accessKeySecret,
      webhookUrl,
      webhookToken,
      regionId,
      ecsInstanceId,
      trafficThresholdGB,
      cdtEndpoint: present(env.CDT_ENDPOINT) ? env.CDT_ENDPOINT : DEFAULT_CDT_ENDPOINT,
      businessRegionId: present(env.BUSINESS_REGION_ID) ? env.BUSINESS_REGION_ID : undefined,
      signatureVersion,
      stoppedMode,
      adminUser: present(env.ADMIN_USER) ? env.ADMIN_USER : DEFAULT_ADMIN_USER,
      adminToken: present(env.ADMIN_TOKEN) ? env.ADMIN_TOKEN : undefined,
      enableBilling:
        typeof env.ENABLE_BILLING === "string" &&
        ["1", "true", "yes"].includes(env.ENABLE_BILLING.trim().toLowerCase()),
    },
  };
}

/**
 * `EcsStatus` is re-exported here only so consumers of `Config` can name the
 * status type without importing the Alibaba module directly.
 */
export type { EcsStatus };
