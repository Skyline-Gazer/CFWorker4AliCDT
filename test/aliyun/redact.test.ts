import { describe, expect, it } from "vitest";

import { redact } from "../../src/aliyun/rpc";

/**
 * Redaction is a single boundary.
 *
 * There were previously **two** implementations: a weaker one in this module and
 * a stronger one in `src/notify/webhook.ts`. That would be harmless if they
 * agreed, but they did not, and the disagreement was not merely cosmetic.
 *
 * `RpcError.message` is built from *this* module's output. The D1 write path then
 * redacts that text again with the stronger implementation. Because this module's
 * key list could consume a scheme word and leave the credential behind:
 *
 *   raw    : `Authorization: Bearer tok123 rejected`
 *   rpc    : `Authorization: [REDACTED] tok123 rejected`   <- "Bearer" eaten, token left
 *   stored : `Authorization: [REDACTED]] tok123 rejected`  <- token persisted to D1
 *
 * The credential survived all the way into a database row. The tests below pin
 * the property that prevents it: redaction must be **idempotent**, so applying a
 * second, stronger pass to already-redacted text cannot expose a value that the
 * first pass left in place.
 */

describe("rpc.redact — delegates to the single redaction boundary", () => {
  it("redacts an Authorization value without consuming the scheme word", () => {
    // The scheme word is deliberately *preserved*: it is the anchor. Removing it
    // is exactly the defect being fixed here.
    const out = redact("Authorization: Bearer tok123 rejected");
    expect(out).not.toContain("tok123");
    expect(out).toBe("Authorization: Bearer [REDACTED] rejected");
  });

  it("redacts a Basic authorization value", () => {
    const out = redact("Authorization: Basic dXNlcjpwYXNz");
    expect(out).not.toContain("dXNlcjpwYXNz");
    expect(out).toBe("Authorization: Basic [REDACTED]");
  });

  it("redacts underscore-prefixed binding names, which a word boundary misses", () => {
    // `_` is a word character, so `\b` never matches between `_` and `TOKEN`.
    for (const message of [
      "WEBHOOK_TOKEN=tok123",
      "ADMIN_TOKEN=tok123",
      "ALIYUN_ACCESS_KEY_SECRET=LTAI5tSecretValue",
    ]) {
      const out = redact(message);
      expect(out).not.toContain("tok123");
      expect(out).not.toContain("LTAI5tSecretValue");
    }
  });

  it("redacts an access key id echoed in a query string", () => {
    const out = redact("AccessKeyId=LTAI5tSecretValue&Signature=9NaGiOspFP5UPcwX8Iwt2YJXXuk");
    expect(out).not.toContain("LTAI5tSecretValue");
    expect(out).not.toContain("9NaGiOspFP5UPcwX8Iwt2YJXXuk");
  });

  it("preserves ordinary error text", () => {
    const message = "InvalidInstanceId: the specified instance does not exist";
    expect(redact(message)).toBe(message);
  });
});

describe("rpc.redact — idempotent, which is what closes the pipeline gap", () => {
  const dangerous = [
    "Authorization: Bearer tok123 rejected",
    "Authorization: Basic dXNlcjpwYXNz",
    "WEBHOOK_TOKEN=tok123",
    "AccessKeySecret=LTAI5tSecretValue failed",
    "Signature=9NaGiOspFP5UPcwX8Iwt2YJXXuk invalid",
  ];

  it.each(dangerous)("leaves no secret after a second application: %s", (message) => {
    // The D1 write path applies this function to text that has, in some paths,
    // already been through it. Idempotence is therefore a security property, not
    // a tidiness one.
    const once = redact(message);
    const twice = redact(once);
    expect(twice).toBe(once);
  });

  it("does not mangle its own placeholder into a fragment", () => {
    // The original defect: a second pass matched the inside of `[REDACTED]` and
    // produced `[REDACTED]]`, which is how the surviving token became visible.
    const once = redact("Authorization: Bearer tok123");
    expect(once).not.toContain("[REDACTED]]");
    expect(redact(once)).not.toContain("[REDACTED]]");
  });

  it("is idempotent for a value that arrives already redacted", () => {
    const already = "Authorization: Bearer [REDACTED] rejected";
    expect(redact(already)).toBe(already);
  });
});