import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const ASSERT_SCRIPT = join(REPO_ROOT, "scripts", "assert-worker-secret-names.mjs");

function runAssertion(input: string) {
  return spawnSync(process.execPath, [ASSERT_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input,
  });
}

describe("assert-worker-secret-names helper", () => {
  it("accepts all required names from Wrangler's JSON array", () => {
    const result = runAssertion(
      JSON.stringify([
        { name: "ALIYUN_ACCESS_KEY_ID" },
        { name: "ALIYUN_ACCESS_KEY_SECRET" },
        { name: "ADMIN_TOKEN" },
      ]),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ALIYUN_ACCESS_KEY_ID");
    expect(result.stdout).toContain("ALIYUN_ACCESS_KEY_SECRET");
    expect(result.stdout).toContain("ADMIN_TOKEN");
  });

  it("reports missing required names and gives secret-only remediation", () => {
    const result = runAssertion(JSON.stringify([{ name: "ALIYUN_ACCESS_KEY_ID" }]));
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("ALIYUN_ACCESS_KEY_SECRET");
    expect(output).toContain("ADMIN_TOKEN");
    expect(output).toContain("wrangler secret put <NAME>");
    expect(output).toContain("Cloudflare Dashboard plaintext vars");
    expect(output).toContain("rotate the Alibaba AccessKey");
    expect(output).not.toContain("ALIYUN_ACCESS_KEY_ID is missing");
  });

  it("accepts optional webhook names without requiring them", () => {
    const result = runAssertion(
      JSON.stringify([
        { name: "ALIYUN_ACCESS_KEY_ID" },
        { name: "ALIYUN_ACCESS_KEY_SECRET" },
        { name: "ADMIN_TOKEN" },
        { name: "WEBHOOK_URL" },
        { name: "WEBHOOK_TOKEN" },
      ]),
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("fails closed for an empty list and malformed JSON without echoing input", () => {
    const empty = runAssertion("[]");
    expect(empty.status).toBe(1);
    expect(`${empty.stdout}${empty.stderr}`).toContain("ALIYUN_ACCESS_KEY_ID");

    const malformedInput = "not valid JSON";
    const malformed = runAssertion(malformedInput);
    expect(malformed.status).toBe(1);
    expect(`${malformed.stdout}${malformed.stderr}`).toContain("could not be parsed");
    expect(`${malformed.stdout}${malformed.stderr}`).not.toContain(malformedInput);
  });

  it("supports common object wrappers around the secret list", () => {
    const result = runAssertion(
      JSON.stringify({
        result: {
          secrets: [
            { name: "ALIYUN_ACCESS_KEY_ID" },
            { name: "ALIYUN_ACCESS_KEY_SECRET" },
            { name: "ADMIN_TOKEN" },
          ],
        },
      }),
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
