import { useEffect, useRef } from "react";
import { getPrimaryImageUrl } from "../../lib/mediaApi";
import type { MediaItem } from "../../lib/types";

/** The step the lock screen and headphone skip buttons move by. */
export const MEDIA_SESSION_SKIP_SECONDS = 10;

export interface MediaSessionMetadataInput {
  title: string;
  item: Pick<
    MediaItem,
    "Id" | "Type" | "SeriesId" | "SeriesName" | "ProductionYear" | "ImageTags"
  >;
}

/**
 * What the operating system shows for the title on the lock screen, in the
 * Now Playing widget and on a watch.
 *
 * An episode is shown under its series, with the series cover: an episode's
 * own still is a frame from the middle of it and reads as nothing at that size.
 */
export function describeMediaSessionMetadata({
  title,
  item,
}: MediaSessionMetadataInput): MediaMetadataInit {
  const isEpisode = item.Type === "Episode";
  const coverItemId = isEpisode && item.SeriesId ? item.SeriesId : item.Id;
  const coverTag = isEpisode ? undefined : item.ImageTags?.Primary;
  return {
    title,
    artist: isEpisode
      ? (item.SeriesName ?? "Seyirlik")
      : item.ProductionYear
        ? String(item.ProductionYear)
        : "Seyirlik",
    album: "Seyirlik",
    artwork: [
      {
        src: getPrimaryImageUrl(coverItemId, coverTag, 512),
        sizes: "512x768",
        type: "image/webp",
      },
    ],
  };
}

interface MediaSessionControlsOptions extends MediaSessionMetadataInput {
  /** A party owns the media keys while it runs; see `usePartyPlayback`. */
  enabled: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onTogglePlay: () => void;
  onSeekTo: (seconds: number) => void;
  onSeekBy: (seconds: number) => void;
  onNextTrack?: () => void;
}

function mediaSessionOf(): MediaSession | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.mediaSession;
}

/**
 * Lock screen, Control Center, Bluetooth headphones and keyboard media keys.
 *
 * Without this the operating system only knows "a video is playing on
 * seyirlik.org": no title, no artwork, and on iOS the skip buttons do nothing.
 */
export function useMediaSessionControls({
  enabled,
  title,
  item,
  isPlaying,
  currentTime,
  duration,
  onTogglePlay,
  onSeekTo,
  onSeekBy,
  onNextTrack,
}: MediaSessionControlsOptions): void {
  const actionsRef = useRef({ onTogglePlay, onSeekTo, onSeekBy, onNextTrack });
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    actionsRef.current = { onTogglePlay, onSeekTo, onSeekBy, onNextTrack };
    isPlayingRef.current = isPlaying;
  });
  const hasNextTrack = Boolean(onNextTrack);

  const { Id, Type, SeriesId, SeriesName, ProductionYear } = item;
  const primaryTag = item.ImageTags?.Primary;
  useEffect(() => {
    const mediaSession = mediaSessionOf();
    if (!mediaSession || typeof MediaMetadata === "undefined") return;
    mediaSession.metadata = new MediaMetadata(
      describeMediaSessionMetadata({
        title,
        item: {
          Id,
          Type,
          SeriesId,
          SeriesName,
          ProductionYear,
          ImageTags: primaryTag ? { Primary: primaryTag } : undefined,
        },
      }),
    );
  }, [Id, ProductionYear, SeriesId, SeriesName, Type, primaryTag, title]);

  useEffect(
    () => () => {
      const mediaSession = mediaSessionOf();
      if (!mediaSession) return;
      mediaSession.metadata = null;
      mediaSession.playbackState = "none";
    },
    [],
  );

  useEffect(() => {
    const mediaSession = mediaSessionOf();
    if (!mediaSession) return;
    mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  // Whole seconds are enough for a scrubber the size of a lock screen, and
  // keep this from running on every timeupdate.
  const wholeSecond = Math.floor(currentTime);
  useEffect(() => {
    const mediaSession = mediaSessionOf();
    if (!mediaSession?.setPositionState) return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      mediaSession.setPositionState({
        duration,
        // The player has no speed control; only a party catch-up nudges the
        // rate, and briefly.
        playbackRate: 1,
        position: Math.min(Math.max(0, wholeSecond), duration),
      });
    } catch {
      // Safari throws on a position past a duration it has not caught up to.
    }
  }, [duration, wholeSecond]);

  useEffect(() => {
    const mediaSession = mediaSessionOf();
    if (!enabled || !mediaSession) return undefined;

    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      [
        "play",
        () => !isPlayingRef.current && actionsRef.current.onTogglePlay(),
      ],
      [
        "pause",
        () => isPlayingRef.current && actionsRef.current.onTogglePlay(),
      ],
      [
        "seekto",
        (details) => {
          if (typeof details.seekTime === "number") {
            actionsRef.current.onSeekTo(details.seekTime);
          }
        },
      ],
      [
        "seekbackward",
        (details) =>
          actionsRef.current.onSeekBy(
            -(details.seekOffset ?? MEDIA_SESSION_SKIP_SECONDS),
          ),
      ],
      [
        "seekforward",
        (details) =>
          actionsRef.current.onSeekBy(
            details.seekOffset ?? MEDIA_SESSION_SKIP_SECONDS,
          ),
      ],
    ];
    if (hasNextTrack) {
      handlers.push(["nexttrack", () => actionsRef.current.onNextTrack?.()]);
    }

    for (const [action, handler] of handlers) {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // Not every browser supports every action.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          mediaSession.setActionHandler(action, null);
        } catch {
          // As above.
        }
      }
    };
  }, [enabled, hasNextTrack]);
}
