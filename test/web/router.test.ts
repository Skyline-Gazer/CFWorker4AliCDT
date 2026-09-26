import { describe, expect, it } from "vitest";

import { route } from "../../src/web/router";
import type { RouteDeps, RouteResult } from "../../src/web/router";
import type { AuthConfig } from "../../src/web/auth";
import type { HistoryRow } from "../../src/storage/read";
import { loadConfig } from "../../src/config";

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
  readonly counts: {
    dashboard: number;
    history: number;
    query: number;
    historyLimit: number | undefined;
  };
}

function harness(overrides: Partial<RouteDeps> = {}): Harness {
  const counts: Harness["counts"] = {
    dashboard: 0,
    history: 0,
    query: 0,
    historyLimit: undefined,
  };
  const defaults: RouteDeps = {
    auth: AUTH,
    config: () =>
      loadConfig({
        ALIYUN_ACCESS_KEY_ID: "secret-access-id",
        ALIYUN_ACCESS_KEY_SECRET: "secret-access-key",
        ADMIN_TOKEN: "tok123",
        WEBHOOK_URL: "https://hooks.example/private-path?token=secret-url-token",
        WEBHOOK_TOKEN: "secret-webhook-token",
        REGION_ID: "cn-hongkong",
        ECS_INSTANCE_ID: "i-0123456789abcdef0",
        TRAFFIC_THRESHOLD_GB: "42.5",
        CDT_ENDPOINT: "cdt.example.aliyun.com",
        BUSINESS_REGION_ID: "cn-hongkong",
        SIGNATURE_VERSION: "v2",
        STOPPED_MODE: "StopCharging",
      }),
    dashboard: () => {
      counts.dashboard += 1;
      return Promise.resolve({ body: "<html>dashboard</html>" });
    },
    // `unknown` return types: the router only serialises these, so it must not
    // require a specific shape from the read paths.
    history: (limit) => {
      counts.history += 1;
      counts.historyLimit = limit;
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
    ["GET", "/?action=get_config"],
    ["GET", "/?action=get_logs"],
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

  it("protects every /api path before route and method checks", async () => {
    const { deps } = harness();
    for (const [method, path] of [
      ["GET", "/api"],
      ["GET", "/api/unknown"],
      ["DELETE", "/api/query"],
    ] as const) {
      const result = await route(request(method, path), deps);
      expect(result.status, `${method} ${path}`).toBe(401);
    }
  });

  it("protects donor action requests before method and action dispatch", async () => {
    const { deps } = harness();
    for (const method of ["GET", "POST", "DELETE"]) {
      const result = await route(request(method, "/?action=control_instance"), deps);
      expect(result.status, method).toBe(401);
    }
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

  it("serves get_logs from the bounded history dependency", async () => {
    const historyRow: HistoryRow = {
      id: 7,
      checked_at: "2026-09-26T11:00:00.000Z",
      trigger: "scheduled",
      status: "error",
      traffic_gb: null,
      threshold_gb: 42.5,
      usage_percent: null,
      remaining_gb: null,
      ecs_status_before: null,
      desired_ecs_state: null,
      action: null,
      decision_reason: null,
      ecs_status_after: null,
      control_ok: null,
      webhook_attempted: null,
      webhook_ok: null,
      error_stage: "query",
      error_message: "failed: WEBHOOK_TOKEN=private-webhook-token",
      duration_ms: 123,
    };
    let historyCalls = 0;
    let requestedLimit: number | undefined;
    const { deps, counts } = harness({
      history: (limit) => {
        historyCalls += 1;
        requestedLimit = limit;
        return [historyRow];
      },
    });
    const result = await route(
      request("GET", "/?action=get_logs&tab=errors", basic("admin", "tok123")),
      deps,
    );

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("application/json");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(result.body)).toEqual({
      success: true,
      mutation: false,
      data: [
        {
          id: 7,
          time: historyRow.checked_at,
          level: "error",
          message: "error",
          trigger: "scheduled",
          status: "error",
          traffic_gb: null,
          threshold_gb: 42.5,
          action: null,
          decision_reason: null,
          error_stage: "query",
          error_message: "failed: WEBHOOK_TOKEN=[REDACTED]",
          duration_ms: 123,
        },
      ],
    });
    expect(result.body).not.toContain("private-webhook-token");
    expect(historyCalls).toBe(1);
    expect(requestedLimit).toBe(200);
    expect(counts.query + counts.dashboard).toBe(0);
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

  it("returns an explicit unsupported response for control_instance", async () => {
    const { deps, counts } = harness();
    const result = await route(request("POST", "/?action=control_instance", "Bearer tok123"), deps);

    expect(result.status).toBe(501);
    expect(result.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(result.body)).toMatchObject({
      action: "control_instance",
      code: "FEATURE_NOT_IMPLEMENTED",
      success: false,
      mutation: false,
    });
    expect(counts.dashboard + counts.history + counts.query).toBe(0);
  });

  it("returns an explicit unsupported response for clear_logs without success", async () => {
    const { deps } = harness();
    const result = await route(
      request("POST", "/?action=clear_logs", basic("admin", "tok123")),
      deps,
    );
    const body = JSON.parse(result.body) as { success: boolean; code: string; mutation: boolean };

    expect(result.status).toBe(501);
    expect(body.success).toBe(false);
    expect(body.code).toBe("FEATURE_NOT_IMPLEMENTED");
    expect(body.mutation).toBe(false);
  });

  it("returns non-success placeholders for donor actions outside this adapter", async () => {
    const { deps } = harness();
    const actions = [
      "check_init",
      "setup",
      "control_instance",
      "save_config",
      "send_test_email",
      "send_test_telegram",
      "send_test_webhook",
      "clear_logs",
      "logout",
    ];

    for (const action of actions) {
      const result = await route(
        request("GET", `/?action=${action}`, basic("admin", "tok123")),
        deps,
      );
      expect(result.status, action).toBe(501);
      expect(JSON.parse(result.body), action).toMatchObject({
        action,
        success: false,
        ok: false,
        available: false,
        mutation: false,
      });
    }
  });

  it("keeps unknown and prototype-like action names in the failure contract", async () => {
    const { deps } = harness();
    for (const action of ["unlisted_action", "toString", "__proto__"]) {
      const result = await route(
        request("GET", `/?action=${action}`, basic("admin", "tok123")),
        deps,
      );
      expect(result.status).toBe(501);
      expect(JSON.parse(result.body)).toMatchObject({
        action: /^[a-z0-9_]{1,64}$/.test(action) ? action : "unknown",
        code: "ACTION_NOT_AVAILABLE",
        success: false,
        mutation: false,
      });
    }
  });

  it("returns only the allowlisted config fields and secret-presence booleans", async () => {
    const { deps, counts } = harness();
    const result = await route(
      request("GET", "/?action=get_config", basic("admin", "tok123")),
      deps,
    );

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("application/json");
    expect(result.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(result.body) as {
      success: boolean;
      mutation: boolean;
      data: Record<string, unknown>;
    };
    expect(body).toEqual({
      success: true,
      mutation: false,
      data: {
        REGION_ID: "cn-hongkong",
        ECS_INSTANCE_ID: "i-0123456789abcdef0",
        TRAFFIC_THRESHOLD_GB: 42.5,
        CDT_ENDPOINT: "cdt.example.aliyun.com",
        BUSINESS_REGION_ID: "cn-hongkong",
        SIGNATURE_VERSION: "v2",
        STOPPED_MODE: "StopCharging",
        webhook_url_configured: true,
        webhook_token_configured: true,
        admin_token_configured: true,
        aliyun_credentials_configured: true,
      },
    });
    expect(Object.keys(body.data).sort()).toEqual(
      [
        "BUSINESS_REGION_ID",
        "CDT_ENDPOINT",
        "ECS_INSTANCE_ID",
        "REGION_ID",
        "SIGNATURE_VERSION",
        "STOPPED_MODE",
        "TRAFFIC_THRESHOLD_GB",
        "admin_token_configured",
        "aliyun_credentials_configured",
        "webhook_token_configured",
        "webhook_url_configured",
      ].sort(),
    );
    for (const secret of [
      "secret-access-id",
      "secret-access-key",
      "secret-url-token",
      "secret-webhook-token",
      "tok123",
      "https://hooks.example/private-path?token=",
    ])
      expect(result.body).not.toContain(secret);
    expect(counts.dashboard).toBe(0);
  });

  it("returns null for an unset business region and false secret presence flags", async () => {
    const { deps } = harness({
      config: () =>
        loadConfig({
          ALIYUN_ACCESS_KEY_ID: "id",
          ALIYUN_ACCESS_KEY_SECRET: "secret",
          REGION_ID: "cn-hongkong",
          ECS_INSTANCE_ID: "i-0123456789abcdef0",
        }),
    });
    const result = await route(request("GET", "/?action=get_config", "Bearer tok123"), deps);
    const data = (JSON.parse(result.body) as { data: Record<string, unknown> }).data;
    expect(result.status).toBe(200);
    expect(data.BUSINESS_REGION_ID).toBeNull();
    expect(data.webhook_url_configured).toBe(false);
    expect(data.webhook_token_configured).toBe(false);
    expect(data.admin_token_configured).toBe(false);
    expect(data.aliyun_credentials_configured).toBe(true);
  });

  it("keeps save_config fail-closed with the backend unavailable contract", async () => {
    const { deps } = harness();
    const result = await route(
      request("POST", "/?action=save_config", basic("admin", "tok123")),
      deps,
    );
    expect(result.status).toBe(501);
    expect(JSON.parse(result.body)).toMatchObject({
      action: "save_config",
      success: false,
      available: false,
      mutation: false,
      code: "BACKEND_NOT_AVAILABLE",
    });
  });

  it("keeps authentication as the gate for donor login and never echoes credentials", async () => {
    const { deps } = harness();
    const denied = await route(request("POST", "/?action=login"), deps);
    expect(denied.status).toBe(401);
    expect(denied.body).not.toContain("tok123");

    const accepted = await route(request("POST", "/?action=login", "Bearer tok123"), deps);
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({
      success: true,
      logged_in: true,
      mutation: false,
    });
    expect(accepted.body).not.toContain("tok123");
  });

  it("rejects unauthenticated status, refresh, and history actions before any read", async () => {
    const { deps, counts } = harness();
    const actions: readonly (readonly [string, string])[] = [
      ["GET", "/?action=get_status"],
      ["POST", "/?action=refresh_account"],
      ["GET", "/?action=get_history"],
    ];

    for (const [method, path] of actions) {
      const missing = await route(request(method, path), deps);
      const invalid = await route(request(method, path, "Bearer invalid"), deps);
      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).not.toContain("tok123");
      expect(invalid.body).not.toContain("invalid");
    }

    expect(counts.query).toBe(0);
    expect(counts.history).toBe(0);
  });

  it("answers check_login only after existing Authorization validation", async () => {
    const { deps } = harness();
    const invalid = await route(request("GET", "/?action=check_login", "Bearer wrong"), deps);
    const valid = await route(
      request("GET", "/?action=check_login", basic("admin", "tok123")),
      deps,
    );

    expect(invalid.status).toBe(401);
    expect(valid.status).toBe(200);
    expect(JSON.parse(valid.body)).toMatchObject({
      success: true,
      logged_in: true,
      mutation: false,
    });
  });

  it("maps status and refresh to the real query result without a history write", async () => {
    const queryResult = {
      status: "success",
      trafficGB: 1.5,
      thresholdGB: 10,
      ecsStatus: "Running",
      desired: "running",
      action: "none-running",
      mutation: false,
    };
    let queryCalls = 0;
    const { deps, counts } = harness({
      query: () => {
        queryCalls += 1;
        return Promise.resolve(queryResult);
      },
    });

    const status = await route(request("GET", "/?action=get_status", "Bearer tok123"), deps);
    const refresh = await route(request("POST", "/?action=refresh_account", "Bearer tok123"), deps);

    expect(JSON.parse(status.body)).toMatchObject({
      success: true,
      mutation: false,
      data: [{ flow_used: 1.5, flow_total: 10, percentageOfUse: 15, instanceStatus: "Running" }],
    });
    expect(JSON.parse(refresh.body)).toEqual(JSON.parse(status.body));
    expect(queryCalls).toBe(2);
    expect(counts.history).toBe(0);
  });

  it("adapts donor history from the newest bounded read", async () => {
    const checkedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    let historyCalls = 0;
    let requestedLimit: number | undefined;
    const { deps, counts } = harness({
      history: (limit) => {
        historyCalls += 1;
        requestedLimit = limit;
        return Promise.resolve([
          {
            id: 2,
            checked_at: checkedAt,
            trigger: "scheduled",
            status: "success",
            traffic_gb: 3,
            threshold_gb: 180,
            usage_percent: 1.6667,
            remaining_gb: 177,
            ecs_status_before: "Running",
            desired_ecs_state: "running",
            action: "none-running",
            ecs_status_after: "Running",
            control_ok: 1,
            webhook_attempted: 0,
            webhook_ok: null,
            error_stage: null,
            error_message: null,
            decision_reason: "measured reason",
            duration_ms: 1,
          },
          {
            id: 1,
            checked_at: new Date(Date.now() - 20 * 60_000).toISOString(),
            trigger: "scheduled",
            status: "error",
            traffic_gb: null,
            threshold_gb: 180,
            usage_percent: null,
            remaining_gb: null,
            ecs_status_before: null,
            desired_ecs_state: null,
            action: null,
            ecs_status_after: null,
            control_ok: 1,
            webhook_attempted: 0,
            webhook_ok: null,
            error_stage: "cdt-query",
            error_message: null,
            decision_reason: null,
            duration_ms: 1,
          },
        ]);
      },
    });

    const result = await route(request("GET", "/?action=get_history", "Bearer tok123"), deps);

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      success: true,
      mutation: false,
      data: {
        history_24h: [{ time: checkedAt, value: 3 }],
        history_30d: [{ date: checkedAt.slice(0, 10), value: 3 }],
      },
    });
    expect(historyCalls).toBe(1);
    expect(requestedLimit).toBe(200);
    expect(counts.history).toBe(0);
  });

  it("keeps logout as an explicit unsupported placeholder", async () => {
    const { deps } = harness();
    const result = await route(request("POST", "/?action=logout", "Bearer tok123"), deps);

    expect(result.status).toBe(501);
    expect(JSON.parse(result.body)).toMatchObject({
      success: false,
      code: "FEATURE_NOT_IMPLEMENTED",
      mutation: false,
    });
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
    expect(Object.keys(deps).sort()).toEqual(["auth", "config", "dashboard", "history", "query"]);
    expect(deps).not.toHaveProperty("startInstance");
    expect(deps).not.toHaveProperty("stopInstance");
  });

  it("does not recognise a control path even when authenticated", async () => {
    // The 404s above are asserted with valid credentials, so a 401 would mask a
    // route that exists. This pins that the status is 404 and not 401/405.
    const { deps } = harness();
    for (const path of controlPaths) {
      const result = await route(request("POST", path, basic("admin", "tok123")), deps);
      expect(result.status).toBe(404);
    }
  });

  it("never invokes a handler for an unknown path", async () => {
    // A route that 404s must also not have done any work on the way there.
    let calls = 0;
    const { deps } = harness({
      dashboard: () => {
        calls += 1;
        return { body: "x" };
      },
      history: () => {
        calls += 1;
        return Promise.resolve([]);
      },
      query: () => {
        calls += 1;
        return Promise.resolve({});
      },
    });
    for (const path of ["/start", "/stop", "/api/control", "/nope"]) {
      await route(request("POST", path, basic("admin", "tok123")), deps);
    }
    expect(calls).toBe(0);
  });

  it("does not run a handler when authentication fails", async () => {
    let calls = 0;
    const { deps } = harness({
      dashboard: () => {
        calls += 1;
        return { body: "leaked" };
      },
    });
    const result = await route(request("GET", "/", basic("admin", "WRONG")), deps);
    expect(result.status).toBe(401);
    expect(calls).toBe(0);
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

  it("does not send a donor action on a non-root API path to the asset surface", async () => {
    const { deps } = harness();
    const result = await route(
      request("GET", "/api/status?action=get_status", basic("admin", "tok123")),
      deps,
    );
    expect(result.status).toBe(404);
    expect(result.headers["content-type"]).toBeUndefined();
  });
});
