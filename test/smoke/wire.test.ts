import { createHmac, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { afterAll, expect, it } from "vitest";

import { callRpc } from "../../src/aliyun/rpc";
import type { FetchLike } from "../../src/aliyun/rpc";

/**
 * Wire-level smoke test.
 *
 * Drives the real signing and transport code over a real socket against a
 * server that verifies the V3 signature using only the published rules. Unit
 * tests assert what we build; this asserts that what we build is verifiable by
 * an independent implementation of the specification.
 */

const ACCESS_KEY_ID = "AKID";
const ACCESS_KEY_SECRET = "SECRET";
/** The endpoint the client addresses. The socket sees a different authority. */
const SIGNED_HOST = "smoke.test";

/** Join byte chunks without Node's `Buffer`. */
function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

interface Captured {
  headers: Record<string, string | string[] | undefined>;
  method: string | undefined;
  url: string | undefined;
  body: string;
}

let captured: Captured | undefined;

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // Read as Uint8Array and decode with `TextDecoder`, which is what the Worker
  // runtime provides. Node's `Buffer` is not usable here: the project's
  // ambient types are Cloudflare's, and they make `node:buffer` untyped.
  const chunks: Uint8Array[] = [];
  req.on("data", (chunk: Uint8Array) => {
    chunks.push(chunk);
  });
  req.on("end", () => {
    const body = new TextDecoder().decode(concatenate(chunks));
    captured = { headers: req.headers, method: req.method, url: req.url, body };

    // Independently reproduce the signature from the published V3 rules.
    const auth = headerValue(req.headers.authorization);
    const match =
      /^ACS3-HMAC-SHA256 Credential=([^,]+),SignedHeaders=([^,]+),Signature=([0-9a-f]+)$/.exec(
        auth,
      );
    if (match === null) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ Code: "BadAuthorization" }));
      return;
    }
    const [, credential, signedHeaderNames, signature] = match as unknown as [
      string,
      string,
      string,
      string,
    ];

    const canonicalHeaders =
      signedHeaderNames
        .split(";")
        .map((name) => {
          // `host` is signed as the endpoint we addressed, but the socket
          // reports the address actually dialled. Reconstruct the signed value,
          // since that is what the signature commits to.
          const value = name === "host" ? SIGNED_HOST : headerValue(req.headers[name]);
          return `${name}:${value.trim()}`;
        })
        .join("\n") + "\n";
    const contentSha256 = createHash("sha256").update(body).digest("hex");
    const canonicalRequest = [
      req.method ?? "",
      req.url ?? "/",
      "",
      canonicalHeaders,
      signedHeaderNames,
      contentSha256,
    ].join("\n");
    const hashed = createHash("sha256").update(canonicalRequest).digest("hex");
    const expected = createHmac("sha256", ACCESS_KEY_SECRET)
      .update(`ACS3-HMAC-SHA256\n${hashed}`)
      .digest("hex");

    const verified =
      expected === signature &&
      credential === ACCESS_KEY_ID &&
      contentSha256 === headerValue(req.headers["x-acs-content-sha256"]);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        verified
          ? {
              RequestId: "r1",
              TrafficDetails: [
                { BusinessRegionId: "cn-hongkong", ISPType: "CMI", Traffic: 40_265_318_400 },
              ],
            }
          : { Code: "SignatureDoesNotMatch" },
      ),
    );
  });
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    resolve();
  });
});

afterAll(() => {
  server.close();
});

function address(): { port: number } {
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no listening address");
  return { port: addr.port };
}

/** Redirect the https URL `callRpc` builds to the local plaintext socket. */
function localFetch(): FetchLike {
  const real = globalThis.fetch;
  return (url, init) =>
    real(url.replace(`https://${SIGNED_HOST}`, `http://127.0.0.1:${address().port}`), init);
}

it("sends a request an independent implementation of the specification verifies", async () => {
  const result = await callRpc({
    endpoint: SIGNED_HOST,
    action: "ListCdtInternetTraffic",
    version: "2021-08-13",
    accessKeyId: ACCESS_KEY_ID,
    accessKeySecret: ACCESS_KEY_SECRET,
    fetch: localFetch(),
  });

  expect(result.ok).toBe(true);
  expect(result.attempts).toBe(1);
});

it("carries the content hash it signed, matching the body on the wire", () => {
  expect(captured).toBeDefined();
  const contentSha256 = createHash("sha256")
    .update(captured?.body ?? "")
    .digest("hex");
  expect(headerValue(captured?.headers["x-acs-content-sha256"])).toBe(contentSha256);
});

it("sends form parameters including Action and Version in the body", () => {
  expect(captured?.body).toContain("Action=ListCdtInternetTraffic");
  expect(captured?.body).toContain("Version=2021-08-13");
  expect(captured?.method).toBe("POST");
  expect(captured?.url).toBe("/");
});

it("signs content-type, so the body encoding cannot be altered in flight", () => {
  expect(captured?.headers.authorization).toContain("content-type;");
  expect(headerValue(captured?.headers["content-type"])).toBe("application/x-www-form-urlencoded");
});

it("formats x-acs-date at seconds precision", () => {
  expect(headerValue(captured?.headers["x-acs-date"])).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  );
});

it("never puts the secret on the wire", () => {
  expect(JSON.stringify(captured?.headers)).not.toContain(ACCESS_KEY_SECRET);
  expect(captured?.url).not.toContain(ACCESS_KEY_SECRET);
  expect(captured?.body).not.toContain(ACCESS_KEY_SECRET);
});
