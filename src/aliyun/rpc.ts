import { z } from "zod";

import type { SignatureVersion, SignRequest } from "./signing";
import { percentEncode } from "./encoding";
import { signRequest } from "./signing";

/**
 * The single boundary through which every Alibaba Cloud API call passes.
 *
 * Centralising transport here is what makes the fail-safe invariant tractable:
 * every call gets the same timeout, the same error classification, and the same
 * redaction, so no call site can accidentally report a transport failure as an
 * empty success or leak a credential into an error message.
 */

/** Classification of a failed call. Mirrors SPEC §4.6. */
export type RpcErrorKind = "transport" | "throttle" | "server" | "client" | "api" | "parse";

/**
 * Whether a failure of this kind may be retried. SPEC §4.6.
 *
 * Exhaustive by type: adding a kind to `RpcErrorKind` without classifying it
 * here is a compile error, so a new failure mode cannot default to retryable.
 */
const RETRYABLE: Record<RpcErrorKind, boolean> = {
  transport: true,
  throttle: true,
  server: true,
  client: false,
  api: false,
  parse: false,
};

export function isRetryable(kind: RpcErrorKind): boolean {
  return RETRYABLE[kind];
}

/**
 * A failed RPC call.
 *
 * `message` is safe for logs and webhook payloads: it is assembled from
 * literals, a numeric status, and a redacted remote message. It never contains
 * a credential or an Authorization header.
 */
export class RpcError extends Error {
  readonly kind: RpcErrorKind;
  /** HTTP status, when a response was received. `undefined` on transport throw. */
  readonly status: number | undefined;

  constructor(kind: RpcErrorKind, message: string, status?: number) {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
    this.status = status;
  }

  get retryable(): boolean {
    return isRetryable(this.kind);
  }
}

/** A successful RPC call. */
export interface RpcSuccess<T> {
  readonly ok: true;
  readonly data: T;
  /** Number of attempts made, including the first. */
  readonly attempts: number;
}

/** A failed RPC call. */
export interface RpcFailure {
  readonly ok: false;
  readonly error: RpcError;
  /** Number of attempts made, including the first. */
  readonly attempts: number;
}

export type RpcResult<T> = RpcSuccess<T> | RpcFailure;

/** Minimal `fetch` surface, so tests can inject a stub. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CallRpcOptions {
  readonly endpoint: string;
  readonly action: string;
  readonly version: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  /** Form parameters. Encoded into the request body. */
  readonly parameters?: Readonly<Record<string, string>>;
  readonly signatureVersion?: SignatureVersion;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: FetchLike | undefined;
  /** Injected for tests. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Injected for tests. Defaults to `crypto.getRandomValues`. */
  readonly nonce?: (() => string) | undefined;
  /** Overall per-attempt timeout in milliseconds. */
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Alibaba's success codes. SPEC §4.7. */
const SUCCESS_CODES: Record<string, true> = { ok: true, "200": true, success: true };

/**
 * Error codes that indicate rate limiting rather than a request fault. Alibaba
 * returns these with a 2xx often enough that relying on HTTP status alone
 * misclassifies them as permanent.
 *
 * `ServiceUnavailable` is deliberately absent: it is a server-side condition,
 * classified as `server` by its 5xx status. Listing it here would relabel a
 * 5xx whose body happens to carry that code.
 */
const THROTTLE_CODES: Record<string, true> = {
  Throttling: true,
  "Throttling.User": true,
  "Throttling.Api": true,
  "Throttling.Resource": true,
  RequestLimitExceeded: true,
};

/**
 * Keys whose values are credentials or credential proxies. Removed before any
 * remote text reaches a log line or a webhook payload.
 */
const SECRET_KEYS: readonly RegExp[] = [
  /accesskey ?id/i,
  /accesskey ?secret/i,
  /authorization/i,
  /signature/i,
  /securitytoken/i,
  /security ?token/i,
  /token/i,
  /credential/i,
];

const REDACTED = "[REDACTED]";

/**
 * Strip credential-shaped content from remote text.
 *
 * Remote messages are attacker-adjacent in the sense that they are outside our
 * control, and Alibaba echoes request parameters back in validation errors. A
 * message that echoed a signed URL would carry an `AccessKeyId` and a
 * `Signature`.
 */
export function redact(text: string): string {
  let out = text;
  // Secret-named keys, in either `key=value` or `"key":"value"` form. Remote
  // messages echo request parameters, so a validation error can carry a signed
  // URL back to us. Only the value is replaced — matching on the redaction
  // placeholder itself would consume the surrounding JSON quoting.
  for (const pattern of SECRET_KEYS) {
    const key = pattern.source;
    // The separator may be preceded by the closing quote of a JSON key
    // (`"AccessKeySecret":"…"`), so the quote is consumed as part of the
    // prefix. The *value* is matched whole, opening quote included, to keep the
    // surrounding notation intact.
    out = out.replace(
      new RegExp(`(\\b(?:${key})\\b["']?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^&\\s,}]+)`, "gi"),
      `$1${REDACTED}`,
    );
  }
  // Long opaque tokens with no key context.
  out = out.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, REDACTED);
  return out;
}

/**
 * The subset of an Alibaba RPC response envelope this module interprets.
 *
 * `Code` is declared as `string | number` because Alibaba returns the numeric
 * HTTP status as a number on some endpoints and a string on others.
 */
const ApiEnvelope = z.object({
  Code: z.union([z.string(), z.number()]).optional(),
  Message: z.string().optional(),
});

type ApiEnvelope = z.infer<typeof ApiEnvelope>;

/**
 * Build the form-encoded body.
 *
 * Sorted for determinism: tests assert exact bodies, and a stable order makes a
 * diff readable.
 */
function encodeParameters(parameters: Readonly<Record<string, string>>): string {
  return Object.keys(parameters)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(parameters[key] ?? "")}`)
    .join("&");
}

function defaultNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Interpret a parsed body as success or a typed failure.
 *
 * A usable body is required for success: a body we cannot parse means we cannot
 * tell what happened, and guessing would risk treating a rejected call as an
 * applied one. SPEC §4.7.
 *
 * The HTTP status is authoritative for `client`, `throttle`, and `server`: a
 * 4xx means the request was rejected regardless of what `Code` says, and Alibaba
 * routinely returns a 4xx whose `Code` is a service-specific string. Treating
 * that as a retryable `api` error would burn the Cron budget on calls that
 * cannot succeed.
 */
function interpretBody(
  status: number,
  body: unknown,
): { ok: true } | { ok: false; error: RpcError } {
  if (status < 200 || status >= 300) {
    const parsed = ApiEnvelope.safeParse(body);
    const code =
      parsed.success && parsed.data.Code !== undefined ? String(parsed.data.Code) : undefined;
    const message = parsed.success ? parsed.data.Message : undefined;
    const detail = [code, message === undefined ? undefined : redact(message)]
      .filter((part) => part !== undefined)
      .join(": ");

    if (status === 429 || (code !== undefined && THROTTLE_CODES[code] === true)) {
      return {
        ok: false,
        error: new RpcError(
          "throttle",
          `Throttled (HTTP ${status})${detail ? ` — ${detail}` : ""}`,
          status,
        ),
      };
    }
    if (status >= 500) {
      return {
        ok: false,
        error: new RpcError(
          "server",
          `Service error (HTTP ${status})${detail ? ` — ${detail}` : ""}`,
          status,
        ),
      };
    }
    return {
      ok: false,
      error: new RpcError(
        "client",
        `Request rejected (HTTP ${status})${detail ? ` — ${detail}` : ""}`,
        status,
      ),
    };
  }

  const parsed = ApiEnvelope.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: new RpcError("parse", `Response body was not a JSON object (HTTP ${status})`, status),
    };
  }

  const code = parsed.data.Code === undefined ? undefined : String(parsed.data.Code);
  const message = parsed.data.Message;

  // No `Code`: accept a 2xx, since some endpoints return only a payload.
  if (code === undefined) return { ok: true };
  if (SUCCESS_CODES[code.toLowerCase()] === true) return { ok: true };

  const detail = message === undefined ? code : `${code}: ${redact(message)}`;
  if (THROTTLE_CODES[code] === true) {
    return { ok: false, error: new RpcError("throttle", `Throttled — ${detail}`, status) };
  }
  return { ok: false, error: new RpcError("api", `API error — ${detail}`, status) };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Perform one signed RPC call.
 *
 * Retries transport-level failures that are safe to repeat. The caller decides
 * whether a retry is safe for its operation: retrying is only sound here
 * because a failure we retry is one where the server did not accept the
 * request. See SPEC §6.3 for the mutation rules that build on this.
 */
export async function callRpc<T = Record<string, unknown>>(
  options: CallRpcOptions,
): Promise<RpcResult<T>> {
  const {
    endpoint,
    action,
    version,
    accessKeyId,
    accessKeySecret,
    parameters = {},
    signatureVersion = "v3",
    fetch: fetchImpl = fetch,
    now = Date.now,
    nonce = defaultNonce,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  // Alibaba's RPC protocol carries `Action` and `Version` in the form body, not
  // only in the `x-acs-*` headers. Signing covers both, but the server resolves
  // the operation from the payload.
  const body = encodeParameters({ ...parameters, Action: action, Version: version });
  const request: SignRequest = {
    method: "POST",
    host: endpoint,
    pathname: "/",
    action,
    version,
    query: [],
    body,
    // Set because a body is being sent. The signer only includes it in
    // `SignedHeaders` when it is present.
    contentType: "application/x-www-form-urlencoded",
  };

  let attempts = 0;
  let lastError: RpcError | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    attempts = attempt + 1;
    const signed = await signRequest(signatureVersion, request, {
      accessKeyId,
      accessKeySecret,
      date: new Date(now()),
      nonce: nonce(),
    });

    let response: Response;
    try {
      response = await fetchImpl(signed.url, {
        method: request.method,
        headers: signed.headers,
        body: signed.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // Transport threw: DNS, TLS, reset, or our own timeout. Nothing was
      // accepted, so repeating is sound. The cause is not surfaced verbatim —
      // a transport error can embed the URL, which carries the access key ID.
      lastError = new RpcError(
        "transport",
        `Transport failure contacting ${endpoint} (${cause instanceof Error ? cause.name : "unknown"})`,
      );
      if (attempt === 0) continue;
      return { ok: false, error: lastError, attempts };
    }

    let parsed: unknown;
    try {
      parsed = await readBody(response);
    } catch (cause) {
      lastError = new RpcError(
        "transport",
        `Failed reading response from ${endpoint} (${cause instanceof Error ? cause.name : "unknown"})`,
        response.status,
      );
      if (attempt === 0) continue;
      return { ok: false, error: lastError, attempts };
    }

    // A retryable HTTP failure is retried once. `interpretBody` owns the
    // classification, so this only decides whether to repeat.
    if (response.status === 429 || response.status >= 500) {
      const outcome = interpretBody(response.status, parsed);
      const error = outcome.ok
        ? new RpcError("server", `Request failed (HTTP ${response.status})`, response.status)
        : outcome.error;
      if (attempt === 0) {
        lastError = error;
        continue;
      }
      return { ok: false, error, attempts };
    }

    const outcome = interpretBody(response.status, parsed);
    if (!outcome.ok) return { ok: false, error: outcome.error, attempts };
    return { ok: true, data: parsed as T, attempts };
  }

  return {
    ok: false,
    error: lastError ?? new RpcError("transport", `Call to ${endpoint} did not complete`),
    attempts,
  };
}
