/**
 * RFC 3986 canonicalisation for Alibaba Cloud request signing.
 *
 * The signing specification defines the unreserved set as `A-Za-z0-9-_.~`.
 * Everything else is percent-encoded, uppercase hex. Four cases are easy to get
 * wrong and are pinned by tests:
 *
 *   - a space encodes as `%20`, never `+`
 *   - `*` encodes as `%2A`
 *   - `~` stays literal, never `%7E`
 *   - `!`, `'`, `(`, and `)` are *encoded*, despite being unreserved in some
 *     other escaping schemes
 */
export function percentEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) {
    const isUnreserved =
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || // -
      byte === 0x5f || // _
      byte === 0x2e || // .
      byte === 0x7e; // ~
    out += isUnreserved
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * Canonical query string: parameters percent-encoded, sorted ascending by
 * encoded key, joined with `&`. A repeated key keeps its relative order.
 *
 * `Signature` is excluded by the caller, not here, so that this stays a pure
 * encoding step.
 */
export function canonicalQueryString(params: readonly (readonly [string, string])[]): string {
  return params
    .map(([key, value]): [string, string] => [percentEncode(key), percentEncode(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}
