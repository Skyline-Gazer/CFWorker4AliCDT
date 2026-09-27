import type { FetchLike } from "../aliyun/rpc";

export interface TelegramOptions {
  readonly botToken: string;
  readonly chatId: string;
  readonly telegramProxyUrl?: string | undefined;
}

export interface TelegramDeps {
  readonly fetch?: FetchLike | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface TelegramResult {
  readonly ok: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Send a clearly labeled manual test message. Every transport failure is contained. */
export async function sendTelegramMessage(
  options: TelegramOptions,
  deps: TelegramDeps = {},
): Promise<TelegramResult> {
  const proxyBase = options.telegramProxyUrl?.trim().replace(/\/+$/, "");
  const base = proxyBase === undefined || proxyBase === "" ? "https://api.telegram.org" : proxyBase;
  const endpoint = `${base}/bot${options.botToken}/sendMessage`;
  const fetchImpl = deps.fetch ?? fetch;
  try {
    if (new URL(base).protocol !== "https:") return { ok: false };
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: options.chatId,
        text: "CFWorker4AliCDT manual Telegram test",
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (response.status >= 200 && response.status < 300) return { ok: true };
    logFailure(base, `HTTP ${response.status}`);
    return { ok: false };
  } catch {
    // Do not use arbitrary exception text or names in persistent logs.
    logFailure(base, "transport failure");
    return { ok: false };
  }
}

function logFailure(base: string, reason: string): void {
  let host = "the configured Telegram endpoint";
  try {
    host = new URL(base).host || host;
  } catch {
    // Do not include malformed endpoint text in logs.
  }
  console.warn(`[telegram] delivery to ${host} failed (${reason})`);
}
