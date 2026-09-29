const HTTP_INCIDENT_PREFIX = "[production-health]";
const CRON_INCIDENT_PREFIX = "[production-cron]";

function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/["']?\bauthorization\b["']?\s*[:=]\s*[^,\r\n]*/gi, "Authorization: [REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/["']?\b(set-cookie|cookie)\b["']?\s*[:=]\s*[^\r\n]*/gi, "$1: [REDACTED]")
    .replace(
      /["']?\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,\s;}\]]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function incidentHost(result, component) {
  try {
    const candidate = component === "cron" ? result.cron_probe_url : result.probe_url;
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return "unknown-host";
  }
}

function safeRunUrl(result) {
  if (typeof result.run_url !== "string") return null;
  try {
    const url = new URL(result.run_url);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function evidenceLines(result, component) {
  const lines = [`- Timestamp (UTC): ${redactSensitiveText(result.timestamp) || "unknown"}`];

  if (component === "http") {
    lines.push(
      `- HTTP status: ${Number.isInteger(result.http_status) ? result.http_status : "no response"}`,
      `- Latency: ${Number.isFinite(result.latency_ms) ? `${result.latency_ms} ms` : "unavailable"}`,
      `- Attempts: ${Number.isInteger(result.attempts) ? result.attempts : "unknown"}`,
      "- HTTP health: FAILED",
    );
  } else {
    lines.push(
      `- Cron health: ${["HEALTHY", "DEGRADED", "UNHEALTHY", "UNKNOWN"].includes(result.cron_health) ? result.cron_health : "UNKNOWN"}`,
      `- Telemetry available: ${result.cron_telemetry_available === true ? "yes" : "no"}`,
      `- Probe attempts: ${Number.isInteger(result.cron_probe_attempts) ? result.cron_probe_attempts : "unknown"}`,
      `- Recent successes: ${Number.isInteger(result.cron_recent_success_count) ? result.cron_recent_success_count : "unknown"}`,
      `- Recent failures: ${Number.isInteger(result.cron_recent_failure_count) ? result.cron_recent_failure_count : "unknown"}`,
      `- Failure classification: ${redactSensitiveText(result.cron_failure_classification) || "none"}`,
    );
  }

  const runUrl = safeRunUrl(result);
  if (runUrl) lines.push(`- Actions run: ${runUrl}`);
  return lines;
}

export function incidentTitle(result) {
  return `${HTTP_INCIDENT_PREFIX} ${incidentHost(result, "http")}`;
}

export function cronIncidentTitle(result) {
  return `${CRON_INCIDENT_PREFIX} ${incidentHost(result, "cron")}`;
}

export function buildIncidentBody(result, component = "http") {
  if (component === "cron") {
    return [
      "The production Cron telemetry probe is not healthy or is unavailable.",
      "",
      ...evidenceLines(result, "cron"),
      `- Cron result: ${redactSensitiveText(result.cron_failure_reason) || "telemetry is not HEALTHY"}`,
      "",
      "This records read-only Cron history telemetry. It does not authorize or perform ECS control.",
    ].join("\n");
  }

  return [
    "The production HTTP health probe failed after its configured retries.",
    "",
    ...evidenceLines(result, "http"),
    `- Failure reason: ${redactSensitiveText(result.failure_reason) || "unspecified probe failure"}`,
    "",
    "This records HTTP `/health` evidence only. It does not report Cron or ECS health.",
  ].join("\n");
}

export function buildRecoveryComment(result, component = "http") {
  if (component === "cron") {
    return [
      "Production Cron telemetry has recovered.",
      "",
      ...evidenceLines(result, "cron"),
      "",
      "This records read-only Cron history telemetry. HTTP and ECS health are separate signals.",
    ].join("\n");
  }

  return [
    "Production HTTP health has recovered.",
    "",
    ...evidenceLines(result, "http"),
    "",
    "This records HTTP `/health` evidence only. Cron and ECS health are separate signals.",
  ].join("\n");
}

function validIssues(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (issue) =>
      issue !== null &&
      typeof issue === "object" &&
      Number.isInteger(issue.number) &&
      issue.number > 0 &&
      typeof issue.title === "string",
  );
}

async function findOpenIncidents(title, gh) {
  const output = await gh([
    "issue",
    "list",
    "--state",
    "open",
    "--search",
    `in:title "${title}"`,
    "--limit",
    "100",
    "--json",
    "number,title",
  ]);
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Could not read open incident issues from GitHub");
  }
  return validIssues(parsed)
    .filter((issue) => issue.title === title)
    .sort((left, right) => left.number - right.number);
}

async function syncComponentIncident(result, gh, component) {
  const isHttp = component === "http";
  const title = isHttp ? incidentTitle(result) : cronIncidentTitle(result);
  const failed = isHttp ? result.ok !== true : result.cron_ok !== true;
  const matching = await findOpenIncidents(title, gh);

  if (failed) {
    const body = buildIncidentBody(result, component);
    const primary = matching[0];
    if (!primary) {
      await gh(["issue", "create", "--title", title, "--body", body]);
      return { action: "created", issueNumber: null };
    }

    await gh(["issue", "comment", String(primary.number), "--body", body]);
    for (const duplicate of matching.slice(1)) {
      await gh([
        "issue",
        "close",
        String(duplicate.number),
        "--comment",
        `Duplicate ${component === "http" ? "production HTTP health" : "production Cron telemetry"} incident consolidated into the oldest open issue.`,
      ]);
    }
    return { action: "updated", issueNumber: primary.number };
  }

  const recovery = buildRecoveryComment(result, component);
  for (const issue of matching) {
    await gh(["issue", "comment", String(issue.number), "--body", recovery]);
    await gh(["issue", "close", String(issue.number)]);
  }
  return {
    action: matching.length > 0 ? "closed" : "none",
    issueNumber: matching[0]?.number ?? null,
  };
}

/** Sync the HTTP `/health` incident only. */
export async function syncIncident(result, gh) {
  if (typeof gh !== "function") throw new TypeError("A GitHub CLI runner is required");
  return syncComponentIncident(result, gh, "http");
}

/** Sync the Cron monitor incident only. */
export async function syncCronIncident(result, gh) {
  if (typeof gh !== "function") throw new TypeError("A GitHub CLI runner is required");
  if (typeof result.cron_ok !== "boolean") return { action: "none", issueNumber: null };
  return syncComponentIncident(result, gh, "cron");
}

/** Keep both incident lifecycles independent and tied to exact, separate titles. */
export async function syncIncidents(result, gh) {
  const http = await syncIncident(result, gh);
  const cron = await syncCronIncident(result, gh);
  return { http, cron };
}

export { redactSensitiveText };
