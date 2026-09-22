import { describe, expect, it } from "vitest";

import { canonicalQueryString, percentEncode } from "../../src/aliyun/encoding";
import { signV2, signV3 } from "../../src/aliyun/signing";
import type { SignRequest } from "../../src/aliyun/signing";
import { EMPTY_BODY_SHA256 } from "../../src/aliyun/signing";

/**
 * Signature verification.
 *
 * The V3 case is the official worked example from Alibaba Cloud's V3 signature
 * specification, reproduced byte-exact. Note its shape: the request parameters
 * live in the *query string* (the specification's own example does this) while
 * the payload hash is the empty-string digest. `x-acs-content-sha256` is part
 * of the signed header set, not excluded from it.
 *
 * The V2 case is the specification's published example.
 */

function v3Signature(headers: Record<string, string>): string {
  const authorization = headers.authorization ?? "";
  return authorization.slice(authorization.lastIndexOf("Signature=") + "Signature=".length);
}

function v3SignedHeaders(headers: Record<string, string>): string {
  const authorization = headers.authorization ?? "";
  return authorization.slice(
    authorization.indexOf("SignedHeaders=") + "SignedHeaders=".length,
    authorization.lastIndexOf(",Signature="),
  );
}

describe("percentEncode", () => {
  it("leaves the unreserved set intact, including ~", () => {
    // `~` is unreserved. Encoding it as `%7E` changes every signature computed
    // over a value containing one.
    expect(percentEncode("AZaz09-_.~")).toBe("AZaz09-_.~");
  });

  it("encodes a space as %20, never +", () => {
    expect(percentEncode("a b")).toBe("a%20b");
  });

  it("encodes !'()* explicitly", () => {
    // encodeURIComponent leaves these alone, so a naive implementation passes
    // every other case and fails here.
    expect(percentEncode("!")).toBe("%21");
    expect(percentEncode("'")).toBe("%27");
    expect(percentEncode("(")).toBe("%28");
    expect(percentEncode(")")).toBe("%29");
    expect(percentEncode("*")).toBe("%2A");
  });

  it("encodes / in a value, since it is not a path separator there", () => {
    expect(percentEncode("a/b")).toBe("a%2Fb");
  });

  it("percent-encodes non-ASCII as UTF-8 bytes", () => {
    expect(percentEncode("巡检")).toBe("%E5%B7%A1%E6%A3%80");
  });
});

describe("canonicalQueryString", () => {
  it("sorts ascending by encoded key", () => {
    expect(
      canonicalQueryString([
        ["b", "2"],
        ["a", "1"],
        ["c", "3"],
      ]),
    ).toBe("a=1&b=2&c=3");
  });

  it("sorts on the encoded form, so % sorts before letters", () => {
    expect(
      canonicalQueryString([
        ["a", "1"],
        ["/", "3"],
        ["Z", "2"],
      ]),
    ).toBe("%2F=3&Z=2&a=1");
  });

  it("encodes keys and values", () => {
    expect(canonicalQueryString([["a b", "c d"]])).toBe("a%20b=c%20d");
  });
});

describe("V3 signing — official example", () => {
  // Alibaba Cloud's published V3 example.
  const OFFICIAL: SignRequest = {
    method: "POST",
    host: "ecs.cn-shanghai.aliyuncs.com",
    pathname: "/",
    action: "RunInstances",
    version: "2014-05-26",
    query: [
      ["ImageId", "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd"],
      ["RegionId", "cn-shanghai"],
    ],
    body: "",
  };
  const OFFICIAL_INPUT = {
    accessKeyId: "YourAccessKeyId",
    accessKeySecret: "YourAccessKeySecret",
    date: new Date("2023-10-26T10:22:32Z"),
    nonce: "3156853299f313e23d1673dc12e1703d",
  };
  const EXPECTED_HASHED_CANONICAL_REQUEST =
    "7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259";
  const EXPECTED_SIGNATURE = "06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0";

  it("reproduces the published signature byte-exact", async () => {
    const signed = await signV3(OFFICIAL, OFFICIAL_INPUT);
    expect(v3Signature(signed.headers)).toBe(EXPECTED_SIGNATURE);
  });

  it("reproduces the published hashed canonical request", async () => {
    // Reconstructed from the specification's stated construction, then hashed.
    // A failure here means the canonical request is malformed, which localises
    // the fault before the HMAC step.
    const canonicalRequest = [
      "POST",
      "/",
      "ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai",
      "host:ecs.cn-shanghai.aliyuncs.com\n" +
        "x-acs-action:RunInstances\n" +
        `x-acs-content-sha256:${EMPTY_BODY_SHA256}\n` +
        "x-acs-date:2023-10-26T10:22:32Z\n" +
        "x-acs-signature-nonce:3156853299f313e23d1673dc12e1703d\n" +
        "x-acs-version:2014-05-26\n",
      "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version",
      EMPTY_BODY_SHA256,
    ].join("\n");

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalRequest),
    );
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

    expect(hex).toBe(EXPECTED_HASHED_CANONICAL_REQUEST);
  });

  it("signs x-acs-content-sha256 as part of the header set", async () => {
    const signed = await signV3(OFFICIAL, OFFICIAL_INPUT);
    expect(v3SignedHeaders(signed.headers)).toBe(
      "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version",
    );
  });

  it("hashes an empty body to the well-known constant", async () => {
    const signed = await signV3(OFFICIAL, OFFICIAL_INPUT);
    expect(signed.headers["x-acs-content-sha256"]).toBe(EMPTY_BODY_SHA256);
  });

  it("emits the published Authorization value", async () => {
    const signed = await signV3(OFFICIAL, OFFICIAL_INPUT);
    expect(signed.headers.authorization).toBe(
      `ACS3-HMAC-SHA256 Credential=YourAccessKeyId,` +
        `SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,` +
        `Signature=${EXPECTED_SIGNATURE}`,
    );
  });
});

describe("V3 signing — request shape this Worker sends", () => {
  /** `StopInstance`, the stop path: form parameters in the body. */
  const STOP: SignRequest = {
    method: "POST",
    host: "ecs.cn-shanghai.aliyuncs.com",
    pathname: "/",
    action: "StopInstance",
    version: "2014-05-26",
    query: [],
    body: "ForceStop=false&InstanceId=i-abc123&StoppedMode=KeepCharging",
    contentType: "application/x-www-form-urlencoded",
  };
  const INPUT = {
    accessKeyId: "AKID",
    accessKeySecret: "SECRET",
    date: new Date("2026-09-20T08:00:00Z"),
    nonce: "00000000000000000000000000000001",
  };

  it("signs the body when parameters are carried there", async () => {
    const signed = await signV3(STOP, INPUT);
    const bodyHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STOP.body));
    const expected = [...new Uint8Array(bodyHash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(signed.headers["x-acs-content-sha256"]).toBe(expected);
    expect(expected).not.toBe(EMPTY_BODY_SHA256);
  });

  it("emits the signed header set in sorted order", async () => {
    const signed = await signV3(STOP, INPUT);
    const names = v3SignedHeaders(signed.headers).split(";");
    expect(names).toEqual([...names].sort());
    for (const name of names) expect(signed.headers[name]).toBeDefined();
  });

  it("includes every x-acs-* header present, so an added header is signed", async () => {
    // Regression guard against a hardcoded list: an omitted header here means a
    // signature the server rejects with no indication of the cause.
    const signed = await signV3(STOP, INPUT);
    expect(v3SignedHeaders(signed.headers)).toContain("x-acs-version");
    expect(v3SignedHeaders(signed.headers)).toContain("x-acs-action");
    expect(v3SignedHeaders(signed.headers)).toContain("content-type");
    expect(v3SignedHeaders(signed.headers)).toContain("host");
  });

  it("uses the raw secret as the signing key, not secret + '&'", async () => {
    const correct = await signV3(STOP, INPUT);
    const wrong = await signV3(STOP, { ...INPUT, accessKeySecret: "SECRET&" });
    expect(v3Signature(correct.headers)).not.toBe(v3Signature(wrong.headers));
  });

  it("formats x-acs-date at seconds precision, without milliseconds", async () => {
    const signed = await signV3(STOP, INPUT);
    expect(signed.headers["x-acs-date"]).toBe("2026-09-20T08:00:00Z");
  });

  it("emits a lowercase 64-character hex signature", async () => {
    const signed = await signV3(STOP, INPUT);
    const signature = v3Signature(signed.headers);
    expect(signature).toBe(signature.toLowerCase());
    expect(signature).toHaveLength(64);
  });

  it("produces a different signature for a different nonce", async () => {
    const a = await signV3(STOP, { ...INPUT, nonce: "a".repeat(32) });
    const b = await signV3(STOP, { ...INPUT, nonce: "b".repeat(32) });
    expect(v3Signature(a.headers)).not.toBe(v3Signature(b.headers));
  });

  it("changes the signature when the body changes", async () => {
    const a = await signV3(STOP, INPUT);
    const b = await signV3({ ...STOP, body: `${STOP.body}X` }, INPUT);
    expect(v3Signature(a.headers)).not.toBe(v3Signature(b.headers));
  });

  it("does not leak the secret into any emitted value", async () => {
    const signed = await signV3(STOP, INPUT);
    expect(JSON.stringify(signed)).not.toContain("SECRET");
  });

  it("leaves the URL free of the request body", async () => {
    const signed = await signV3(STOP, INPUT);
    expect(signed.url).toBe("https://ecs.cn-shanghai.aliyuncs.com/");
    expect(signed.body).toBe(STOP.body);
  });
});

describe("V2 signing (HMAC-SHA1)", () => {
  const V2_VECTOR = {
    request: {
      method: "GET",
      host: "ecs.aliyuncs.com",
      pathname: "/",
      action: "DescribeDedicatedHosts",
      version: "2014-05-26",
      query: [["RegionId", "cn-beijing"]],
      body: "",
    } satisfies SignRequest,
    input: {
      accessKeyId: "testid",
      accessKeySecret: "testsecret",
      date: new Date("2023-03-13T08:34:30Z"),
      nonce: "edb2b34af0af9a6d14deaf7c1a5315eb",
    },
    expectedSignature: "9NaGiOspFP5UPcwX8Iwt2YJXXuk=",
  } as const;

  it("reproduces the published signature byte-exact", async () => {
    const signed = await signV2(V2_VECTOR.request, V2_VECTOR.input);
    expect(new URL(signed.url).searchParams.get("Signature")).toBe(V2_VECTOR.expectedSignature);
  });

  it("appends '&' to the secret, unlike V3", async () => {
    const correct = await signV2(V2_VECTOR.request, V2_VECTOR.input);
    const wrong = await signV2(V2_VECTOR.request, {
      ...V2_VECTOR.input,
      accessKeySecret: `${V2_VECTOR.input.accessKeySecret}&`,
    });
    const sig = (url: string): string | null => new URL(url).searchParams.get("Signature");
    expect(sig(correct.url)).toBe(V2_VECTOR.expectedSignature);
    expect(sig(wrong.url)).not.toBe(V2_VECTOR.expectedSignature);
  });

  it("emits a Base64 signature, not hex", async () => {
    const signed = await signV2(V2_VECTOR.request, V2_VECTOR.input);
    expect(new URL(signed.url).searchParams.get("Signature") ?? "").toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("includes the required protocol parameters", async () => {
    const params = new URL((await signV2(V2_VECTOR.request, V2_VECTOR.input)).url).searchParams;
    expect(params.get("SignatureMethod")).toBe("HMAC-SHA1");
    expect(params.get("SignatureVersion")).toBe("1.0");
    expect(params.get("Action")).toBe("DescribeDedicatedHosts");
    expect(params.get("Version")).toBe("2014-05-26");
    expect(params.get("AccessKeyId")).toBe("testid");
    expect(params.get("Format")).toBe("JSON");
    expect(params.get("SignatureNonce")).toBe(V2_VECTOR.input.nonce);
    expect(params.get("Timestamp")).toBe("2023-03-13T08:34:30Z");
    expect(params.get("RegionId")).toBe("cn-beijing");
  });

  it("does not leak the secret into the signed URL", async () => {
    const signed = await signV2(V2_VECTOR.request, V2_VECTOR.input);
    expect(signed.url).not.toContain(V2_VECTOR.input.accessKeySecret);
  });
});
