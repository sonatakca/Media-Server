/**
 * A random UUID that works outside a secure context.
 *
 * `crypto.randomUUID` is secure-context only, so it is undefined on every
 * origin that is not HTTPS or localhost — which is exactly how the dev server
 * is reached from another machine on the LAN (http://192.168.x.x:5173) or over
 * Tailscale. Calling it unguarded there throws, and because it sits on the
 * request path the failure surfaces as an unexplained login error.
 *
 * `crypto.getRandomValues` has no such restriction, so the fallback is still
 * cryptographically random rather than `Math.random`.
 */
export function randomUuid(): string {
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    // No Web Crypto at all. Nothing here is a secret — these ids only correlate
    // a request with a log line — so a weaker source beats refusing to work.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  // Version 4, variant 1, per RFC 4122.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
