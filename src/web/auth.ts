/**
 * Authentication boundary (SPEC §8.2, §8.3).
 *
 * Every rule here exists because the naive version is a real bypass:
 *
 * - A comparison that returns on the first differing byte leaks the token one
 *   byte at a time, so it must inspect **every** byte regardless of where the
 *   difference falls.
 * - A lenient parser that treats an unrecognised `Authorization` header as
 *   authenticated turns a malformed request into a session.
 * - A fallback to an empty or default token turns a forgotten secret into an
 *   open door, so a missing `ADMIN_TOKEN` must deny everything.
 *
 * The result deliberately carries no credential material: it is logged, and on
 * the failure path it may reach a response.
 */

export interface AuthConfig {
  readonly adminUser: string | undefined;
  readonly adminToken: string | undefined;
}

export interface AuthResult {
  readonly ok: boolean;
}

const DENIED: AuthResult = { ok: false };
const GRANTED: AuthResult = { ok: true };

const DEFAULT_ADMIN_USER = "admin";

/**
 * Compare two strings without short-circuiting (SPEC §8.2).
 *
 * Returns `false` for differing lengths, but still walks the shorter string
 * rather than returning immediately, so the length difference does not collapse
 * the comparison to a single step.
 *
 * `onVisit` is an instrumentation seam for the timing-safety test. It exists
 * because the alternative — asserting wall-clock timings — is flaky under CI
 * load and gives a false signal in both directions. What must hold is that the
 * loop does not exit early, and that is what the test counts.
 */
export function constantTimeEqual(a: string, b: string, onVisit?: () => void): boolean {
  // `!==` on length is unavoidable (it is public information in HTTP), but the
  // byte walk below still runs so the result does not depend on where the first
  // difference falls.
  const lengthMismatch = a.length !== b.length;
  const length = Math.min(a.length, b.length);

  let difference = 0;
  for (let index = 0; index < length; index += 1) {
    onVisit?.();
    // XOR accumulates rather than returning early, so every byte is inspected.
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return !lengthMismatch && difference === 0;
}

/** The 401 challenge. A browser needs the realm to prompt (SPEC §8.2). */
export function basicChallenge(): string {
  return 'Basic realm="cfworker4alicdt"';
}

/** An empty or whitespace-only binding is treated as unset. */
function usable(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function effectiveUser(config: AuthConfig): string {
  return usable(config.adminUser) ? config.adminUser : DEFAULT_ADMIN_USER;
}

/**
 * Decode a Basic credential.
 *
 * Returns `undefined` for anything malformed, so the caller cannot mistake an
 * unparseable header for a credential. Splits on the **first** colon: a token
 * may legitimately contain one, and splitting on the last would corrupt it.
 */
function decodeBasic(encoded: string): { user: string; password: string } | undefined {
  if (encoded.trim() === "") return undefined;

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    // Not valid Base64. Unparseable is unauthenticated, never authenticated.
    return undefined;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) return undefined;

  return {
    user: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

/**
 * Verify an `Authorization` header.
 *
 * Fails closed: an absent, empty, unrecognised, or malformed header is denied,
 * and so is every request when `ADMIN_TOKEN` is unset (SPEC §8.3).
 */
export function authenticate(header: string | null | undefined, config: AuthConfig): AuthResult {
  // Fail closed before any parsing. An absent or blank token denies everything
  // rather than falling back to a default, so a forgotten secret locks the door.
  if (!usable(config.adminToken)) return DENIED;

  if (header === null || header === undefined) return DENIED;

  const trimmed = header.trim();
  if (trimmed === "") return DENIED;

  const space = trimmed.indexOf(" ");
  if (space === -1) return DENIED; // scheme with no value

  const scheme = trimmed.slice(0, space).toLowerCase();
  const credential = trimmed.slice(space + 1).trim();
  if (credential === "") return DENIED;

  if (scheme === "basic") {
    const parsed = decodeBasic(credential);
    if (parsed === undefined) return DENIED;

    // Both halves are checked, and both comparisons always run so the outcome
    // does not depend on which half failed.
    const userMatches = constantTimeEqual(parsed.user, effectiveUser(config));
    const tokenMatches = constantTimeEqual(parsed.password, config.adminToken);
    return userMatches && tokenMatches ? GRANTED : DENIED;
  }

  if (scheme === "bearer") {
    // A Basic credential presented as a Bearer token is not a token.
    return constantTimeEqual(credential, config.adminToken) ? GRANTED : DENIED;
  }

  // Any other scheme is unauthenticated. Notably this is not a fall-through to
  // "no auth required".
  return DENIED;
}
