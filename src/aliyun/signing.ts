/**
 * Alibaba Cloud request signing.
 *
 * Two schemes are implemented. V3 (`ACS3-HMAC-SHA256`) is the default; V2
 * (`HMAC-SHA1`) is retained behind `SIGNATURE_VERSION` because the target CDT
 * operation is undocumented and the accepted signing method for it cannot be
 * confirmed from any official example (PLAN R3).
 *
 * The two schemes differ in more than the hash:
 *
 *   - V2's signing key is `AccessKeySecret + "&"`; V3's is the raw secret.
 *   - V2 signs a canonical query string; V3 signs a canonical request that
 *     includes the request body's SHA-256 digest.
 *   - V2 emits a Base64 signature; V3 emits lowercase hex.
 *
 * All digests are computed with `crypto.subtle`. Hand-rolled SHA or HMAC is
 * prohibited: a subtly wrong implementation here fails only in production.
 */

import { canonicalQueryString, percentEncode } from "./encoding";

export type SignatureVersion = "v2" | "v3";

const V3_ALGORITHM = "ACS3-HMAC-SHA256";

/**
 * `HexEncode(SHA256(""))`. The signing specification names this value for an
 * empty request payload, and Alibaba's own worked example uses it.
 */
export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const V2_ALGORITHM = "HMAC-SHA1";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(value));
  return toHex(new Uint8Array(digest));
}

async function hmac(
  hash: "SHA-1" | "SHA-256",
  key: Uint8Array,
  message: string,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, utf8(message));
  return new Uint8Array(signature);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface SignRequest {
  readonly method: "POST" | "GET";
  /** Host only: no scheme, no path. */
  readonly host: string;
  /** Request path. Always `/` for this API's RPC style. */
  readonly pathname: string;
  readonly action: string;
  readonly version: string;
  /** Canonical query parameters, excluding `Signature`. */
  readonly query: readonly (readonly [string, string])[];
  /** Form-encoded request body. Empty string when there is no body. */
  readonly body: string;
  /**
   * Content type to send. Omitted from both the request and the signature when
   * absent.
   *
   * This is opt-in rather than a fixed default because the signing
   * specification signs `content-type` *when it is present*: adding it
   * unconditionally changes `SignedHeaders` and therefore the signature, which
   * Alibaba's own published example demonstrates by having no `content-type` at
   * all. Callers that send a body set it explicitly.
   */
  readonly contentType?: string;
}

export interface SignatureInput {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly date: Date;
  /** Injected in tests so signatures are deterministic. */
  readonly nonce: string;
}

export interface SignedRequest {
  readonly headers: Record<string, string>;
  /** Full URL including the canonical query string. */
  readonly url: string;
  readonly body: string;
}

/**
 * Produce a signed V3 request.
 *
 * `x-acs-date` is formatted `YYYY-MM-DDTHH:MM:SSZ` and must be within 15
 * minutes of the server's clock.
 *
 * Header selection follows the specification exactly: every `x-acs-*` header
 * plus `host` and `content-type` participates in the signature, and
 * `x-acs-content-sha256` is among them. A hardcoded list is wrong here — it
 * silently omits `x-acs-security-token` when STS credentials are used, and the
 * server rejects the request without saying which header was missed.
 */
export async function signV3(request: SignRequest, input: SignatureInput): Promise<SignedRequest> {
  const { accessKeyId, accessKeySecret, date, nonce } = input;
  const contentSha256 = await sha256Hex(request.body);
  const acsDate = date.toISOString().replace(/\.\d{3}Z$/, "Z");

  const allHeaders: Record<string, string> = {
    host: request.host,
    "x-acs-action": request.action,
    "x-acs-content-sha256": contentSha256,
    "x-acs-date": acsDate,
    "x-acs-signature-nonce": nonce,
    "x-acs-version": request.version,
  };
  if (request.contentType !== undefined) {
    allHeaders["content-type"] = request.contentType;
  }

  const signedHeaderNames = Object.keys(allHeaders)
    .filter((name) => name.startsWith("x-acs-") || name === "host" || name === "content-type")
    .sort();

  // Entries are `lowercase(name) + ":" + trim(value) + "\n"`, concatenated.
  const canonicalHeaders =
    signedHeaderNames.map((name) => `${name}:${(allHeaders[name] ?? "").trim()}`).join("\n") + "\n";

  // Parameters for other RPC calls are carried in the body, so the canonical
  // query string is normally empty. `Signature` is excluded by construction: it
  // does not exist until the end of this function.
  const queryString = canonicalQueryString(request.query);

  const canonicalRequest = [
    request.method,
    request.pathname,
    queryString,
    canonicalHeaders,
    signedHeaderNames.join(";"),
    contentSha256,
  ].join("\n");

  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = `${V3_ALGORITHM}\n${hashedCanonicalRequest}`;

  // V3 uses the raw secret. Appending "&" (the V2 rule) silently produces a
  // different, invalid signature.
  const signature = toHex(await hmac("SHA-256", utf8(accessKeySecret), stringToSign));

  const authorization =
    `${V3_ALGORITHM} Credential=${accessKeyId},` +
    `SignedHeaders=${signedHeaderNames.join(";")},` +
    `Signature=${signature}`;

  const url = `https://${request.host}${request.pathname}${queryString ? `?${queryString}` : ""}`;

  return {
    url,
    body: request.body,
    headers: { ...allHeaders, authorization },
  };
}

/**
 * Produce a signed V2 request.
 *
 * V2 signs the canonicalised query string and emits Base64. Retained only as a
 * configurable fallback; see the module header.
 */
export async function signV2(request: SignRequest, input: SignatureInput): Promise<SignedRequest> {
  const { accessKeyId, accessKeySecret, date, nonce } = input;

  const parameters: [string, string][] = [
    ...request.query.map(([k, v]): [string, string] => [k, v]),
    ["AccessKeyId", accessKeyId],
    ["Action", request.action],
    ["Format", "JSON"],
    ["SignatureMethod", V2_ALGORITHM],
    ["SignatureNonce", nonce],
    ["SignatureVersion", "1.0"],
    ["Timestamp", date.toISOString().replace(/\.\d{3}Z$/, "Z")],
    ["Version", request.version],
  ];

  const canonicalizedQuery = canonicalQueryString(parameters);
  const stringToSign = `${request.method}&${percentEncode(request.pathname)}&${percentEncode(canonicalizedQuery)}`;

  // V2 appends "&" to the secret; V3 does not.
  const signature = base64(await hmac("SHA-1", utf8(`${accessKeySecret}&`), stringToSign));

  const query = canonicalQueryString([...parameters, ["Signature", signature]]);
  const url = `https://${request.host}${request.pathname}?${query}`;

  return {
    url,
    body: request.body,
    headers: request.contentType === undefined ? {} : { "content-type": request.contentType },
  };
}

export async function signRequest(
  version: SignatureVersion,
  request: SignRequest,
  input: SignatureInput,
): Promise<SignedRequest> {
  return version === "v2" ? signV2(request, input) : signV3(request, input);
}
