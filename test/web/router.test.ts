import { describe, expect, it } from "vitest";

import { route } from "../../src/web/router";
import type { RouteDeps, RouteResult } from "../../src/web/router";
import type { AuthConfig } from "../../src/web/auth";

/**
 * HTTP dispatch (SPEC §8.1).
 *
 * The surface is small and closed, so dispatch is asserted exhaustively rather
 * than sampled. Two properties carry the weight.
 *
 * **No route mutates an instance.** The absence of a control route is asserted
 * directly, and the injected dependencies have no mutation seam at all — the
 * router cannot call `StartInstance` because it is never given one.
 *
 * **Auth is consulted before any work.** A protected route with bad credentials
 * must not reach its handler, so the handler counters stay at zero.
 */

const AUTH: AuthConfig = { adminUser: "admin", adminToken: "tok123" };

function basic(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

interface Harness {
  readonly deps: RouteDeps;
  readonly counts: { dashboard: number; history: number; query: number };
}

function harness(overrides: Partial<RouteDeps> = {}): Harness {
  const counts = { dashboard: 0, history: 0, query: 0 };
  const defaults: RouteDeps = {
    auth: AUTH,
    dashboard: () => {
      counts.dashboard += 1;
      return Promise.resolve({ body: "<html>dashboard</html>" });
    },
    // `unknown` return types: the router only serialises these, so it must not
    // require a specific shape from the read paths.
    history: () => {
      counts.history += 1;
      return Promise.resolve([]);
    },
    query: () => {
      counts.query += 1;
      return Promise.resolve({ trafficGB: 1, ecsStatus: "running", decision: "none-running" });
    },
  };
  return { deps: { ...defaults, ...overrides }, counts };
}

function request(method: string, path: string, authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request(`https://worker.test${path}`, { method, headers });
}

describe("route — public surface", () => {
  it("serves GET /health without authentication", async () => {
    const { deps } = harness();
    const result = await route(request("GET", "/health"), deps);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ status: "ok" });
  });

  it("serves GET /health even when ADMIN_TOKEN is unset", async () => {
    // Liveness must not depend on the dashboard secret, or a misconfigured
    // deploy would look entirely dead (SPEC §8.3 locks the *protected* routes).
    const { deps } = harness({ auth: { adminUser: "admin", adminToken: undefined } });
    const result = await route(request("GET", "/health"), deps);
    expect(result.status).toBe(200);
  });

  it("reveals no configuration in the health body", async () => {
    const { deps } = harness();
    const result = await route(request("GET", "/health"), deps);
    expect(result.body).not.toMatch(/i-[0-9a-f]{8,}|cn-|aliyuncs|tok123|AccessKey/i);
  });

  it("does not read history or run a query for /health", async () => {
    const { deps, counts } = harness();
    await route(request("GET", "/health"), deps);
    expect(counts.history).toBe(0);
    expect(counts.query).toBe(0);
    expect(counts.dashboard).toBe(0);
  });
});

describe("route — protected routes require authentication", () => {
  const protectedRoutes: readonly (readonly [string, string])[] = [
    ["GET", "/"],
    ["GET", "/api/history"],
    ["POST", "/api/query"],
  ];

  it.each(protectedRoutes)("%s %s refuses a missing credential", async (method, path) => {
    const { deps, counts } = harness();
    const result = await route(request(method, path), deps);
    expect(result.status).toBe(401);
    expect(counts.dashboard + counts.history + counts.query).toBe(0);
  });

  it.each(protectedRoutes)("%s %s refuses a wrong token", async (method, path) => {
    const { deps, counts } = harness();
    const result = await route(request(method, path, basic("admin", "wrong")), deps);
    expect(result.status).toBe(401);
    expect(counts.dashboard + counts.history + counts.query).toBe(0);
  });

  it.each(protectedRoutes)("%s %s refuses a malformed header", async (method, path) => {
    const { deps } = harness();
    for (const header of ["not-base64!!!", "Basic", "Bearer ", "Digest xyz", ""]) {
      const result = await route(request(method, path, header), deps);
      expect(result.status, `${header} must be refused`).toBe(401);
    }
  });

  it("issues a WWW-Authenticate challenge on 401", async () => {
    const { deps } = harness();
    const result = await route(request("GET", "/"), deps);
    expect(result.status).toBe(401);
    expect(result.headers["www-authenticate"]).toContain("Basic realm=");
  });

  it("fails closed on every protected route when ADMIN_TOKEN is unset", async () => {
    const { deps, counts } = harness({ auth: { adminUser: "admin", adminToken: undefined } });
    for (const [method, path] of protectedRoutes) {
      const result = await route(request(method, path, basic("admin", "")), deps);
      expect(result.status, `${method} ${path}`).toBe(401);
    }
    expect(counts.dashboard + counts.history + counts.query).toBe(0);
  });
});

describe("route — dispatch with valid credentials", () => {
  it("serves the dashboard at GET /", async () => {
    const { deps, counts } = harness();
    const result = await route(request("GET", "/", basic("admin", "tok123")), deps);
    expect(result.status).toBe(200);
    expect(counts.dashboard).toBe(1);
  });

  it("serves history at GET /api/history as JSON", async () => {
    const { deps, counts } = harness();
    const result = await route(request("GET", "/api/history", basic("admin", "tok123")), deps);
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("application/json");
    expect(counts.history).toBe(1);
  });

  it("serves a query at POST /api/query", async () => {
    const { deps, counts } = harness();
    const result = await route(request("POST", "/api/query", basic("admin", "tok123")), deps);
    expect(result.status).toBe(200);
    expect(counts.query).toBe(1);
  });

  it("accepts a Bearer token on protected routes", async () => {
    const { deps, counts } = harness();
    const result = await route(request("GET", "/api/history", "Bearer tok123"), deps);
    expect(result.status).toBe(200);
    expect(counts.history).toBe(1);
  });
});

describe("route — 404 and 405 semantics (SPEC §8.1)", () => {
  const unknownPaths = [
    "/nope",
    "/api",
    "/api/",
    "/api/unknown",
    "/start",
    "/stop",
    "/run",
    "/run-control",
    "/execute-control",
    "/admin",
    "/health/extra",
  ];

  it.each(unknownPaths)("%s returns 404", async (path) => {
    const { deps } = harness();
    const result = await route(request("GET", path, basic("admin", "tok123")), deps);
    expect(result.status).toBe(404);
  });

  it("returns 405 for a known path with an unsupported method", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["POST", "/health"],
      ["DELETE", "/health"],
      ["POST", "/"],
      ["POST", "/api/history"],
      ["GET", "/api/query"],
      ["PUT", "/api/query"],
    ];
    for (const [method, path] of cases) {
      const { deps } = harness();
      const result = await route(request(method, path, basic("admin", "tok123")), deps);
      expect(result.status, `${method} ${path} must be 405`).toBe(405);
    }
  });

  it("does not run a handler for a 405", async () => {
    const { deps, counts } = harness();
    await route(request("POST", "/api/history", basic("admin", "tok123")), deps);
    expect(counts.dashboard + counts.history + counts.query).toBe(0);
  });
});

describe("route — no mutating route exists (SPEC §8.5, A6)", () => {
  const controlPaths = [
    "/start",
    "/stop",
    "/reboot",
    "/run-control",
    "/execute-control",
    "/api/start",
    "/api/stop",
    "/api/control",
  ];

  it.each(controlPaths)("has no route at %s for any method", async (path) => {
    const { deps } = harness();
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      const result = await route(request(method, path, basic("admin", "tok123")), deps);
      // 404 rather than 405: the path is not part of the surface at all.
      expect(result.status, `${method} ${path}`).toBe(404);
    }
  });

  it("exposes no dependency through which a mutation could be issued", () => {
    // Structural guarantee: `RouteDeps` has no `startInstance`/`stopInstance`
    // seam, so a future handler cannot reach one by accident.
    const { deps } = harness();
    expect(Object.keys(deps).sort()).toEqual(["auth", "dashboard", "history", "query"]);
    expect(deps).not.toHaveProperty("startInstance");
    expect(deps).not.toHaveProperty("stopInstance");
  });
});

describe("route — handler failures do not leak (SPEC §7.5)", () => {
  it("maps a thrown handler to a 500 without echoing the error", async () => {
    const { deps } = harness({
      history: () => Promise.reject(new Error("D1_ERROR: AccessKeySecret=LTAI5tSecretValue")),
    });
    const result = await route(request("GET", "/api/history", basic("admin", "tok123")), deps);
    expect(result.status).toBe(500);
    expect(result.body).not.toContain("LTAI5tSecretValue");
  });

  it("maps a synchronously thrown handler to a 500", async () => {
    const { deps } = harness({
      dashboard: () => {
        throw new Error("boom");
      },
    });
    const result = await route(request("GET", "/", basic("admin", "tok123")), deps);
    expect(result.status).toBe(500);
  });

  it("never leaks the token in an error body", async () => {
    const { deps } = harness({
      query: () => Promise.reject(new Error("token tok123 rejected")),
    });
    const result = await route(request("POST", "/api/query", basic("admin", "tok123")), deps);
    expect(result.body).not.toContain("tok123");
  });
});

describe("route — result shape", () => {
  it("always returns a status, headers, and a string body", async () => {
    const { deps } = harness();
    const results: RouteResult[] = [
      await route(request("GET", "/health"), deps),
      await route(request("GET", "/"), deps),
      await route(request("GET", "/nope"), deps),
    ];
    for (const result of results) {
      expect(typeof result.status).toBe("number");
      expect(typeof result.body).toBe("string");
      expect(result.headers).toBeTypeOf("object");
    }
  });
});
