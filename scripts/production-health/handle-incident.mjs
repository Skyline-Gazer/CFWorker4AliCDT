import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { syncIncident } from "./incident.mjs";

const execFileAsync = promisify(execFile);

export async function runGh(args) {
  const { stdout } = await execFileAsync("gh", args, {
    encoding: "utf8",
    maxBuffer: 1_000_000,
    env: process.env,
  });
  return stdout;
}

export async function main({ resultPath = "production-health-result.json", gh = runGh } = {}) {
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  // Reassert the invariant at the GitHub boundary even if an artifact was edited.
  result.cron_health = "UNKNOWN";
  await syncIncident(result, gh);
  if (result.ok !== true) process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    process.stderr.write("Production health incident handling failed.\n");
    process.exitCode = 1;
  }
}
