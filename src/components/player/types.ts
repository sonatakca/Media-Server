import type { PlaybackTechnicalDetails } from "../../hooks/usePlaybackSource";
import type { PlaybackQueue } from "../../lib/playbackQueue";
import type { JellyfinItem, PlaybackSourceCandidate } from "../../lib/types";

export interface CustomVideoPlayerProps {
  item: JellyfinItem;
  source: PlaybackSourceCandidate;
  playbackCandidates?: PlaybackSourceCandidate[];
  notice?: string | null;
  error?: PlaybackTechnicalDetails | null;
  hasTranscodingFallback: boolean;
  initialStartSeconds?: number;
  onVideoFailure: (details: string) => void;
  onTryTranscodedPlayback: () => void;
  onRetryPlayback: () => void;
  onPlaybackStarted?: (positionSeconds: number) => void;
  onPlaybackProgress?: (positionSeconds: number, isPaused: boolean) => void;
  onPlaybackStopped?: (positionSeconds: number) => void;
  onPlaybackBeforeUnload?: (positionSeconds: number) => void;
  nextEpisode?: JellyfinItem | null;
  playbackQueue?: PlaybackQueue | null;
  enableDefaultNextEpisodeCountdown?: boolean;
  onAutoPlayNextEpisode?: (nextEpisode: JellyfinItem) => void;
  onPlayQueueItem?: (item: JellyfinItem) => void;
}

export interface PendingSourceRestore {
  token: number;
  currentTime: number;
  wasPlaying: boolean;
}

export interface PendingAudioTranscodePlay {
  token: number;
  reason: string;
  wasPlaying: boolean;
  startedAt: number;
}

export interface SubtitlePosition {
  x: number;
  y: number;
}

export interface SubtitleDragState {
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

export interface SubtitleSize {
  scale: number;
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export type SeekFeedbackDirection = "backward" | "forward";
export type TouchSeekSide = "left" | "right";

export interface TouchSeekSessionState {
  lastTapTime: number;
  lastTapSide: TouchSeekSide | null;
  isActive: boolean;
  accumulatedSeconds: number;
  timeoutId: number | null;
}

export interface SeekFeedbackItem {
  amount: number;
  visible: boolean;
  pulse: number;
  spinPulse: number;
}

export interface SeekFeedbackState {
  backward: SeekFeedbackItem;
  forward: SeekFeedbackItem;
}

export interface SeekFeedbackSpinState {
  isSpinning: boolean;
  hasPendingSpin: boolean;
  finishTimerId: number | null;
}

export type PortraitPlayerRotation = -90 | 90;

export interface SubtitleResizeState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScale: number;
  directionX: -1 | 1;
  directionY: -1 | 1;
}

export interface NativeAudioTrack {
  enabled: boolean;
  id?: string;
  kind?: string;
  label?: string;
  language?: string;
}

export interface NativeAudioTrackList {
  readonly length: number;
  [index: number]: NativeAudioTrack | undefined;
}

export interface NativeAudioSyncResult {
  succeeded: boolean;
  streamIndex?: number;
  nativeTrackIndex?: number;
  reason: string;
}

export type VideoElementWithAudioTracks = HTMLVideoElement & {
  audioTracks?: NativeAudioTrackList;
};
