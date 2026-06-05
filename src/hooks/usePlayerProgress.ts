import { RefObject, useCallback, useEffect, useState } from "react";

export interface PlayerProgressState {
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  isPlaying: boolean;
  isBuffering: boolean;
  volume: number;
  muted: boolean;
}

const initialState: PlayerProgressState = {
  currentTime: 0,
  duration: 0,
  bufferedEnd: 0,
  isPlaying: false,
  isBuffering: true,
  volume: 1,
  muted: false,
};

const PLAYER_VOLUME_STORAGE_KEY = "seyirlik.playerVolume";

function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, volume));
}

function getStoredVolumeState(): Pick<PlayerProgressState, "volume" | "muted"> {
  if (typeof window === "undefined") {
    return { volume: 1, muted: false };
  }

  try {
    const rawValue = window.localStorage.getItem(PLAYER_VOLUME_STORAGE_KEY);

    if (!rawValue) {
      return { volume: 1, muted: false };
    }

    const parsedValue = JSON.parse(rawValue) as {
      volume?: unknown;
      muted?: unknown;
    };
    const volume =
      typeof parsedValue.volume === "number" &&
      Number.isFinite(parsedValue.volume)
        ? clampVolume(parsedValue.volume)
        : 1;
    const muted =
      typeof parsedValue.muted === "boolean" ? parsedValue.muted : false;

    return { volume, muted };
  } catch {
    return { volume: 1, muted: false };
  }
}

function saveStoredVolumeState(volume: number, muted: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      PLAYER_VOLUME_STORAGE_KEY,
      JSON.stringify({ volume: clampVolume(volume), muted }),
    );
  } catch {
    // Ignore storage failures; playback should continue normally.
  }
}

export function usePlayerProgress(videoRef: RefObject<HTMLVideoElement>) {
  const [state, setState] = useState<PlayerProgressState>(() => ({
    ...initialState,
    ...getStoredVolumeState(),
  }));

  const readVideoState = useCallback(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const bufferedEnd =
      video.buffered.length > 0
        ? video.buffered.end(video.buffered.length - 1)
        : 0;

    setState({
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      bufferedEnd,
      isPlaying: !video.paused && !video.ended,
      isBuffering: video.readyState < 3 && !video.paused,
      volume: video.volume,
      muted: video.muted,
    });
  }, [videoRef]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    const markBuffering = () => {
      setState((currentState) => ({ ...currentState, isBuffering: true }));
    };

    const markReady = () => {
      readVideoState();
      setState((currentState) => ({ ...currentState, isBuffering: false }));
    };
    const handleVolumeChange = () => {
      saveStoredVolumeState(video.volume, video.muted);
      readVideoState();
    };

    const events: Array<keyof HTMLMediaElementEventMap> = [
      "durationchange",
      "loadedmetadata",
      "play",
      "pause",
      "progress",
      "timeupdate",
      "volumechange",
      "waiting",
      "canplay",
      "playing",
      "ended",
    ];

    const storedVolumeState = getStoredVolumeState();
    video.volume = storedVolumeState.volume;
    video.muted = storedVolumeState.muted;

    events.forEach((eventName) => {
      video.addEventListener(
        eventName,
        eventName === "waiting"
          ? markBuffering
          : eventName === "volumechange"
            ? handleVolumeChange
            : readVideoState,
      );
    });
    video.addEventListener("canplay", markReady);
    video.addEventListener("playing", markReady);

    readVideoState();

    return () => {
      events.forEach((eventName) => {
        video.removeEventListener(
          eventName,
          eventName === "waiting"
            ? markBuffering
            : eventName === "volumechange"
              ? handleVolumeChange
              : readVideoState,
        );
      });
      video.removeEventListener("canplay", markReady);
      video.removeEventListener("playing", markReady);
    };
  }, [readVideoState, videoRef]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (video.paused) {
      void video.play().catch((error: unknown) => {
        console.warn(
          "[Seyirlik Playback] video.play() was blocked or failed",
          error,
        );
      });
    } else {
      video.pause();
    }
  }, [videoRef]);

  const seekTo = useCallback(
    (seconds: number) => {
      const video = videoRef.current;

      if (!video || !Number.isFinite(video.duration)) {
        return;
      }

      video.currentTime = Math.min(video.duration, Math.max(0, seconds));
      readVideoState();
    },
    [readVideoState, videoRef],
  );

  const seekBy = useCallback(
    (seconds: number) => {
      const video = videoRef.current;

      if (!video) {
        return;
      }

      seekTo(video.currentTime + seconds);
    },
    [seekTo, videoRef],
  );

  const setVolume = useCallback(
    (volume: number) => {
      const video = videoRef.current;

      if (!video) {
        return;
      }

      const nextVolume = clampVolume(volume);

      video.volume = nextVolume;
      video.muted = nextVolume === 0;
      saveStoredVolumeState(video.volume, video.muted);
      readVideoState();
    },
    [readVideoState, videoRef],
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    video.muted = !video.muted;
    saveStoredVolumeState(video.volume, video.muted);
    readVideoState();
  }, [readVideoState, videoRef]);

  return {
    ...state,
    togglePlay,
    seekTo,
    seekBy,
    setVolume,
    toggleMute,
    refresh: readVideoState,
  };
}
