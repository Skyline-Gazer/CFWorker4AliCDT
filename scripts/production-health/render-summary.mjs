import { redactSensitiveText } from "./incident.mjs";

/** Render HTTP and Cron evidence independently, without credentials or bodies. */
export function renderSummary(result) {
  const httpRows = [
    ["Timestamp (UTC)", redactSensitiveText(result.timestamp) || "unknown"],
    ["Probe URL", redactSensitiveText(result.http_probe_url ?? result.probe_url) || "unavailable"],
    [
      "HTTP status",
      Number.isInteger(result.http_status) ? String(result.http_status) : "no response",
    ],
    ["Latency", Number.isFinite(result.latency_ms) ? `${result.latency_ms} ms` : "unavailable"],
    ["Attempts", Number.isInteger(result.attempts) ? String(result.attempts) : "unknown"],
    ["HTTP health", (result.http_ok ?? result.ok) === true ? "OK" : "FAILED"],
  ];

  const summary = [
    "## Production health",
    "",
    "### HTTP `/health`",
    "",
    "| Evidence | Result |",
    "| --- | --- |",
    ...httpRows.map(([label, value]) => `| ${label} | ${value.replaceAll("|", "\\|")} |`),
    "",
    "### Cron telemetry",
    "",
    "| Evidence | Result |",
    "| --- | --- |",
    ...[
      ["Cron health", result.cron_health ?? "UNKNOWN"],
      ["Telemetry available", result.cron_telemetry_available === true ? "yes" : "no"],
      ["Last execution (UTC)", result.cron_last_execution_ts ?? "unknown"],
      ["Last success (UTC)", result.cron_last_success_ts ?? "unknown"],
      [
        "Recent successes",
        Number.isInteger(result.cron_recent_success_count)
          ? String(result.cron_recent_success_count)
          : "unknown",
      ],
      [
        "Recent failures",
        Number.isInteger(result.cron_recent_failure_count)
          ? String(result.cron_recent_failure_count)
          : "unknown",
      ],
      ["Failure classification", result.cron_failure_classification ?? "none"],
      [
        "Cron probe attempts",
        Number.isInteger(result.cron_probe_attempts)
          ? String(result.cron_probe_attempts)
          : "unknown",
      ],
    ].map(
      ([label, value]) => `| ${label} | ${redactSensitiveText(value).replaceAll("|", "\\|")} |`,
    ),
  ];

  if (result.failure_reason) {
    summary.push("", `HTTP failure reason: ${redactSensitiveText(result.failure_reason)}`);
  }
  if (result.cron_failure_reason) {
    summary.push("", `Cron failure reason: ${redactSensitiveText(result.cron_failure_reason)}`);
  }

  summary.push(
    "",
    "HTTP `/health` and Cron telemetry are independent signals. The Cron monitor is read-only and does not report ECS health.",
    "",
  );
  return summary.join("\n");
}
