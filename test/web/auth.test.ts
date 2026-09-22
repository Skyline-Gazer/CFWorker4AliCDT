import { describe, expect, it } from "vitest";

import { authenticate, constantTimeEqual, basicChallenge } from "../../src/web/auth";
import type { AuthConfig } from "../../src/web/auth";

/**
 * The authentication boundary (SPEC §8.2, §8.3).
 *
 * Six normative rules exist here because each is a real bypass when implemented
 * naively: a short-circuiting comparison leaks the token a byte at a time, a
 * lenient parser accepts a malformed header as authenticated, and a default
 * token turns a forgotten secret into an open door.
 *
 * The timing test is written as a *structural* property — the comparator must
 * inspect every byte — rather than a wall-clock measurement. A wall-clock
 * assertion is flaky under CI load and would be a false signal either way; what
 * actually matters is that the loop does not exit early.
 */

const CONFIG: AuthConfig = { adminUser: "admin", adminToken: "s3cret-token" };

function basic(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

describe("constantTimeEqual — timing safety (SPEC §8.2)", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(constantTimeEqual("s3cret-token", "s3cret-tokeX")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(constantTimeEqual("short", "muchlongervalue")).toBe(false);
    expect(constantTimeEqual("muchlongervalue", "short")).toBe(false);
  });

  it("does not short-circuit on the first differing byte", () => {
    // The property that matters: every byte is inspected regardless of where the
    // first difference falls. A comparator that returned early would be
    // observably faster for an early mismatch — which is how a token is
    // recovered one byte at a time.
    //
    // Counted directly rather than measured in wall-clock time, so CI load
    // cannot make this flaky.
    const visits: number[] = [];
    const spyCompare = (a: string, b: string): boolean => {
      let checked = 0;
      const result = constantTimeEqual(a, b, () => {
        checked += 1;
      });
      visits.push(checked);
      return result;
    };

    const target = "0123456789abcdef";
    spyCompare(target, "X123456789abcdef"); // differs at byte 0
    spyCompare(target, "0123456789abcdeX"); // differs at the last byte

    // Both comparisons inspect the same number of bytes.
    expect(visits[0]).toBe(visits[1]);
    expect(visits[0]).toBe(target.length);
  });

  it("compares by code point, so a multi-byte difference is still unequal", () => {
    expect(constantTimeEqual("a", "b")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
  });
});

describe("authenticate — HTTP Basic (SPEC §8.2)", () => {
  it("accepts valid Basic credentials", () => {
    const result = authenticate(basic("admin", "s3cret-token"), CONFIG);
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(authenticate(basic("admin", "wrong"), CONFIG).ok).toBe(false);
  });

  it("rejects a wrong username", () => {
    expect(authenticate(basic("root", "s3cret-token"), CONFIG).ok).toBe(false);
  });

  it("rejects a wrong username even when the password is correct", () => {
    // Both halves must be checked. Validating only the token would let any
    // username in, and the username is the half a browser prefills.
    expect(authenticate(basic("anything", "s3cret-token"), CONFIG).ok).toBe(false);
  });

  it("does not disclose which half was wrong", () => {
    const wrongUser = authenticate(basic("root", "s3cret-token"), CONFIG);
    const wrongPass = authenticate(basic("admin", "wrong"), CONFIG);
    expect(wrongUser).toEqual(wrongPass);
  });

  it("handles a password containing a colon", () => {
    // The separator is the FIRST colon: a token may legitimately contain one,
    // and splitting on the last colon would corrupt it.
    const config: AuthConfig = { adminUser: "admin", adminToken: "a:b:c" };
    expect(authenticate(basic("admin", "a:b:c"), config).ok).toBe(true);
  });
});

describe("authenticate — Bearer (SPEC §8.2)", () => {
  it("accepts a valid Bearer token", () => {
    expect(authenticate("Bearer s3cret-token", CONFIG).ok).toBe(true);
  });

  it("is case-insensitive on the scheme", () => {
    expect(authenticate("bearer s3cret-token", CONFIG).ok).toBe(true);
    expect(authenticate("BEARER s3cret-token", CONFIG).ok).toBe(true);
  });

  it("rejects a wrong or truncated token", () => {
    expect(authenticate("Bearer wrong", CONFIG).ok).toBe(false);
    expect(authenticate("Bearer s3cret-toke", CONFIG).ok).toBe(false);
    expect(authenticate("Bearer s3cret-tokenX", CONFIG).ok).toBe(false);
  });

  it("does not accept Basic credentials through the Bearer path", () => {
    expect(authenticate(`Bearer ${btoa("admin:s3cret-token")}`, CONFIG).ok).toBe(false);
  });
});

describe("authenticate — malformed input is never authenticated (SPEC §8.2)", () => {
  const malformed: readonly (readonly [string, string | null])[] = [
    ["absent header", null],
    ["empty header", ""],
    ["whitespace only", "   "],
    ["unknown scheme", "Digest abc"],
    ["scheme with no value", "Basic"],
    ["Bearer with no value", "Bearer"],
    ["unparseable Base64", "Basic !!!not-base64!!!"],
    ["no colon separator", `Basic ${btoa("adminonly")}`],
    ["Basic with empty value", "Basic "],
    ["nested scheme", `Basic ${btoa("Basic admin:s3cret-token")}`],
    ["token as username", `Basic ${btoa("s3cret-token:")}`],
  ];

  it.each(malformed)("rejects %s", (_label, header) => {
    expect(authenticate(header, CONFIG).ok).toBe(false);
  });

  it("rejects an Authorization header that merely contains the token", () => {
    expect(authenticate(`Custom s3cret-token`, CONFIG).ok).toBe(false);
    expect(authenticate(`Basic s3cret-token`, CONFIG).ok).toBe(false);
  });

  it("does not treat a raw Base64 credential without a scheme as authenticated", () => {
    expect(authenticate(btoa("admin:s3cret-token"), CONFIG).ok).toBe(false);
  });

  it("does not accept a token-only value with no username separator", () => {
    // `Basic <token>` has no colon, so it is not a Basic credential at all.
    expect(authenticate(`Basic ${btoa("s3cret-token")}`, CONFIG).ok).toBe(false);
    expect(authenticate("Basic s3cret-token", CONFIG).ok).toBe(false);
  });

  it("rejects a non-ASCII homoglyph username rather than folding it", () => {
    // 'à' (U+00E0) is Latin-1 representable, so it survives `btoa`, and is
    // visually confusable with 'a'. No normalisation is applied, so the
    // comparison must fail. `atob` decodes Latin-1, so a UTF-8 credential would
    // also mis-decode — which fails closed, the safe direction.
    expect(authenticate(basic("\u00e0dmin", "s3cret-token"), CONFIG).ok).toBe(false);
    // Sanity: the same construction with the correct user does authenticate,
    // so the failure above is the homoglyph and not a broken fixture.
    expect(authenticate(basic("admin", "s3cret-token"), CONFIG).ok).toBe(true);
  });

  it("rejects a credential with a trailing newline appended", () => {
    // Header-splitting attempts must not smuggle a valid credential through.
    expect(authenticate(`${basic("admin", "s3cret-token")}\nX-Injected: 1`, CONFIG).ok).toBe(false);
  });

  it("treats a trailing space in the token as significant", () => {
    expect(authenticate(basic("admin", "s3cret-token "), CONFIG).ok).toBe(false);
  });

  it("does not accept a token containing an appended null byte", () => {
    expect(authenticate(basic("admin", "s3cret-token\u0000"), CONFIG).ok).toBe(false);
  });
});

describe("authenticate — fail closed when ADMIN_TOKEN is absent (SPEC §8.3)", () => {
  const noToken: readonly (readonly [string, AuthConfig])[] = [
    ["undefined", { adminUser: "admin", adminToken: undefined }],
    ["empty", { adminUser: "admin", adminToken: "" }],
    ["whitespace", { adminUser: "admin", adminToken: "   " }],
  ];

  it.each(noToken)("denies every request when the token is %s", (_label, config) => {
    // An operator who forgets the secret gets a locked door, not an open one.
    // The dangerous alternative is falling back to an empty or default token.
    for (const header of [
      null,
      "",
      "Basic ",
      basic("admin", ""),
      "Bearer ",
      `Basic ${btoa("admin:")}`,
    ]) {
      expect(authenticate(header, config).ok).toBe(false);
    }
  });

  it("does not accept a request whose credential is also empty", () => {
    const config: AuthConfig = { adminUser: "admin", adminToken: "" };
    expect(authenticate(basic("admin", ""), config).ok).toBe(false);
    expect(authenticate("Bearer ", config).ok).toBe(false);
  });
});

describe("authenticate — ADMIN_USER defaulting (SPEC §8.2)", () => {
  it("defaults the username to admin when unset or empty", () => {
    for (const adminUser of [undefined, ""]) {
      const config: AuthConfig = { adminUser, adminToken: "tok" };
      expect(authenticate(basic("admin", "tok"), config).ok).toBe(true);
    }
  });

  it("rejects a username that is not the configured one", () => {
    const config: AuthConfig = { adminUser: "operator", adminToken: "tok" };
    expect(authenticate(basic("admin", "tok"), config).ok).toBe(false);
    expect(authenticate(basic("operator", "tok"), config).ok).toBe(true);
  });
});

describe("authenticate — result carries no credential material", () => {
  it("does not echo the header or token in the result", () => {
    // Results are logged and, on the failure path, may reach a response. The
    // token must not be recoverable from either.
    const okResult = authenticate(basic("admin", "s3cret-token"), CONFIG);
    const failResult = authenticate(basic("admin", "wrong"), CONFIG);
    for (const result of [okResult, failResult]) {
      expect(JSON.stringify(result)).not.toContain("s3cret-token");
      expect(JSON.stringify(result)).not.toContain(btoa("admin:s3cret-token"));
    }
  });
});

describe("basicChallenge — 401 challenge (SPEC §8.2)", () => {
  it("names the Basic realm so a browser prompts", () => {
    expect(basicChallenge()).toBe('Basic realm="cfworker4alicdt"');
  });

  it("does not include the token", () => {
    expect(basicChallenge()).not.toContain("s3cret-token");
  });
});
