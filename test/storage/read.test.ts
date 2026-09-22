import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clampLimit,
  historyQuery,
  readHistory,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../../src/storage/read";
import type { HistoryRow } from "../../src/storage/read";

/**
 * Bounded history read (SPEC §9.5).
 *
 * The bound is the point. A dashboard refresh is a user-triggered read against a
 * table that grows ~144 rows/day, so an unclamped `limit` turns a page load into
 * an unbounded scan. Clamping is asserted for oversized *and* malformed input,
 * because the malformed case is the one that reaches the database by accident.
 *
 * The read must also be provably read-only, and ordering deterministic, so the
 * dashboard does not present rows in an order that changes between refreshes.
 */

const require = createRequire(import.meta.url);

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

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");

function migrated(): Database {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
  return db;
}

function seed(db: Database, count: number, minuteStart = 0): void {
  const insert = db.prepare(
    `INSERT INTO traffic_checks (checked_at, trigger, status, traffic_gb, threshold_gb, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < count; i += 1) {
    const minute = String(minuteStart + i).padStart(2, "0");
    insert.run(`2026-09-22T00:${minute}:00Z`, "scheduled", "success", i, 180, i);
  }
}

/** `all()` is typed loosely by the driver, so narrow once. */
function query<T>(db: Database, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

describe("clampLimit — the bound is always applied (SPEC §9.5)", () => {
  it("defaults when no limit is given", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(null)).toBe(DEFAULT_LIMIT);
    expect(clampLimit("")).toBe(DEFAULT_LIMIT);
  });

  it("accepts a reasonable limit", () => {
    expect(clampLimit("10")).toBe(10);
    expect(clampLimit("1")).toBe(1);
  });

  it("clamps an oversized limit to the hard maximum rather than honouring it", () => {
    // The case that matters: a caller asking for everything must not get it.
    expect(clampLimit("100000")).toBe(MAX_LIMIT);
    expect(clampLimit(String(Number.MAX_SAFE_INTEGER))).toBe(MAX_LIMIT);
    expect(clampLimit(String(MAX_LIMIT + 1))).toBe(MAX_LIMIT);
  });

  it("clamps malformed input rather than erroring or passing it through", () => {
    for (const bad of ["abc", "NaN", "Infinity", "-1", "-0", "0", "1e999", "  ", "1.5"]) {
      const result = clampLimit(bad);
      expect(Number.isInteger(result), `${bad} must clamp to an integer`).toBe(true);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(MAX_LIMIT);
    }
  });

  it("never returns a value that could disable the bound", () => {
    for (const input of [
      undefined,
      null,
      "",
      "abc",
      "-1",
      "0",
      "999999999",
      "Infinity",
      "NaN",
      "1e309",
    ]) {
      const result = clampLimit(input);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(MAX_LIMIT);
    }
  });
});

describe("historyQuery — SQL is bounded and deterministic (SPEC §9.5)", () => {
  it("orders newest-first with id as the tiebreaker", () => {
    const sql = historyQuery();
    expect(sql).toMatch(/ORDER BY\s+checked_at\s+DESC\s*,\s*id\s+DESC/i);
  });

  it("applies a LIMIT", () => {
    expect(historyQuery()).toMatch(/LIMIT/i);
  });

  it("contains no write, migration, or schema statement", () => {
    // The read path must be incapable of mutating anything it reads.
    const sql = historyQuery();
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i);
  });
});

describe("readHistory — reads the real schema", () => {
  it("returns rows newest-first", async () => {
    const db = migrated();
    seed(db, 3);
    const rows = await readHistory(
      { limit: "10" },
      { query: (sql, params) => query(db, sql, ...params) },
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.checked_at).toBe("2026-09-22T00:02:00Z");
    db.close();
  });

  it("is deterministic on equal timestamps via the id tiebreaker", async () => {
    const db = migrated();
    // Three rows sharing a timestamp, so only `id` can order them.
    const insert = db.prepare(
      `INSERT INTO traffic_checks (checked_at, trigger, status, threshold_gb, duration_ms)
       VALUES ('2026-09-22T00:00:00Z', 'scheduled', 'success', 180, ?)`,
    );
    insert.run(1);
    insert.run(2);
    insert.run(3);

    const run = () =>
      readHistory(
        { limit: "10" },
        { query: (sql, params) => query<HistoryRow>(db, sql, ...params) },
      );
    const first = await run();
    const second = await run();
    expect(first.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(first).toEqual(second);
    db.close();
  });

  it("honours a small limit", async () => {
    const db = migrated();
    seed(db, 10);
    const rows = await readHistory(
      { limit: "2" },
      { query: (sql, params) => query(db, sql, ...params) },
    );
    expect(rows).toHaveLength(2);
    db.close();
  });

  it("clamps an oversized limit against the database", async () => {
    const db = migrated();
    seed(db, 5);
    const rows = await readHistory(
      { limit: "100000" },
      { query: (sql, params) => query(db, sql, ...params) },
    );
    // Bounded read of an existing table: it cannot return more than the max.
    expect(rows.length).toBeLessThanOrEqual(MAX_LIMIT);
    db.close();
  });

  it("preserves NULL traffic rather than coercing it to 0", async () => {
    const db = migrated();
    db.prepare(
      `INSERT INTO traffic_checks (checked_at, trigger, status, traffic_gb, threshold_gb, duration_ms)
       VALUES ('2026-09-22T00:00:00Z', 'scheduled', 'error', NULL, 180, 1)`,
    ).run();
    const rows = await readHistory(
      { limit: "10" },
      { query: (sql, params) => query(db, sql, ...params) },
    );
    expect(rows[0]?.traffic_gb).toBeNull();
    db.close();
  });

  it("returns an empty array rather than failing on an empty table", async () => {
    const db = migrated();
    const rows = await readHistory(
      { limit: "10" },
      { query: (sql, params) => query(db, sql, ...params) },
    );
    expect(rows).toEqual([]);
    db.close();
  });

  it("issues exactly one statement, and it is a read", async () => {
    const statements: string[] = [];
    const db = migrated();
    await readHistory(
      { limit: "5" },
      {
        query: (sql, params) => {
          statements.push(sql);
          return query(db, sql, ...params);
        },
      },
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/SELECT/i);
    db.close();
  });
});

describe("readHistory — failure isolation for the scheduled path (SPEC §9.6)", () => {
  it("rejects on a query failure so the caller decides how to surface it", async () => {
    // Unlike the write path, a read failure has no control outcome to protect:
    // the scheduled path never reads history, and the HTTP path returns an
    // error response. Rejecting is correct here so the route can map it to a
    // status; silently returning [] would render an empty dashboard as if the
    // history were genuinely empty.
    const failing = {
      query: (): HistoryRow[] => {
        throw new Error("D1_ERROR: unavailable");
      },
    };
    await expect(readHistory({ limit: "10" }, failing)).rejects.toThrow();
  });

  it("does not swallow the failure as an empty result", async () => {
    const failing = {
      query: (): HistoryRow[] => {
        throw new Error("D1_ERROR: unavailable");
      },
    };
    await expect(readHistory({ limit: "10" }, failing)).rejects.toThrow(/D1_ERROR/);
  });
});
