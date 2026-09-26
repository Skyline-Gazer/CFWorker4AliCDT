/**
 * HTTP route dispatch (SPEC §8.1, §8.5).
 *
 * The pathname surface is deliberately small and closed: four routes, one of
 * them public and inert. Supported donor query actions adapt those same
 * authenticated read paths; unsupported actions stay behind a failure facade.
 * Two properties are structural rather than conventional.
 *
 * **No route can mutate an instance.** `RouteDeps` exposes no mutation seam at
 * all — there is no `startInstance`/`stopInstance` to call. A control route
 * cannot be added by wiring alone; it would require deliberately widening this
 * interface, which is exactly the reviewable change the design wants.
 *
 * **Dispatch is a table, not a branch chain.** Every method/path pair is stated
 * once, so "is this route protected" and "does this path exist" are answered by
 * the same data rather than by two pieces of logic that can disagree.
 *
 * The router returns a plain result rather than a `Response` so it can be tested
 * without the Worker runtime and so the caller owns serialisation.
 */

import { authenticate, basicChallenge } from "./auth";
import type { AuthConfig } from "./auth";
import {
  adaptDonorConfig,
  adaptDonorBilling,
  adaptDonorHistory,
  adaptDonorLogs,
  adaptDonorStatus,
  unsupportedDonorAction,
} from "./donor-actions";
import { redact } from "../redact";
import type { HistoryRow } from "../storage/read";
import type { ConfigResult } from "../config";
import type { DonorCostInfo } from "../aliyun/api";

/** What a handler returns: a body plus any headers to add. */
export interface HandlerOutput {
  readonly body: string;
  readonly headers?: Record<string, string>;
}

export interface RouteDeps {
  readonly auth: AuthConfig;
  /** Validated config for the authenticated donor `get_config` projection. */
  readonly config: () => ConfigResult;
  /** `GET /` — server-rendered dashboard (SPEC §8.4). */
  readonly dashboard: () => HandlerOutput | Promise<HandlerOutput>;
  /** `GET /api/history` — bounded history (SPEC §9.5). Serialised as-is. */
  readonly history: (limit?: number) => Promise<readonly HistoryRow[]>;
  /** `POST /api/query` — strictly read-only live query (SPEC §8.5). Serialised as-is. */
  readonly query: () => Promise<unknown>;
  /** Optional BSS balance read for authenticated donor billing actions. */
  readonly billing?: () => Promise<DonorCostInfo>;
}

export interface RouteResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * The pathname route table.
 *
 * A path is listed here even for methods it does not support, so a known path
 * with the wrong method can be distinguished from an unknown path. That
 * distinction is the whole reason `404` and `405` are separate requirements.
 */
const ROUTES: readonly { readonly path: string; readonly methods: readonly string[] }[] = [
  { path: "/health", methods: ["GET"] },
  { path: "/", methods: ["GET"] },
  { path: "/api/history", methods: ["GET"] },
  { path: "/api/query", methods: ["POST"] },
];

/** Paths served without authentication. Only liveness. */
const PUBLIC_PATHS: readonly string[] = ["/health"];

/** The methods actually used by the donor page for the adapted actions. */
const ADAPTED_DONOR_METHODS: ReadonlyMap<string, string> = new Map([
  ["login", "POST"],
  ["check_login", "GET"],
  ["get_status", "GET"],
  ["refresh_account", "POST"],
  ["get_history", "GET"],
  ["get_logs", "GET"],
  ["get_config", "GET"],
  ["get_billing", "GET"],
  ["send_test_webhook", "POST"],
  ["send_test_email", "POST"],
  ["send_test_telegram", "POST"],
]);

function isKnownPath(path: string): boolean {
  return ROUTES.some((entry) => entry.path === path);
}

function allowsMethod(path: string, method: string): boolean {
  const entry = ROUTES.find((candidate) => candidate.path === path);
  return entry?.methods.includes(method) ?? false;
}

function result(status: number, body: string, headers: Record<string, string> = {}): RouteResult {
  return { status, headers, body };
}

function authorize(request: Request, config: AuthConfig): boolean {
  // `.ok` is load-bearing: `authenticate` returns a result object, and
  // `!result` on an object is always `false` because objects are truthy. Without
  // this the guard silently never fires and every protected route is served
  // unauthenticated.
  return authenticate(request.headers.get("authorization"), config).ok;
}

/**
 * Dispatch one request.
 *
 * Never throws: a handler failure becomes a `500` with a generic body, because a
 * raw error message can carry a bound parameter or a credential (SPEC §7.5).
 */
export async function route(request: Request, deps: RouteDeps): Promise<RouteResult> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();
  const hasDonorAction = url.searchParams.has("action");

  // Protect the full root and API namespaces before checking route existence or
  // method. The imported donor UI sends its legacy actions as `/?action=...`;
  // those must also authenticate before returning either a placeholder or 405.
  const protectedPath =
    pathname === "/" || pathname === "/api" || pathname.startsWith("/api/") || hasDonorAction;
  if (protectedPath && !authorize(request, deps.auth)) {
    return result(401, "Unauthorized", { "www-authenticate": basicChallenge() });
  }

  if (hasDonorAction) {
    if (pathname !== "/") return result(404, "Not Found");
    if (method !== "GET" && method !== "POST") {
      return result(405, "Method Not Allowed", { allow: "GET, POST" });
    }
    const action = url.searchParams.get("action") ?? "";
    const expectedMethod = ADAPTED_DONOR_METHODS.get(action);
    if (expectedMethod !== undefined && method !== expectedMethod) {
      return result(405, "Method Not Allowed", { allow: expectedMethod });
    }
    try {
      return await dispatchDonorAction(action, deps);
    } catch (cause) {
      console.warn(`[http] donor action failed (${redact(errorMessage(cause))})`);
      return result(500, "Internal Server Error");
    }
  }

  // After namespace authentication, an unknown path is not part of the surface,
  // so no method on it can be "unsupported" — 404, never 405.
  if (!isKnownPath(pathname)) {
    return result(404, "Not Found");
  }

  if (!allowsMethod(pathname, method)) {
    // A real path with the wrong method. Reported as 405 so a client can tell a
    // typo from a missing route.
    return result(405, "Method Not Allowed", { allow: allowedMethodsFor(pathname) });
  }

  // Authentication before any work. A protected route must not reach its handler
  // with bad credentials, so nothing is invoked below this point until it passes.
  if (!protectedPath && !PUBLIC_PATHS.includes(pathname) && !authorize(request, deps.auth)) {
    return result(401, "Unauthorized", { "www-authenticate": basicChallenge() });
  }

  try {
    return await dispatch(pathname, deps);
  } catch (cause) {
    // Redacted: a D1 driver error can echo the failed statement and its bound
    // parameters, and this body may be returned to a client.
    console.warn(`[http] handler failed (${redact(errorMessage(cause))})`);
    return result(500, "Internal Server Error");
  }
}

async function dispatchDonorAction(action: string, deps: RouteDeps): Promise<RouteResult> {
  // Authorization was checked before this function runs. These are UX replies
  // to that check only; no credential is parsed from a request body or returned.
  if (action === "login" || action === "check_login") {
    return jsonResult(200, { success: true, logged_in: true, mutation: false });
  }

  if (action === "get_status" || action === "refresh_account") {
    return jsonResult(200, adaptDonorStatus(await deps.query()));
  }

  if (action === "get_history") {
    // The donor chart receives at most the newest 200 D1 observations.
    const rows = await deps.history(200);
    return jsonResult(200, adaptDonorHistory(rows));
  }

  if (action === "get_logs") {
    // Logs are the same bounded monitoring observations, not a separate store.
    const rows = await deps.history(200);
    return jsonResult(200, adaptDonorLogs(rows));
  }

  if (action === "get_config") {
    const parsed = deps.config();
    if (!parsed.ok) return result(500, "Internal Server Error");
    return jsonResult(200, adaptDonorConfig(parsed.config));
  }

  if (action === "send_test_webhook") {
    // Deliberately ignore the request body: webhook credentials come only from
    // validated Worker config, and HTTP never invokes the scheduled sender.
    const parsed = deps.config();
    if (!parsed.ok) return result(500, "Internal Server Error");
    return jsonResult(501, {
      success: false,
      available: false,
      mutation: false,
      code:
        parsed.config.webhookUrl === undefined ? "WEBHOOK_NOT_CONFIGURED" : "BACKEND_NOT_AVAILABLE",
      action: "send_test_webhook",
    });
  }

  if (action === "send_test_email") {
    // Ignore browser SMTP credentials; only Worker bindings decide configuration.
    const parsed = deps.config();
    if (!parsed.ok) return result(500, "Internal Server Error");
    const configured = parsed.config.smtpHost !== undefined && parsed.config.smtpFrom !== undefined;
    return jsonResult(501, {
      success: false,
      available: false,
      mutation: false,
      code: configured ? "BACKEND_NOT_AVAILABLE" : "SMTP_NOT_CONFIGURED",
      action: "send_test_email",
    });
  }

  if (action === "send_test_telegram") {
    // Ignore browser Telegram credentials; only Worker bindings decide configuration.
    const parsed = deps.config();
    if (!parsed.ok) return result(500, "Internal Server Error");
    const configured =
      parsed.config.telegramBotToken !== undefined && parsed.config.telegramChatId !== undefined;
    return jsonResult(501, {
      success: false,
      available: false,
      mutation: false,
      code: configured ? "BACKEND_NOT_AVAILABLE" : "TELEGRAM_NOT_CONFIGURED",
      action: "send_test_telegram",
    });
  }

  if (action === "get_billing") {
    const cost =
      deps.billing === undefined
        ? { enabled: false, monthly_cost: null, balance: null, currency: null, error: null }
        : await deps.billing();
    return jsonResult(200, adaptDonorBilling(cost));
  }

  const unsupported = unsupportedDonorAction(action);
  return result(unsupported.status, unsupported.body, unsupported.headers);
}

function jsonResult(status: number, value: unknown): RouteResult {
  return result(status, JSON.stringify(value), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
}

function allowedMethodsFor(path: string): string {
  const entry = ROUTES.find((candidate) => candidate.path === path);
  return entry === undefined ? "" : entry.methods.join(", ");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "unknown handler failure";
}

async function dispatch(pathname: string, deps: RouteDeps): Promise<RouteResult> {
  if (pathname === "/health") {
    // Inert: no Alibaba call, no D1 read, no configuration disclosed.
    return result(200, JSON.stringify({ status: "ok", service: "cfworker4alicdt" }), {
      "content-type": "application/json",
    });
  }

  if (pathname === "/") {
    const output = await deps.dashboard();
    return result(200, output.body, {
      "content-type": "text/html; charset=utf-8",
      ...output.headers,
    });
  }

  if (pathname === "/api/history") {
    const rows = await deps.history();
    return result(200, JSON.stringify(rows), { "content-type": "application/json" });
  }

  // `/api/query` — the only remaining route in the table. It is strictly
  // read-only: `deps.query` has no way to issue a mutation (SPEC §8.5).
  const outcome = await deps.query();
  return result(200, JSON.stringify(outcome), { "content-type": "application/json" });
}
