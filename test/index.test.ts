import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/index";

/**
 * Scheduled runtime integration (SPEC §9, §10, §11) and the HTTP surface (§8).
 *
 * The scheduled handler is where every prior phase's guarantee either holds or
 * is lost. Two properties matter most here, and neither is visible from inside a
 * single module:
 *
 * **The run must not be able to throw.** A rejection escapes into the Cron
 * runtime, which records a failed invocation and — more importantly — means the
 * history row was never attempted. When configured, a webhook notification may
 * also be skipped.
 *
 * **A D1 failure must not change the control outcome.** The history write happens
 * after the decision has already been applied, so an unavailable database must
 * degrade the *record*, never the *action* (SPEC §9.6).
 */

const SECRET = "SUPER-SECRET-VALUE";

function env(overrides: Partial<Env> = {}): Env {
  return {
    ALIYUN_ACCESS_KEY_ID: "AKID",
    ALIYUN_ACCESS_KEY_SECRET: SECRET,
    WEBHOOK_URL: "https://hooks.example.test/run",
    WEBHOOK_TOKEN: "tok123",
    REGION_ID: "cn-hongkong",
    ECS_INSTANCE_ID: "i-abc123",
    ADMIN_USER: "admin",
    ADMIN_TOKEN: "tok123",
    TRAFFIC_DB: { prepare: () => ({ bind: () => ({ run: () => Promise.resolve({}) }) }) },
    ...overrides,
  } as Env;
}

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

describe("scheduled — configuration failure aborts before any Alibaba call", () => {
  it("makes no Alibaba API call when the configuration is invalid", async () => {
    // This fixture has a configured webhook, so the assertion is on the
    // *Alibaba* endpoints, not on fetch generally.
    const alibaba: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
        alibaba.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(new Response("{}", { status: 200 }));
      });
    // Missing ECS_INSTANCE_ID: a config error.
    await worker.scheduled({} as ScheduledController, env({ ECS_INSTANCE_ID: "" }), ctx());
    expect(alibaba.filter((u) => u.includes("aliyuncs.com"))).toEqual([]);
    fetchSpy.mockRestore();
  });

  it("still reports a configuration failure to the webhook", async () => {
    const seen: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
        seen.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(new Response("{}", { status: 200 }));
      });
    await worker.scheduled({} as ScheduledController, env({ ECS_INSTANCE_ID: "" }), ctx());
    expect(seen.some((u) => u.includes("/run"))).toBe(true);
    fetchSpy.mockRestore();
  });

  it("does not notify about a configuration failure when the URL is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await worker.scheduled(
      {} as ScheduledController,
      env({ WEBHOOK_URL: undefined, WEBHOOK_TOKEN: undefined, ECS_INSTANCE_ID: "" }),
      ctx(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("resolves rather than throwing on a configuration failure", async () => {
    await expect(
      worker.scheduled({} as ScheduledController, env({ WEBHOOK_URL: "" }), ctx()),
    ).resolves.toBeUndefined();
  });
});

describe("scheduled — a run must not be able to throw", () => {
  it("resolves when every upstream fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      worker.scheduled({} as ScheduledController, env(), ctx()),
    ).resolves.toBeUndefined();
    fetchSpy.mockRestore();
  });

  it("resolves when the webhook itself rejects", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/run")) return Promise.reject(new Error("webhook exploded"));
        return Promise.reject(new Error("upstream down"));
      });
    await expect(
      worker.scheduled({} as ScheduledController, env(), ctx()),
    ).resolves.toBeUndefined();
    fetchSpy.mockRestore();
  });

  it("resolves when the D1 binding throws synchronously", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("upstream down"));
    const exploding = {
      prepare: () => {
        throw new Error("D1_ERROR: no such table");
      },
    };
    await expect(
      worker.scheduled(
        {} as ScheduledController,
        env({ TRAFFIC_DB: exploding as unknown as D1Database }),
        ctx(),
      ),
    ).resolves.toBeUndefined();
    fetchSpy.mockRestore();
  });
});

describe("scheduled — configured webhook reporting (SPEC §7.2, §9.2)", () => {
  it("attempts a webhook even when the run fails", async () => {
    const seen: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seen.push(url);
        if (url.includes("/run")) return Promise.resolve(new Response("{}", { status: 200 }));
        return Promise.reject(new Error("upstream down"));
      });
    await worker.scheduled({} as ScheduledController, env(), ctx());
    expect(seen.some((u) => u.includes("/run"))).toBe(true);
    fetchSpy.mockRestore();
  });

  it("attempts a webhook on a no-op run", async () => {
    // A no-op still reports when the optional notifier is configured.
    const seen: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seen.push(url);
        if (url.includes("/run")) return Promise.resolve(new Response("{}", { status: 200 }));
        // CDT then ECS describe, both plausible successes.
        if (url.includes("cdt.")) {
          return Promise.resolve(
            new Response(JSON.stringify({ TrafficDetails: [{ Traffic: 1024 ** 3 }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Instances: { Instance: [{ InstanceId: "i-abc123", Status: "Running" }] },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      });
    await worker.scheduled({} as ScheduledController, env(), ctx());
    expect(seen.some((u) => u.includes("/run"))).toBe(true);
    fetchSpy.mockRestore();
  });
});

describe("scheduled — webhook is optional", () => {
  it("runs and records history without attempting a webhook", async () => {
    const seen: string[] = [];
    let historyRow: Record<string, unknown> | undefined;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seen.push(url);
        if (url.includes("cdt.")) {
          return Promise.resolve(
            new Response(JSON.stringify({ TrafficDetails: [{ Traffic: 1024 ** 3 }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Instances: { Instance: [{ InstanceId: "i-abc123", Status: "Running" }] },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      });
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: () => {
            const columns = /\(([^)]+)\) VALUES/.exec(sql)?.[1]?.split(", ") ?? [];
            historyRow = Object.fromEntries(
              columns.map((column, index) => [column, values[index]]),
            );
            return Promise.resolve({});
          },
        }),
      }),
    };

    await worker.scheduled(
      {} as ScheduledController,
      env({
        WEBHOOK_URL: undefined,
        WEBHOOK_TOKEN: undefined,
        TRAFFIC_DB: db as unknown as D1Database,
      }),
      ctx(),
    );

    expect(seen.some((url) => url.includes("/run"))).toBe(false);
    expect(seen.some((url) => url.includes("cdt."))).toBe(true);
    expect(historyRow?.webhook_attempted).toBe(0);
    expect(historyRow?.webhook_ok).toBeNull();
    fetchSpy.mockRestore();
  });
});

describe("fetch — HTTP surface (SPEC §8.1)", () => {
  it("serves GET /health without authentication", async () => {
    const response = await worker.fetch(new Request("https://w.test/health"), env(), ctx());
    expect(response.status).toBe(200);
  });

  it("discloses no configuration value in the health body", async () => {
    const response = await worker.fetch(new Request("https://w.test/health"), env(), ctx());
    const body = JSON.stringify(await response.json());
    expect(body).not.toMatch(/i-abc|cn-hongkong|AKID|aliyuncs|tok123/i);
    expect(body).not.toContain(SECRET);
  });

  it("does not read D1 for /health", async () => {
    let prepared = 0;
    const counting = {
      prepare: () => {
        prepared += 1;
        return { bind: () => ({ run: () => Promise.resolve({}) }) };
      },
    };
    await worker.fetch(
      new Request("https://w.test/health"),
      env({ TRAFFIC_DB: counting as unknown as D1Database }),
      ctx(),
    );
    expect(prepared).toBe(0);
  });

  it("refuses the dashboard without authentication", async () => {
    const response = await worker.fetch(new Request("https://w.test/"), env(), ctx());
    expect(response.status).toBe(401);
  });

  it("refuses /api/history without authentication", async () => {
    const response = await worker.fetch(new Request("https://w.test/api/history"), env(), ctx());
    expect(response.status).toBe(401);
  });

  it("refuses /api/query without authentication", async () => {
    const response = await worker.fetch(
      new Request("https://w.test/api/query", { method: "POST" }),
      env(),
      ctx(),
    );
    expect(response.status).toBe(401);
  });

  it("refreshes the configured instance from live reads with no ECS mutation or D1 write", async () => {
    const actions: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const rpcBody = typeof init?.body === "string" ? init.body : "";
      const action = new URLSearchParams(rpcBody).get("Action");
      if (action !== null) actions.push(action);
      if (action === "ListCdtInternetTraffic") {
        return Promise.resolve(
          new Response(JSON.stringify({ TrafficDetails: [{ Traffic: 3 * 1024 ** 3 }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            Instances: { Instance: [{ InstanceId: "i-abc123", Status: "Running" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    let prepared = 0;
    const db = {
      prepare: () => {
        prepared += 1;
        throw new Error("refresh must not access D1");
      },
    };

    const response = await worker.fetch(
      new Request("https://w.test/?action=refresh_account", {
        method: "POST",
        headers: {
          authorization: "Bearer tok123",
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: "configured-instance" }),
      }),
      env({ TRAFFIC_DB: db as unknown as D1Database }),
      ctx(),
    );
    const body: {
      success: boolean;
      mutation: boolean;
      data: { flow_used: number; instanceStatus: string }[];
    } = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      mutation: false,
      data: [{ flow_used: 3, instanceStatus: "Running" }],
    });
    expect(actions).toEqual(["ListCdtInternetTraffic", "DescribeInstances"]);
    expect(actions).not.toContain("StartInstance");
    expect(actions).not.toContain("StopInstance");
    expect(prepared).toBe(0);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain("tok123");
    fetchSpy.mockRestore();
  });

  it("returns 404 for an unknown path", async () => {
    const response = await worker.fetch(new Request("https://w.test/nope"), env(), ctx());
    expect(response.status).toBe(404);
  });

  it("serves donor CSS, Vue, ECharts, icon, and source assets from the binding", async () => {
    const served: string[] = [];
    const assets: NonNullable<Env["ASSETS"]> = {
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        served.push(path);
        return Promise.resolve(new Response(`asset:${path}`));
      },
    };

    for (const path of [
      "/tailwind-compiled.css",
      "/vue.global.prod.js",
      "/echarts.min.js",
      "/icon.png",
      "/input.css",
    ]) {
      const response = await worker.fetch(
        new Request(`https://w.test${path}`),
        env({ ASSETS: assets }),
        ctx(),
      );
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(`asset:${path}`);
    }

    expect(served).toEqual([
      "/tailwind-compiled.css",
      "/vue.global.prod.js",
      "/echarts.min.js",
      "/icon.png",
      "/input.css",
    ]);
  });

  it("serves the donor index at / only after existing auth succeeds", async () => {
    let assetRequests = 0;
    const assets: NonNullable<Env["ASSETS"]> = {
      fetch: () => {
        assetRequests += 1;
        return Promise.resolve(
          new Response("<html>donor console</html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      },
    };

    const denied = await worker.fetch(
      new Request("https://w.test/"),
      env({ ASSETS: assets }),
      ctx(),
    );
    expect(denied.status).toBe(401);
    expect(assetRequests).toBe(0);

    const allowed = await worker.fetch(
      new Request("https://w.test/", {
        headers: { authorization: `Bearer tok123` },
      }),
      env({ ASSETS: assets }),
      ctx(),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toContain("text/html");
    expect(await allowed.text()).toContain("donor console");
    expect(assetRequests).toBe(1);
  });

  it("does not let API or health paths fall through to SPA assets", async () => {
    let assetRequests = 0;
    const assets: NonNullable<Env["ASSETS"]> = {
      fetch: () => {
        assetRequests += 1;
        return Promise.resolve(new Response("<html>fallback</html>"));
      },
    };

    const apiDenied = await worker.fetch(
      new Request("https://w.test/api/not-implemented"),
      env({ ASSETS: assets }),
      ctx(),
    );
    const health = await worker.fetch(
      new Request("https://w.test/health"),
      env({ ASSETS: assets }),
      ctx(),
    );
    const nestedHealth = await worker.fetch(
      new Request("https://w.test/health/extra"),
      env({ ASSETS: assets }),
      ctx(),
    );

    expect(apiDenied.status).toBe(401);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });
    expect(nestedHealth.status).toBe(404);
    expect(assetRequests).toBe(0);
  });

  it("authenticates SPA fallbacks and allows the authenticated fallback", async () => {
    const paths: string[] = [];
    const assets: NonNullable<Env["ASSETS"]> = {
      fetch: (request) => {
        paths.push(new URL(request.url).pathname);
        return Promise.resolve(new Response("<html>spa</html>"));
      },
    };

    const denied = await worker.fetch(
      new Request("https://w.test/settings"),
      env({ ASSETS: assets }),
      ctx(),
    );
    expect(denied.status).toBe(401);
    expect(paths).toEqual([]);

    const allowed = await worker.fetch(
      new Request("https://w.test/settings", {
        headers: { authorization: `Basic ${btoa("admin:tok123")}` },
      }),
      env({ ASSETS: assets }),
      ctx(),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("spa");
    expect(paths).toEqual(["/settings"]);
  });

  it("returns 405 for a known path with the wrong method", async () => {
    const response = await worker.fetch(
      new Request("https://w.test/api/query", { method: "GET" }),
      env(),
      ctx(),
    );
    expect(response.status).toBe(401);

    const authenticatedResponse = await worker.fetch(
      new Request("https://w.test/api/query", {
        method: "GET",
        headers: { authorization: `Basic ${btoa("admin:tok123")}` },
      }),
      env(),
      ctx(),
    );
    expect(authenticatedResponse.status).toBe(405);
  });

  it.each(["Start", "Stop"])(
    "rejects %s control without making any ECS or network call",
    async (action) => {
      let mutationCalls = 0;
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation((input: RequestInfo | URL) => {
          const target =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (target.includes("StartInstance") || target.includes("StopInstance"))
            mutationCalls += 1;
          return Promise.resolve(new Response("{}", { status: 200 }));
        });

      const response = await worker.fetch(
        new Request("https://w.test/?action=control_instance", {
          method: "POST",
          headers: {
            authorization: `Bearer tok123`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id: "i-test", action }),
        }),
        env(),
        ctx(),
      );
      const body = await response.json();

      expect(response.status).toBe(501);
      expect(body).toMatchObject({
        action: "control_instance",
        code: "FEATURE_NOT_IMPLEMENTED",
        success: false,
        mutation: false,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mutationCalls).toBe(0);
      fetchSpy.mockRestore();
    },
  );

  it("serves the dashboard with valid credentials", async () => {
    const response = await worker.fetch(
      new Request("https://w.test/", {
        headers: { authorization: `Basic ${btoa("admin:tok123")}` },
      }),
      env(),
      ctx(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("fails closed on every protected route when ADMIN_TOKEN is unset", async () => {
    const noToken = { ...env(), ADMIN_TOKEN: undefined } as unknown as Env;
    for (const [method, url] of [
      ["GET", "https://w.test/"],
      ["GET", "https://w.test/api/history"],
      ["POST", "https://w.test/api/query"],
    ] as const) {
      const response = await worker.fetch(
        new Request(url, {
          method,
          headers: { authorization: `Basic ${btoa("admin:anything")}` },
        }),
        noToken,
        ctx(),
      );
      expect(response.status, `${method} ${url}`).toBe(401);
    }
  });
});

describe("fetch — the fetch handler never runs a monitor (SPEC §8, anti-requirement)", () => {
  it("makes no Alibaba call for any HTTP route", async () => {
    // An unauthenticated fetch handler running the whole monitor is the
    // anti-requirement this project exists to avoid.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    for (const [method, url] of [
      ["GET", "https://w.test/health"],
      ["GET", "https://w.test/"],
      ["GET", "https://w.test/api/history"],
      ["POST", "https://w.test/api/query"],
      ["GET", "https://w.test/nope"],
    ] as const) {
      await worker.fetch(new Request(url, { method }), env(), ctx());
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not start or stop an instance for any HTTP route", async () => {
    // The control operations must be unreachable from every route (SPEC §8.5).
    const bodies: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body === "string") bodies.push(init.body);
        return Promise.resolve(new Response("{}", { status: 200 }));
      });
    for (const [method, url] of [
      ["GET", "https://w.test/health"],
      ["GET", "https://w.test/"],
      ["GET", "https://w.test/api/history"],
      ["POST", "https://w.test/api/query"],
    ] as const) {
      await worker.fetch(
        new Request(url, { method, headers: { authorization: `Basic ${btoa("admin:tok123")}` } }),
        env(),
        ctx(),
      );
    }
    const all = bodies.join(" ");
    expect(all).not.toContain("StartInstance");
    expect(all).not.toContain("StopInstance");
    fetchSpy.mockRestore();
  });
});

describe("scheduled — history and control are independent (SPEC §9.6, A11)", () => {
  it("completes the run when the history write fails", async () => {
    const seen: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seen.push(url);
        if (typeof init?.body === "string") seen.push(init.body);
        if (url.includes("/run")) return Promise.resolve(new Response("{}", { status: 200 }));
        if (url.includes("cdt.")) {
          return Promise.resolve(
            new Response(JSON.stringify({ TrafficDetails: [{ Traffic: 1024 ** 3 }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Instances: { Instance: [{ InstanceId: "i-abc123", Status: "Running" }] },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      });
    const failingDb = {
      prepare: () => ({
        bind: () => ({ run: () => Promise.reject(new Error("D1_ERROR: unavailable")) }),
      }),
    };
    await expect(
      worker.scheduled(
        {} as ScheduledController,
        env({ TRAFFIC_DB: failingDb as unknown as D1Database }),
        ctx(),
      ),
    ).resolves.toBeUndefined();
    // A no-op run: no mutation was needed, and the D1 failure must not change that.
    expect(seen.join(" ")).not.toContain("StartInstance");
    expect(seen.join(" ")).not.toContain("StopInstance");
    fetchSpy.mockRestore();
  });

  it("records exactly one history row per scheduled execution", async () => {
    let runs = 0;
    const countingDb = {
      prepare: () => ({
        bind: () => ({
          run: () => {
            runs += 1;
            return Promise.resolve({});
          },
        }),
      }),
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/run")) return Promise.resolve(new Response("{}", { status: 200 }));
        if (url.includes("cdt.")) {
          return Promise.resolve(
            new Response(JSON.stringify({ TrafficDetails: [{ Traffic: 1024 ** 3 }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Instances: { Instance: [{ InstanceId: "i-abc123", Status: "Running" }] },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      });
    await worker.scheduled(
      {} as ScheduledController,
      env({ TRAFFIC_DB: countingDb as unknown as D1Database }),
      ctx(),
    );
    expect(runs).toBe(1);
    fetchSpy.mockRestore();
  });
});
