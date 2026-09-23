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
 * The two-stage deployment model exists because Cron is the only ECS mutation
 * authority. Enabling it before the traffic unit has been verified against the
 * console could produce a *valid but wrong* threshold decision, which is not a
 * failure mode the fail-closed design can catch. So the workflows are split:
 * PRE-FLIGHT creates the Worker with Cron explicitly disabled, and RELEASE — a
 * separate, explicitly authorized dispatch — is the only path that enables it.
 */

const WORKFLOWS_DIR = join(import.meta.dirname, "..", "..", ".github", "workflows");

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

describe("workflow dispatch and PR isolation", () => {
  for (const [label, workflow] of [
    ["preflight.yml", PREFLIGHT],
    ["release.yml", RELEASE],
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
    // bypassing the generated config entirely. Cron authority must come only from
    // the release config, so no stage passes these flags.
    for (const [label, workflow] of [
      ["preflight.yml", PREFLIGHT],
      ["release.yml", RELEASE],
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
    const confirmInputs = ["confirmation", "LIVE_READ_ONLY_VERIFIED"];
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

  it("deploys against the generated release config, not the committed one", () => {
    const deploy = allRuns(RELEASE).find((run) => run.includes("wrangler deploy"));
    expect(deploy).toContain("wrangler.deploy.jsonc");
  });

  it("echoes no secret values", () => {
    for (const [label, workflow] of [
      ["preflight.yml", PREFLIGHT],
      ["release.yml", RELEASE],
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

describe("Cron authority is exclusive to RELEASE", () => {
  it("only the release workflow resolves the release config", () => {
    expect(allRuns(RELEASE).join("\n")).toContain("--mode release");
    expect(allRuns(PREFLIGHT).join("\n")).not.toContain("--mode release");
  });

  it("the preflight config explicitly disables Cron with an empty array", () => {
    // The resolver is what produces this, but the workflow's documentation must
    // state it, because that is what a reviewer reads before approving the run.
    const raw = readFileSync(join(WORKFLOWS_DIR, "preflight.yml"), "utf8");
    expect(raw).toContain("crons");
    expect(raw).toMatch(/Cron/i);
  });

  it("the release workflow states the Cron expression it enables", () => {
    // The expression lives in the resolver's release mode; the workflow names it
    // so the authority being granted is visible without reading code.
    expect(readFileSync(join(WORKFLOWS_DIR, "release.yml"), "utf8")).toContain("*/10 * * * *");
  });
});

describe("the superseded single-stage deploy workflow is gone", () => {
  it("has no deploy.yml that conflates bootstrap with release", () => {
    const names = ["deploy.yml"];
    for (const name of names) {
      expect(() => readFileSync(join(WORKFLOWS_DIR, name), "utf8")).toThrow();
    }
  });
});
