const INCIDENT_PREFIX = "[production-health]";

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

function incidentHost(result) {
  try {
    return new URL(result.probe_url).hostname.toLowerCase();
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

function evidenceLines(result) {
  const lines = [
    `- Timestamp (UTC): ${redactSensitiveText(result.timestamp) || "unknown"}`,
    `- HTTP status: ${Number.isInteger(result.http_status) ? result.http_status : "no response"}`,
    `- Latency: ${Number.isFinite(result.latency_ms) ? `${result.latency_ms} ms` : "unavailable"}`,
    `- Attempts: ${Number.isInteger(result.attempts) ? result.attempts : "unknown"}`,
    "- Cron health: UNKNOWN",
  ];
  const runUrl = safeRunUrl(result);
  if (runUrl) lines.push(`- Actions run: ${runUrl}`);
  return lines;
}

export function incidentTitle(result) {
  return `${INCIDENT_PREFIX} ${incidentHost(result)}`;
}

export function buildIncidentBody(result) {
  const lines = [
    "The production HTTP health probe failed after its configured retries.",
    "",
    ...evidenceLines(result),
    `- Failure reason: ${redactSensitiveText(result.failure_reason) || "unspecified probe failure"}`,
    "",
    "This records HTTP `/health` evidence only. It does not report Cron or ECS health.",
  ];
  return lines.join("\n");
}

export function buildRecoveryComment(result) {
  return [
    "Production HTTP health has recovered.",
    "",
    ...evidenceLines({ ...result, failure_reason: null }),
    "",
    "This records HTTP `/health` evidence only. Cron health remains UNKNOWN; ECS health is not measured.",
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

/** Sync exactly one monitor's incident using an injectable, argv-based gh runner. */
export async function syncIncident(result, gh) {
  if (typeof gh !== "function") throw new TypeError("A GitHub CLI runner is required");

  const title = incidentTitle(result);
  const matching = await findOpenIncidents(title, gh);

  if (!result.ok) {
    const body = buildIncidentBody(result);
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
        "Duplicate production health incident consolidated into the oldest open issue.",
      ]);
    }
    return { action: "updated", issueNumber: primary.number };
  }

  const recovery = buildRecoveryComment(result);
  for (const issue of matching) {
    await gh(["issue", "close", String(issue.number), "--comment", recovery]);
  }
  return {
    action: matching.length > 0 ? "closed" : "none",
    issueNumber: matching[0]?.number ?? null,
  };
}

export { redactSensitiveText };
