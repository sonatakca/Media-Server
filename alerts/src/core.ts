/**
 * The alert service's rules, kept free of Cloudflare so they are tested with
 * the rest of Seyirlik.
 *
 * The service runs where neither the Seyirlik server nor the Mac does, because
 * its most important message is the one those two cannot send: that they have
 * gone quiet. The server reports events and a heartbeat, signed with a secret
 * the two share; the service decides what is worth waking somebody for.
 */

export type Severity = "critical" | "warning" | "info";

export interface AlertEvent {
  kind: string;
  severity: Severity;
  title: string;
  body?: string;
  /**
   * Names a condition rather than an occurrence: while an alert with this key
   * is open, the same key again is the same problem, not a new one.
   */
  key?: string;
  /** Closes the open alert with `key`, recording this as its resolution. */
  resolve?: boolean;
}

export interface StoredAlert {
  id: string;
  kind: string;
  severity: Severity;
  title: string;
  body: string;
  key: string | null;
  createdAt: number;
  resolvedAt: number | null;
  lastSeenAt: number;
}

export interface Heartbeat {
  /** When the server sent it, by its own clock. */
  at: number;
  version?: string;
  /** The storage guard's state, e.g. "available", "quarantined". */
  storage?: string;
  /** When the last verified backup finished, if there has been one. */
  lastVerifiedBackupAt?: number | null;
}

/** How long without a heartbeat before the server counts as down. */
export const HEARTBEAT_STALE_MS = 3 * 60_000;
/** How old the last verified backup may be before it is worth saying. */
export const BACKUP_STALE_MS = 36 * 60 * 60_000;
/** How far a signed request's clock may be from ours. */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;
export const HOST_DOWN_KEY = "host-down";
export const BACKUP_STALE_KEY = "backup-stale";

const SEVERITIES: ReadonlySet<string> = new Set([
  "critical",
  "warning",
  "info",
]);

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacHex(secret: string, message: string): Promise<string> {
  return toHex(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(secret),
      encoder.encode(message),
    ),
  );
}

/** Constant-time comparison of two strings of hex or base64url. */
function sameText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** The signature a request from the server carries over `timestamp.body`. */
export function signRequest(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  return hmacHex(secret, `${timestamp}.${body}`);
}

export async function verifyRequest(
  secret: string,
  timestampHeader: string | null,
  signature: string | null,
  body: string,
  now: number,
): Promise<boolean> {
  const timestamp = Number(timestampHeader);
  if (!signature || !Number.isFinite(timestamp)) return false;
  if (Math.abs(now - timestamp) > SIGNATURE_WINDOW_MS) return false;
  return sameText(await signRequest(secret, timestamp, body), signature);
}

/**
 * A token that lets a device read alerts without the server.
 *
 * The server mints it for an administrator while it is up; the service can
 * check it on its own, so the alerts page still opens when the server is the
 * thing that is down.
 */
export async function mintViewerToken(
  secret: string,
  subject: string,
  expiresAt: number,
): Promise<string> {
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ sub: subject, exp: expiresAt })),
  );
  return `v1.${payload}.${await hmacHex(secret, `viewer.${payload}`)}`;
}

export async function verifyViewerToken(
  secret: string,
  token: string | null,
  now: number,
): Promise<{ subject: string } | null> {
  const [version, payload, signature] = (token ?? "").split(".");
  if (version !== "v1" || !payload || !signature) return null;
  if (!sameText(await hmacHex(secret, `viewer.${payload}`), signature)) {
    return null;
  }
  try {
    const claims = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payload)),
    );
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") {
      return null;
    }
    return claims.exp > now ? { subject: claims.sub } : null;
  } catch {
    return null;
  }
}

/** An event as the server sent it, or null if it is not one. */
export function parseEvent(value: unknown): AlertEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.kind !== "string" ||
    !event.kind ||
    event.kind.length > 64 ||
    typeof event.title !== "string" ||
    !event.title ||
    event.title.length > 200 ||
    !SEVERITIES.has(String(event.severity))
  ) {
    return null;
  }
  const body =
    typeof event.body === "string" ? event.body.slice(0, 1_000) : undefined;
  const key =
    typeof event.key === "string" && event.key && event.key.length <= 128
      ? event.key
      : undefined;
  return {
    kind: event.kind,
    severity: event.severity as Severity,
    title: event.title,
    ...(body ? { body } : {}),
    ...(key ? { key } : {}),
    ...(event.resolve === true && key ? { resolve: true } : {}),
  };
}

/** What one event does to the store, decided before anything is written. */
export type EventDecision =
  | { action: "open"; notify: boolean }
  | { action: "touch"; alertId: string }
  | { action: "resolve"; alertId: string; notify: boolean }
  | { action: "ignore" };

export function decideEvent(
  event: AlertEvent,
  openWithKey: StoredAlert | null,
): EventDecision {
  if (event.resolve) {
    // Resolving what is not open says nothing new.
    return openWithKey
      ? { action: "resolve", alertId: openWithKey.id, notify: true }
      : { action: "ignore" };
  }
  if (openWithKey) return { action: "touch", alertId: openWithKey.id };
  // Info is kept for the record; only warnings and worse wake anybody.
  return { action: "open", notify: event.severity !== "info" };
}

/** A duration a person reads: "4 min", "2 h 10 min". */
export function describeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * What the minute-by-minute check concludes about the server, given the last
 * heartbeat and whether the public health endpoint answered.
 */
export function assessHost(
  heartbeat: Heartbeat | null,
  receivedAt: number | null,
  healthAnswered: boolean,
  now: number,
): { down: boolean; detail: string } {
  if (!heartbeat || receivedAt === null) {
    return { down: false, detail: "No heartbeat has ever arrived." };
  }
  const silentFor = now - receivedAt;
  if (silentFor <= HEARTBEAT_STALE_MS) return { down: false, detail: "" };
  return {
    down: true,
    detail: healthAnswered
      ? `No heartbeat for ${describeDuration(silentFor)}, although the health endpoint still answers: the server process may be wedged.`
      : `No heartbeat for ${describeDuration(silentFor)}, and the health endpoint does not answer.`,
  };
}

export function backupIsStale(
  heartbeat: Heartbeat | null,
  now: number,
): boolean {
  if (!heartbeat || heartbeat.lastVerifiedBackupAt === undefined) return false;
  return (
    heartbeat.lastVerifiedBackupAt === null ||
    now - heartbeat.lastVerifiedBackupAt > BACKUP_STALE_MS
  );
}
