import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const STATIC_DIR = resolve(import.meta.dirname, "../../static");

function asset(name: string): string {
  return resolve(STATIC_DIR, name);
}

describe("donor static asset import", () => {
  it("contains the pinned UI, styles, bundles, icon, and source stylesheet", () => {
    for (const name of [
      "index.html",
      "tailwind-compiled.css",
      "vue.global.prod.js",
      "echarts.min.js",
      "icon.png",
      "input.css",
    ]) {
      expect(statSync(asset(name)).size, name).toBeGreaterThan(0);
    }
  });

  it("keeps the donor entrypoint wired to its same-origin asset paths and bundles", () => {
    const html = readFileSync(asset("index.html"), "utf8");
    expect(html).toContain("tailwind-compiled.css");
    expect(html).toContain("vue.global.prod.js");
    expect(html).toContain("echarts.min.js");
    expect(html).toContain("?action=control_instance");
    expect(html).toContain("?action=get_history");
    expect(html).toContain("item.decision_reason");
    expect(html).toContain("item.traffic_summation_scope");
    expect(html).toContain("currentChartData.decision_history");
  });

  it("unlocks through Authorization without persisting or posting the admin token", () => {
    const html = readFileSync(asset("index.html"), "utf8");
    expect(html).toContain("Authorization: `Bearer ${candidate}`");
    expect(html).toContain("authorizationHeader = `Bearer ${candidate}`");
    expect(html).toContain("?action=check_login");
    expect(html).not.toMatch(/\b(?:localStorage|sessionStorage|document\.cookie)\s*(?:\.|=)/);
    expect(html).not.toMatch(
      /\?action=login['`][\s\S]{0,240}body:\s*JSON\.stringify\(\{\s*password/,
    );
  });

  it("preserves the bundled Vue, ECharts, and Tailwind license headers", () => {
    const vue = readFileSync(asset("vue.global.prod.js"), "utf8");
    const echarts = readFileSync(asset("echarts.min.js"), "utf8");
    const tailwind = readFileSync(asset("tailwind-compiled.css"), "utf8");

    expect(vue.slice(0, 180)).toContain("@license MIT");
    expect(echarts.slice(0, 450)).toContain("Apache Software Foundation");
    expect(tailwind.slice(0, 100)).toContain("tailwindcss");
    expect(tailwind.slice(0, 100)).toContain("MIT License");
  });

  it("contains a PNG icon asset", () => {
    const icon = readFileSync(asset("icon.png"));
    expect([...icon.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
