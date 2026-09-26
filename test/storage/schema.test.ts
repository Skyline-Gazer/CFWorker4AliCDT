import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * D1 schema contract (SPEC §9.3).
 *
 * These tests apply the **real committed migrations** to an in-memory SQLite
 * database and assert the resulting schema. Reading the migration files rather
 * than restating the DDL is the point: if the migration and this test were
 * written independently they could disagree, and the schema is the one artifact
 * a later phase cannot change cheaply.
 *
 * The nullability assertions carry the weight. `traffic_gb` MUST be nullable so
 * that traffic which could not be established is stored as NULL — SPEC §5.4's
 * invariant applies to persistence too, and a `NOT NULL DEFAULT 0` would turn
 * "unknown" into a fabricated zero in a row that outlives the bug.
 *
 * `node:sqlite` is loaded through `createRequire` because it is newer than
 * Vite's builtin-module list: a static `import` is rewritten to a bare `sqlite`
 * specifier that Vite cannot resolve. This keeps the migration testable offline
 * rather than only after a deploy.
 */

const require = createRequire(import.meta.url);
/** Loaded at runtime: see the module header for why a static import fails. */
const sqlite = require("node:sqlite") as {
  DatabaseSync: new (path: string) => Database;
};
interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown;
  };
  close(): void;
}
const { DatabaseSync } = sqlite;

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");

/** Every migration, in filename order, as the migration runner would apply it. */
function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));
}

function migrated(): Database {
  const db = new DatabaseSync(":memory:");
  for (const { sql } of migrationFiles()) db.exec(sql);
  return db;
}

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
}

function columns(db: Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fresh(): Database {
  const db = migrated();
  databases.push(db);
  return db;
}

/** SPEC §9.3, as (column, declared type, nullable). */
const SPEC_COLUMNS: readonly (readonly [string, string, boolean])[] = [
  ["id", "INTEGER", false],
  ["checked_at", "TEXT", false],
  ["trigger", "TEXT", false],
  ["status", "TEXT", false],
  ["traffic_gb", "REAL", true],
  ["threshold_gb", "REAL", false],
  ["usage_percent", "REAL", true],
  ["remaining_gb", "REAL", true],
  ["ecs_status_before", "TEXT", true],
  ["desired_ecs_state", "TEXT", true],
  ["action", "TEXT", true],
  ["ecs_status_after", "TEXT", true],
  ["decision_reason", "TEXT", true],
  ["control_ok", "INTEGER", true],
  ["webhook_attempted", "INTEGER", true],
  ["webhook_ok", "INTEGER", true],
  ["error_stage", "TEXT", true],
  ["error_message", "TEXT", true],
  ["duration_ms", "INTEGER", true],
];

describe("traffic_checks schema — migration applies cleanly", () => {
  it("has at least one committed migration", () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
  });

  it("applies every migration to a fresh database", () => {
    expect(() => fresh()).not.toThrow();
  });

  it("creates the traffic_checks table", () => {
    const db = fresh();
    const found = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'traffic_checks'")
      .get();
    expect(found).toBeDefined();
  });
});

describe("traffic_checks schema — columns match SPEC §9.3", () => {
  it("has exactly the specified columns, no more and no fewer", () => {
    const db = fresh();
    const names = columns(db, "traffic_checks").map((c) => c.name);
    expect(names.sort()).toEqual(SPEC_COLUMNS.map(([name]) => name).sort());
  });

  it.each(SPEC_COLUMNS)("declares %s as %s", (name, type, nullable) => {
    const db = fresh();
    const column = columns(db, "traffic_checks").find((c) => c.name === name);
    expect(column, `column ${name} must exist`).toBeDefined();
    if (column === undefined) return;
    expect(column.type).toBe(type);

    // Nullability is the load-bearing property: a nullable column is how
    // "unknown" survives as NULL rather than becoming a fabricated 0.
    //
    // SQLite reports an `INTEGER PRIMARY KEY` as `notnull = 0` even though the
    // column cannot hold NULL, so the primary key is excluded from the NOT NULL
    // check and asserted separately below. For every other column the flag is
    // authoritative.
    if (column.pk === 1) {
      expect(column.name).toBe("id");
      return;
    }
    expect(column.notnull === 1).toBe(!nullable);
  });

  it("makes id an autoincrementing primary key", () => {
    const db = fresh();
    const id = columns(db, "traffic_checks").find((c) => c.name === "id");
    expect(id?.pk).toBe(1);
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'traffic_checks'").get() as {
      sql: string;
    };
    expect(ddl.sql.toUpperCase()).toContain("AUTOINCREMENT");
  });
});

describe("decision_reason migration — unknown history stays unknown", () => {
  it("adds a nullable column and leaves pre-migration rows NULL", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const migrations = migrationFiles();
    const initial = migrations.find(({ name }) => name === "0001_traffic_checks.sql");
    const reason = migrations.find(({ name }) => name === "0002_decision_reason.sql");
    expect(initial).toBeDefined();
    expect(reason).toBeDefined();
    if (initial === undefined || reason === undefined) return;

    db.exec(initial.sql);
    db.prepare(
      `INSERT INTO traffic_checks (checked_at, trigger, status, threshold_gb, duration_ms)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("2026-09-22T00:00:00Z", "scheduled", "success", 180, 1);

    db.exec(reason.sql);
    const column = columns(db, "traffic_checks").find((item) => item.name === "decision_reason");
    expect(column?.type).toBe("TEXT");
    expect(column?.notnull).toBe(0);

    const row = db.prepare("SELECT decision_reason FROM traffic_checks").get() as {
      decision_reason: string | null;
    };
    expect(row.decision_reason).toBeNull();
  });
});

describe("traffic_checks schema — indexes support bounded reads", () => {
  it("indexes checked_at so the history read is bounded (SPEC §9.5)", () => {
    const db = fresh();
    const indexes = db.prepare("PRAGMA index_list(traffic_checks)").all() as {
      name: string;
    }[];
    const covers = indexes.some((index) => {
      const cols = db.prepare(`PRAGMA index_info(${index.name})`).all() as {
        name: string;
      }[];
      return cols.length === 1 && cols[0]?.name === "checked_at";
    });
    expect(covers).toBe(true);
  });
});

describe("traffic_checks schema — unknown traffic is NULL, never 0 (SPEC §5.4, §9.3)", () => {
  it("stores a NULL traffic_gb and reads it back as NULL, not 0", () => {
    const db = fresh();
    db.prepare(
      `INSERT INTO traffic_checks
         (checked_at, trigger, status, traffic_gb, threshold_gb, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("2026-09-22T00:00:00Z", "scheduled", "error", null, 180, 340);

    const row = db.prepare("SELECT traffic_gb FROM traffic_checks").get() as {
      traffic_gb: number | null;
    };
    expect(row.traffic_gb).toBeNull();
    expect(row.traffic_gb).not.toBe(0);
  });

  it("rejects an insert that omits a NOT NULL column", () => {
    const db = fresh();
    // `threshold_gb` is NOT NULL: a row that cannot state the threshold it was
    // judged against is not a usable record.
    expect(() =>
      db
        .prepare(
          `INSERT INTO traffic_checks (checked_at, trigger, status, duration_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run("2026-09-22T00:00:00Z", "scheduled", "success", 1),
    ).toThrow();
  });

  it("accepts a genuine zero traffic reading", () => {
    // Zero from a present reading is a fact, unlike unknown traffic. Both must
    // be representable and distinguishable.
    const db = fresh();
    db.prepare(
      `INSERT INTO traffic_checks
         (checked_at, trigger, status, traffic_gb, threshold_gb, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("2026-09-22T00:00:00Z", "scheduled", "success", 0, 180, 1);

    const row = db.prepare("SELECT traffic_gb FROM traffic_checks").get() as {
      traffic_gb: number | null;
    };
    expect(row.traffic_gb).toBe(0);
  });

  it("orders deterministically by (checked_at DESC, id DESC) (SPEC §9.5)", () => {
    const db = fresh();
    const insert = db.prepare(
      `INSERT INTO traffic_checks (checked_at, trigger, status, threshold_gb, duration_ms)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // Same timestamp deliberately: `id` is the tiebreaker.
    insert.run("2026-09-22T00:00:00Z", "scheduled", "success", 180, 1);
    insert.run("2026-09-22T00:00:00Z", "scheduled", "success", 180, 2);
    insert.run("2026-09-21T23:50:00Z", "scheduled", "success", 180, 3);

    const rows = db
      .prepare("SELECT id FROM traffic_checks ORDER BY checked_at DESC, id DESC")
      .all() as { id: number }[];
    expect(rows.map((r) => r.id)).toEqual([2, 1, 3]);
  });
});
