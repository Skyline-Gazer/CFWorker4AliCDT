import { describe, expect, it } from "vitest";

import {
  buildIncidentBody,
  incidentTitle,
  syncIncident,
  type GhRunner,
} from "../../scripts/production-health/incident.mjs";
import type { ProbeResult } from "../../scripts/production-health/probe.mjs";

const failedProbe: ProbeResult = {
  timestamp: "2026-09-29T00:17:00.000Z",
  http_status: 500,
  latency_ms: 123,
  ok: false,
  failure_reason: "Unexpected HTTP status 500",
  probe_url: "https://cdt.q9m3.com/health",
  cron_health: "UNKNOWN",
  attempts: 3,
  expected_status: 200,
  expected_body_status: "ok",
  expected_service: "cfworker4alicdt",
  run_url: "https://github.com/Skyline-Gazer/CFWorker4AliCDT/actions/runs/123",
};

describe("production health incident handling", () => {
  it("uses the exact host in the monitor incident title", () => {
    expect(incidentTitle(failedProbe)).toBe("[production-health] cdt.q9m3.com");
  });

  it("updates the existing open issue on a subsequent failure", async () => {
    const calls: string[][] = [];
    let openIssue: { number: number; title: string } | null = null;
    const createdTitles: string[] = [];
    const gh: GhRunner = (args) => {
      calls.push([...args]);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(JSON.stringify(openIssue === null ? [] : [openIssue]));
      }
      if (args[0] === "issue" && args[1] === "create") {
        const titleIndex = args.indexOf("--title");
        const title = args[titleIndex + 1] ?? "";
        openIssue = { number: 136, title };
        createdTitles.push(title);
        return Promise.resolve("https://github.com/example/repo/issues/136\n");
      }
      return Promise.resolve("");
    };

    const first = await syncIncident(failedProbe, gh);
    const second = await syncIncident(failedProbe, gh);

    expect(first).toEqual({ action: "created", issueNumber: null });
    expect(second).toEqual({ action: "updated", issueNumber: 136 });
    expect(calls.filter((args) => args[0] === "issue" && args[1] === "create")).toHaveLength(1);
    expect(
      calls.some((args) => args[0] === "issue" && args[1] === "comment" && args[2] === "136"),
    ).toBe(true);
    expect(createdTitles).toEqual(["[production-health] cdt.q9m3.com"]);
  });

  it("redacts credential-shaped failure text and ignores response headers", () => {
    const headerBody = buildIncidentBody({
      ...failedProbe,
      failure_reason:
        "Authorization: Bearer fixture-auth-secret ADMIN_TOKEN=fixture-admin-secret COOKIE=session-fixture-secret",
      response_headers: {
        authorization: "Bearer header-fixture-secret",
        cookie: "session=header-cookie-secret",
      },
    } as ProbeResult & { response_headers: Record<string, string> });
    const jsonBody = buildIncidentBody({
      ...failedProbe,
      failure_reason:
        '{"Authorization":"Bearer json-auth-secret","ADMIN_TOKEN":"json-admin-secret","COOKIE":"json-cookie-secret"}',
    });

    for (const secret of [
      "fixture-auth-secret",
      "fixture-admin-secret",
      "session-fixture-secret",
      "header-fixture-secret",
      "header-cookie-secret",
    ]) {
      expect(headerBody).not.toContain(secret);
    }
    for (const secret of ["json-auth-secret", "json-admin-secret", "json-cookie-secret"]) {
      expect(jsonBody).not.toContain(secret);
    }
    expect(headerBody).toContain("[REDACTED]");
    expect(headerBody).toContain("Cron health: UNKNOWN");
  });

  it("closes the matching open incident after HTTP health recovers", async () => {
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push([...args]);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(
          JSON.stringify([{ number: 136, title: "[production-health] cdt.q9m3.com" }]),
        );
      }
      return Promise.resolve("");
    };

    const result = await syncIncident(
      {
        ...failedProbe,
        http_status: 200,
        ok: true,
        failure_reason: null,
      },
      gh,
    );

    expect(result).toEqual({ action: "closed", issueNumber: 136 });
    expect(
      calls.some((args) => args[0] === "issue" && args[1] === "close" && args[2] === "136"),
    ).toBe(true);
  });
});
