/**
 * HTTP route dispatch (SPEC §8.1, §8.5).
 *
 * The surface is deliberately small and closed: four routes, one of them public
 * and inert. Two properties are structural rather than conventional.
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
import { redact } from "../redact";

/** What a handler returns: a body plus any headers to add. */
export interface HandlerOutput {
  readonly body: string;
  readonly headers?: Record<string, string>;
}

export interface RouteDeps {
  readonly auth: AuthConfig;
  /** `GET /` — server-rendered dashboard (SPEC §8.4). */
  readonly dashboard: () => HandlerOutput | Promise<HandlerOutput>;
  /** `GET /api/history` — bounded history (SPEC §9.5). Serialised as-is. */
  readonly history: () => Promise<unknown>;
  /** `POST /api/query` — strictly read-only live query (SPEC §8.5). Serialised as-is. */
  readonly query: () => Promise<unknown>;
}

export interface RouteResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * The route table.
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
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();

  // Unknown path first: it is not part of the surface at all, so no method on it
  // can be "unsupported" — 404, never 405.
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
  if (!PUBLIC_PATHS.includes(pathname) && !authorize(request, deps.auth)) {
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
    return result(200, output.body, { "content-type": "text/html; charset=utf-8" });
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
