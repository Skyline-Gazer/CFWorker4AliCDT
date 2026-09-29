import { redactSensitiveText } from "./incident.mjs";

/** Render only the public HTTP evidence; Cron telemetry is intentionally absent. */
export function renderSummary(result) {
  const rows = [
    ["Timestamp (UTC)", redactSensitiveText(result.timestamp) || "unknown"],
    ["Probe URL", redactSensitiveText(result.probe_url) || "unavailable"],
    [
      "HTTP status",
      Number.isInteger(result.http_status) ? String(result.http_status) : "no response",
    ],
    ["Latency", Number.isFinite(result.latency_ms) ? `${result.latency_ms} ms` : "unavailable"],
    ["Attempts", Number.isInteger(result.attempts) ? String(result.attempts) : "unknown"],
    ["HTTP health", result.ok === true ? "OK" : "FAILED"],
    ["Cron health", "UNKNOWN"],
  ];

  const summary = [
    "## Production HTTP health",
    "",
    "| Evidence | Result |",
    "| --- | --- |",
    ...rows.map(([label, value]) => `| ${label} | ${value.replaceAll("|", "\\|")} |`),
  ];

  if (result.failure_reason) {
    summary.push("", `Failure reason: ${redactSensitiveText(result.failure_reason)}`);
  }

  summary.push(
    "",
    "`/health` measures the Worker HTTP response only. Cron health is UNKNOWN until secure Cron telemetry exists; ECS health is not measured.",
    "",
  );
  return summary.join("\n");
}
