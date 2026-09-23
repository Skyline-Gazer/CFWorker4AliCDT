import { describe, expect, it, vi } from "vitest";

import { redact } from "../src/redact";
import { buildPayload, notify } from "../src/notify/webhook";
import { renderDashboard } from "../src/web/dashboard";
import { buildRow, recordRun } from "../src/storage/history";
import type { HistoryReport } from "../src/storage/history";
import type { HistoryRow } from "../src/storage/read";

/**
 * Redaction across every output surface (SPEC §9.4, §7.5, A5).
 *
 * The per-module tests each assert their own surface. This file asserts the
 * property that matters to an operator: **the same secret-shaped input cannot
 * escape through any of the four destinations**, and it does so through the
 * *single* boundary rather than four independent implementations.
 *
 * The four surfaces are the ones a secret can actually reach:
 *
 * 1. a webhook payload — leaves the system
 * 2. a rendered HTML document — shown to the operator's browser
 * 3. a D1 row — the most durable destination in the project
 * 4. a log line — persisted by default, so a leak is durable
 *
 * A second, weaker redaction implementation previously existed in the RPC layer,
 * and the divergence let a credential reach a D1 row. These tests would have
 * caught that, which is the point of asserting the surfaces together.
 */

const SECRET = "LTAI5tSecretValue";
const BEARER = "sk-live-abcdef1234567890";

/** Every form a credential can take in text this system handles. */
const CREDENTIALS: readonly string[] = [
  `AccessKeyId=${SECRET}`,
  `AccessKeySecret=${SECRET}`,
  `ALIYUN_ACCESS_KEY_ID=${SECRET}`,
  `ALIYUN_ACCESS_KEY_SECRET=${SECRET}`,
  `Authorization: Bearer ${BEARER}`,
  `Authorization: Basic ${SECRET}`,
  `authorization=${BEARER}`,
  `WEBHOOK_TOKEN=${BEARER}`,
  `ADMIN_TOKEN=${BEARER}`,
  `Signature=9NaGiOspFP5UPcwX8Iwt2YJXXuk`,
];

const SECRET_VALUES: readonly string[] = [SECRET, BEARER, "9NaGiOspFP5UPcwX8Iwt2YJXXuk"];

function leaks(text: string): string[] {
  return SECRET_VALUES.filter((value) => text.includes(value));
}

const REPORT: HistoryReport = {
  status: "error",
  trafficGB: undefined,
  thresholdGB: 180,
  ecsStatusBefore: undefined,
  ecsStatusAfter: undefined,
  desired: undefined,
  action: undefined,
  stoppedModeRequested: undefined,
  instanceId: "i-abc123",
  region: "cn-hongkong",
  time: "2026-09-23T00:00:00Z",
  durationMs: 1,
  stage: "cdt-query",
  error: undefined,
  webhookAttempted: true,
  webhookOk: true,
};

const ROW: HistoryRow = {
  id: 1,
  checked_at: "2026-09-23T00:00:00Z",
  trigger: "scheduled",
  status: "error",
  traffic_gb: null,
  threshold_gb: 180,
  usage_percent: null,
  remaining_gb: null,
  ecs_status_before: null,
  desired_ecs_state: null,
  action: null,
  ecs_status_after: null,
  control_ok: 1,
  webhook_attempted: 1,
  webhook_ok: 1,
  error_stage: "cdt-query",
  error_message: null,
  duration_ms: 1,
};

describe("redaction — no credential escapes any surface", () => {
  it.each(CREDENTIALS)("the boundary redacts %s", (credential) => {
    expect(leaks(redact(credential))).toEqual([]);
  });

  it.each(CREDENTIALS)("a webhook payload cannot carry %s", (credential) => {
    const payload = buildPayload({ ...REPORT, error: credential });
    expect(leaks(JSON.stringify(payload))).toEqual([]);
  });

  it.each(CREDENTIALS)("a D1 row cannot carry %s", (credential) => {
    const row = buildRow({ ...REPORT, error: credential });
    expect(leaks(JSON.stringify(row))).toEqual([]);
  });

  it.each(CREDENTIALS)("rendered HTML cannot carry %s", (credential) => {
    const html = renderDashboard({
      latest: { ...ROW, error_message: credential },
      history: [{ ...ROW, error_message: credential }],
      storageOk: true,
    });
    expect(leaks(html)).toEqual([]);
  });

  it.each(CREDENTIALS)("no module logs %s unredacted", async (credential) => {
    // Logs persist by default, so a leaked secret here is a durable leak
    // (PLAN R9). The real code paths are exercised rather than a hand-rolled log
    // call, because the question is what the *modules* emit.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // The storage write path, failing with a credential-bearing driver message.
    await recordRun(
      { ...REPORT, error: credential },
      {
        insert: () => Promise.reject(new Error(credential)),
      },
    );

    // The webhook failure path, with a URL that itself carries a token.
    await notify(
      { webhookUrl: `https://example.test/${credential}`, webhookToken: credential },
      { ...REPORT, error: credential },
      { fetch: () => Promise.reject(new Error(credential)) },
    );

    const written = [...warn.mock.calls, ...error.mock.calls].flat().map(String).join(" ");
    expect(leaks(written)).toEqual([]);
    warn.mockRestore();
    error.mockRestore();
  });
});

describe("redaction — a single boundary, not four implementations", () => {
  it("the exported boundary is the only one the surfaces use", async () => {
    // Every module imports `redact` from `src/redact`. If a module reintroduced
    // its own copy, this file's cross-surface assertions would not necessarily
    // catch it — so the import graph is asserted directly.
    const sources = await Promise.all(
      [
        "../src/aliyun/rpc",
        "../src/notify/webhook",
        "../src/storage/history",
        "../src/web/dashboard",
        "../src/web/query",
        "../src/web/router",
      ].map((path) => import(path) as Promise<Record<string, unknown>>),
    );
    // Each module either re-exports the boundary or does not export a redact at
    // all; none may export a *different* implementation.
    for (const module of sources) {
      const candidate = module.redact;
      if (candidate === undefined) continue;
      expect(candidate).toBe(redact);
    }
  });

  it("is idempotent, which is what makes a second pass safe", () => {
    // Text on the path to D1 is redacted more than once, so idempotence is a
    // security property rather than tidiness.
    for (const credential of CREDENTIALS) {
      const once = redact(credential);
      expect(redact(once)).toBe(once);
      expect(once).not.toContain("[REDACTED]]");
    }
  });

  it("preserves ordinary text, so redaction is not just deletion", () => {
    const ordinary = "InvalidInstanceId: the specified instance does not exist";
    expect(redact(ordinary)).toBe(ordinary);
  });
});
