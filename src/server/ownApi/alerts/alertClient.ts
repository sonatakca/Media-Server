import {
  mintViewerToken,
  signRequest,
  type AlertEvent,
  type Heartbeat,
} from "../../../../alerts/src/core";

/**
 * Seyirlik's side of the alert service (alerts/, a Cloudflare Worker).
 *
 * Everything here is best-effort and never blocks the caller: an alert that
 * cannot be delivered is a line in the log, not a failed scan or a stuck
 * encode. What matters most — noticing that this process has gone quiet — is
 * the service's job, precisely because this process cannot do it.
 */

export interface AlertClient {
  emit(event: AlertEvent): void;
  /**
   * Sends one event and waits for it, for a short-lived script that would
   * otherwise exit before a background retry ever ran.
   */
  deliver(event: AlertEvent): Promise<boolean>;
  heartbeat(payload: Omit<Heartbeat, "at">): Promise<void>;
  /** A token that lets a device read alerts while this server is down. */
  mintViewerToken(subject: string): Promise<string>;
  readonly url: string;
}

export interface AlertConfig {
  url: string;
  secret: string;
}

/** The alert service's address and secret, or null when not configured. */
export function parseAlertConfig(
  environment: Record<string, string | undefined>,
): AlertConfig | null {
  const url = environment.SEYIRLIK_ALERTS_URL?.trim();
  const secret = environment.SEYIRLIK_ALERTS_SECRET?.trim();
  if (!url && !secret) return null;
  if (!url || !secret) {
    throw new Error(
      "SEYIRLIK_ALERTS_URL and SEYIRLIK_ALERTS_SECRET must be set together.",
    );
  }
  if (secret.length < 32) {
    throw new Error("SEYIRLIK_ALERTS_SECRET must be at least 32 characters.");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new Error("SEYIRLIK_ALERTS_URL must be an http(s) URL.");
  }
  return { url: url.replace(/\/+$/, ""), secret };
}

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
/** A year: long enough to still work on the night it is needed. */
const VIEWER_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export function createAlertClient(
  config: AlertConfig,
  options: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    schedule?: (callback: () => void, delayMs: number) => void;
    log?: (message: string) => void;
  } = {},
): AlertClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((callback, delayMs) => {
      setTimeout(callback, delayMs).unref?.();
    });
  const log = options.log ?? ((message) => console.warn(message));

  async function post(path: string, payload: unknown): Promise<boolean> {
    const body = JSON.stringify(payload);
    const timestamp = now();
    try {
      const response = await fetchImpl(`${config.url}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Seyirlik-Timestamp": String(timestamp),
          "X-Seyirlik-Signature": await signRequest(
            config.secret,
            timestamp,
            body,
          ),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  return {
    url: config.url,

    emit(event) {
      const attempt = (index: number) => {
        void post("/v1/events", event).then((delivered) => {
          if (delivered) return;
          const delay = RETRY_DELAYS_MS[index];
          if (delay === undefined) {
            log(`[Seyirlik] alert not delivered: ${event.kind}`);
            return;
          }
          schedule(() => attempt(index + 1), delay);
        });
      };
      attempt(0);
    },

    async deliver(event) {
      return (
        (await post("/v1/events", event)) || (await post("/v1/events", event))
      );
    },

    async heartbeat(payload) {
      // Not retried: the next one is a minute away, and a late heartbeat
      // says nothing the next one will not.
      await post("/v1/heartbeat", { ...payload, at: now() });
    },

    mintViewerToken: (subject) =>
      mintViewerToken(config.secret, subject, now() + VIEWER_TOKEN_LIFETIME_MS),
  };
}

/** What a storage guard transition means to somebody away from the server. */
export function storageTransitionEvent(
  event: string,
  detail: string,
): AlertEvent | null {
  // Only the guard's own first sentence, which classifies the fault. What
  // follows it is error text that can name files, and paths never leave the
  // server. The detail's own prefix is the media root, dropped for the same
  // reason.
  const reason = detail.split(": ").slice(1).join(": ") || detail;
  const body = reason.split(/(?<=\.)\s/)[0] ?? "";
  switch (event) {
    case "storage.unavailable":
    case "storage.suspect":
    case "storage.quarantined":
    case "storage.recovery_pending":
      return {
        kind: "storage",
        severity: event === "storage.recovery_pending" ? "warning" : "critical",
        title:
          event === "storage.recovery_pending"
            ? "Media storage needs a check before work resumes"
            : event === "storage.unavailable"
              ? "Media storage is unavailable"
              : "Media storage is on hold",
        body: body.slice(0, 300),
        key: "storage",
      };
    case "storage.available":
    case "storage.recovered":
    case "storage.identity_adopted":
      return {
        kind: "storage",
        severity: "info",
        title: "Media storage is back",
        key: "storage",
        resolve: true,
      };
    default:
      return null;
  }
}
