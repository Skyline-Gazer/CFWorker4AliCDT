/**
 * Secret redaction — the project's **single** redaction boundary (SPEC §7.5).
 *
 * Every destination that persists or displays untrusted text routes through
 * here: webhook payloads, D1 rows, rendered HTML, HTTP error bodies, and RPC
 * error messages. It lives in its own module so that the RPC layer and the
 * notification layer can both consume it without an import cycle.
 *
 * There used to be **two** implementations — a weaker one in `src/aliyun/rpc.ts`
 * and this one — and the divergence was a real leak, not untidiness:
 *
 *   raw    `Authorization: Bearer tok123 rejected`
 *   weak   `Authorization: [REDACTED] tok123 rejected`   <- "Bearer" eaten, token left
 *   then   `Authorization: [REDACTED]] tok123 rejected`  <- token reached a D1 row
 *
 * `RpcError.message` is built from redacted text and is redacted *again*
 * downstream, so a first pass that eats the scheme word (rather than the value)
 * hands the next pass a credential with nothing left to anchor on. Two key lists
 * can always disagree again; one boundary cannot.
 *
 * **Idempotence is a security property here, not tidiness**, for the reason
 * above: applying this function to its own output must not expose anything.
 *
 * Three passes, because one regex cannot cover the forms:
 *
 * 1. **Scheme-anchored header values.** `Authorization`, `Bearer`, `Basic`, and
 *    `Digest` are preserved as anchors while the value after them — and any
 *    scheme word — is replaced. Treating the scheme word as part of the value
 *    would delete the anchor and leave the credential in place.
 * 2. **Bare `key=value` / `key: value`**, including underscore-containing names
 *    that a word boundary cannot match.
 * 3. **Bare opaque tokens** with no key context at all.
 *
 * A remote validation error can echo a request header or a signed URL verbatim,
 * so values are treated as opaque: redaction keys off the *name*, never off
 * recognising what the credential looks like.
 */

/**
 * Keys whose values are credentials.
 *
 * Split into two disjoint sets so the two passes cannot re-process each other's
 * output. If a key appeared in both, the second pass would re-match the first
 * pass's placeholder and leave a fragment behind (`authorization: [REDACTED]]`).
 * Disjoint sets make that structurally impossible rather than dependent on an
 * escape hatch holding.
 *
 * The scheme-anchored names are handled by pass 1's own regex, which must
 * *preserve* the anchor and the scheme word; they are therefore not listed here.
 */
const PLAIN_KEYS: readonly string[] = [
  // `accesskey ?id`/`accesskey ?secret` (no underscore) and the underscored
  // `access_key_id`/`access_key_secret` in UNDERSCORED_KEYS are mutually
  // exclusive: the former requires `accesskey` as one word. Keeping the sets
  // disjoint is what prevents a second pass from re-processing an earlier pass's
  // placeholder.
  "accesskey ?id",
  "accesskey ?secret",
  "signature",
  "security ?token",
  "securitytoken",
  "token",
];

/**
 * Key names that carry credentials but contain underscores.
 *
 * These need their own pattern because `\b` does not help: `_` is a word
 * character in JavaScript, so there is no word boundary between `_` and `TOKEN`
 * in `WEBHOOK_TOKEN`. A `\b`-anchored `token` pattern therefore never matches the
 * project's own secret binding names — which is exactly how the value of
 * `WEBHOOK_TOKEN` passed through redaction unaltered.
 *
 * Listed explicitly rather than by loosening `\b` to `(?:^|[^A-Za-z0-9])`,
 * because that loosening would also start matching the `_`-suffixed form of
 * ordinary words and make prose redaction unpredictable.
 */
const UNDERSCORED_KEYS: readonly string[] = [
  "webhook_token",
  "admin_token",
  // `access_key_id` and `access_key_secret` are deliberately the only forms
  // listed: they match as substrings of `ALIYUN_ACCESS_KEY_ID` /
  // `ALIYUN_ACCESS_KEY_SECRET` AND standalone. Listing the `aliyun_`-prefixed
  // variants as well made two patterns match the same text, and the second pass
  // then re-processed the first pass's placeholder. The entries are kept mutually
  // non-overlapping so that cannot recur.
  "access_key_id",
  "access_key_secret",
  "webhook_url",
];

export const REDACTED = "[REDACTED]";

/**
 * Strip credential-shaped content from untrusted text.
 *
 * See the module header: idempotent by construction, and that matters.
 */
export function redact(text: string): string {
  let out = text;

  // Pass 1 — scheme-anchored. The anchor, separator, scheme word, and spacing
  // are all preserved; only the credential is replaced.
  //
  // Idempotence is enforced in the replacer rather than with a lookahead. A
  // lookahead fails here because the regex backtracks: when the value is already
  // `[REDACTED]`, the optional scheme group gives up, `Bearer` becomes the
  // *value*, and the text degrades to `Authorization: [REDACTED] [REDACTED]`.
  // Returning the match untouched when the value is already a placeholder cannot
  // backtrack into that.
  out = out.replace(
    new RegExp(
      `\\b(Authorization|Bearer|Basic|Digest)\\b(\\s*[:=]?\\s*)(Bearer|Basic|Digest)?(\\s*)("[^"]*"|'[^']*'|[^\\s,;"'}]+)`,
      "gi",
    ),
    (
      match: string,
      anchor: string,
      separator: string,
      scheme: string | undefined,
      spacing: string,
      value: string,
    ) => {
      if (value === REDACTED) return match;
      return scheme === undefined
        ? `${anchor}${separator}${REDACTED}`
        : `${anchor}${separator}${scheme}${spacing}${REDACTED}`;
    },
  );

  // Pass 2 — bare key/value pairs on keys disjoint from pass 1.
  for (const key of PLAIN_KEYS) {
    out = out.replace(
      new RegExp(`(\\b(?:${key})\\b["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^&\\s,;"'}]+)`, "gi"),
      (match: string, prefix: string, value: string) =>
        value === REDACTED ? match : `${prefix}${REDACTED}`,
    );
  }

  // Pass 2b — underscore-containing key names, which `\b` cannot anchor. Matched
  // anywhere in the string rather than at a word boundary.
  for (const key of UNDERSCORED_KEYS) {
    out = out.replace(
      new RegExp(`(${key}["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^&\\s,;"'}]+)`, "gi"),
      (match: string, prefix: string, value: string) =>
        value === REDACTED ? match : `${prefix}${REDACTED}`,
    );
  }

  // Pass 3 — long opaque tokens with no key context at all.
  out = out.replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, REDACTED);
  return out;
}

/**
 * Describe a value for a log line without exposing it.
 *
 * Used where a failure message may itself embed a credential-bearing URL.
 */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the configured endpoint";
  }
}
