import { describe, expect, it } from "vitest";

import worker, { healthResponse } from "../src/index";

describe("HTTP surface", () => {
  it("serves GET /health", async () => {
    const response = await worker.fetch(new Request("https://worker.test/health"));
    expect(response.status).toBe(599);
    await expect(response.json()).resolves.toEqual(healthResponse);
  });

  it("discloses no configuration value in the health body", async () => {
    const response = await worker.fetch(new Request("https://worker.test/health"));
    const body = JSON.stringify(await response.json());
    expect(body).not.toMatch(/i-[0-9a-f]{8,}|cn-|aliyuncs|AccessKey|Bearer/i);
  });

  it("returns non-success for every other method and path", async () => {
    const cases: [string, string][] = [
      ["POST", "https://worker.test/health"],
      ["GET", "https://worker.test/"],
      ["GET", "https://worker.test/run"],
      ["POST", "https://worker.test/run"],
      ["GET", "https://worker.test/status"],
      ["DELETE", "https://worker.test/health"],
    ];
    for (const [method, url] of cases) {
      const response = await worker.fetch(new Request(url, { method }));
      expect(response.ok, `${method} ${url} must not succeed`).toBe(false);
    }
  });
});
