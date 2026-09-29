import { appendFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { probeHealth } from "./probe.mjs";
import { renderSummary } from "./render-summary.mjs";

export async function main(env = process.env) {
  const resultPath = env.PRODUCTION_HEALTH_RESULT_FILE || "production-health-result.json";
  const probeUrl = env.PROBE_URL || "https://cdt.q9m3.com/health";
  const runUrl = env.RUN_URL || "";
  const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value || "", 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };

  const result = await probeHealth({
    url: probeUrl,
    runUrl,
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
