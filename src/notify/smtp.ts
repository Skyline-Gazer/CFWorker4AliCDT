import type { connect as connectSocket } from "cloudflare:sockets";

export interface SmtpTestOptions {
  readonly host: string;
  readonly port?: string | number | undefined;
  readonly user?: string | undefined;
  readonly pass?: string | undefined;
  readonly from: string;
  readonly to: string;
  readonly subject?: string;
  readonly text?: string;
}

export interface SmtpDeps {
  readonly connect: typeof connectSocket;
  readonly timeoutMs?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Minimal Worker TCP SMTP client. Never throws or exposes credentials in logs. */
export async function sendSmtpTestMessage(
  options: SmtpTestOptions,
  deps?: SmtpDeps,
): Promise<{ ok: boolean }> {
  const port = Number(options.port ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 25) {
    console.warn("SMTP test unavailable", { host: options.host, reason: "unsupported port" });
    return { ok: false };
  }
  if (deps === undefined) return { ok: false };
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutState = { fired: false };
  try {
    const operation = async (): Promise<boolean> => {
      socket = deps.connect(
        { hostname: options.host, port },
        { allowHalfOpen: false, secureTransport: port === 465 ? "on" : "starttls" },
      );
      let active = socket;
      let reader = active.readable.getReader();
      let writer = active.writable.getWriter();
      let buffered = "";
      const response = async (): Promise<number> => {
        let code: number | undefined;
        let continuation = true;
        while (continuation) {
          let lineEnd = buffered.indexOf("\n");
          while (lineEnd < 0) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("SMTP closed connection");
            buffered += dec.decode(chunk.value as Uint8Array, { stream: true });
            lineEnd = buffered.indexOf("\n");
          }
          const line = buffered.slice(0, lineEnd).replace(/\r$/, "");
          buffered = buffered.slice(lineEnd + 1);
          const match = /^(\d{3})([ -])/.exec(line);
          if (!match) throw new Error("Invalid SMTP reply");
          code = Number(match[1]);
          continuation = match[2] === "-";
        }
        if (code === undefined) throw new Error("Missing SMTP reply");
        return code;
      };
      const command = async (line: string, expected = 250): Promise<boolean> => {
        await writer.write(enc.encode(`${line}\r\n`));
        return Math.floor((await response()) / 100) === Math.floor(expected / 100);
      };
      if (Math.floor((await response()) / 100) !== 2 || !(await command("EHLO cfworker4alicdt")))
        return false;
      if (port !== 465) {
        // STARTTLS required for non-465; plaintext-only servers fail closed.
        if (!(await command("STARTTLS", 220))) return false;
        reader.releaseLock();
        writer.releaseLock();
        active = socket.startTls();
        socket = active;
        reader = active.readable.getReader();
        writer = active.writable.getWriter();
        buffered = "";
        if (!(await command("EHLO cfworker4alicdt"))) return false;
      }
      if (options.user && options.pass) {
        if (
          !(await command("AUTH LOGIN", 334)) ||
          !(await command(btoa(options.user), 334)) ||
          !(await command(btoa(options.pass), 235))
        )
          return false;
      }
      if (
        !(await command(`MAIL FROM:<${options.from}>`)) ||
        !(await command(`RCPT TO:<${options.to}>`)) ||
        !(await command("DATA", 354))
      )
        return false;
      const subject = options.subject ?? "CFWorker4AliCDT manual SMTP test";
      const body = options.text ?? "CFWorker4AliCDT manual SMTP test";
      // RFC 5321: normalize newlines and dot-stuff lines that begin with ".".
      const safeBody = body
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n")
        .map((line) => (line.startsWith(".") ? `.${line}` : line))
        .join("\r\n");
      await writer.write(
        enc.encode(
          `From: <${options.from}>\r\nTo: <${options.to}>\r\nSubject: ${subject}\r\n\r\n${safeBody}\r\n.\r\n`,
        ),
      );
      if (Math.floor((await response()) / 100) !== 2) return false;
      await command("QUIT", 221);
      return true;
    };
    const ms = deps.timeoutMs ?? 10_000;
    const ok = await Promise.race([
      operation(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          timeoutState.fired = true;
          const open = socket;
          if (open !== undefined) {
            void Promise.resolve(open.close()).catch(() => undefined);
          }
          resolve(false);
        }, ms);
      }),
    ]);
    if (!ok)
      console.warn("SMTP test failed", {
        host: options.host,
        reason: timeoutState.fired ? "timeout" : "SMTP exchange failed",
      });
    try {
      await socket?.close();
    } catch {
      /* best effort */
    }
    return { ok };
  } catch {
    // Transport errors may echo protocol data, so never log their messages.
    console.warn("SMTP test failed", {
      host: options.host,
      reason: timeoutState.fired ? "timeout" : "transport error",
    });
    try {
      await socket?.close();
    } catch {
      /* best effort */
    }
    return { ok: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
