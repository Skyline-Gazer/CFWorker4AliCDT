import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildRow, recordRun, controlOk } from "../../src/storage/history";
import type { HistoryReport, RowInsert } from "../../src/storage/history";
import type { RunReport } from "../../src/monitor/execute";

/**
 * D1 monitoring history write path (SPEC §9.6).
 *
 * Three properties carry the weight here.
 *
 * **Failure isolation.** A D1 failure must never reach the control path. The
 * tests assert `recordRun` *resolves* on a throwing insert, not merely that it
 * returns a flag: a rejection would propagate into the scheduled handler.
 *
 * **A row must not describe its own insert.** `storageOk` is returned to the
 * caller, never written into the row it would have to describe.
 *
 * **Unknown traffic is NULL, never 0.** A fabricated zero in a persisted row
 * outlives the bug that produced it, and SPEC §5.4's invariant applies to
 * storage as much as to control.
 */

const SUCCESS: HistoryReport = {
  status: "success",
  trafficGB: 123.45,
  thresholdGB: 180,
  ecsStatusBefore: "running",
  ecsStatusAfter: "stopped",
  desired: "stopped",
  action: "stop",
  decisionReason:
    'traffic 123.45 GB has reached threshold 180 GB; instance is "running", so a stop is required',
  stoppedModeRequested: "KeepCharging",
  instanceId: "i-abc123",
  region: "cn-hongkong",
  time: "2026-09-22T00:00:00Z",
  durationMs: 812,
  stage: undefined,
  error: undefined,
  webhookAttempted: true,
  webhookOk: true,
};

const FAILED: HistoryReport = {
  ...SUCCESS,
  status: "error",
  stage: "cdt-query",
  error: "CDT response had no TrafficDetails",
  trafficGB: undefined,
  decisionReason: undefined,
  ecsStatusBefore: undefined,
  ecsStatusAfter: undefined,
  desired: undefined,
  action: undefined,
  stoppedModeRequested: undefined,
  webhookAttempted: true,
  webhookOk: true,
  durationMs: 340,
};

function captureInsert(): { insert: (row: RowInsert) => Promise<void>; rows: RowInsert[] } {
  const rows: RowInsert[] = [];
  return {
    rows,
    insert: (row) => {
      rows.push(row);
      return Promise.resolve();
    },
  };
}

describe("buildRow — maps the report onto SPEC §9.3", () => {
  it("records a scheduled trigger", () => {
    expect(buildRow(SUCCESS).trigger).toBe("scheduled");
  });

  it("maps every success field", () => {
    expect(buildRow(SUCCESS)).toMatchObject({
      checked_at: "2026-09-22T00:00:00Z",
      trigger: "scheduled",
      status: "success",
      traffic_gb: 123.45,
      threshold_gb: 180,
      ecs_status_before: "running",
      desired_ecs_state: "stopped",
      action: "stop",
      decision_reason: SUCCESS.decisionReason,
      ecs_status_after: "stopped",
      webhook_attempted: 1,
      webhook_ok: 1,
      duration_ms: 812,
    });
  });

  it("derives usage percentage and remaining traffic", () => {
    const row = buildRow(SUCCESS);
    expect(row.usage_percent).toBeCloseTo((123.45 / 180) * 100, 6);
    expect(row.remaining_gb).toBeCloseTo(180 - 123.45, 6);
  });

  it("stores unknown traffic as NULL, never 0 (SPEC §5.4, §9.3)", () => {
    const row = buildRow(FAILED);
    expect(row.traffic_gb).toBeNull();
    expect(row.traffic_gb).not.toBe(0);
    // Derived values are unknown too: a remaining figure computed from a
    // fabricated zero would read as a full allowance.
    expect(row.usage_percent).toBeNull();
    expect(row.remaining_gb).toBeNull();
  });

  it("stores a decision reason only when the report actually has one", () => {
    expect(buildRow(SUCCESS).decision_reason).toBe(SUCCESS.decisionReason);
    expect(buildRow(FAILED).decision_reason).toBeNull();
    expect(
      buildRow({ ...FAILED, decisionReason: undefined, error: "Threshold unavailable" })
        .decision_reason,
    ).toBeNull();
  });

  it("stores a genuine zero reading as 0, distinguishably from NULL", () => {
    const row = buildRow({ ...SUCCESS, trafficGB: 0 });
    expect(row.traffic_gb).toBe(0);
    expect(row.usage_percent).toBe(0);
    expect(row.remaining_gb).toBe(180);
  });

  it("stores unobserved status fields as NULL rather than inventing a state", () => {
    const row = buildRow(FAILED);
    expect(row.ecs_status_before).toBeNull();
    expect(row.ecs_status_after).toBeNull();
    expect(row.desired_ecs_state).toBeNull();
    expect(row.action).toBeNull();
  });

  it("stores error stage and message, and NULLs them on success", () => {
    expect(buildRow(FAILED)).toMatchObject({
      error_stage: "cdt-query",
      error_message: "CDT response had no TrafficDetails",
    });
    const ok = buildRow(SUCCESS);
    expect(ok.error_stage).toBeNull();
    expect(ok.error_message).toBeNull();
  });

  it("stores a null webhook_ok when the webhook was not attempted", () => {
    const row = buildRow({ ...SUCCESS, webhookAttempted: false, webhookOk: undefined });
    expect(row.webhook_attempted).toBe(0);
    expect(row.webhook_ok).toBeNull();
  });

  it("does not store a non-finite derived value", () => {
    // `usage_percent` divides by the threshold. A zero threshold makes it
    // `Infinity`, and a non-finite REAL has no defined persistent form: it may
    // be rejected, stored as NULL, or stored oddly depending on the driver's
    // JSON handling. `loadConfig` rejects a non-positive threshold, but
    // `buildRow` must be total on its own inputs rather than relying on a caller
    // upstream (SPEC §5.4 — a value that cannot be established is not a value).
    const row = buildRow({ ...SUCCESS, thresholdGB: 0 });
    expect(Number.isFinite(row.usage_percent)).toBe(false);
    expect(row.usage_percent).toBeNull();
  });

  it("never stores a non-finite traffic value", () => {
    for (const trafficGB of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const row = buildRow({ ...SUCCESS, trafficGB });
      expect(row.traffic_gb).toBeNull();
      expect(row.usage_percent).toBeNull();
      expect(row.remaining_gb).toBeNull();
    }
  });

  it("does not record its own insert success in the row (SPEC §9.6)", () => {
    // A row cannot describe the insert that would have to succeed for the field
    // to exist. `storageOk` belongs to the caller's report, not the row.
    expect(buildRow(SUCCESS)).not.toHaveProperty("storage_ok");
    expect(buildRow(SUCCESS)).not.toHaveProperty("storageOk");
  });
});

describe("buildRow — secret hygiene (SPEC §9.4, §7.5)", () => {
  const secrets = [
    "LTAI5tSecretValue",
    "sk-live-abcdef123456",
    "dXNlcjpwYXNz",
    "9NaGiOspFP5UPcwX8Iwt2YJXXuk",
  ];

  it("redacts a credential echoed in an error message before it is stored", () => {
    // D1 rows are the most durable destination in the project: a secret written
    // here outlives the run, the log retention window, and the bug.
    const cases = [
      "AccessKeyId=LTAI5tSecretValue&Signature=9NaGiOspFP5UPcwX8Iwt2YJXXuk failed",
      "Authorization: Bearer sk-live-abcdef123456",
      "Authorization: Basic dXNlcjpwYXNz",
      "authorization=sk-live-abcdef123456",
      "AccessKeySecret=LTAI5tSecretValue",
    ];
    for (const message of cases) {
      const row = buildRow({ ...FAILED, error: message });
      const serialised = JSON.stringify(row);
      for (const secret of secrets) {
        expect(serialised, `${message} must not store ${secret}`).not.toContain(secret);
      }
    }
  });

  it("redacts a realistic opaque token interpolated after the word 'token'", () => {
    // A bearer token is long and opaque. Redaction catches it by length, since
    // there is no separator to key on.
    const row = buildRow({ ...FAILED, error: `webhook token ${"a".repeat(40)} rejected` });
    expect(JSON.stringify(row)).not.toContain("a".repeat(40));
  });

  it("redacts a token given with an explicit separator", () => {
    const row = buildRow({ ...FAILED, error: "WEBHOOK_TOKEN=tok123" });
    expect(JSON.stringify(row)).not.toContain("tok123");
  });

  it("redacts the project's own underscore-prefixed secret binding names", () => {
    // `WEBHOOK_TOKEN` and `ADMIN_TOKEN` are real binding names in this project.
    // A `\b`-anchored key pattern does not match them, because `_` is a word
    // character: there is no word boundary between `_` and `TOKEN`, so the whole
    // value passed through unredacted.
    const cases = [
      "WEBHOOK_TOKEN=tok123",
      "ADMIN_TOKEN=tok123",
      "ALIYUN_ACCESS_KEY_SECRET=LTAI5tSecretValue",
      "ALIYUN_ACCESS_KEY_ID=LTAI5tSecretValue",
      '{"WEBHOOK_TOKEN":"tok123"}',
    ];
    for (const message of cases) {
      const row = buildRow({ ...FAILED, error: message });
      const serialised = JSON.stringify(row);
      expect(serialised, `${message} must not store its value`).not.toContain("tok123");
      expect(serialised, `${message} must not store its value`).not.toContain("LTAI5tSecretValue");
    }
  });

  it("preserves ordinary prose containing the word 'token'", () => {
    // The tradeoff is deliberate: redacting the word *after* "token" in prose
    // form would mangle messages like these, and a short non-token value has no
    // separator or opaque length to key on. The pipeline never interpolates the
    // real token into a message at all (SPEC §7.5), so this is the residual
    // case, not the route a token actually takes.
    for (const message of ["Token not found", "auth token expired", "token budget exceeded"]) {
      expect(buildRow({ ...FAILED, error: message }).error_message).toBe(message);
    }
  });

  it("leaves an ordinary error message readable", () => {
    expect(buildRow(FAILED).error_message).toBe("CDT response had no TrafficDetails");
  });
});

describe("controlOk — distinguishes a control failure from other failures", () => {
  it("is true when the run succeeded", () => {
    expect(controlOk(SUCCESS)).toBe(true);
  });

  it("is true when the run aborted before any control was attempted", () => {
    // A CDT failure is not a control failure: control was never exercised, and
    // recording it as a control failure would misattribute the cause.
    expect(controlOk({ ...FAILED, stage: "cdt-query" })).toBe(true);
    expect(controlOk({ ...FAILED, stage: "ecs-describe" })).toBe(true);
    expect(controlOk({ ...FAILED, stage: "config" })).toBe(true);
  });

  it("is false when the control outcome itself failed", () => {
    expect(controlOk({ ...FAILED, stage: "ecs-start" })).toBe(false);
    expect(controlOk({ ...FAILED, stage: "ecs-stop" })).toBe(false);
  });
});

describe("recordRun — writes exactly one row per scheduled execution", () => {
  it("inserts one row on a successful run", async () => {
    const { insert, rows } = captureInsert();
    const result = await recordRun(SUCCESS, { insert });
    expect(rows).toHaveLength(1);
    expect(result.storageOk).toBe(true);
  });

  it("inserts one row on an error run", async () => {
    const { insert, rows } = captureInsert();
    await recordRun(FAILED, { insert });
    expect(rows).toHaveLength(1);
  });

  it("inserts one row on a no-op run", async () => {
    const { insert, rows } = captureInsert();
    await recordRun(
      { ...SUCCESS, action: "none-running", stoppedModeRequested: undefined },
      { insert },
    );
    expect(rows).toHaveLength(1);
  });

  it("returns storageOk true only after the insert resolves (SPEC §9.6)", async () => {
    let resolved = false;
    const insert = (): Promise<void> => {
      resolved = true;
      return Promise.resolve();
    };
    const result = await recordRun(SUCCESS, { insert });
    expect(resolved).toBe(true);
    expect(result.storageOk).toBe(true);
  });
});

describe("recordRun — failure isolation (SPEC §9.6, A11)", () => {
  it("resolves rather than rejecting when the insert throws", async () => {
    // The assertion that matters: a rejection here would propagate into the
    // scheduled handler and could be mistaken for a control failure.
    const insert = (): Promise<void> => Promise.reject(new Error("D1_ERROR: unavailable"));
    await expect(recordRun(SUCCESS, { insert })).resolves.toMatchObject({ storageOk: false });
  });

  it("resolves when the insert throws synchronously", async () => {
    const insert = (): Promise<void> => {
      throw new Error("D1_ERROR: no such table");
    };
    await expect(recordRun(SUCCESS, { insert })).resolves.toMatchObject({ storageOk: false });
  });

  it("reports the failure to the caller instead of throwing it", async () => {
    const insert = (): Promise<void> => Promise.reject(new Error("D1_ERROR: quota exceeded"));
    const result = await recordRun(SUCCESS, { insert });
    expect(result.storageOk).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("does not change the report it was given", async () => {
    // A storage failure must not alter the recorded control outcome.
    const report = { ...SUCCESS };
    const insert = (): Promise<void> => Promise.reject(new Error("D1_ERROR"));
    await recordRun(report, { insert });
    expect(report).toEqual(SUCCESS);
  });

  it("logs the failure locally, since a D1 failure cannot report itself", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const insert = (): Promise<void> => Promise.reject(new Error("D1_ERROR: unavailable"));
    await recordRun(SUCCESS, { insert });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not leak the error's credentials into the local log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const insert = (): Promise<void> =>
      Promise.reject(new Error("D1_ERROR: AccessKeySecret=LTAI5tSecretValue"));
    await recordRun(SUCCESS, { insert });
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain("LTAI5tSecretValue");
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The row must actually fit the committed schema. A unit test over `buildRow`
// alone could pass while the column names or nullability disagreed with the
// migration, which is the failure that only shows up on the first real run.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

/** The slice of `node:sqlite` these tests use, typed rather than `any`. */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown;
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => Database;
};

// ---------------------------------------------------------------------------
// Cross-phase integration pin.
//
// `HistoryReport` restates part of `RunReport`'s shape rather than importing it,
// so that the storage module does not depend on the orchestration module. The
// cost of that choice is that the two can drift, and the place it would surface
// is the P8 wiring (#27), long after this phase closed.
//
// This is a type-level assertion that emits no meaningful runtime value: if a
// future change to `RunReport` makes it incompatible, the conditional resolves
// to `never` and the assignment below stops compiling. CI runs `typecheck` over
// the test tree, so this phase's tests fail instead of the wiring failing later.
//
// Deliberately NOT written as `const x: HistoryReport = someDeclaredConst`: a
// `declare const` is erased at runtime, so that form type-checks but throws
// `ReferenceError` when the file is actually loaded.
// ---------------------------------------------------------------------------

type RunReportSatisfiesHistoryReport = RunReport extends HistoryReport ? true : never;
export const runReportSatisfiesHistoryReport: RunReportSatisfiesHistoryReport = true;

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");

describe("buildRow — fits the committed schema", () => {
  function migrated(): Database {
    const db = new DatabaseSync(":memory:");
    for (const name of readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    }
    return db;
  }

  function insert(db: Database, row: RowInsert): void {
    // `Object.entries` widens values to `any`; the row's value union is stated
    // explicitly so no `any` reaches the driver call.
    const entries = Object.entries(row) as [string, string | number | null][];
    const sql = `INSERT INTO traffic_checks (${entries.map(([c]) => c).join(", ")})
                 VALUES (${entries.map(() => "?").join(", ")})`;
    db.prepare(sql).run(...entries.map(([, v]) => v));
  }

  /** Narrowed read of `all()`, which the driver types loosely. */
  function all<T>(db: Database, sql: string): T[] {
    return db.prepare(sql).all() as T[];
  }

  it("inserts a success row into the real schema", () => {
    const db = migrated();
    expect(() => {
      insert(db, buildRow(SUCCESS));
    }).not.toThrow();
    expect(all<{ n: number }>(db, "SELECT COUNT(*) AS n FROM traffic_checks")[0]?.n).toBe(1);
    db.close();
  });

  it("inserts an error row with NULL traffic and reads it back as NULL", () => {
    const db = migrated();
    insert(db, buildRow(FAILED));
    const row = all<{ traffic_gb: number | null }>(db, "SELECT traffic_gb FROM traffic_checks");
    expect(row[0]?.traffic_gb).toBeNull();
    db.close();
  });

  it("round-trips a genuine zero distinguishably from NULL", () => {
    const db = migrated();
    insert(db, buildRow(FAILED));
    insert(db, buildRow({ ...SUCCESS, trafficGB: 0 }));
    const rows = all<{ traffic_gb: number | null }>(
      db,
      "SELECT traffic_gb FROM traffic_checks ORDER BY id",
    );
    expect(rows[0]?.traffic_gb).toBeNull();
    expect(rows[1]?.traffic_gb).toBe(0);
    db.close();
  });

  it("exposes exactly the schema's column names", () => {
    const db = migrated();
    const expected = all<{ name: string }>(db, "PRAGMA table_info(traffic_checks)")
      .map((c) => c.name)
      .filter((n) => n !== "id")
      .sort();
    expect(Object.keys(buildRow(SUCCESS)).sort()).toEqual(expected);
    db.close();
  });
});
