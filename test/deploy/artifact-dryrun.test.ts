import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

/**
 * Deployment-path artefact verification (mandatory lesson from PR #66).
 *
 * A dry-run against `wrangler.jsonc` does **not** prove that
 * `wrangler.preflight.jsonc` or `wrangler.deploy.jsonc` works. The earlier
 * config-path defect passed CI precisely because the dry-run in `npm run
 * validate` tested a different file than the deploy path used.
 *
 * So these tests run Wrangler against the **exact generated artefact** and assert
 * the three things that only resolve if the file is genuinely usable:
 *
 * 1. the entry point (`main`) resolves;
 * 2. the `TRAFFIC_DB` binding resolves, with the injected `database_id`;
 * 3. the config passes Wrangler's own schema validation.
 *
 * Wrangler is invoked as the local dependency, never through `npx`, so the test
 * does not reach the network to resolve a package.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const WRANGLER_BIN = join(REPO_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const RESOLVER = join(REPO_ROOT, "scripts", "resolve-deploy-config.mjs");

/**
 * Scratch configs for this file. They must sit at the repository root, because
 * Wrangler resolves `main` relative to the config's directory and the resolver
 * refuses any other location. The prefix is file-unique so parallel test files do
 * not race on one path, and `wrangler.test-*` is gitignored.
 */
const SCRATCH_PREFIX = "wrangler.test-artifact-";

const FAKE_DATABASE_ID = "11111111-2222-3333-4444-555555555555";

/** Wrangler writes diagnostics to a log file; keep that out of the real HOME. */
const LOG_DIR = mkdtempSync(join(tmpdir(), "wrangler-logs-"));

/** Every scratch config this file wrote, so cleanup never touches anything else. */
function listScratchFiles(): string[] {
  return readdirSync(REPO_ROOT)
    .filter((name) => name.startsWith(SCRATCH_PREFIX))
    .map((name) => join(REPO_ROOT, name));
}

afterAll(() => {
  rmSync(LOG_DIR, { recursive: true, force: true });
  for (const file of listScratchFiles()) rmSync(file, { force: true });
});

function resolverEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CI: "true",
    ...extra,
  };
}

/** Generate one config at a scratch path, and fail loudly if the resolver does. */
function generate(mode: string, label: string, extra: Record<string, string>): string {
  const outputPath = join(REPO_ROOT, `${SCRATCH_PREFIX}${label}.jsonc`);
  const result = spawnSync(process.execPath, [RESOLVER, "--mode", mode], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: resolverEnv({
      D1_DATABASE_ID: FAKE_DATABASE_ID,
      DEPLOY_CONFIG_PATH: outputPath,
      ...extra,
    }),
  });
  expect(result.status, `resolver failed: ${result.stderr}`).toBe(0);
  return outputPath;
}

interface DryRun {
  readonly status: number | null;
  readonly output: string;
}

/** Run `wrangler deploy --dry-run` against one exact generated config file. */
function dryRun(configFile: string): DryRun {
  const result = spawnSync(
    process.execPath,
    [WRANGLER_BIN, "deploy", "--dry-run", "--config", configFile, "--outdir", join(LOG_DIR, "out")],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: resolverEnv({ WRANGLER_LOG_PATH: LOG_DIR, WRANGLER_SEND_METRICS: "false" }),
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The assertions shared by every generated artefact. */
function expectWranglerAccepts(generatedPath: string): void {
  const run = dryRun(generatedPath);
  // Include the config in the failure message: when this breaks, the config is
  // what a reader needs to see.
  const body = `${run.output}\n--- generated config ---\n${readFileSync(generatedPath, "utf8")}`;

  expect(run.status, body).toBe(0);
  // 3. Config schema: Wrangler reports no error of its own.
  expect(run.output, body).not.toContain("✘");
  expect(run.output, body).not.toContain("ERROR");
  // 1. Entry point resolved: it bundles the Worker rather than failing to find it.
  expect(run.output, body).toContain("Total Upload");
  expect(run.output, body).not.toContain("entry-point file");
  // 2. Binding resolved and named, which only happens after config validation.
  expect(run.output, body).toContain("env.TRAFFIC_DB");
  expect(run.output, body).toContain("D1 Database");
}

describe("Wrangler accepts the exact generated PRE-FLIGHT artifact", () => {
  it("resolves entry point, TRAFFIC_DB binding, and config schema", () => {
    const path = generate("preflight", "preflight", {});
    expectWranglerAccepts(path);
  });

  it("accepts an explicitly disabled Cron trigger", () => {
    // `triggers.crons = []` is the operation that removes Cron. If Wrangler rejected
    // an empty array, preflight could not be deployed safely at all.
    const path = generate("preflight", "preflight-cron", {});
    expect(readFileSync(path, "utf8")).toContain('"crons": []');
  });
});

describe("Wrangler accepts the exact generated RELEASE artifact", () => {
  it("accepts the workers_dev exposure mode", () => {
    const path = generate("release", "release-workers-dev", { HTTP_EXPOSURE_MODE: "workers_dev" });
    expectWranglerAccepts(path);
  });

  it("accepts the custom_domain exposure mode", () => {
    const path = generate("release", "release-custom-domain", {
      HTTP_EXPOSURE_MODE: "custom_domain",
      WORKER_CUSTOM_DOMAIN: "worker.example.com",
    });
    expectWranglerAccepts(path);
  });

  it("accepts the authoritative production Cron expression", () => {
    const path = generate("release", "release-cron", { HTTP_EXPOSURE_MODE: "workers_dev" });
    expectWranglerAccepts(path);
    expect(readFileSync(path, "utf8")).toContain('"*/10 * * * *"');
  });
});

describe("the assertion above has teeth", () => {
  it("fails when the config file does not exist", () => {
    // A negative control. Without it, `toContain("Total Upload")` could pass on
    // output that never ran Wrangler at all.
    const missing = join(REPO_ROOT, `${SCRATCH_PREFIX}does-not-exist.jsonc`);
    const run = dryRun(missing);
    expect(run.status).not.toBe(0);
  });

  it("fails when the entry point does not resolve", () => {
    // The exact defect from PR #66: the config sits at the repository root, so
    // Wrangler treats it as the project root, but `main` points at a file that is
    // not there. This proves the positive assertions above are not vacuous.
    const broken = join(REPO_ROOT, `${SCRATCH_PREFIX}broken-entry-point.jsonc`);
    writeFileSync(
      broken,
      `${JSON.stringify(
        {
          name: "cfworker4alicdt",
          main: "src/definitely-not-here.ts",
          compatibility_date: "2026-09-20",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const run = dryRun(broken);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("entry-point");
  });
});
