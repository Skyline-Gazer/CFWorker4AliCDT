const EXPECTED_STATUS = "ok";
const EXPECTED_SERVICE = "cfworker4alicdt";
const EXPECTED_HTTP_STATUS = 200;
const CRON_HEALTH_VALUES = new Set(["HEALTHY", "DEGRADED", "UNHEALTHY", "UNKNOWN"]);
const LATEST_STATUS_VALUES = new Set(["success", "error", "unknown"]);
const FAILURE_CLASSIFICATIONS = new Set([
  "CONFIGURATION",
  "CDT_QUERY",
  "ECS_DESCRIBE",
  "ECS_START",
  "ECS_STOP",
  "WEBHOOK",
  "UNEXPECTED",
  "UNCLASSIFIED",
]);
const TELEMETRY_ERRORS = new Set(["D1_UNAVAILABLE", "D1_QUERY_FAILED"]);

class ProbeTimeoutError extends Error {}

function parseProbeUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeProbeUrl(parsed, knownPath) {
  const publicPath = parsed.pathname === knownPath ? knownPath : "/[path-redacted]";
  return `${parsed.origin}${publicPath}`;
}

function safeRunUrl(runUrl) {
  if (typeof runUrl !== "string") return "";
  try {
    const parsed = new URL(runUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function httpFailureResult(reason, attempts, status, latency, probeUrl, runUrl, timestamp) {
  return {
    timestamp,
    http_status: status,
    latency_ms: latency,
    ok: false,
    failure_reason: reason,
    probe_url: probeUrl,
    cron_health: "UNKNOWN",
    cron_ok: false,
    cron_telemetry_available: false,
    cron_failure_reason: "MONITOR_TOKEN_MISSING",
    attempts,
    expected_status: EXPECTED_HTTP_STATUS,
    expected_body_status: EXPECTED_STATUS,
    expected_service: EXPECTED_SERVICE,
    ...(runUrl ? { run_url: runUrl } : {}),
  };
}

async function attemptHttpProbe({ fetchImpl, url, timeoutMs }) {
  const controller = new AbortController();
  let timeoutId;
  let timedOut = false;

  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      if (timedOut) throw new ProbeTimeoutError();
      return { ok: false, status: null, reason: "Network request failed" };
    }

    if (response.status !== EXPECTED_HTTP_STATUS) {
      return {
        ok: false,
        status: Number.isFinite(response.status) ? response.status : null,
        reason: `Unexpected HTTP status ${response.status}`,
      };
    }

    let body;
    try {
      body = await response.json();
    } catch {
      if (timedOut) throw new ProbeTimeoutError();
      return {
        ok: false,
        status: EXPECTED_HTTP_STATUS,
        reason: "Response body was not valid JSON",
      };
    }

    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      body.status !== EXPECTED_STATUS ||
      body.service !== EXPECTED_SERVICE
    ) {
      return {
        ok: false,
        status: EXPECTED_HTTP_STATUS,
        reason: "Health response did not match the expected contract",
      };
    }

    return { ok: true, status: EXPECTED_HTTP_STATUS, reason: null };
  })();

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProbeTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof ProbeTimeoutError) {
      return { ok: false, status: null, reason: `Request timed out after ${timeoutMs} ms` };
    }
    return { ok: false, status: null, reason: "Network request failed" };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Public HTTP liveness probe; injected fetch/clock/delay keep tests offline. */
export async function probeHealth({
  url = "https://cdt.q9m3.com/health",
  runUrl = "",
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 10_000,
  maxAttempts = 3,
  backoffMs = 500,
} = {}) {
  const parsedUrl = parseProbeUrl(String(url));
  const safeUrl = parsedUrl ? safeProbeUrl(parsedUrl, "/health") : "[invalid HTTPS probe URL]";
  const safeRun = safeRunUrl(runUrl);
  const timestamp = () => new Date(now()).toISOString();

  if (!parsedUrl) {
    return httpFailureResult(
      "Probe URL must be HTTPS and must not contain credentials, query parameters, or fragments",
      0,
      null,
      null,
      safeUrl,
      safeRun,
      timestamp(),
    );
  }

  const attemptsLimit = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
  let status = null;
  let latency = null;
  let reason = "Network request failed";

  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    const startedAt = now();
    const outcome = await attemptHttpProbe({
      fetchImpl,
      url: `${parsedUrl.origin}${parsedUrl.pathname}`,
      timeoutMs: boundedTimeout,
    });
    latency = Math.max(0, now() - startedAt);
    status = outcome.status;
    reason = outcome.reason;

    if (outcome.ok) {
      return {
        timestamp: timestamp(),
        http_status: EXPECTED_HTTP_STATUS,
        latency_ms: latency,
        ok: true,
        failure_reason: null,
        probe_url: safeUrl,
        cron_health: "UNKNOWN",
        cron_ok: false,
        cron_telemetry_available: false,
        cron_failure_reason: "MONITOR_TOKEN_MISSING",
        attempts: attempt,
        expected_status: EXPECTED_HTTP_STATUS,
        expected_body_status: EXPECTED_STATUS,
        expected_service: EXPECTED_SERVICE,
        ...(safeRun ? { run_url: safeRun } : {}),
      };
    }

    if (attempt < attemptsLimit) await delay(Math.max(0, backoffMs));
  }

  return httpFailureResult(reason, attemptsLimit, status, latency, safeUrl, safeRun, timestamp());
}

function validIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validateCronBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  if (!validIsoTimestamp(body.observation_ts)) return null;
  if (body.last_execution_ts !== null && !validIsoTimestamp(body.last_execution_ts)) return null;
  if (body.last_success_ts !== null && !validIsoTimestamp(body.last_success_ts)) return null;
  if (!CRON_HEALTH_VALUES.has(body.cron_health)) return null;
  if (!LATEST_STATUS_VALUES.has(body.latest_status) && body.latest_status !== null) return null;
  if (!Number.isSafeInteger(body.recent_success_count) || body.recent_success_count < 0)
    return null;
  if (!Number.isSafeInteger(body.recent_failure_count) || body.recent_failure_count < 0)
    return null;
  if (typeof body.telemetry_available !== "boolean") return null;
  if (
    body.failure_classification !== null &&
    !FAILURE_CLASSIFICATIONS.has(body.failure_classification)
  ) {
    return null;
  }
  if (body.telemetry_error !== undefined && !TELEMETRY_ERRORS.has(body.telemetry_error))
    return null;
  return body;
}

function cronResult({ snapshot, failureReason, attempts, url }) {
  const telemetryAvailable = snapshot?.telemetry_available === true;
  const health = CRON_HEALTH_VALUES.has(snapshot?.cron_health) ? snapshot.cron_health : "UNKNOWN";
  const cronOk = telemetryAvailable && health === "HEALTHY";
  const base = {
    cron_health: health,
    cron_ok: cronOk,
    cron_telemetry_available: telemetryAvailable,
    cron_failure_reason:
      failureReason ??
      (cronOk
        ? null
        : (snapshot?.telemetry_error ??
          (telemetryAvailable ? `Cron health ${health}` : "Cron telemetry unavailable"))),
    cron_probe_url: url,
    cron_probe_attempts: attempts,
  };
  if (snapshot === null) return base;

  return {
    ...base,
    cron_observation_ts: snapshot.observation_ts,
    cron_last_execution_ts: snapshot.last_execution_ts,
    cron_last_success_ts: snapshot.last_success_ts,
    cron_latest_status: snapshot.latest_status,
    cron_recent_success_count: snapshot.recent_success_count,
    cron_recent_failure_count: snapshot.recent_failure_count,
    cron_failure_classification: snapshot.failure_classification,
    ...(snapshot.telemetry_error ? { cron_telemetry_error: snapshot.telemetry_error } : {}),
  };
}

async function attemptCronProbe({ fetchImpl, url, token, timeoutMs }) {
  const controller = new AbortController();
  let timeoutId;
  let timedOut = false;
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
    } catch {
      if (timedOut) throw new ProbeTimeoutError();
      return { ok: false, reason: "Network request failed" };
    }
    if (response.status !== 200) {
      return { ok: false, reason: `Cron monitor returned HTTP ${response.status}` };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      if (timedOut) throw new ProbeTimeoutError();
      return { ok: false, reason: "Cron monitor response was not valid JSON" };
    }
    const snapshot = validateCronBody(body);
    if (snapshot === null)
      return { ok: false, reason: "Cron monitor response did not match the expected contract" };
    return { ok: true, snapshot };
  })();

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProbeTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof ProbeTimeoutError) {
      return { ok: false, reason: `Request timed out after ${timeoutMs} ms` };
    }
    return { ok: false, reason: "Network request failed" };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Authenticated Cron telemetry probe. The token is used only in the header. */
export async function probeCron({
  url = "https://cdt.q9m3.com/api/monitor/cron",
  token,
  fetchImpl = globalThis.fetch,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 10_000,
  maxAttempts = 3,
  backoffMs = 500,
} = {}) {
  const parsedUrl = parseProbeUrl(String(url));
  const safeUrl = parsedUrl
    ? safeProbeUrl(parsedUrl, "/api/monitor/cron")
    : "[invalid HTTPS Cron monitor URL]";

  if (typeof token !== "string" || token.trim() === "") {
    return cronResult({
      snapshot: null,
      failureReason: "MONITOR_TOKEN_MISSING",
      attempts: 0,
      url: safeUrl,
    });
  }
  if (!parsedUrl) {
    return cronResult({
      snapshot: null,
      failureReason: "Invalid Cron monitor URL",
      attempts: 0,
      url: safeUrl,
    });
  }

  const attemptsLimit = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
  let reason = "Network request failed";
  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    const outcome = await attemptCronProbe({
      fetchImpl,
      url: `${parsedUrl.origin}${parsedUrl.pathname}`,
      token,
      timeoutMs: boundedTimeout,
    });
    if (outcome.ok) {
      return cronResult({ snapshot: outcome.snapshot, attempts: attempt, url: safeUrl });
    }
    reason = outcome.reason;
    if (attempt < attemptsLimit) await delay(Math.max(0, backoffMs));
  }
  return cronResult({
    snapshot: null,
    failureReason: reason,
    attempts: attemptsLimit,
    url: safeUrl,
  });
}
