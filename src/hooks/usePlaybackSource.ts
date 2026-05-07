import { useCallback, useEffect, useMemo, useState } from "react";
import { buildPlaybackCandidates, getPlaybackInfo, redactPlaybackUrl } from "../lib/jellyfinApi";
import type { PlaybackSourceCandidate } from "../lib/types";

export interface PlaybackTechnicalDetails {
  message: string;
  details: string;
}

interface PlaybackSourceState {
  isLoading: boolean;
  activeSource: PlaybackSourceCandidate | null;
  candidates: PlaybackSourceCandidate[];
  notice: string | null;
  error: PlaybackTechnicalDetails | null;
}

const initialState: PlaybackSourceState = {
  isLoading: true,
  activeSource: null,
  candidates: [],
  notice: null,
  error: null,
};

function getSourceSummary(source: PlaybackSourceCandidate): Record<string, unknown> {
  const videoStream = source.mediaSource.MediaStreams?.find((stream) => stream.Type?.toLowerCase() === "video");
  const audioStream = source.mediaSource.MediaStreams?.find((stream) => stream.Type?.toLowerCase() === "audio");

  return {
    mode: source.mode,
    reason: source.reason,
    mediaSourceId: source.mediaSourceId,
    container: source.mediaSource.Container,
    transcodingSubProtocol: source.mediaSource.TranscodingSubProtocol,
    transcodingContainer: source.mediaSource.TranscodingContainer,
    supportsDirectPlay: source.mediaSource.SupportsDirectPlay,
    supportsDirectStream: source.mediaSource.SupportsDirectStream,
    supportsTranscoding: source.mediaSource.SupportsTranscoding,
    videoCodec: videoStream?.Codec,
    audioCodec: audioStream?.Codec,
    url: redactPlaybackUrl(source.url),
  };
}

function getVideoErrorName(code?: number): string {
  switch (code) {
    case 1:
      return "MEDIA_ERR_ABORTED";
    case 2:
      return "MEDIA_ERR_NETWORK";
    case 3:
      return "MEDIA_ERR_DECODE";
    case 4:
      return "MEDIA_ERR_SRC_NOT_SUPPORTED";
    default:
      return "UNKNOWN_MEDIA_ERROR";
  }
}

export function getVideoErrorDetails(video: HTMLVideoElement, source: PlaybackSourceCandidate | null): string {
  const error = video.error;
  const payload = {
    videoErrorCode: error?.code,
    videoErrorName: getVideoErrorName(error?.code),
    videoErrorMessage: error?.message,
    networkState: video.networkState,
    readyState: video.readyState,
    currentSrc: video.currentSrc ? redactPlaybackUrl(video.currentSrc) : undefined,
    selectedSource: source ? getSourceSummary(source) : undefined,
  };

  return JSON.stringify(payload, null, 2);
}

export function usePlaybackSource(itemId?: string) {
  const [state, setState] = useState<PlaybackSourceState>(initialState);
  const [sourceIndex, setSourceIndex] = useState(0);
  const activeSource = state.candidates[sourceIndex] ?? null;

  const loadPlaybackInfo = useCallback(async () => {
    if (!itemId) {
      setState({
        ...initialState,
        isLoading: false,
        error: {
          message: "Missing item id.",
          details: "The player route did not receive a Jellyfin item id.",
        },
      });
      return;
    }

    setState(initialState);
    setSourceIndex(0);

    try {
      const playbackInfo = await getPlaybackInfo(itemId);
      const candidates = buildPlaybackCandidates(itemId, playbackInfo);

      console.info("[Seyirlik Playback] PlaybackInfo received", {
        playSessionId: playbackInfo.PlaySessionId,
        mediaSources: playbackInfo.MediaSources?.length ?? 0,
        errorCode: playbackInfo.ErrorCode,
      });

      if (candidates.length === 0) {
        setState({
          isLoading: false,
          activeSource: null,
          candidates: [],
          notice: null,
          error: {
            message: "Playback failed. Jellyfin did not return a playable source.",
            details: JSON.stringify(playbackInfo, null, 2),
          },
        });
        return;
      }

      setState({
        isLoading: false,
        activeSource: candidates[0],
        candidates,
        notice: null,
        error: null,
      });
    } catch (error) {
      setState({
        isLoading: false,
        activeSource: null,
        candidates: [],
        notice: null,
        error: {
          message: "Playback failed while asking Jellyfin for PlaybackInfo.",
          details: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }, [itemId]);

  useEffect(() => {
    void loadPlaybackInfo();
  }, [loadPlaybackInfo]);

  useEffect(() => {
    if (!activeSource) {
      return;
    }

    console.info("[Seyirlik Playback] Selected MediaSource", getSourceSummary(activeSource));
    setState((currentState) => ({ ...currentState, activeSource }));
  }, [activeSource]);

  const switchToSource = useCallback(
    (nextIndex: number, notice: string) => {
      setSourceIndex(nextIndex);
      setState((currentState) => ({
        ...currentState,
        notice,
        error: null,
      }));
    },
    [],
  );

  const tryTranscodedPlayback = useCallback(() => {
    const transcodingIndex = state.candidates.findIndex(
      (candidate, index) => index !== sourceIndex && candidate.mode === "Transcoding",
    );

    if (transcodingIndex >= 0) {
      switchToSource(transcodingIndex, "Trying Jellyfin transcoded playback.");
    }
  }, [sourceIndex, state.candidates, switchToSource]);

  const handleVideoFailure = useCallback(
    (technicalDetails: string) => {
      const currentSource = state.candidates[sourceIndex] ?? null;
      const transcodeFallbackIndex = state.candidates.findIndex(
        (candidate, index) => index > sourceIndex && candidate.mode === "Transcoding",
      );

      if (currentSource?.mode !== "Transcoding" && transcodeFallbackIndex >= 0) {
        switchToSource(
          transcodeFallbackIndex,
          "This file could not be played directly. Trying Jellyfin transcoding...",
        );
        return;
      }

      const nextIndex = state.candidates.findIndex((_, index) => index > sourceIndex);

      if (nextIndex >= 0) {
        switchToSource(nextIndex, "Trying another Jellyfin playback source...");
        return;
      }

      setState((currentState) => ({
        ...currentState,
        notice: null,
        error: {
          message: "Playback failed. This may be a codec, CORS, token, or transcoding issue.",
          details: technicalDetails,
        },
      }));
    },
    [sourceIndex, state.candidates, switchToSource],
  );

  const hasTranscodingFallback = useMemo(
    () => state.candidates.some((candidate, index) => index !== sourceIndex && candidate.mode === "Transcoding"),
    [sourceIndex, state.candidates],
  );

  return {
    ...state,
    activeSource,
    retry: loadPlaybackInfo,
    handleVideoFailure,
    tryTranscodedPlayback,
    hasTranscodingFallback,
  };
}
