import { useEffect, useMemo, useState } from "react";
import { getMediaSegments } from "../lib/jellyfinApi";
import type { NormalizedMediaSegment } from "../lib/types";

interface MediaSegmentsState {
  segments: NormalizedMediaSegment[];
  isLoading: boolean;
  error: Error | null;
}

const initialState: MediaSegmentsState = {
  segments: [],
  isLoading: false,
  error: null,
};

export function useMediaSegments(itemId?: string, currentTime?: number) {
  const [state, setState] = useState<MediaSegmentsState>(initialState);

  useEffect(() => {
    if (!itemId) {
      setState(initialState);
      return undefined;
    }

    let isStale = false;

    setState({
      segments: [],
      isLoading: true,
      error: null,
    });

    const loadSegments = async () => {
      try {
        const segments = await getMediaSegments(itemId);

        if (!isStale) {
          setState({
            segments,
            isLoading: false,
            error: null,
          });
        }
      } catch (error) {
        if (!isStale) {
          setState({
            segments: [],
            isLoading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    };

    void loadSegments();

    return () => {
      isStale = true;
    };
  }, [itemId]);

  const activeSegment = useMemo(() => {
    if (currentTime === undefined || !Number.isFinite(currentTime)) {
      return null;
    }

    return (
      state.segments.find(
        (segment) =>
          currentTime >= segment.startSeconds &&
          currentTime < segment.endSeconds,
      ) ?? null
    );
  }, [currentTime, state.segments]);

  const upcomingSegment = useMemo(() => {
    if (state.segments.length === 0) {
      return null;
    }

    if (currentTime === undefined || !Number.isFinite(currentTime)) {
      return state.segments[0] ?? null;
    }

    return (
      state.segments.find((segment) => segment.startSeconds > currentTime) ??
      null
    );
  }, [currentTime, state.segments]);

  return {
    ...state,
    activeSegment,
    upcomingSegment,
  };
}
