import { afterEach, describe, expect, it, vi } from "vitest";
import { sendTelegramMessage } from "../../src/notify/telegram";
import type { FetchLike } from "../../src/aliyun/rpc";

const options = {
  botToken: "123456:private-bot-token",
  chatId: "-1009988776655",
};

afterEach(() => vi.restoreAllMocks());

describe("sendTelegramMessage", () => {
  it("posts a labeled message with Worker credentials", async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(new Response(null, { status: 200 })));
    const result = await sendTelegramMessage(options, { fetch });
    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${options.botToken}/sendMessage`);
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: options.chatId,
      text: "CFWorker4AliCDT manual Telegram test",
    });
  });

  it("returns false for non-2xx without including Telegram credentials in logs", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(new Response(null, { status: 403 })));
    const result = await sendTelegramMessage(options, { fetch });
    expect(result).toEqual({ ok: false });
    expect(warning.mock.calls.flat().join(" ")).not.toContain(options.botToken);
    expect(warning.mock.calls.flat().join(" ")).not.toContain(options.chatId);
  });

  it("contains thrown errors and does not leak token/chat id in error text", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi.fn<FetchLike>(() => {
      throw new Error(`failed ${options.botToken} ${options.chatId}`);
    });
    const result = await sendTelegramMessage(options, { fetch });
    expect(result).toEqual({ ok: false });
    expect(warning.mock.calls.flat().join(" ")).not.toContain(options.botToken);
    expect(warning.mock.calls.flat().join(" ")).not.toContain(options.chatId);
    expect(JSON.stringify(result)).not.toContain(options.botToken);
    expect(JSON.stringify(result)).not.toContain(options.chatId);
  });

  it("uses the proxy as API base", async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(new Response(null, { status: 200 })));
    await sendTelegramMessage(
      { ...options, telegramProxyUrl: "https://proxy.example/api/" },
      { fetch },
    );
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://proxy.example/api/bot${options.botToken}/sendMessage`,
    );
  });
});
