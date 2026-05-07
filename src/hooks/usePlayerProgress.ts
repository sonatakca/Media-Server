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

export function usePlayerProgress(videoRef: RefObject<HTMLVideoElement>) {
  const [state, setState] = useState<PlayerProgressState>(initialState);

  const readVideoState = useCallback(() => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const bufferedEnd = video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0;

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

    events.forEach((eventName) => {
      video.addEventListener(eventName, eventName === "waiting" ? markBuffering : readVideoState);
    });
    video.addEventListener("canplay", markReady);
    video.addEventListener("playing", markReady);

    readVideoState();

    return () => {
      events.forEach((eventName) => {
        video.removeEventListener(eventName, eventName === "waiting" ? markBuffering : readVideoState);
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
        console.warn("[Seyirlik Playback] video.play() was blocked or failed", error);
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

      video.volume = Math.min(1, Math.max(0, volume));
      video.muted = volume === 0;
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
