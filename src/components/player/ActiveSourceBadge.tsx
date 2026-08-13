/**
 * Development-only readout of which media is actually on screen.
 *
 * A rendition handoff is deliberately invisible — that is the whole point of it
 * — which makes it very hard to tell a switch that worked from one that quietly
 * declined. This reads the decoded frame size straight off the video element
 * that is currently visible, so it reports what the decoder is really producing
 * rather than what the picker believes it selected. When the two disagree, the
 * switch did not happen.
 *
 * Never rendered in a production build.
 */

import { useEffect, useRef, useState } from "react";

import type { DeckId } from "./deckModel";

export interface ActiveSourceBadgeProps {
  /** Live view of the deck that owns playback. */
  videoRef: { readonly current: HTMLVideoElement | null };
  activeDeckId: DeckId;
  /** Changes on every promotion, which is the cue to re-read the element. */
  deckEpoch: number;
  /** The rendition the player believes is active. */
  activeQualityId: string | null;
  activeQualityLabel?: string;
  /** The rendition a switch is currently preparing, if any. */
  pendingQualityId: string | null;
}

interface DecodedFrame {
  width: number;
  height: number;
}

/** How long a change stays highlighted, so a handoff is visible as it happens. */
const FLASH_MS = 1_600;

export function ActiveSourceBadge({
  videoRef,
  activeDeckId,
  deckEpoch,
  activeQualityId,
  activeQualityLabel,
  pendingQualityId,
}: ActiveSourceBadgeProps) {
  const [frame, setFrame] = useState<DecodedFrame>({ width: 0, height: 0 });
  const [isFlashing, setIsFlashing] = useState(false);
  const lastSignatureRef = useRef<string>("");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    const read = () => {
      setFrame((current) =>
        current.width === video.videoWidth &&
        current.height === video.videoHeight
          ? current
          : { width: video.videoWidth, height: video.videoHeight },
      );
    };

    read();
    video.addEventListener("loadedmetadata", read);
    video.addEventListener("loadeddata", read);
    video.addEventListener("resize", read);
    // `resize` is the event for a changed frame size, but a promotion swaps the
    // element rather than resizing it, and a slow source can report its size
    // late. A slow poll costs nothing here and keeps the readout honest.
    const poll = window.setInterval(read, 500);

    return () => {
      video.removeEventListener("loadedmetadata", read);
      video.removeEventListener("loadeddata", read);
      video.removeEventListener("resize", read);
      window.clearInterval(poll);
    };
  }, [deckEpoch, videoRef]);

  const signature = `${activeDeckId}:${activeQualityId}:${frame.width}x${frame.height}`;

  useEffect(() => {
    if (lastSignatureRef.current === signature) return undefined;

    const isFirstReading = lastSignatureRef.current === "";
    lastSignatureRef.current = signature;
    if (isFirstReading) return undefined;

    setIsFlashing(true);
    const timer = window.setTimeout(() => setIsFlashing(false), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [signature]);

  const hasFrame = frame.width > 0 && frame.height > 0;

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute left-3 top-3 z-[60] select-none rounded-md px-2.5 py-1.5 font-mono text-[11px] leading-tight tracking-tight transition-colors duration-200 ${
        isFlashing
          ? "bg-emerald-500/90 text-black"
          : "bg-black/70 text-white/85"
      }`}
    >
      <div className="font-semibold">
        deck {activeDeckId.toUpperCase()} · {activeQualityLabel ?? "—"}
      </div>
      <div className="opacity-80">
        decoded {hasFrame ? `${frame.width}×${frame.height}` : "—"}
      </div>
      <div className="opacity-60">id {activeQualityId ?? "—"}</div>
      {pendingQualityId ? (
        <div className="mt-0.5 text-amber-300">
          preparing {pendingQualityId}
        </div>
      ) : null}
    </div>
  );
}
