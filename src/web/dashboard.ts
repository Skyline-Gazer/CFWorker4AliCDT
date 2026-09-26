/**
 * Server-rendered operational dashboard (SPEC §8.4).
 *
 * The dashboard is why a deliberately conservative system can be operated with
 * confidence: it makes fail-safe behaviour *inspectable*. It is read-only with
 * respect to ECS control, and it is rendered from data alone.
 *
 * Two properties are structural rather than conventional.
 *
 * **Rendering cannot perform a privileged operation.** `renderDashboard` takes a
 * plain value and returns a string. There is no fetch, no D1 handle, and no ECS
 * client in its signature, so "rendering does no privileged work" is a property
 * of the types rather than a rule an author has to remember.
 *
 * **Every dynamic value is escaped.** All of this content originates from an
 * external API response, a driver error, or a run report, and the document is
 * served to a browser holding the operator's session. An unescaped value is an
 * XSS with a credential's reach, and some of these fields are stored error
 * messages that a remote service composed.
 *
 * No frontend framework and no build step: the output is one HTML string.
 */

import type { HistoryRow } from "../storage/read";
import { redact } from "../redact";

/** What the dashboard renders from. */
export interface DashboardInput {
  /** The most recent run, or `undefined` when there is no history yet. */
  readonly latest: HistoryRow | undefined;
  /** Recent runs, newest first, already bounded by the read path. */
  readonly history: readonly HistoryRow[];
  /** Whether the last run's history write succeeded, when known. */
  readonly storageOk?: boolean | undefined;
}

/**
 * The maximum number of rows the table will render.
 *
 * The read path already bounds its query, but the renderer bounds again: a
 * caller passing an unbounded array must not be able to produce an unbounded
 * document, and "the dashboard cannot return more than N rows" is a property
 * worth holding at the point the document is built.
 */
export const DASHBOARD_ROW_LIMIT = 50;

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 *
 * Covers the five characters that can change parsing in either context:
 * `&`, `<`, `>`, `"`, and `'`. Quotes are escaped because a value may land in an
 * attribute — escaping only `&<>` is the classic incomplete fix.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `null`/`undefined` render as an explicit unknown marker, never as `0`. */
function numberOrUnknown(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return `<span class="unknown">unknown</span>`;
  }
  return `${escapeHtml(String(value))}${escapeHtml(suffix)}`;
}

function textOrUnknown(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return `<span class="unknown">unknown</span>`;
  }
  return escapeHtml(value);
}

/** A boolean stored as SQLite 0/1, rendered honestly when absent. */
function boolOrUnknown(value: number | null | undefined): string {
  if (value === null || value === undefined) return `<span class="unknown">unknown</span>`;
  return value === 1 ? "yes" : "no";
}

function percentage(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return `<span class="unknown">unknown</span>`;
  }
  return `${escapeHtml(value.toFixed(1))}%`;
}

function row(cells: readonly string[]): string {
  return `        <tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
}

function field(label: string, value: string): string {
  return `      <div class="field"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

/**
 * Render the dashboard.
 *
 * Pure: identical input yields an identical document, and no I/O occurs.
 */
export function renderDashboard(input: DashboardInput): string {
  const { latest, history, storageOk } = input;

  // Error messages are redacted before rendering, not merely escaped. Escaping
  // stops the value changing the document's structure; redaction stops a
  // credential that a remote service echoed into the message from being
  // *displayed* at all. Both are needed, and they are different concerns.
  const errorMessage =
    latest?.error_message === undefined || latest.error_message === null
      ? null
      : redact(latest.error_message);

  const summary =
    latest === undefined
      ? `    <p class="empty">No history yet. No scheduled run has been recorded.</p>`
      : [
          `    <dl class="summary">`,
          field("Current CDT traffic (GB)", numberOrUnknown(latest.traffic_gb, " GB")),
          field("Configured threshold (GB)", numberOrUnknown(latest.threshold_gb, " GB")),
          field("Usage", percentage(latest.usage_percent)),
          field("Remaining before threshold", numberOrUnknown(latest.remaining_gb, " GB")),
          field("Current ECS state", textOrUnknown(latest.ecs_status_before)),
          field("Desired ECS state", textOrUnknown(latest.desired_ecs_state)),
          field("Decision reason", textOrUnknown(latest.decision_reason)),
          field("Last action", textOrUnknown(latest.action)),
          field("ECS state after", textOrUnknown(latest.ecs_status_after)),
          field("Last scheduled execution", textOrUnknown(latest.checked_at)),
          field("Execution result", textOrUnknown(latest.status)),
          field("Error stage", textOrUnknown(latest.error_stage)),
          field(
            "Error",
            errorMessage === null ? `<span class="unknown">none</span>` : escapeHtml(errorMessage),
          ),
          field("Webhook attempted", boolOrUnknown(latest.webhook_attempted)),
          field("Webhook result", boolOrUnknown(latest.webhook_ok)),
          field(
            "History persistence",
            storageOk === undefined
              ? `<span class="unknown">unknown</span>`
              : storageOk
                ? "ok"
                : "failed",
          ),
          field("Duration", numberOrUnknown(latest.duration_ms, " ms")),
          `    </dl>`,
        ].join("\n");

  const rows = history.slice(0, DASHBOARD_ROW_LIMIT);
  const table =
    rows.length === 0
      ? `    <p class="empty">No history yet. No scheduled run has been recorded.</p>`
      : [
          `    <table>`,
          `      <thead><tr>${[
            "Time",
            "Status",
            "Traffic (GB)",
            "Threshold (GB)",
            "ECS before",
            "Desired",
            "Action",
            "Decision reason",
            "ECS after",
            "Webhook",
            "Duration (ms)",
          ]
            .map((h) => `<th>${escapeHtml(h)}</th>`)
            .join("")}</tr></thead>`,
          `      <tbody>`,
          ...rows.map((r) =>
            row([
              textOrUnknown(r.checked_at),
              textOrUnknown(r.status),
              numberOrUnknown(r.traffic_gb),
              numberOrUnknown(r.threshold_gb),
              textOrUnknown(r.ecs_status_before),
              textOrUnknown(r.desired_ecs_state),
              textOrUnknown(r.action),
              textOrUnknown(r.decision_reason),
              textOrUnknown(r.ecs_status_after),
              boolOrUnknown(r.webhook_ok),
              numberOrUnknown(r.duration_ms),
            ]),
          ),
          `      </tbody>`,
          `    </table>`,
        ].join("\n");

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `  <head>`,
    `    <meta charset="utf-8">`,
    `    <meta name="viewport" content="width=device-width, initial-scale=1">`,
    // No external resources, so the document cannot leak a request to a third
    // party, and no inline script, so there is no script context to escape into.
    `    <title>CFWorker4AliCDT</title>`,
    `  </head>`,
    `  <body>`,
    `    <h1>CFWorker4AliCDT monitoring</h1>`,
    summary,
    `    <h2>Recent runs</h2>`,
    table,
    `  </body>`,
    `</html>`,
  ].join("\n");
}
