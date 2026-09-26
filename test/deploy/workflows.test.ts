import { readFileSync } from "node:fs";
import { join } from "node:path";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * Deployment workflow structure (PLAN R10, §14).
 *
 * These are **structural** assertions over the workflow artifacts. They do not
 * prove GitHub will behave as configured; they prove the files state the
 * guarantees the design depends on, so a deletion or a quiet edit is caught
 * rather than discovered during the first real deployment.
 *
 * The initial two-stage deployment exists because Cron is the only ECS mutation
 * authority. Enabling it before the traffic unit has been verified against the
 * console could produce a *valid but wrong* threshold decision. PRE-FLIGHT
 * creates a new Worker with Cron disabled; RELEASE is the first-enable path;
 * UPDATE preserves the known production schedule on an existing Worker.
 */

const WORKFLOWS_DIR = join(import.meta.dirname, "..", "..", ".github", "workflows");
const DEPLOYMENT_DOC = join(WORKFLOWS_DIR, "..", "..", "docs", "operations", "deployment.md");

interface Step {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, string>;
}

interface Job {
  readonly name?: string;
  readonly environment?: string | { readonly name?: string };
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly name?: string;
  readonly on?: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly concurrency?: { readonly group?: string; readonly "cancel-in-progress"?: boolean };
  readonly jobs?: Record<string, Job>;
}

function readWorkflow(file: string): Workflow {
  const loaded: unknown = load(readFileSync(join(WORKFLOWS_DIR, file), "utf8"));
  return loaded as Workflow;
}

/** `.github` is not part of the typed program, so the parser sees plain objects. */
function text(workflow: Workflow): string {
  return JSON.stringify(workflow);
}

function allSteps(workflow: Workflow): Step[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => [...(job.steps ?? [])]);
}

function allRuns(workflow: Workflow): string[] {
  return allSteps(workflow)
    .map((step) => step.run ?? "")
    .filter((run) => run !== "");
}

/** A job's environment may be a name or an object; normalise both. */
function environmentName(job: Job): string | undefined {
  if (typeof job.environment === "string") return job.environment;
  return job.environment?.name;
}

const PREFLIGHT = readWorkflow("preflight.yml");
const RELEASE = readWorkflow("release.yml");
const UPDATE = readWorkflow("update.yml");

describe("workflow dispatch and PR isolation", () => {
  for (const [label, workflow] of [
    ["preflight.yml", PREFLIGHT],
    ["release.yml", RELEASE],
    ["update.yml", UPDATE],
  ] as const) {
    it(`${label} is workflow_dispatch only`, () => {
      const triggers = Object.keys(workflow.on ?? {});
      expect(triggers).toEqual(["workflow_dispatch"]);
    });

    it(`${label} has no pull_request trigger`, () => {
      const triggers = Object.keys(workflow.on ?? {});
      expect(triggers).not.toContain("pull_request");
      expect(triggers).not.toContain("pull_request_target");
      expect(triggers).not.toContain("push");
    });

    it(`${label} requests read-only contents permission`, () => {
      expect(workflow.permissions?.contents).toBe("read");
      expect(text(workflow)).not.toContain("contents: write");
    });

    it(`${label} does not cancel a deployment in flight`, () => {
      expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    });
  }

  it("PRE-FLIGHT and RELEASE are distinguishable dispatches", () => {
    expect(PREFLIGHT.name).not.toBe(RELEASE.name);
    expect(PREFLIGHT.name).toContain("Preflight");
    expect(RELEASE.name).toContain("Release");
  });

  it("UPDATE is distinct and has its own concurrency group", () => {
    expect(UPDATE.name).toContain("Update");
    expect(UPDATE.name).not.toBe(RELEASE.name);
    expect(UPDATE.concurrency?.group).not.toBe(RELEASE.concurrency?.group);
  });

  it("PR CI cannot reach deployment secrets", () => {
    // The PR workflow holds no credentials, so it is structurally incapable of
    // mutating a live account.
    const ci = readWorkflow("ci.yml");
    const ciText = readFileSync(join(WORKFLOWS_DIR, "ci.yml"), "utf8");
    expect(ciText).not.toContain("secrets.");
    expect(ciText).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(text(ci)).toContain("pull_request");
  });
});

describe("deployment trust boundary", () => {
  for (const [label, workflow] of [
    ["preflight.yml", PREFLIGHT],
    ["release.yml", RELEASE],
    ["update.yml", UPDATE],
  ] as const) {
    it(`${label} targets the production Environment`, () => {
      const jobs = Object.values(workflow.jobs ?? {});
      expect(jobs.length).toBeGreaterThan(0);
      for (const job of jobs) expect(environmentName(job)).toBe("production");
    });

    it(`${label} rejects non-main refs before checkout, migration, or deploy`, () => {
      const steps = allSteps(workflow);
      const guardIndex = steps.findIndex(
        (step) => step.if?.includes("github.ref") && step.if.includes("refs/heads/main"),
      );
      expect(guardIndex).toBe(0);
      expect(steps[guardIndex]?.if).toContain("!=");
      expect(steps[guardIndex]?.run).toContain("exit 1");

      const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
      const migrationIndex = steps.findIndex((step) =>
        (step.run ?? "").includes("migrations apply"),
      );
      const deployIndex = steps.findIndex((step) => (step.run ?? "").includes("wrangler deploy"));
      for (const index of [checkoutIndex, migrationIndex, deployIndex]) {
        expect(index).toBeGreaterThan(guardIndex);
      }
    });

    it(`${label} reads Cloudflare deployment credentials from the secret context`, () => {
      const credentialEnvs = allSteps(workflow)
        .map((step) => step.env)
        .filter((env) => env?.CLOUDFLARE_API_TOKEN !== undefined);
      expect(credentialEnvs.length).toBeGreaterThan(0);
      for (const env of credentialEnvs) {
        expect(env?.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.CLOUDFLARE_API_TOKEN }}");
        expect(env?.CLOUDFLARE_ACCOUNT_ID).toBe("${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
      }
    });
  }

  it("PRE-FLIGHT cannot dispatch or chain into RELEASE", () => {
    expect(PREFLIGHT.on).not.toHaveProperty("workflow_run");
    expect(PREFLIGHT.on).not.toHaveProperty("workflow_call");
    expect(allRuns(PREFLIGHT).join("\n")).not.toMatch(/gh\s+workflow\s+run\s+release/i);
  });

  it("documents the mandatory Environment boundary and keeps runtime config in repository variables", () => {
    const doc = readFileSync(DEPLOYMENT_DOC, "utf8");
    expect(doc).toContain("**required reviewers enabled**");
    expect(doc).toContain("deployment branches/tags **restricted to `main` only**");
    expect(doc).toContain("| `CLOUDFLARE_API_TOKEN` | Secret | **`production` Environment** |");
    expect(doc).toContain("| `CLOUDFLARE_ACCOUNT_ID` | Secret | **`production` Environment** |");
    expect(doc).toContain("Keep `REGION_ID`");
    expect(doc).toContain("`D1_DATABASE_ID`");
    expect(doc).toContain("ref guard is supplementary");
  });
});

describe("PRE-FLIGHT cannot enable Cron", () => {
  it("never enables the production Cron expression", () => {
    for (const run of allRuns(PREFLIGHT)) {
      expect(run).not.toContain("*/10 * * * *");
    }
    expect(text(PREFLIGHT)).not.toContain("*/10 * * * *");
  });

  it("resolves the preflight config rather than the release config", () => {
    const runs = allRuns(PREFLIGHT).join("\n");
    expect(runs).toContain("--mode preflight");
    expect(runs).not.toContain("--mode release");
  });

  it("does not attach a Cron trigger through a Wrangler CLI flag", () => {
    // `wrangler deploy --triggers` would attach a schedule from the command line,
    // bypassing the generated config entirely. RELEASE and UPDATE declare Cron in
    // their mode-specific configs, so no stage passes these flags.
    for (const [label, workflow] of [
      ["preflight.yml", PREFLIGHT],
      ["release.yml", RELEASE],
      ["update.yml", UPDATE],
    ] as const) {
      const runs = allRuns(workflow).join("\n");
      expect(runs, label).not.toMatch(/--triggers|--schedule|--schedules/);
      expect(runs, label).not.toMatch(/--routes|--route\b|--domains|--domain\b/);
    }
  });

  it("does not reference the generated release config", () => {
    expect(allRuns(PREFLIGHT).join("\n")).not.toContain("wrangler.deploy.jsonc");
  });

  it("applies migrations before the first Worker deploy", () => {
    // The spec permits preflight to apply remote migrations, and the order is
    // normative: the schema must exist before a Worker version that reads it is
    // live. Reversing these would deploy first and migrate second.
    const runs = allRuns(PREFLIGHT);
    const migrateIndex = runs.findIndex((run) => run.includes("migrations apply"));
    const deployIndex = runs.findIndex((run) => run.includes("wrangler deploy"));
    expect(migrateIndex, "preflight applies migrations").toBeGreaterThanOrEqual(0);
    expect(deployIndex, "preflight performs the first deploy").toBeGreaterThanOrEqual(0);
    expect(migrateIndex).toBeLessThan(deployIndex);
  });

  it("deploys against the generated preflight config, not the committed one", () => {
    const deploy = allRuns(PREFLIGHT).find((run) => run.includes("wrangler deploy"));
    expect(deploy).toContain("wrangler.preflight.jsonc");
  });

  it("performs no scheduled control run and calls no Alibaba mutation", () => {
    // Assert over the executable steps only. The informational `Next step` message
    // names the actions the owner must *not* observe having happened, so matching
    // the whole file would flag the very documentation that describes the
    // guarantee.
    const runs = allSteps(PREFLIGHT)
      .filter((step) => step.name !== "Next step — live read-only verification")
      .map((step) => step.run ?? "")
      .join("\n")
      .toLowerCase();
    expect(runs).not.toContain("startinstance");
    expect(runs).not.toContain("stopinstance");
    // No unauthenticated trigger of the scheduled handler either.
    expect(runs).not.toContain("cdn-cgi/local/scheduled");
    expect(runs).not.toContain("--test-scheduled");
  });

  it("does not require the release-only HTTP exposure decision", () => {
    // Preflight exposes no production endpoint, so its resolver invocation must
    // not demand a release-only variable.
    const resolverStep = allSteps(PREFLIGHT).find((step) => (step.run ?? "").includes("resolve-"));
    expect(resolverStep).toBeDefined();
    expect(JSON.stringify(resolverStep?.env ?? {})).not.toContain("HTTP_EXPOSURE_MODE");
  });

  it("passes the required application runtime variables into the resolver", () => {
    // Without these, the resolver refuses to generate a config, and the deploy
    // never starts. If the workflow failed to pass them, the guard would fire on
    // every run rather than protecting anything.
    const resolverStep = allSteps(PREFLIGHT).find((step) => (step.run ?? "").includes("resolve-"));
    expect(resolverStep?.env).toMatchObject({
      REGION_ID: "${{ vars.REGION_ID }}",
      ECS_INSTANCE_ID: "${{ vars.ECS_INSTANCE_ID }}",
    });
  });

  it("passes the optional application overrides through to the resolver", () => {
    const resolverStep = allSteps(PREFLIGHT).find((step) => (step.run ?? "").includes("resolve-"));
    for (const name of [
      "TRAFFIC_THRESHOLD_GB",
      "CDT_ENDPOINT",
      "BUSINESS_REGION_ID",
      "SIGNATURE_VERSION",
      "STOPPED_MODE",
    ]) {
      expect(resolverStep?.env, name).toHaveProperty(name);
    }
  });

  it("takes application values from repository variables, never secrets", () => {
    // Application configuration is not a credential. Routing it through Secrets
    // would obscure it and imply it needed protecting.
    const resolverStep = allSteps(PREFLIGHT).find((step) => (step.run ?? "").includes("resolve-"));
    for (const [name, value] of Object.entries(resolverStep?.env ?? {})) {
      expect(value, name).not.toContain("secrets.");
    }
  });

  it("guards the required runtime variables before any migration or deploy", () => {
    // The workflow must fail early and explicitly, not deploy a Worker that
    // discovers the binding is absent at its first request.
    const steps = allSteps(PREFLIGHT);
    const guardIndex = steps.findIndex((step) =>
      JSON.stringify(step.env ?? {}).includes("vars.REGION_ID"),
    );
    const resolverIndex = steps.findIndex((step) => (step.run ?? "").includes("resolve-"));
    const migrateIndex = steps.findIndex((step) => (step.run ?? "").includes("migrations apply"));
    const deployIndex = steps.findIndex((step) => (step.run ?? "").includes("wrangler deploy"));
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(resolverIndex);
    expect(resolverIndex).toBeLessThan(migrateIndex);
    expect(migrateIndex).toBeLessThan(deployIndex);
  });
});

describe("RELEASE carries the required gates", () => {
  it("targets the protected production Environment", () => {
    const jobs = Object.values(RELEASE.jobs ?? {});
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(environmentName(job)).toBe("production");
    }
  });

  it("requires a typed DEPLOY confirmation", () => {
    const inputs = text(RELEASE);
    expect(inputs).toContain("confirmation");
    expect(inputs).toContain("DEPLOY");
    // The check must be a real comparison against the literal, not a truthy test.
    const guard = allSteps(RELEASE).find((step) => step.if?.includes("confirmation"));
    expect(guard).toBeDefined();
    expect(guard?.if).toContain("'DEPLOY'");
    expect(guard?.run).toContain("exit 1");
  });

  it("requires an explicit live-read-only verification confirmation", () => {
    const inputs = text(RELEASE);
    expect(inputs).toContain("LIVE_READ_ONLY_VERIFIED");
    const guard = allSteps(RELEASE).find((step) => step.if?.includes("LIVE_READ_ONLY_VERIFIED"));
    expect(guard).toBeDefined();
    expect(guard?.run).toContain("exit 1");
  });

  it("fails closed when a confirmation input is absent rather than defaulting", () => {
    // A defaulted input would make the gate decorative. Every confirmation must
    // be `required` and must have no default.
    const raw = readFileSync(join(WORKFLOWS_DIR, "release.yml"), "utf8");
    const confirmInputs = ["confirmation", "LIVE_READ_ONLY_VERIFIED", "HTTP_EXPOSURE_MODE"];
    for (const name of confirmInputs) {
      const block = new RegExp(`${name}:\\n(?:.*\\n)*?\\s+required: true`);
      expect(raw, name).toMatch(block);
    }
    expect(raw).not.toContain("default:");
  });

  it("applies migrations before deploying the Worker", () => {
    const runs = allRuns(RELEASE);
    const migrateIndex = runs.findIndex((run) => run.includes("migrations apply"));
    const deployIndex = runs.findIndex((run) => run.includes("wrangler deploy"));
    expect(migrateIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThanOrEqual(0);
    expect(migrateIndex).toBeLessThan(deployIndex);
  });

  it("resolves the release config from the explicit HTTP exposure decision", () => {
    const runs = allRuns(RELEASE).join("\n");
    expect(runs).toContain("--mode release");
    expect(runs).not.toContain("--mode preflight");
  });

  it("passes the same application runtime variables as preflight", () => {
    // Mode-specific properties may differ; the runtime application configuration
    // must not. Every workflow draws it from the one resolver boundary.
    for (const workflow of [PREFLIGHT, RELEASE, UPDATE]) {
      const resolverStep = allSteps(workflow).find((step) => (step.run ?? "").includes("resolve-"));
      expect(resolverStep?.env).toMatchObject({
        D1_DATABASE_ID: "${{ vars.D1_DATABASE_ID }}",
        REGION_ID: "${{ vars.REGION_ID }}",
        ECS_INSTANCE_ID: "${{ vars.ECS_INSTANCE_ID }}",
      });
    }
  });

  it("takes application values from repository variables, never secrets", () => {
    const resolverStep = allSteps(RELEASE).find((step) => (step.run ?? "").includes("resolve-"));
    for (const [name, value] of Object.entries(resolverStep?.env ?? {})) {
      expect(value, name).not.toContain("secrets.");
    }
  });

  it("deploys against the generated release config, not the committed one", () => {
    const deploy = allRuns(RELEASE).find((run) => run.includes("wrangler deploy"));
    expect(deploy).toContain("wrangler.deploy.jsonc");
  });

  it("echoes no secret values", () => {
    for (const [label, workflow] of [
      ["preflight.yml", PREFLIGHT],
      ["release.yml", RELEASE],
      ["update.yml", UPDATE],
    ] as const) {
      for (const step of allSteps(workflow)) {
        const run = step.run ?? "";
        expect(run, `${label}: ${step.name ?? "unnamed step"}`).not.toMatch(
          /echo\s+\$\{\{\s*secrets\./,
        );
        expect(run, `${label}: ${step.name ?? "unnamed step"}`).not.toMatch(
          /echo\s+"\$\{?CLOUDFLARE_API_TOKEN/,
        );
      }
    }
  });
});

describe("UPDATE is a separate existing-Worker path", () => {
  it("requires typed update and existing-Worker confirmations without defaults", () => {
    const dispatch = UPDATE.on?.workflow_dispatch as {
      inputs: Record<string, Record<string, unknown>>;
    };
    const inputs = dispatch.inputs;
    expect(inputs.confirmation).toMatchObject({ required: true, type: "string" });
    expect(inputs.EXISTING_WORKER_CONFIRMED).toMatchObject({ required: true, type: "string" });
    expect(inputs.HTTP_EXPOSURE_MODE).toMatchObject({ required: true, type: "choice" });
    expect(inputs.HTTP_EXPOSURE_MODE?.options).toEqual(["workers_dev", "custom_domain"]);

    const raw = readFileSync(join(WORKFLOWS_DIR, "update.yml"), "utf8");
    expect(raw).not.toContain("default:");
    expect(allSteps(UPDATE).find((step) => step.if?.includes("confirmation"))?.if).toContain(
      "'UPDATE'",
    );
    expect(
      allSteps(UPDATE).find((step) => step.if?.includes("EXISTING_WORKER_CONFIRMED"))?.if,
    ).toContain("'YES'");
    expect(text(UPDATE)).not.toContain("LIVE_READ_ONLY_VERIFIED");
  });

  it("resolves UPDATE and applies D1 migrations before deploying the generated artifact", () => {
    const runs = allRuns(UPDATE);
    const resolverIndex = runs.findIndex((run) => run.includes("--mode update"));
    const migrateIndex = runs.findIndex((run) => run.includes("migrations apply"));
    const deployIndex = runs.findIndex((run) => run.includes("wrangler deploy"));
    expect(resolverIndex).toBeGreaterThanOrEqual(0);
    expect(migrateIndex).toBeGreaterThan(resolverIndex);
    expect(deployIndex).toBeGreaterThan(migrateIndex);
    expect(runs[migrateIndex]).toContain("wrangler.update.jsonc");
    expect(runs[deployIndex]).toContain("wrangler.update.jsonc");
    expect(runs.join("\n")).not.toContain("--mode preflight");
    expect(runs.join("\n")).not.toContain("wrangler.preflight.jsonc");
  });

  it("has no CLI Cron or route flags and loudly documents Cron preservation", () => {
    const runs = allRuns(UPDATE).join("\n");
    expect(runs).not.toMatch(/--triggers|--schedule|--schedules/);
    expect(runs).not.toMatch(/--routes|--route\b|--domains|--domain\b/);
    const raw = readFileSync(join(WORKFLOWS_DIR, "update.yml"), "utf8");
    expect(raw).toContain("PRE-FLIGHT IS FIRST-DEPLOY ONLY");
    expect(raw).toContain("Never run it against a live Cron Worker");
    expect(raw).toContain("*/10 * * * *");
    expect(raw).toContain("existing production Worker");
  });

  it("checks required Worker Secret names after deploy", () => {
    const steps = allSteps(UPDATE);
    const deployIndex = steps.findIndex((step) => (step.run ?? "").includes("wrangler deploy"));
    const secretListIndex = steps.findIndex((step) =>
      (step.run ?? "").includes(
        "wrangler secret list --format json --config wrangler.update.jsonc",
      ),
    );
    expect(secretListIndex).toBeGreaterThan(deployIndex);
    expect(steps[secretListIndex]?.run).toContain("set -o pipefail");
    expect(steps[secretListIndex]?.run).toContain("node scripts/assert-worker-secret-names.mjs");
  });

  it("targets production and receives runtime values as repository variables", () => {
    const jobs = Object.values(UPDATE.jobs ?? {});
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) expect(environmentName(job)).toBe("production");
    const resolverStep = allSteps(UPDATE).find((step) =>
      (step.run ?? "").includes("--mode update"),
    );
    expect(resolverStep?.env).toMatchObject({
      D1_DATABASE_ID: "${{ vars.D1_DATABASE_ID }}",
      REGION_ID: "${{ vars.REGION_ID }}",
      ECS_INSTANCE_ID: "${{ vars.ECS_INSTANCE_ID }}",
      HTTP_EXPOSURE_MODE: "${{ inputs.HTTP_EXPOSURE_MODE }}",
    });
    for (const value of Object.values(resolverStep?.env ?? {})) {
      expect(value).not.toContain("secrets.");
    }
  });

  it("does not chain into PRE-FLIGHT or RELEASE", () => {
    expect(UPDATE.on).not.toHaveProperty("workflow_run");
    expect(UPDATE.on).not.toHaveProperty("workflow_call");
    expect(allRuns(UPDATE).join("\n")).not.toMatch(/gh\s+workflow\s+run\s+(preflight|release)/i);
  });
});

describe("Cron first-enable authority and UPDATE preservation", () => {
  it("RELEASE is the first-enable path and UPDATE is the existing-Worker path", () => {
    expect(allRuns(RELEASE).join("\n")).toContain("--mode release");
    expect(allRuns(PREFLIGHT).join("\n")).not.toContain("--mode release");
    expect(allRuns(UPDATE).join("\n")).toContain("--mode update");
  });

  it("the preflight config explicitly disables Cron with an empty array", () => {
    // The resolver is what produces this, but the workflow's documentation must
    // state it, because that is what a reviewer reads before approving the run.
    const raw = readFileSync(join(WORKFLOWS_DIR, "preflight.yml"), "utf8");
    expect(raw).toContain("crons");
    expect(raw).toMatch(/Cron/i);
  });

  it("RELEASE names the first Cron enable and UPDATE names the preserved schedule", () => {
    expect(readFileSync(join(WORKFLOWS_DIR, "release.yml"), "utf8")).toContain("*/10 * * * *");
    expect(readFileSync(join(WORKFLOWS_DIR, "update.yml"), "utf8")).toContain("*/10 * * * *");
  });
});

describe("post-deploy Worker Secret presence gate", () => {
  for (const [label, workflow, config] of [
    ["PRE-FLIGHT", PREFLIGHT, "wrangler.preflight.jsonc"],
    ["RELEASE", RELEASE, "wrangler.deploy.jsonc"],
    ["UPDATE", UPDATE, "wrangler.update.jsonc"],
  ] as const) {
    it(`${label} checks required secret names after deploy and fails through the helper`, () => {
      const steps = allSteps(workflow);
      const deployIndex = steps.findIndex((step) => (step.run ?? "").includes("wrangler deploy"));
      const secretListIndex = steps.findIndex((step) =>
        (step.run ?? "").includes(`wrangler secret list --format json --config ${config}`),
      );

      expect(deployIndex).toBeGreaterThanOrEqual(0);
      expect(secretListIndex).toBeGreaterThan(deployIndex);
      expect(steps[secretListIndex]?.run).toContain("set -o pipefail");
      expect(steps[secretListIndex]?.run).toContain("node scripts/assert-worker-secret-names.mjs");
    });
  }
});

describe("the superseded single-stage deploy workflow is gone", () => {
  it("has no deploy.yml that conflates bootstrap with release", () => {
    const names = ["deploy.yml"];
    for (const name of names) {
      expect(() => readFileSync(join(WORKFLOWS_DIR, name), "utf8")).toThrow();
    }
  });
});
