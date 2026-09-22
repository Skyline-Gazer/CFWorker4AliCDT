/**
 * Run reporting webhook (SPEC §7).
 *
 * The webhook is a reporting side channel, never a control input. Two
 * consequences shape this module.
 *
 * **It must be unable to affect control.** `notify()` never throws: a transport
 * error, a timeout, and a non-2xx all become `{ ok: false }`. The control
 * pipeline assembles its report before calling this, so a failure here cannot
 * change what was done or what was recorded.
 *
 * **It must not leak.** `WEBHOOK_TOKEN` goes into a request header only, and
 * error text is redacted before it reaches a payload. The token cannot appear in
 * a body, a result, or a log line derived from one.
 */

import type { DecisionAction } from "../monitor/decision";
import type { ErrorStage } from "../monitor/execute";
import { RpcError } from "../aliyun/rpc";
import type { FetchLike } from "../aliyun/rpc";

/** The outcome fields the payload is built from. A subset of `RunReport`. */
export interface RunReportLike {
  readonly status: "success" | "error";
  readonly trafficGB: number | undefined;
  readonly thresholdGB: number;
  readonly ecsStatusBefore: string | undefined;
  readonly ecsStatusAfter: string | undefined;
  readonly desired: "running" | "stopped" | undefined;
  readonly action: DecisionAction | undefined;
  readonly stoppedModeRequested: "StopCharging" | "KeepCharging" | undefined;
  readonly instanceId: string;
  readonly region: string;
  readonly time: string;
  readonly durationMs: number;
  readonly stage?: ErrorStage | undefined;
  readonly error?: string | undefined;
}

export interface NotifyOptions {
  readonly webhookUrl: string;
  readonly webhookToken: string | undefined;
}

export interface NotifyDeps {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike | undefined;
  /** Per-request timeout. A hanging webhook must not consume the invocation. */
  readonly timeoutMs?: number | undefined;
}

export interface NotifyResult {
  readonly ok: boolean;
}

/** SPEC §7.3 success payload. Field order follows the specification. */
export interface SuccessPayload {
  readonly status: "success";
  readonly trafficGB: number | undefined;
  readonly thresholdGB: number;
  readonly ecsStatusBefore: string | undefined;
  readonly ecsStatusAfter: string | undefined;
  readonly action: DecisionAction | undefined;
  readonly instanceId: string;
  readonly region: string;
  readonly time: string;
  readonly durationMs: number;
  /** Present only when a stop was issued. Reports the mode *requested*. */
  readonly stoppedModeRequested?: "StopCharging" | "KeepCharging";
}

/** SPEC §7.4 error payload. */
export interface ErrorPayload {
  readonly status: "error";
  readonly stage: ErrorStage | undefined;
  readonly error: string;
  readonly thresholdGB: number;
  readonly instanceId: string;
  readonly region: string;
  readonly time: string;
  readonly durationMs: number;
}

export type WebhookPayload = SuccessPayload | ErrorPayload;

/**
 * Keys whose values are credentials. Duplicated in spirit from `rpc.ts`, but
 * kept local so this module's redaction cannot be changed by an edit elsewhere.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /accesskey ?id/gi,
  /accesskey ?secret/gi,
  /authorization/gi,
  /signature/gi,
  /security ?token/gi,
  /bearer/gi,
  /token/gi,
];

const REDACTED = "[REDACTED]";

/** Strip credential-shaped content from remote error text (SPEC §7.5). */
function redact(text: string): string {
  let out = text;

  // `Bearer <value>` first. A key-based pass would otherwise consume the literal
  // word "Bearer" as the value and leave the token itself untouched.
  out = out.replace(/\bBearer\s+[^\s,;"'}]+/gi, `Bearer ${REDACTED}`);

  for (const pattern of SECRET_PATTERNS) {
    const key = pattern.source.replace(/\\/g, "");
    // `authorization` as a trigger would also strip a following scheme word, so
    // it is matched only when it carries a value directly (`authorization=...`).
    if (key === "authorization" || key === "bearer") continue;
    out = out.replace(
      new RegExp(`(\\b(?:${key})\\b["']?\\s*[:=]?\\s*)(?:"[^"]*"|'[^']*'|[^&\\s,}]+)`, "gi"),
      `$1${REDACTED}`,
    );
  }

  // Long opaque tokens with no key context.
  out = out.replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, REDACTED);
  return out;
}

/**
 * Assemble the payload for a run.
 *
 * Built as two explicit branches rather than one object with conditionally
 * deleted keys: which fields are *absent* is part of the contract (SPEC §7.3,
 * §7.4), and an explicit literal makes each shape reviewable at a glance.
 */
export function buildPayload(report: RunReportLike): WebhookPayload {
  if (report.status === "error") {
    return {
      status: "error",
      stage: report.stage,
      error: redact(report.error ?? "Run failed"),
      thresholdGB: report.thresholdGB,
      instanceId: report.instanceId,
      region: report.region,
      time: report.time,
      durationMs: report.durationMs,
    };
  }

  const base: SuccessPayload = {
    status: "success",
    trafficGB: report.trafficGB,
    thresholdGB: report.thresholdGB,
    ecsStatusBefore: report.ecsStatusBefore,
    ecsStatusAfter: report.ecsStatusAfter,
    action: report.action,
    instanceId: report.instanceId,
    region: report.region,
    time: report.time,
    durationMs: report.durationMs,
  };

  // Omitted entirely when no stop was issued, so a no-op run cannot imply one.
  return report.stoppedModeRequested === undefined
    ? base
    : { ...base, stoppedModeRequested: report.stoppedModeRequested };
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Dispatch the run report.
 *
 * Never throws. Every failure mode — a transport throw, our own timeout, a
 * non-2xx — is reported as `{ ok: false }`, because a webhook failure must not
 * be observable to the control path (SPEC §7.1).
 */
export async function notify(
  options: NotifyOptions,
  report: RunReportLike,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify(buildPayload(report));

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.webhookToken !== undefined && options.webhookToken !== "") {
    // Header only. The token is never placed in the body.
    headers.authorization = `Bearer ${options.webhookToken}`;
  }

  try {
    const response = await fetchImpl(options.webhookUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.status >= 200 && response.status < 300 };
  } catch {
    // Deliberately swallowed: the caller must not be able to distinguish a
    // webhook failure from a webhook success except by this boolean. The
    // failure is logged by the caller with `stage: "webhook"`.
    return { ok: false };
  }
}

/**
 * Describe a webhook failure for local logging.
 *
 * Composed from literals and a status code only. The URL is excluded: it may
 * carry a token, and this text is destined for persisted logs (SPEC §7.5).
 */
export function describeWebhookFailure(url: string, cause: unknown): string {
  const host = safeHost(url);
  const reason = cause instanceof RpcError ? cause.message : "transport failure";
  return `Webhook delivery to ${host} failed (${reason})`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the configured webhook endpoint";
  }
}
