import { appendFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { probeHealth } from "./probe.mjs";
import { probeCron } from "./probe.mjs";
import { renderSummary } from "./render-summary.mjs";

export async function probeProductionHealth({
  httpUrl = "https://cdt.q9m3.com/health",
  cronUrl = "https://cdt.q9m3.com/api/monitor/cron",
  monitorToken,
  runUrl = "",
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  delay,
  timeoutMs = 10_000,
  maxAttempts = 3,
  backoffMs = 500,
} = {}) {
  const [http, cron] = await Promise.all([
    probeHealth({
      url: httpUrl,
      runUrl,
      fetchImpl,
      now,
      delay,
      timeoutMs,
      maxAttempts,
      backoffMs,
    }),
    probeCron({
      url: cronUrl,
      token: monitorToken,
      fetchImpl,
      delay,
      timeoutMs,
      maxAttempts,
      backoffMs,
    }),
  ]);

  return {
    ...http,
    http_ok: http.ok,
    http_status: http.http_status,
    http_latency_ms: http.latency_ms,
    http_failure_reason: http.failure_reason,
    http_probe_url: http.probe_url,
    http_attempts: http.attempts,
    ...cron,
  };
}

export async function main(env = process.env, options = {}) {
  const resultPath = env.PRODUCTION_HEALTH_RESULT_FILE || "production-health-result.json";
  const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value || "", 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };

  const result = await probeProductionHealth({
    httpUrl: env.PROBE_URL || "https://cdt.q9m3.com/health",
    cronUrl: env.CRON_PROBE_URL || "https://cdt.q9m3.com/api/monitor/cron",
    monitorToken: env.MONITOR_READ_TOKEN,
    runUrl: env.RUN_URL || "",
    fetchImpl: options.fetchImpl,
    now: options.now,
    delay: options.delay,
    timeoutMs: parsePositiveInt(env.PROBE_TIMEOUT_MS, 10_000),
    maxAttempts: parsePositiveInt(env.PROBE_MAX_ATTEMPTS, 3),
    backoffMs: parsePositiveInt(env.PROBE_BACKOFF_MS, 500),
  });

  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `${renderSummary(result)}\n`, "utf8");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    process.stderr.write("Production health probe runner could not write its result.\n");
    process.exitCode = 1;
  }
}
