/**
 * Optional external playback coordination after a durable library change.
 * Seyirlik decides what changed. An adapter maps its catalogue ID to an external
 * item ID; paths, credentials and provider decisions do not cross this boundary.
 * No adapter is installed by default, and no refresh request is a library scan.
 */
export interface PlaybackChange {
  readonly mediaFileId: string;
  readonly kind: "subtitles" | "metadata";
}

export interface PlaybackRefreshAdapter {
  refresh(change: PlaybackChange, signal: AbortSignal): Promise<void>;
}

export type PlaybackRefreshResult =
  | { readonly outcome: "refreshed" }
  | { readonly outcome: "unconfigured" }
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "timeout" }
  | { readonly outcome: "cancelled" };

export interface PlaybackRefreshBoundary {
  readonly configured: boolean;
  request(
    change: PlaybackChange,
    signal?: AbortSignal,
  ): Promise<PlaybackRefreshResult>;
}

/**
 * This result describes an external integration, never core health. Call only
 * after the subtitle/metadata commit: failure must not roll back a valid file.
 * Even an adapter ignoring abort cannot hold the calling job indefinitely.
 */
export function createPlaybackRefreshBoundary(
  options: {
    adapter?: PlaybackRefreshAdapter;
    timeoutMs?: number;
  } = {},
): PlaybackRefreshBoundary {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new Error(
      "Playback refresh timeout must be between 1 and 300000 milliseconds.",
    );
  }
  const adapter = options.adapter;
  return {
    configured: adapter !== undefined,
    async request(change, signal) {
      if (!adapter) return { outcome: "unconfigured" };
      if (signal?.aborted) return { outcome: "cancelled" };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel = () => {};
      const interrupted = new Promise<PlaybackRefreshResult>((resolve) => {
        cancel = () => {
          resolve({ outcome: "cancelled" });
          controller.abort();
        };
        signal?.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => {
          resolve({ outcome: "timeout" });
          controller.abort();
        }, timeoutMs);
      });
      try {
        const refreshed = Promise.resolve()
          .then(async (): Promise<PlaybackRefreshResult> => {
            if (controller.signal.aborted) return { outcome: "cancelled" };
            await adapter.refresh(
              { mediaFileId: change.mediaFileId, kind: change.kind },
              controller.signal,
            );
            return { outcome: "refreshed" };
          })
          .catch((): PlaybackRefreshResult => ({ outcome: "unavailable" }));
        return await Promise.race([interrupted, refreshed]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
