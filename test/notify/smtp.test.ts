import { describe, expect, it, vi } from "vitest";

import { sendSmtpTestMessage } from "../../src/notify/smtp";

function fakeSocket(replies: string[]) {
  const writes: string[] = [];
  const make = (reply: string) => ({
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(reply));
        controller.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(new TextDecoder().decode(chunk));
      },
    }),
    close() {
      return Promise.resolve();
    },
  });
  const sockets = [make(replies[0] ?? ""), make(replies[1] ?? "")];
  return { socket: { ...sockets[0], startTls: () => sockets[1] }, writes };
}

const base = {
  host: "smtp.example.test",
  from: "sender@example.test",
  to: "to@example.test",
  user: "u",
  pass: "p",
};

describe("sendSmtpTestMessage", () => {
  it("refuses port 25 without connecting", async () => {
    const connect = vi.fn();
    expect(await sendSmtpTestMessage({ ...base, port: 25 }, { connect })).toEqual({
      ok: false,
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("contains a connect failure", async () => {
    expect(
      await sendSmtpTestMessage(base, {
        connect: () => {
          throw new Error("offline");
        },
      }),
    ).toEqual({ ok: false });
  });

  it("performs STARTTLS, AUTH LOGIN and message delivery", async () => {
    const fake = fakeSocket([
      "220 ready\r\n250 hello\r\n220 tls\r\n",
      "250 hello\r\n334 user\r\n334 pass\r\n235 auth\r\n250 mail\r\n250 rcpt\r\n354 data\r\n250 queued\r\n221 bye\r\n",
    ]);
    const connect = vi.fn(() => fake.socket as never);
    const result = await sendSmtpTestMessage(base, { connect });
    expect(result).toEqual({ ok: true });
    expect(connect).toHaveBeenCalledWith(
      { hostname: base.host, port: 587 },
      { allowHalfOpen: false, secureTransport: "starttls" },
    );
    expect(fake.writes.join("")).toContain("STARTTLS\r\n");
    expect(fake.writes.join("")).toContain("AUTH LOGIN\r\n");
    expect(fake.writes.join("")).toContain("CFWorker4AliCDT manual SMTP test");
  });

  it("returns false for SMTP failure replies", async () => {
    const fake = fakeSocket(["554 rejected\r\n", ""]);
    expect(await sendSmtpTestMessage(base, { connect: () => fake.socket as never })).toEqual({
      ok: false,
    });
  });
});

it("closes the socket when the timeout fires", async () => {
  const closed: string[] = [];
  const hang = {
    readable: new ReadableStream<Uint8Array>({
      start() {
        /* never enqueues; wait until cancel/close */
      },
    }),
    writable: new WritableStream<Uint8Array>(),
    close() {
      closed.push("close");
      return Promise.resolve();
    },
    startTls() {
      return this;
    },
  };
  const result = await sendSmtpTestMessage(base, {
    connect: () => hang as never,
    timeoutMs: 20,
  });
  expect(result).toEqual({ ok: false });
  expect(closed).toContain("close");
});
