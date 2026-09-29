const EXPECTED_STATUS = "ok";
const EXPECTED_SERVICE = "cfworker4alicdt";
const EXPECTED_HTTP_STATUS = 200;
const CRON_HEALTH = "UNKNOWN";

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

function safeProbeUrl(parsed) {
  const publicPath = parsed.pathname === "/health" ? "/health" : "/[path-redacted]";
  return `${parsed.origin}${publicPath}`;
}

function failureResult(reason, attempts, status, latency, probeUrl, runUrl, timestamp) {
  return {
    timestamp,
    http_status: status,
    latency_ms: latency,
    ok: false,
    failure_reason: reason,
    probe_url: probeUrl,
    cron_health: CRON_HEALTH,
    attempts,
    expected_status: EXPECTED_HTTP_STATUS,
    expected_body_status: EXPECTED_STATUS,
    expected_service: EXPECTED_SERVICE,
    ...(runUrl ? { run_url: runUrl } : {}),
  };
}

async function attemptProbe({ fetchImpl, url, timeoutMs }) {
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

/**
 * Probe a public HTTPS health URL without exposing response bodies or transport
 * error details. The injected fetch, clock, and delay keep unit tests offline.
 */
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
  const safeUrl = parsedUrl ? safeProbeUrl(parsedUrl) : "[invalid HTTPS probe URL]";
  const safeRunUrl = typeof runUrl === "string" ? runUrl.replace(/[\u0000-\u0020<>`]/g, "") : "";
  const timestamp = () => new Date(now()).toISOString();

  if (!parsedUrl) {
    return failureResult(
      "Probe URL must be HTTPS and must not contain credentials, query parameters, or fragments",
      0,
      null,
      null,
      safeUrl,
      safeRunUrl,
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
    const outcome = await attemptProbe({
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
        cron_health: CRON_HEALTH,
        attempts: attempt,
        expected_status: EXPECTED_HTTP_STATUS,
        expected_body_status: EXPECTED_STATUS,
        expected_service: EXPECTED_SERVICE,
        ...(safeRunUrl ? { run_url: safeRunUrl } : {}),
      };
    }

    if (attempt < attemptsLimit) await delay(Math.max(0, backoffMs));
  }

  return failureResult(reason, attemptsLimit, status, latency, safeUrl, safeRunUrl, timestamp());
}
