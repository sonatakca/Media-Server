import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { fetchOriginalFrame } from "../../lib/mediaApi";
import type { TranslationKey } from "../../i18n/translations";

const FRAME_NOTICE_MS = 3200;

/** Finder and Explorer both refuse these characters in a file name. */
function toFileSafeName(name: string | null | undefined): string {
  const safeName = (name ?? "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return safeName || "Seyirlik";
}

/** `1-04-44` rather than `1:04:44`, which Finder shows with slashes. */
function formatFrameTimestamp(seconds: number): string {
  const wholeSeconds = Math.floor(seconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${Math.floor(wholeSeconds / 3600)}-${pad(
    Math.floor((wholeSeconds % 3600) / 60),
  )}-${pad(wholeSeconds % 60)}`;
}

/**
 * Hands a blob to the browser's download flow. The object URL is revoked
 * later rather than at once, because Safari may read it after the click
 * handler has returned.
 */
function saveBlobToDevice(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

interface FrameCaptureOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  playSessionId: string | undefined;
  itemName: string | null | undefined;
  revealPlayerChrome: () => void;
  t: (key: TranslationKey) => string;
}

/** Saving the paused frame at the original's full resolution, and saying how it went. */
export function useFrameCapture({
  videoRef,
  playSessionId,
  itemName,
  revealPlayerChrome,
  t,
}: FrameCaptureOptions) {
  const [frameNotice, setFrameNotice] = useState<string | null>(null);
  const [isSavingFrame, setIsSavingFrame] = useState(false);
  const frameNoticeTimerRef = useRef<number | null>(null);

  const showFrameNotice = useCallback(
    (message: string, durationMs = FRAME_NOTICE_MS) => {
      if (frameNoticeTimerRef.current !== null) {
        window.clearTimeout(frameNoticeTimerRef.current);
      }
      setFrameNotice(message);
      frameNoticeTimerRef.current = window.setTimeout(() => {
        frameNoticeTimerRef.current = null;
        setFrameNotice(null);
      }, durationMs);
    },
    [],
  );

  useEffect(
    () => () => {
      if (frameNoticeTimerRef.current !== null) {
        window.clearTimeout(frameNoticeTimerRef.current);
      }
    },
    [],
  );

  /**
   * Saves the paused frame from the original file rather than from the
   * element: the element holds whichever quality rung Auto chose, and in
   * Safari it streams from another origin, so its pixels cannot be exported.
   * Refused while playing, because the picture moves on before the capture
   * returns and the viewer would get a frame they never chose.
   */
  const handleSaveFrame = useCallback(async () => {
    revealPlayerChrome();
    if (isSavingFrame) return;

    const video = videoRef.current;
    if (!video || !video.paused) {
      showFrameNotice(t("player.saveFramePauseFirst"));
      return;
    }

    const sessionId = playSessionId;
    if (!sessionId) {
      showFrameNotice(t("player.saveFrameFailed"));
      return;
    }

    const atSeconds = Math.max(0, video.currentTime);
    setIsSavingFrame(true);
    // Held until the capture answers: a 4K HEVC frame can take a few seconds.
    showFrameNotice(t("player.saveFrameSaving"), 60_000);

    try {
      const frame = await fetchOriginalFrame(sessionId, atSeconds);
      saveBlobToDevice(
        frame,
        `${toFileSafeName(itemName)} ${formatFrameTimestamp(atSeconds)}.png`,
      );
      showFrameNotice(t("player.saveFrameSaved"));
    } catch (frameError) {
      console.warn("[Seyirlik Player] Could not save the frame", frameError);
      showFrameNotice(t("player.saveFrameFailed"));
    } finally {
      setIsSavingFrame(false);
    }
  }, [
    playSessionId,
    isSavingFrame,
    itemName,
    revealPlayerChrome,
    showFrameNotice,
    t,
    videoRef,
  ]);

  return { frameNotice, isSavingFrame, handleSaveFrame };
}
