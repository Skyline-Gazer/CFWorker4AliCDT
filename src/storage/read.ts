/**
 * Bounded D1 history read (SPEC §9.5).
 *
 * The read backs `GET /api/history` and the dashboard. It is **read-only**: it
 * must not write, migrate, or mutate anything it reads, which is why the query
 * is assembled from a single `SELECT` and asserted to contain no write keyword.
 *
 * Two properties are load-bearing.
 *
 * **The bound is always applied.** A dashboard refresh is user-triggered against
 * a table growing ~144 rows/day, so an unclamped `limit` turns a page load into
 * an unbounded scan. Clamping covers oversized *and* malformed input, because
 * malformed input is the case that reaches the database by accident.
 *
 * **Ordering is deterministic.** `(checked_at DESC, id DESC)`: at a 10-minute
 * cadence two runs can share a timestamp, and without the `id` tiebreaker the
 * dashboard would reorder rows between refreshes.
 *
 * Unlike the write path, a read failure **rejects**. There is no control outcome
 * to protect here — the scheduled path never reads history — and swallowing the
 * error as `[]` would render an empty dashboard as though the history were
 * genuinely empty, which is the same "absence is not evidence" mistake the
 * fail-safe model forbids elsewhere.
 */

/** Columns returned by the read, mirroring SPEC §9.3. */
export interface HistoryRow {
  readonly id: number;
  readonly checked_at: string;
  readonly trigger: string;
  readonly status: string;
  readonly traffic_gb: number | null;
  readonly threshold_gb: number;
  readonly usage_percent: number | null;
  readonly remaining_gb: number | null;
  readonly ecs_status_before: string | null;
  readonly desired_ecs_state: string | null;
  readonly action: string | null;
  readonly decision_reason: string | null;
  readonly ecs_status_after: string | null;
  readonly control_ok: number | null;
  readonly webhook_attempted: number | null;
  readonly webhook_ok: number | null;
  readonly error_stage: string | null;
  readonly error_message: string | null;
  readonly duration_ms: number | null;
}

export interface ReadDeps {
  /**
   * Injected for tests. A production caller supplies a D1-bound query, which is
   * asynchronous — modelled as possibly-async so the real binding and a test
   * stub are both valid.
   */
  readonly query: (sql: string, params: readonly unknown[]) => HistoryRow[] | Promise<HistoryRow[]>;
}

export interface ReadOptions {
  /** Raw, untrusted `limit` from a query string. Always clamped. */
  readonly limit: string | null | undefined;
}

/** Applied when no limit is supplied. */
export const DEFAULT_LIMIT = 50;

/**
 * The hard ceiling. A caller asking for more gets this, not more.
 *
 * 200 rows covers roughly 33 hours at the 10-minute cadence — comfortably more
 * than one screen of dashboard history, and small enough that a refresh cannot
 * become an unbounded scan.
 */
export const MAX_LIMIT = 200;

/**
 * Clamp an untrusted `limit` into `[1, MAX_LIMIT]`.
 *
 * Total by construction: every branch returns an integer in range, so there is
 * no input that can disable the bound — including `NaN`, `Infinity`, a
 * negative, a fraction, or an exponent that overflows to `Infinity`.
 */
export function clampLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return DEFAULT_LIMIT;

  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_LIMIT;

  const parsed = Number(trimmed);
  // `Number("")` is 0 and `Number(" ")` is 0, both handled above. A non-numeric
  // string is `NaN`, which is not a usable limit, so the default applies rather
  // than the request failing — an unusable bound must never become no bound.
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;

  const integer = Math.floor(parsed);
  if (integer < 1) return DEFAULT_LIMIT; // 0, negative, and fractions below 1
  if (integer > MAX_LIMIT) return MAX_LIMIT;
  return integer;
}

/**
 * The exact statement the read issues.
 *
 * The limit is a **bound parameter**, never interpolated: it reaches here from a
 * query string, so building it into the SQL text would be the one injection
 * surface on this path.
 *
 * Exposed so a test can assert the ordering, the presence of `LIMIT`, and the
 * absence of any write keyword without reaching a database.
 */
export function historyQuery(): string {
  return `SELECT id, checked_at, trigger, status, traffic_gb, threshold_gb,
                 usage_percent, remaining_gb, ecs_status_before, desired_ecs_state,
                 action, ecs_status_after, decision_reason, control_ok, webhook_attempted, webhook_ok,
                 error_stage, error_message, duration_ms
          FROM traffic_checks
          ORDER BY checked_at DESC, id DESC
          LIMIT ?`;
}

/**
 * Read the most recent history rows, newest first.
 *
 * Rejects on failure. See the module header for why that differs from the write
 * path.
 */
export async function readHistory(options: ReadOptions, deps: ReadDeps): Promise<HistoryRow[]> {
  // Clamped first, then passed as a bound parameter, so an untrusted value never
  // reaches the SQL text.
  const limit = clampLimit(options.limit);
  return deps.query(historyQuery(), [limit]);
}
