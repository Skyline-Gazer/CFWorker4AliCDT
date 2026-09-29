import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../scripts/production-health/handle-incident.mjs";
import type { GhRunner } from "../../scripts/production-health/incident.mjs";

const originalExitCode = process.exitCode;
const tempDirectories: string[] = [];

afterEach(async () => {
  process.exitCode = originalExitCode;
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function resultFile(result: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "production-health-test-"));
  tempDirectories.push(directory);
  const path = join(directory, "result.json");
  await writeFile(path, `${JSON.stringify(result)}\n`, "utf8");
  return path;
}

function incidentGh(createdTitles: string[]): GhRunner {
  return (args) => {
    if (args[0] === "issue" && args[1] === "list") return Promise.resolve("[]");
    if (args[0] === "issue" && args[1] === "create") {
      createdTitles.push(args[args.indexOf("--title") + 1] ?? "");
    }
    return Promise.resolve("");
  };
}

describe("production health incident workflow exit semantics", () => {
  it("tracks a Cron-only failure without failing a healthy HTTP job", async () => {
    process.exitCode = 0;
    const createdTitles: string[] = [];
    const path = await resultFile({
      timestamp: "2026-09-29T00:17:00.000Z",
      ok: true,
      http_status: 200,
      probe_url: "https://cdt.q9m3.com/health",
      cron_health: "UNHEALTHY",
      cron_ok: false,
      cron_telemetry_available: true,
      cron_probe_url: "https://cdt.q9m3.com/api/monitor/cron",
      cron_failure_reason: "Cron health UNHEALTHY",
    });

    await main({ resultPath: path, gh: incidentGh(createdTitles) });

    expect(process.exitCode).toBe(0);
    expect(createdTitles).toEqual(["[production-cron] cdt.q9m3.com"]);
  });

  it("keeps HTTP failure as the job failure condition when Cron is healthy", async () => {
    process.exitCode = 0;
    const createdTitles: string[] = [];
    const path = await resultFile({
      timestamp: "2026-09-29T00:17:00.000Z",
      ok: false,
      http_status: 500,
      failure_reason: "Unexpected HTTP status 500",
      probe_url: "https://cdt.q9m3.com/health",
      cron_health: "HEALTHY",
      cron_ok: true,
      cron_telemetry_available: true,
      cron_probe_url: "https://cdt.q9m3.com/api/monitor/cron",
    });

    await main({ resultPath: path, gh: incidentGh(createdTitles) });

    expect(process.exitCode).toBe(1);
    expect(createdTitles).toEqual(["[production-health] cdt.q9m3.com"]);
  });
});
