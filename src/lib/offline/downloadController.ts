import { useEffect, useState } from "react";
import { getItemWithSources } from "../mediaApi";
import type { MediaItem } from "../types";
import {
  defaultDownloadHeight,
  downloadTitle,
  getDownloadPlan,
  getOfflineTitle,
  type OfflineTitle,
} from "./offlineLibrary";

/**
 * Downloads in progress in this tab, and their latest progress.
 *
 * Held outside React so a download keeps going, and keeps reporting, when the
 * page that started it is left; every button and the Downloads page read the
 * same entry.
 */

export type DownloadFailure = "not-allowed" | "unavailable" | "failed";

export interface ActiveDownload {
  itemId: string;
  progress: OfflineTitle | null;
  failure: DownloadFailure | null;
}

const active = new Map<string, ActiveDownload & { abort: AbortController }>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Whether this browser can play HEVC, which HDR packages are encoded in. */
function supportsHevc(): boolean {
  const source =
    (
      window as unknown as {
        ManagedMediaSource?: { isTypeSupported(type: string): boolean };
        MediaSource?: { isTypeSupported(type: string): boolean };
      }
    ).ManagedMediaSource ?? window.MediaSource;
  return Boolean(
    source?.isTypeSupported?.('video/mp4; codecs="hvc1.2.4.L153.B0"'),
  );
}

function failureOf(error: unknown): DownloadFailure {
  const code = (error as { code?: string } | null)?.code;
  if (code === "DOWNLOADS_NOT_ALLOWED") return "not-allowed";
  if (code === "DOWNLOAD_UNAVAILABLE") return "unavailable";
  return "failed";
}

/**
 * Starts, or resumes, keeping `item` on this device at its default quality.
 * A title already downloading is left alone.
 */
export function startDownload(item: MediaItem): void {
  if (active.get(item.Id)?.failure === null) return;
  const abort = new AbortController();
  const entry: ActiveDownload & { abort: AbortController } = {
    itemId: item.Id,
    progress: null,
    failure: null,
    abort,
  };
  active.set(item.Id, entry);
  notify();

  void (async () => {
    try {
      const plan = await getDownloadPlan(item.Id, supportsHevc());
      // A page's item carries no track list, and a stored copy is played with
      // no session to learn one from: without it the player would offer no
      // audio or subtitle choice offline.
      const itemWithTracks = await getItemWithSources(item.Id);
      const stored = await getOfflineTitle(item.Id);
      await downloadTitle(
        itemWithTracks,
        plan,
        stored?.height ?? defaultDownloadHeight(plan),
        {
          signal: abort.signal,
          onProgress: (progress) => {
            entry.progress = progress;
            notify();
          },
        },
      );
      active.delete(item.Id);
    } catch (error) {
      if (abort.signal.aborted) {
        active.delete(item.Id);
      } else {
        console.warn("[Seyirlik Offline] Download stopped", error);
        entry.failure = failureOf(error);
      }
    }
    notify();
  })();
}

export function cancelDownload(itemId: string): void {
  active.get(itemId)?.abort.abort();
  active.delete(itemId);
  notify();
}

export function dismissDownloadFailure(itemId: string): void {
  if (active.get(itemId)?.failure) {
    active.delete(itemId);
    notify();
  }
}

/** The live state of one title's download in this tab, if any. */
export function useActiveDownload(itemId: string): ActiveDownload | null {
  const [entry, setEntry] = useState<ActiveDownload | null>(() =>
    snapshot(itemId),
  );
  useEffect(() => {
    const update = () => setEntry(snapshot(itemId));
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, [itemId]);
  return entry;
}

function snapshot(itemId: string): ActiveDownload | null {
  const entry = active.get(itemId);
  return entry
    ? { itemId, progress: entry.progress, failure: entry.failure }
    : null;
}
