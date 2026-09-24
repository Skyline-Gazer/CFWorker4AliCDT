import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config";
import type { RawEnv } from "../src/config";

/**
 * Configuration parsing and validation (SPEC §2).
 *
 * Validation happens once, before any network call, and fails closed. A
 * `TRAFFIC_THRESHOLD_GB` that silently became `NaN`, or an absent
 * `ECS_INSTANCE_ID`, would otherwise produce a comparison that is always false
 * or a call against the wrong resource.
 *
 * The secret-hygiene tests matter as much as the validation ones: a config error
 * is the one place an operator is most likely to have a raw binding value in
 * scope, and Workers Logs persist by default (PLAN R9).
 */

/** A fully valid environment. Each test overrides one field to isolate a rule. */
const VALID: RawEnv = {
  ALIYUN_ACCESS_KEY_ID: "AKID",
  ALIYUN_ACCESS_KEY_SECRET: "SECRET",
  REGION_ID: "cn-hongkong",
  ECS_INSTANCE_ID: "i-abc123",
};

describe("loadConfig — defaults (SPEC §2.2)", () => {
  it("applies every documented default", () => {
    const result = loadConfig(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.trafficThresholdGB).toBe(180);
    expect(result.config.cdtEndpoint).toBe("cdt.aliyuncs.com");
    expect(result.config.signatureVersion).toBe("v3");
    expect(result.config.stoppedMode).toBe("KeepCharging");
    expect(result.config.businessRegionId).toBeUndefined();
    expect(result.config.adminUser).toBe("admin");
  });

  it("populates required fields from the environment", () => {
    const result = loadConfig(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.regionId).toBe("cn-hongkong");
    expect(result.config.ecsInstanceId).toBe("i-abc123");
    expect(result.config.webhookUrl).toBeUndefined();
    expect(result.config.webhookToken).toBeUndefined();
  });

  it("honours overrides for every optional binding", () => {
    const result = loadConfig({
      ...VALID,
      TRAFFIC_THRESHOLD_GB: "250",
      CDT_ENDPOINT: "cdt.example.test",
      SIGNATURE_VERSION: "v2",
      STOPPED_MODE: "StopCharging",
      BUSINESS_REGION_ID: "cn-hongkong",
      ADMIN_USER: "operator",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.trafficThresholdGB).toBe(250);
    expect(result.config.cdtEndpoint).toBe("cdt.example.test");
    expect(result.config.signatureVersion).toBe("v2");
    expect(result.config.stoppedMode).toBe("StopCharging");
    expect(result.config.businessRegionId).toBe("cn-hongkong");
    expect(result.config.adminUser).toBe("operator");
  });
});

describe("loadConfig — required bindings (SPEC §2.4)", () => {
  const required = [
    "ALIYUN_ACCESS_KEY_ID",
    "ALIYUN_ACCESS_KEY_SECRET",
    "REGION_ID",
    "ECS_INSTANCE_ID",
  ] as const;

  it.each(required)("rejects an absent %s", (key) => {
    const env: Record<string, string | undefined> = { ...VALID };
    const withoutKey = Object.fromEntries(
      Object.entries(env).filter(([name]) => name !== key),
    ) as RawEnv;
    const result = loadConfig(withoutKey);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe("config");
  });

  it.each(required)("rejects an empty %s", (key) => {
    const result = loadConfig({ ...VALID, [key]: "" });
    expect(result.ok).toBe(false);
  });
});

describe("loadConfig — TRAFFIC_THRESHOLD_GB (SPEC §2.4)", () => {
  const invalid = ["abc", "NaN", "Infinity", "-1", "0", "-0.5", "1e", " 12abc "];

  it.each(invalid)("rejects %o as a config error", (value) => {
    const result = loadConfig({ ...VALID, TRAFFIC_THRESHOLD_GB: value });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe("config");
  });

  it("never coerces an invalid threshold to zero", () => {
    // A coerced 0 would make every comparison `traffic >= 0` true, stopping the
    // instance permanently.
    const result = loadConfig({ ...VALID, TRAFFIC_THRESHOLD_GB: "not-a-number" });
    expect(result.ok).toBe(false);
    expect(result).not.toMatchObject({ config: { trafficThresholdGB: 0 } });
  });

  it("accepts a decimal threshold", () => {
    const result = loadConfig({ ...VALID, TRAFFIC_THRESHOLD_GB: "180.5" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.trafficThresholdGB).toBe(180.5);
  });
});

describe("loadConfig — declared-but-empty optional bindings (SPEC §2.2)", () => {
  // An optional binding with a documented default is indistinguishable from an
  // unset one when its value is empty or whitespace, so the default applies
  // rather than an error. Validation applies to a value that was supplied.
  // These tests pin that reading so it cannot drift silently.
  it.each(["", "   "])("treats TRAFFIC_THRESHOLD_GB %o as unset, taking the default", (value) => {
    const result = loadConfig({ ...VALID, TRAFFIC_THRESHOLD_GB: value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.trafficThresholdGB).toBe(180);
  });

  it.each(["", "   "])("treats SIGNATURE_VERSION %o as unset, taking the default", (value) => {
    const result = loadConfig({ ...VALID, SIGNATURE_VERSION: value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.signatureVersion).toBe("v3");
  });

  it.each(["", "   "])("treats STOPPED_MODE %o as unset, taking the default", (value) => {
    const result = loadConfig({ ...VALID, STOPPED_MODE: value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.stoppedMode).toBe("KeepCharging");
  });

  it.each(["", "   "])("treats CDT_ENDPOINT %o as unset, taking the default", (value) => {
    const result = loadConfig({ ...VALID, CDT_ENDPOINT: value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.cdtEndpoint).toBe("cdt.aliyuncs.com");
  });

  it.each(["", "   "])("treats BUSINESS_REGION_ID %o as unset", (value) => {
    const result = loadConfig({ ...VALID, BUSINESS_REGION_ID: value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.businessRegionId).toBeUndefined();
  });

  it("still rejects a required binding that is only whitespace", () => {
    // The default only applies to optional bindings. A required one that is
    // blank is a misconfiguration, not an omission to paper over.
    const result = loadConfig({ ...VALID, ECS_INSTANCE_ID: "   " });
    expect(result.ok).toBe(false);
  });
});

describe("loadConfig — enum bindings (SPEC §2.4)", () => {
  it.each(["v1", "V3", "sha256"])("rejects SIGNATURE_VERSION %o", (value) => {
    const result = loadConfig({ ...VALID, SIGNATURE_VERSION: value });
    expect(result.ok).toBe(false);
  });

  it.each(["v2", "v3"])("accepts SIGNATURE_VERSION %o", (value) => {
    expect(loadConfig({ ...VALID, SIGNATURE_VERSION: value }).ok).toBe(true);
  });

  it.each(["Stop", "keepcharging", "NONE", "   "])("rejects STOPPED_MODE %o", (value) => {
    const result = loadConfig({ ...VALID, STOPPED_MODE: value });
    // Whitespace is treated as unset (defaults), so only a real value is invalid.
    if (value.trim() === "") {
      expect(result.ok).toBe(true);
      return;
    }
    expect(result.ok).toBe(false);
  });

  it.each(["StopCharging", "KeepCharging"])("accepts STOPPED_MODE %o", (value) => {
    expect(loadConfig({ ...VALID, STOPPED_MODE: value }).ok).toBe(true);
  });
});

describe("loadConfig — WEBHOOK_URL (SPEC §2.4)", () => {
  it.each([undefined, "", "   "])("allows an absent or empty URL without a token (%o)", (value) => {
    const result = loadConfig({ ...VALID, WEBHOOK_URL: value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.webhookUrl).toBeUndefined();
    expect(result.config.webhookToken).toBeUndefined();
  });

  it("requires a URL when a non-empty token is configured without one", () => {
    const result = loadConfig({ ...VALID, WEBHOOK_TOKEN: "private-token-value" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("WEBHOOK_TOKEN");
    expect(result.error.message).toContain("WEBHOOK_URL");
    expect(result.error.message).not.toContain("private-token-value");
  });

  it.each(["", "   "])("treats an empty token as absent when URL is absent (%o)", (token) => {
    const result = loadConfig({ ...VALID, WEBHOOK_TOKEN: token });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.webhookUrl).toBeUndefined();
    expect(result.config.webhookToken).toBeUndefined();
  });

  it.each(["http://example.test/hook", "example.test/hook", "ftp://example.test", "/relative"])(
    "rejects non-https URL %o",
    (value) => {
      const result = loadConfig({ ...VALID, WEBHOOK_URL: value });
      expect(result.ok).toBe(false);
    },
  );

  it("accepts an absolute https URL", () => {
    expect(loadConfig({ ...VALID, WEBHOOK_URL: "https://hooks.example.test/x?y=1" }).ok).toBe(true);
  });

  it("accepts a URL without a token", () => {
    const result = loadConfig({ ...VALID, WEBHOOK_URL: "https://hooks.example.test/run" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.webhookUrl).toBe("https://hooks.example.test/run");
    expect(result.config.webhookToken).toBeUndefined();
  });
});

describe("loadConfig — secret hygiene (SPEC §2.4, §9; PLAN R9)", () => {
  const SECRETS = ["AKID-SECRET-VALUE", "https://secret.example.test/tok-abc"];

  it("does not echo a secret value in a validation error", () => {
    // Two fields invalid at once, one of them secret-bearing. The error must
    // name the binding at most, never its value.
    const result = loadConfig({
      ...VALID,
      ALIYUN_ACCESS_KEY_SECRET: "AKID-SECRET-VALUE",
      TRAFFIC_THRESHOLD_GB: "nope",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const serialised = JSON.stringify(result.error);
    expect(serialised).not.toContain("AKID-SECRET-VALUE");
  });

  it("does not leak a secret into an error produced by a different rule", () => {
    const result = loadConfig({
      ...VALID,
      ALIYUN_ACCESS_KEY_ID: "AKID-SECRET-VALUE",
      WEBHOOK_URL: "http://insecure.example.test",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain("AKID-SECRET-VALUE");
  });

  it("does not leak the webhook URL token into an error", () => {
    const result = loadConfig({
      ...VALID,
      WEBHOOK_URL: "https://secret.example.test/tok-abc",
      STOPPED_MODE: "bogus",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const serialised = JSON.stringify(result.error);
    for (const secret of SECRETS) expect(serialised).not.toContain(secret);
  });

  it("exposes secret values on the parsed config for use, but never in the error", () => {
    const result = loadConfig(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.accessKeySecret).toBe("SECRET");
  });
});

describe("loadConfig — optional ADMIN_TOKEN (SPEC §2.4, §8.3)", () => {
  it("does not require ADMIN_TOKEN on the scheduled path", () => {
    // The scheduled path must not depend on the dashboard secret; a missing
    // token fails closed on the HTTP path instead (§8.3).
    expect(loadConfig(VALID).ok).toBe(true);
  });

  it("carries ADMIN_TOKEN when present", () => {
    const result = loadConfig({ ...VALID, ADMIN_TOKEN: "tok" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.adminToken).toBe("tok");
  });
});
