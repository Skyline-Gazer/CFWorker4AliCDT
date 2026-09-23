import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config";

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
 *
 * A dry-run still does not prove the *Worker* can start. So a final group feeds the
 * generated `vars` to the real `loadConfig()`, which is the check that a config
 * omitting a required runtime binding would fail.
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

/** Required application runtime variables; see the module header. */
const RUNTIME_VARS: Record<string, string> = {
  REGION_ID: "cn-hongkong",
  ECS_INSTANCE_ID: "i-test-instance",
};

/** Generate one config at a scratch path, and fail loudly if the resolver does. */
function generate(mode: string, label: string, extra: Record<string, string>): string {
  const outputPath = join(REPO_ROOT, `${SCRATCH_PREFIX}${label}.jsonc`);
  const result = spawnSync(process.execPath, [RESOLVER, "--mode", mode], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: resolverEnv({
      D1_DATABASE_ID: FAKE_DATABASE_ID,
      DEPLOY_CONFIG_PATH: outputPath,
      ...RUNTIME_VARS,
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

/** Parse the JSONC the resolver emits, using an independent stripper. */
function readGenerated(path: string): { vars?: Record<string, string> } {
  const stripped = readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped) as { vars?: Record<string, string> };
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

describe("the generated artifact is sufficient for the Worker to start", () => {
  /**
   * A dry-run proves Wrangler accepts the config; it does not prove the *Worker*
   * can resolve its configuration at runtime. The blocker this suite exists for was
   * exactly that gap: a config that deploys cleanly and then fails `loadConfig()`
   * because a required binding is absent.
   *
   * So this closes the loop end to end: generate the exact preflight artifact, feed
   * its `vars` block plus the Worker secrets to the real `loadConfig()`, and assert
   * the config is accepted. The secrets are obviously fake — the point is that the
   * *non-secret* half is complete without any Worker Secret covering it.
   */
  it("loadConfig() accepts the preflight vars, with no secret covering the runtime vars", () => {
    const path = generate("preflight", "preflight-loadconfig", {});
    const generated = readGenerated(path);

    const parsed = loadConfig({
      ...(generated.vars ?? {}),
      // Worker Secrets, attached separately after the preflight deploy.
      ALIYUN_ACCESS_KEY_ID: "fake-akid",
      ALIYUN_ACCESS_KEY_SECRET: "fake-aksecret",
      WEBHOOK_URL: "https://hooks.example.test/run",
      ADMIN_TOKEN: "fake-admin-token",
    });

    expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.regionId).toBe("cn-hongkong");
      expect(parsed.config.ecsInstanceId).toBe("i-test-instance");
      expect(parsed.config.trafficThresholdGB).toBe(180);
      expect(parsed.config.cdtEndpoint).toBe("cdt.aliyuncs.com");
      expect(parsed.config.signatureVersion).toBe("v3");
      expect(parsed.config.stoppedMode).toBe("KeepCharging");
      expect(parsed.config.businessRegionId).toBeUndefined();
    }
  });

  it("loadConfig() accepts the release vars too", () => {
    const path = generate("release", "release-loadconfig", {
      HTTP_EXPOSURE_MODE: "workers_dev",
    });
    const generated = readGenerated(path);
    const parsed = loadConfig({
      ...(generated.vars ?? {}),
      ALIYUN_ACCESS_KEY_ID: "fake-akid",
      ALIYUN_ACCESS_KEY_SECRET: "fake-aksecret",
      WEBHOOK_URL: "https://hooks.example.test/run",
      ADMIN_TOKEN: "fake-admin-token",
    });
    expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
  });

  it("demonstrates the failure this guards against: vars without the required bindings", () => {
    // Negative control. Without REGION_ID and ECS_INSTANCE_ID, `loadConfig()` fails
    // even with every secret present — precisely the deployed-but-broken state the
    // resolver's required-variable guard prevents.
    const parsed = loadConfig({
      TRAFFIC_THRESHOLD_GB: "180",
      ALIYUN_ACCESS_KEY_ID: "fake-akid",
      ALIYUN_ACCESS_KEY_SECRET: "fake-aksecret",
      WEBHOOK_URL: "https://hooks.example.test/run",
      ADMIN_TOKEN: "fake-admin-token",
    });
    expect(parsed.ok).toBe(false);
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
