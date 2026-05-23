import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildPlaybackCandidates,
  getPlaybackInfo,
  redactPlaybackUrl,
} from "../lib/jellyfinApi";
import type { PlaybackSourceCandidate } from "../lib/types";
import { useLanguage } from "../i18n/LanguageContext";

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

function getSourceSummary(
  source: PlaybackSourceCandidate,
): Record<string, unknown> {
  const videoStream = source.mediaSource.MediaStreams?.find(
    (stream) => stream.Type?.toLowerCase() === "video",
  );
  const audioStream = source.mediaSource.MediaStreams?.find(
    (stream) => stream.Type?.toLowerCase() === "audio",
  );

  return {
    mode: source.mode,
    isHls: source.isHls,
    hlsKind: source.hlsKind,
    priority: source.priority,
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

export function getVideoErrorDetails(
  video: HTMLVideoElement,
  source: PlaybackSourceCandidate | null,
): string {
  const error = video.error;
  const payload = {
    videoErrorCode: error?.code,
    videoErrorName: getVideoErrorName(error?.code),
    videoErrorMessage: error?.message,
    networkState: video.networkState,
    readyState: video.readyState,
    currentSrc: video.currentSrc
      ? redactPlaybackUrl(video.currentSrc)
      : undefined,
    selectedSource: source ? getSourceSummary(source) : undefined,
  };

  return JSON.stringify(payload, null, 2);
}

export function usePlaybackSource(itemId?: string) {
  const { t } = useLanguage();
  const [state, setState] = useState<PlaybackSourceState>(initialState);
  const [sourceIndex, setSourceIndex] = useState(0);
  const activeSource = state.candidates[sourceIndex] ?? null;

  const loadPlaybackInfo = useCallback(async () => {
    if (!itemId) {
      setState({
        ...initialState,
        isLoading: false,
        error: {
          message: t("player.missingItemId"),
          details: t("player.missingRouteItemId"),
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
            message: t("player.noPlayableSource"),
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
          message: t("player.playbackInfoRequestFailed"),
          details: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }, [itemId, t]);

  useEffect(() => {
    void loadPlaybackInfo();
  }, [loadPlaybackInfo]);

  useEffect(() => {
    if (!activeSource) {
      return;
    }

    console.info(
      "[Seyirlik Playback] Selected MediaSource",
      getSourceSummary(activeSource),
    );
    setState((currentState) => ({ ...currentState, activeSource }));
  }, [activeSource]);

  const switchToSource = useCallback((nextIndex: number) => {
    setSourceIndex(nextIndex);
    setState((currentState) => ({
      ...currentState,
      notice: null,
      error: null,
    }));
  }, []);

  const tryTranscodedPlayback = useCallback(() => {
    const transcodingIndex = state.candidates.findIndex(
      (candidate, index) =>
        index !== sourceIndex && candidate.mode === "Transcoding",
    );

    if (transcodingIndex >= 0) {
      switchToSource(transcodingIndex);
    }
  }, [sourceIndex, state.candidates, switchToSource]);

  const handleVideoFailure = useCallback(
    (technicalDetails: string) => {
      const currentSource = state.candidates[sourceIndex] ?? null;
      const detailsLower = technicalDetails.toLowerCase();
      const looksLikeHlsSegmentFailure =
        detailsLower.includes("500") ||
        detailsLower.includes(".ts") ||
        detailsLower.includes("segment") ||
        detailsLower.includes("startup watchdog");
      let nextIndex = -1;

      if (
        currentSource?.hlsKind === "stream-copy" ||
        looksLikeHlsSegmentFailure
      ) {
        nextIndex = state.candidates.findIndex(
          (candidate, index) =>
            index > sourceIndex &&
            (candidate.hlsKind === "jellyfin-transcoding-url" ||
              candidate.hlsKind === "forced-transcode"),
        );
      }

      if (nextIndex < 0) {
        nextIndex = state.candidates.findIndex(
          (_, index) => index > sourceIndex,
        );
      }

      if (nextIndex >= 0) {
        const nextSource = state.candidates[nextIndex] ?? null;

        console.info("[Seyirlik Playback] Switching to fallback candidate", {
          failedIndex: sourceIndex,
          nextIndex,
          failedSource: currentSource
            ? getSourceSummary(currentSource)
            : undefined,
          nextSource: nextSource ? getSourceSummary(nextSource) : undefined,
        });
        switchToSource(nextIndex);
        return;
      }

      setState((currentState) => ({
        ...currentState,
        notice: null,
        error: {
          message: t("player.playbackFailurePossibleCauses"),
          details: technicalDetails,
        },
      }));
    },
    [sourceIndex, state.candidates, switchToSource, t],
  );

  const hasTranscodingFallback = useMemo(
    () =>
      state.candidates.some(
        (candidate, index) =>
          index !== sourceIndex && candidate.mode === "Transcoding",
      ),
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
