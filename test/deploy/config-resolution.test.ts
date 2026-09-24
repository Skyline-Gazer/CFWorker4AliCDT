import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

/**
 * Generated deployment configuration (PLAN §14).
 *
 * The resolver is the one boundary where a production identifier enters a
 * Wrangler config. Three properties carry the weight here:
 *
 * **The generated file must live at the repository root.** Wrangler treats the
 * config's *directory* as the project root, so a generated config anywhere else
 * makes `main: "src/index.ts"` resolve outside the repository. That defect was
 * measured once already; it is pinned here so it cannot come back.
 *
 * **The committed `wrangler.jsonc` must be byte-stable.** Generation is a
 * read-and-copy operation, never an in-place rewrite. A resolver that mutated
 * the source config would make local development drift from what is deployed.
 *
 * **Every failure is closed.** An absent D1 id, an absent or unrecognised HTTP
 * exposure mode, or a malformed custom domain must produce no config at all
 * rather than a config with a hole in it.
 *
 * The tests exercise the real script through its command-line interface rather
 * than importing it, because the script *is* the artifact the workflows invoke. A
 * test against an imported helper would not prove the CLI works.
 *
 * Each test writes to its own root-level scratch path via `DEPLOY_CONFIG_PATH`.
 * The path must be at the repository root — the resolver refuses any other
 * location — and a file-unique name keeps parallel test files from racing on one
 * path. `wrangler.test-*.jsonc` is gitignored.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const RESOLVER = join(REPO_ROOT, "scripts", "resolve-deploy-config.mjs");
const SOURCE_CONFIG = join(REPO_ROOT, "wrangler.jsonc");

/**
 * Scratch configs for this file. They must sit at the repository root, because
 * Wrangler resolves `main` relative to the config's directory and the resolver
 * refuses any other location. The prefix is file-unique so parallel test files do
 * not race on one path, and `wrangler.test-*` is gitignored.
 */
const SCRATCH_PREFIX = "wrangler.test-config-resolution-";

/** A syntactically valid placeholder. Never a real account identifier. */
const FAKE_DATABASE_ID = "11111111-2222-3333-4444-555555555555";

let counter = 0;

/** A unique root-level generated path per invocation, so no two tests share a file. */
function scratchPath(label: string): string {
  counter += 1;
  return join(REPO_ROOT, `${SCRATCH_PREFIX}${label}-${counter}.jsonc`);
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Invoke the resolver with a clean environment, so no ambient value leaks in. */
function resolve(mode: string, env: Record<string, string> = {}, outputPath?: string): RunResult {
  const result = spawnSync(process.execPath, [RESOLVER, "--mode", mode], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CI: "true",
      ...(outputPath === undefined ? {} : { DEPLOY_CONFIG_PATH: outputPath }),
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Parse the JSONC the resolver emits, using an independent stripper. */
function readGenerated(path: string): Record<string, unknown> {
  const stripped = readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped) as Record<string, unknown>;
}

function ignoreStatus(path: string): number | null {
  return spawnSync("git", ["check-ignore", "-q", path], { cwd: REPO_ROOT }).status;
}

function isTracked(path: string): boolean {
  return spawnSync("git", ["ls-files", "--error-unmatch", path], { cwd: REPO_ROOT }).status === 0;
}

/** Generate with a unique path and return both the result and the parsed config. */
function generate(
  mode: string,
  env: Record<string, string>,
  label: string,
): { result: RunResult; path: string } {
  const path = scratchPath(label);
  const result = resolve(mode, env, path);
  return { result, path };
}

/**
 * The runtime configuration every deployment must carry.
 *
 * `REGION_ID` and `ECS_INSTANCE_ID` are required by `loadConfig()`, so a generated
 * config that omits them deploys successfully and then fails at the first request.
 * Tests that are not specifically about application variables supply them here so
 * that unrelated assertions are not coupled to the required-variable guard.
 */
const RUNTIME_VARS: Record<string, string> = {
  REGION_ID: "cn-hongkong",
  ECS_INSTANCE_ID: "i-test-instance",
};

/** Extract the `vars` block from a generated config. */
function varsOf(path: string): Record<string, unknown> {
  return (readGenerated(path).vars ?? {}) as Record<string, unknown>;
}

describe("Workers Free CPU configuration", () => {
  it("keeps the committed source config free of custom CPU limits", () => {
    expect(readGenerated(SOURCE_CONFIG).limits).toBeUndefined();
  });
});

/** The mode-specific arguments for a release, plus the required runtime vars. */
function releaseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    D1_DATABASE_ID: FAKE_DATABASE_ID,
    HTTP_EXPOSURE_MODE: "workers_dev",
    ...RUNTIME_VARS,
    ...extra,
  };
}

/** Every scratch config this file wrote, so cleanup never touches anything else. */
function listScratchFiles(): string[] {
  return readdirSync(REPO_ROOT)
    .filter((name) => name.startsWith(SCRATCH_PREFIX))
    .map((name) => join(REPO_ROOT, name));
}

afterAll(() => {
  for (const file of listScratchFiles()) rmSync(file, { force: true });
});

describe("PRE-FLIGHT generation", () => {
  it("omits custom CPU limits on Workers Free", () => {
    // Regression for live Cloudflare error 100328: custom CPU limits are unsupported on Free.
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "preflight-cpu-limit",
    );
    expect(readGenerated(path).limits).toBeUndefined();
  });

  it("writes the generated config to the repository root by default", () => {
    const path = join(REPO_ROOT, "wrangler.preflight.jsonc");
    const result = resolve("preflight", { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS });
    expect(result.status).toBe(0);
    expect(existsSync(path)).toBe(true);
    rmSync(path, { force: true });
  });

  it("fails closed when D1_DATABASE_ID is absent", () => {
    const { result, path } = generate("preflight", { ...RUNTIME_VARS }, "preflight-no-id");
    expect(result.status).not.toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("injects the D1 database id into the TRAFFIC_DB binding", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "preflight-id",
    );
    const config = readGenerated(path);
    const databases = config.d1_databases as { binding: string; database_id?: string }[];
    const traffic = databases.find((entry) => entry.binding === "TRAFFIC_DB");
    expect(traffic?.database_id).toBe(FAKE_DATABASE_ID);
  });

  it("leaves the committed wrangler.jsonc byte-identical", () => {
    const before = readFileSync(SOURCE_CONFIG, "utf8");
    generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "preflight-stable",
    );
    expect(readFileSync(SOURCE_CONFIG, "utf8")).toBe(before);
  });

  it("keeps 'main' resolving to the Worker entry point", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "preflight-main",
    );
    const config = readGenerated(path);
    expect(config.main).toBe("src/index.ts");
    expect(existsSync(join(REPO_ROOT, config.main as string))).toBe(true);
  });

  it("enables preview_urls so a Version URL exists for live verification", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "preflight-prev",
    );
    expect(readGenerated(path).preview_urls).toBe(true);
  });

  it("keeps workers_dev disabled", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "preflight-wd",
    );
    expect(readGenerated(path).workers_dev).toBe(false);
  });

  it("declares no production route or custom domain", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "preflight-rte",
    );
    const config = readGenerated(path);
    expect(config.routes).toBeUndefined();
    expect(config.route).toBeUndefined();
  });

  it("explicitly disables Cron with an empty array, rather than omitting it", () => {
    // An omitted `crons` leaves existing triggers in place; an empty array
    // removes them. Preflight must assert the removal, not merely decline to add
    // one — the two are different operations to Cloudflare.
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "preflight-cron",
    );
    const triggers = readGenerated(path).triggers as { crons?: unknown } | undefined;
    expect(triggers).toBeDefined();
    expect(triggers?.crons).toEqual([]);
  });

  it("does not require the release-only HTTP exposure decision", () => {
    const { result } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "preflight-exp",
    );
    expect(result.status).toBe(0);
  });

  it("does not declare required secrets, because the Worker does not exist yet", () => {
    // Cloudflare/Wrangler constraint: `secrets.required` is validated at deploy
    // time, and a NEW Worker cannot have secrets set in advance — Wrangler refuses
    // with "This Worker does not exist yet, so secrets cannot be set in advance".
    // So a first deploy that declared `secrets.required` could never succeed.
    //
    // A `--dry-run` does NOT catch this, because validation happens on the real
    // upload path. Hence a structural assertion on the generated config.
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "preflight-sec",
    );
    const secrets = readGenerated(path).secrets as { required?: unknown } | undefined;
    expect(secrets?.required ?? []).toEqual([]);
  });
});

describe("RELEASE generation — Cron authority", () => {
  it("omits custom CPU limits on Workers Free", () => {
    const { path } = generate("release", releaseEnv(), "release-cpu-limit");
    expect(readGenerated(path).limits).toBeUndefined();
  });

  it("restores the authoritative production Cron expression", () => {
    const { path } = generate("release", releaseEnv(), "release-cron");
    const triggers = readGenerated(path).triggers as { crons?: unknown };
    expect(triggers.crons).toEqual(["*/10 * * * *"]);
  });

  it("injects the D1 database id", () => {
    const { path } = generate("release", releaseEnv(), "release-id");
    const databases = readGenerated(path).d1_databases as {
      binding: string;
      database_id?: string;
    }[];
    expect(databases.find((entry) => entry.binding === "TRAFFIC_DB")?.database_id).toBe(
      FAKE_DATABASE_ID,
    );
  });

  it("leaves the committed wrangler.jsonc byte-identical", () => {
    const before = readFileSync(SOURCE_CONFIG, "utf8");
    generate("release", releaseEnv(), "release-stable");
    expect(readFileSync(SOURCE_CONFIG, "utf8")).toBe(before);
  });

  it("does not retain the preflight preview exposure", () => {
    const { path } = generate("release", releaseEnv(), "release-prev");
    expect(readGenerated(path).preview_urls).toBe(false);
  });

  it("restores the required-secret validation the preflight stage had to omit", () => {
    // The first deploy cannot declare `secrets.required`, because the Worker does
    // not exist yet to hold them. From the second deploy onward the Worker does
    // exist, so the fail-loudly-on-a-missing-secret guarantee is restored here.
    const { path } = generate("release", releaseEnv(), "release-secrets");
    const secrets = readGenerated(path).secrets as { required?: string[] } | undefined;
    expect(secrets?.required).toEqual([
      "ALIYUN_ACCESS_KEY_ID",
      "ALIYUN_ACCESS_KEY_SECRET",
      "WEBHOOK_URL",
      "ADMIN_TOKEN",
    ]);
  });
});

describe("RELEASE generation — HTTP exposure is an explicit owner choice", () => {
  it("fails closed when HTTP_EXPOSURE_MODE is absent", () => {
    const { result, path } = generate(
      "release",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "release-no-exposure",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("HTTP_EXPOSURE_MODE");
    expect(existsSync(path)).toBe(false);
  });

  it("fails closed on an unrecognised HTTP_EXPOSURE_MODE", () => {
    const { result, path } = generate(
      "release",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, HTTP_EXPOSURE_MODE: "public", ...RUNTIME_VARS },
      "release-bad-exposure",
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("fails closed on a blank HTTP_EXPOSURE_MODE", () => {
    const { result, path } = generate(
      "release",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, HTTP_EXPOSURE_MODE: "   ", ...RUNTIME_VARS },
      "release-blank-exposure",
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("workers_dev mode enables workers.dev and declares no route", () => {
    const { path } = generate("release", releaseEnv(), "release-workers-dev");
    const config = readGenerated(path);
    expect(config.workers_dev).toBe(true);
    expect(config.routes).toBeUndefined();
    expect(config.route).toBeUndefined();
  });

  it("custom_domain mode disables workers.dev and declares the custom-domain route", () => {
    const { path } = generate(
      "release",
      {
        D1_DATABASE_ID: FAKE_DATABASE_ID,
        HTTP_EXPOSURE_MODE: "custom_domain",
        WORKER_CUSTOM_DOMAIN: "worker.example.com",
        ...RUNTIME_VARS,
      },
      "release-custom-domain",
    );
    const config = readGenerated(path);
    expect(config.workers_dev).toBe(false);
    expect(config.routes).toEqual([{ pattern: "worker.example.com", custom_domain: true }]);
  });

  it("fails closed when custom_domain is selected without a domain", () => {
    const { result, path } = generate(
      "release",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, HTTP_EXPOSURE_MODE: "custom_domain", ...RUNTIME_VARS },
      "release-no-domain",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("WORKER_CUSTOM_DOMAIN");
    expect(existsSync(path)).toBe(false);
  });

  it("fails closed on a blank custom domain", () => {
    const { result, path } = generate(
      "release",
      {
        D1_DATABASE_ID: FAKE_DATABASE_ID,
        HTTP_EXPOSURE_MODE: "custom_domain",
        WORKER_CUSTOM_DOMAIN: "   ",
        ...RUNTIME_VARS,
      },
      "release-blank-domain",
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("fails closed on a malformed custom domain", () => {
    for (const malformed of ["exa mple.com", ".example.com", "https://worker.example.com"]) {
      const { result, path } = generate(
        "release",
        {
          D1_DATABASE_ID: FAKE_DATABASE_ID,
          HTTP_EXPOSURE_MODE: "custom_domain",
          WORKER_CUSTOM_DOMAIN: malformed,
          ...RUNTIME_VARS,
        },
        "release-malformed-domain",
      );
      expect(result.status, `WORKER_CUSTOM_DOMAIN=${malformed}`).not.toBe(0);
      expect(existsSync(path), `WORKER_CUSTOM_DOMAIN=${malformed}`).toBe(false);
    }
  });

  it("refuses an output path outside the repository root", () => {
    const result = resolve(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "/tmp/outside.jsonc",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("repository root");
  });

  it("never prints the resolved database id", () => {
    const { result } = generate("release", releaseEnv(), "release-no-print");
    expect(result.stdout).not.toContain(FAKE_DATABASE_ID);
    expect(result.stderr).not.toContain(FAKE_DATABASE_ID);
  });
});

describe("application runtime configuration is injected into every mode", () => {
  // `loadConfig()` requires REGION_ID and ECS_INSTANCE_ID. A generated config that
  // omits them deploys successfully and then fails at the first request, which is
  // the worst possible moment to discover a missing binding. So the resolver must
  // fail *before* generating, not let the deployment discover it later.

  it("injects REGION_ID and ECS_INSTANCE_ID into the preflight config", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "app-region-pf",
    );
    const vars = varsOf(path);
    expect(vars.REGION_ID).toBe(RUNTIME_VARS.REGION_ID);
    expect(vars.ECS_INSTANCE_ID).toBe(RUNTIME_VARS.ECS_INSTANCE_ID);
  });

  it("injects REGION_ID and ECS_INSTANCE_ID into the release config", () => {
    const { path } = generate("release", releaseEnv(), "app-region-rel");
    const vars = varsOf(path);
    expect(vars.REGION_ID).toBe(RUNTIME_VARS.REGION_ID);
    expect(vars.ECS_INSTANCE_ID).toBe(RUNTIME_VARS.ECS_INSTANCE_ID);
  });

  it("trims surrounding whitespace from the required values", () => {
    const { path } = generate(
      "preflight",
      {
        D1_DATABASE_ID: FAKE_DATABASE_ID,
        REGION_ID: "  cn-hongkong  ",
        ECS_INSTANCE_ID: "\ti-trimmed \n",
      },
      "app-trim",
    );
    const vars = varsOf(path);
    expect(vars.REGION_ID).toBe("cn-hongkong");
    expect(vars.ECS_INSTANCE_ID).toBe("i-trimmed");
  });

  it("retains the committed default when no threshold override is supplied", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "app-thr-def",
    );
    expect(varsOf(path).TRAFFIC_THRESHOLD_GB).toBe("180");
  });

  it("applies a threshold override when supplied", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS, TRAFFIC_THRESHOLD_GB: "250" },
      "app-thr-ovr",
    );
    expect(varsOf(path).TRAFFIC_THRESHOLD_GB).toBe("250");
  });

  it("retains the committed default when no CDT endpoint override is supplied", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "app-cdt-def",
    );
    expect(varsOf(path).CDT_ENDPOINT).toBe("cdt.aliyuncs.com");
  });

  it("applies a CDT endpoint override when supplied", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS, CDT_ENDPOINT: "cdt.example.test" },
      "app-cdt-ovr",
    );
    expect(varsOf(path).CDT_ENDPOINT).toBe("cdt.example.test");
  });

  it("leaves BUSINESS_REGION_ID absent when it is not supplied", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "app-br-absent",
    );
    expect(varsOf(path)).not.toHaveProperty("BUSINESS_REGION_ID");
  });

  it("includes BUSINESS_REGION_ID when supplied", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS, BUSINESS_REGION_ID: "cn-hongkong" },
      "app-br-present",
    );
    expect(varsOf(path).BUSINESS_REGION_ID).toBe("cn-hongkong");
  });

  it("retains the committed default when no signature override is supplied", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "app-sig-def",
    );
    expect(varsOf(path).SIGNATURE_VERSION).toBe("v3");
  });

  it("applies a signature override when supplied", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS, SIGNATURE_VERSION: "v2" },
      "app-sig-ovr",
    );
    expect(varsOf(path).SIGNATURE_VERSION).toBe("v2");
  });

  it("retains the committed default when no stopped-mode override is supplied", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "app-stop-def",
    );
    expect(varsOf(path).STOPPED_MODE).toBe("KeepCharging");
  });

  it("applies a stopped-mode override when supplied", () => {
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS, STOPPED_MODE: "StopCharging" },
      "app-stop-ovr",
    );
    expect(varsOf(path).STOPPED_MODE).toBe("StopCharging");
  });

  it("preserves the non-application D1 binding alongside the injected vars", () => {
    // The two classes of configuration must not be confused: injecting runtime
    // vars must not disturb the deployment-only D1 binding.
    const { path } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS },
      "app-d1-kept",
    );
    const databases = readGenerated(path).d1_databases as {
      binding: string;
      database_id?: string;
    }[];
    expect(databases.find((entry) => entry.binding === "TRAFFIC_DB")?.database_id).toBe(
      FAKE_DATABASE_ID,
    );
  });
});

describe("required application variables fail closed", () => {
  // Deployment completeness is the resolver's job. Runtime *semantic* validation
  // (is the threshold a number > 0, is the signature version v2/v3) remains
  // `loadConfig()`'s job and is deliberately not duplicated here.

  for (const [label, env] of [
    ["REGION_ID absent", { ECS_INSTANCE_ID: "i-test" }],
    ["REGION_ID blank", { REGION_ID: "   ", ECS_INSTANCE_ID: "i-test" }],
    ["ECS_INSTANCE_ID absent", { REGION_ID: "cn-hongkong" }],
    ["ECS_INSTANCE_ID blank", { REGION_ID: "cn-hongkong", ECS_INSTANCE_ID: "\t\n " }],
  ] as const) {
    it(`preflight fails and produces no artifact when ${label}`, () => {
      const { result, path } = generate(
        "preflight",
        { D1_DATABASE_ID: FAKE_DATABASE_ID, ...env },
        "app-missing",
      );
      expect(result.status).not.toBe(0);
      expect(existsSync(path)).toBe(false);
    });

    it(`release fails and produces no artifact when ${label}`, () => {
      const { result, path } = generate(
        "release",
        { D1_DATABASE_ID: FAKE_DATABASE_ID, HTTP_EXPOSURE_MODE: "workers_dev", ...env },
        "app-missing-rel",
      );
      expect(result.status).not.toBe(0);
      expect(existsSync(path)).toBe(false);
    });
  }

  it("names the missing binding without printing any value", () => {
    const secretishRegion = "cn-hongkong-secret-region-value";
    const { result } = generate(
      "preflight",
      { D1_DATABASE_ID: FAKE_DATABASE_ID, REGION_ID: secretishRegion },
      "app-name-only",
    );
    expect(result.status).not.toBe(0);
    // The *name* of the offending binding is the only thing that may appear. A
    // value from the environment must never reach CI logs.
    expect(result.stderr).toContain("ECS_INSTANCE_ID");
    expect(result.stderr).not.toContain(secretishRegion);
    expect(result.stdout).not.toContain(secretishRegion);
  });

  it("does not print an optional override value either", () => {
    const overrideValue = "cdt-distinctive-override-value.test";
    const { result } = generate(
      "preflight",
      {
        D1_DATABASE_ID: FAKE_DATABASE_ID,
        ...RUNTIME_VARS,
        CDT_ENDPOINT: overrideValue,
        ECS_INSTANCE_ID: "",
      },
      "app-opt-no-print",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain(overrideValue);
    expect(result.stdout).not.toContain(overrideValue);
  });
});

describe("deployment mode must not change application configuration", () => {
  // Mode-specific properties (Cron, preview URL, workers.dev / custom domain,
  // required-secret declaration) may differ. The runtime application
  // configuration must not. If it did, the verified preflight behaviour would
  // stop describing what RELEASE actually runs.

  it("derives identical application vars from both modes for identical inputs", () => {
    const inputs = {
      D1_DATABASE_ID: FAKE_DATABASE_ID,
      REGION_ID: "cn-hongkong",
      ECS_INSTANCE_ID: "i-parity",
      TRAFFIC_THRESHOLD_GB: "200",
      CDT_ENDPOINT: "cdt.parity.test",
      BUSINESS_REGION_ID: "cn-shanghai",
      SIGNATURE_VERSION: "v2",
      STOPPED_MODE: "StopCharging",
    };
    const preflight = generate("preflight", inputs, "parity-pf");
    const release = generate(
      "release",
      { ...inputs, HTTP_EXPOSURE_MODE: "workers_dev" },
      "parity-rel",
    );

    expect(varsOf(preflight.path)).toEqual(varsOf(release.path));
  });

  it("keeps application vars equal even when the release exposure mode differs", () => {
    const inputs = {
      D1_DATABASE_ID: FAKE_DATABASE_ID,
      REGION_ID: "cn-hongkong",
      ECS_INSTANCE_ID: "i-parity-2",
    };
    const workersDev = generate(
      "release",
      { ...inputs, HTTP_EXPOSURE_MODE: "workers_dev" },
      "parity-wd",
    );
    const customDomain = generate(
      "release",
      {
        ...inputs,
        HTTP_EXPOSURE_MODE: "custom_domain",
        WORKER_CUSTOM_DOMAIN: "worker.example.com",
      },
      "parity-cd",
    );
    expect(varsOf(workersDev.path)).toEqual(varsOf(customDomain.path));
  });

  it("differs between modes only in the documented mode-specific properties", () => {
    const inputs = {
      D1_DATABASE_ID: FAKE_DATABASE_ID,
      REGION_ID: "cn-hongkong",
      ECS_INSTANCE_ID: "i-parity-3",
    };
    const preflight = readGenerated(generate("preflight", inputs, "parity-diff-pf").path);
    const release = readGenerated(
      generate("release", { ...inputs, HTTP_EXPOSURE_MODE: "workers_dev" }, "parity-diff-rel").path,
    );

    const differingKeys = Object.keys({ ...preflight, ...release }).filter(
      (key) => JSON.stringify(preflight[key]) !== JSON.stringify(release[key]),
    );
    // Exactly the mode-specific set, and nothing else.
    expect([...differingKeys].sort()).toEqual([
      "preview_urls",
      "secrets",
      "triggers",
      "workers_dev",
    ]);
  });
});

describe("generated files never enter the tracked tree", () => {
  it("gitignores both default generated configs", () => {
    expect(ignoreStatus("wrangler.preflight.jsonc")).toBe(0);
    expect(ignoreStatus("wrangler.deploy.jsonc")).toBe(0);
  });

  it("tracks neither generated config", () => {
    expect(isTracked("wrangler.preflight.jsonc")).toBe(false);
    expect(isTracked("wrangler.deploy.jsonc")).toBe(false);
  });

  it("gitignores the scratch directory used by these tests", () => {
    expect(ignoreStatus("wrangler.test-scratch-example.jsonc")).toBe(0);
  });
});

describe("resolver modes", () => {
  it("rejects a missing --mode", () => {
    const result = spawnSync(process.execPath, [RESOLVER], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CI: "true" },
    });
    expect(result.status).not.toBe(0);
  });

  it("rejects an unknown --mode", () => {
    const result = resolve("bogus", { D1_DATABASE_ID: FAKE_DATABASE_ID, ...RUNTIME_VARS });
    expect(result.status).not.toBe(0);
  });
});
