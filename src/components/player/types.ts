import type { PlaybackTechnicalDetails } from "../../hooks/usePlaybackSource";
import type { PlaybackQueue } from "../../lib/playbackQueue";
import type {
  MediaItem,
  PlaybackQualityOption,
  PlaybackSourceCandidate,
} from "../../lib/types";
import type { QualityPreferenceMode } from "../../renditions/contracts";

export type AutomaticQualityMode = Exclude<QualityPreferenceMode, "advanced">;

/**
 * Describes the complete-file quality controls the player exposes when a media
 * item has a validated rendition manifest. Every entry is backed by a file that
 * already exists, so selecting one can never start an encode.
 */
export interface CompleteFileQualityControls {
  /** Active top-level mode: `low-data`, `auto`, `higher-resolution` or `advanced`. */
  activeMode: QualityPreferenceMode;
  /** Resolution of the file that is actually playing, for example `1080p`. */
  effectiveQualityLabel?: string;
  /** Effective resolution for each automatic mode, keyed by mode. */
  modeQualityLabels: Partial<Record<AutomaticQualityMode, string>>;
  /** Every quality the Advanced list may lock onto, lowest first. */
  advancedOptions: PlaybackQualityOption[];
  /** Identifier of the quality Advanced is currently locked to, when locked. */
  lockedQualityId?: string;
  /** The rendition a switch is currently preparing, if any. */
  preparingQualityId?: string;
  limitationsText?: string;
  noticeText?: string;
  onSelectMode: (mode: AutomaticQualityMode) => void;
  onSelectAdvancedQuality: (qualityId: string) => void;
}

export interface CustomVideoPlayerProps {
  item: MediaItem;
  source: PlaybackSourceCandidate;
  playbackCandidates?: PlaybackSourceCandidate[];
  notice?: string | null;
  error?: PlaybackTechnicalDetails | null;
  hasTranscodingFallback: boolean;
  initialStartSeconds?: number;
  onVideoFailure: (details: string) => void;
  onVideoRecovery: () => void;
  onTryTranscodedPlayback: () => void;
  onRetryPlayback: () => void;
  onPlaybackStarted?: (positionSeconds: number) => void;
  onPlaybackProgress?: (positionSeconds: number, isPaused: boolean) => void;
  onPlaybackStopped?: (positionSeconds: number) => void;
  onPlaybackBeforeUnload?: (positionSeconds: number) => void;
  onPreparingPlaybackChange?: (isPreparing: boolean) => void;
  nextEpisode?: MediaItem | null;
  playbackQueue?: PlaybackQueue | null;
  enableDefaultNextEpisodeCountdown?: boolean;
  onAutoPlayNextEpisode?: (nextEpisode: MediaItem) => void;
  onPlayQueueItem?: (item: MediaItem) => void;
  preparingBackdropUrl?: string | null;
  showPreparingArtwork?: boolean;
  backTo?: string;
}

export interface PendingSourceRestore {
  token: number;
  currentTime: number;
  wasPlaying: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex: number;
}

export interface PendingAudioTranscodePlay {
  token: number;
  attemptId: number;
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
