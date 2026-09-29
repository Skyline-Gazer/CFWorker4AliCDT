import { readFileSync } from "node:fs";
import { join } from "node:path";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface ProductionHealthWorkflow {
  readonly on?: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly jobs?: Record<
    string,
    {
      readonly "runs-on"?: string;
      readonly "timeout-minutes"?: number;
      readonly steps?: readonly {
        readonly uses?: string;
        readonly if?: string;
        readonly name?: string;
        readonly run?: string;
        readonly env?: Record<string, unknown>;
        readonly with?: Record<string, unknown>;
      }[];
    }
  >;
}

const WORKFLOW_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "production-health.yml",
);
const workflowSource = readFileSync(WORKFLOW_PATH, "utf8");
const workflow = load(workflowSource) as ProductionHealthWorkflow;

describe("production health workflow structure", () => {
  it("runs hourly at minute 17 and supports manual dispatch only", () => {
    expect(workflow.on?.schedule).toEqual([{ cron: "17 * * * *" }]);
    expect(workflow.on?.workflow_dispatch).toEqual({});
    expect(workflow.on).not.toHaveProperty("pull_request");
    expect(workflow.on).not.toHaveProperty("pull_request_target");
  });

  it("has one bounded Ubuntu job and only read contents plus issue write permission", () => {
    expect(Object.keys(workflow.jobs ?? {})).toEqual(["probe"]);
    expect(workflow.jobs?.probe?.["runs-on"]).toBe("ubuntu-latest");
    expect(workflow.jobs?.probe?.["timeout-minutes"]).toBeGreaterThan(0);
    expect(workflow.permissions).toEqual({ contents: "read", issues: "write" });
  });

  it("references only the dedicated monitor secret and no deploy credentials", () => {
    expect(workflowSource.match(/secrets\.[A-Z0-9_]+/g)).toEqual(["secrets.MONITOR_READ_TOKEN"]);
    expect(workflowSource.toUpperCase()).not.toContain("CLOUDFLARE_");
    expect(workflowSource).not.toContain("ADMIN_TOKEN");
    expect(workflowSource).not.toContain("ALIYUN_ACCESS_KEY");
    expect(workflowSource).not.toContain("UPDATE_TOKEN");
  });

  it("uploads the structured result for at least 30 days", () => {
    const steps = workflow.jobs?.probe?.steps ?? [];
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    const probe = steps.find((step) => step.name === "Probe HTTP and Cron health");
    const incident = steps.find((step) => step.name === "Create, update, or close incident");

    expect(probe?.run).toBe("node scripts/production-health/run-probe.mjs");
    expect(probe?.env?.MONITOR_READ_TOKEN).toBe("${{ secrets.MONITOR_READ_TOKEN }}");
    expect(probe?.env).not.toHaveProperty("ADMIN_TOKEN");
    expect(upload?.with?.path).toBe("production-health-result.json");
    expect(upload?.with?.["retention-days"]).toBeGreaterThanOrEqual(30);
    expect(incident?.if).toBe("always()");
    expect(upload?.if).toBe("always()");
  });
});
