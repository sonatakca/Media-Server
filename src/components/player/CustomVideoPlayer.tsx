import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Bookmark, ChevronsRight, Eye, EyeOff, Users, X } from "lucide-react";
import {
  buildConfiguredHlsPlaybackSource,
  buildSubtitleStreamUrl,
  getLogoImageUrl,
  getPrimaryImageUrl,
  getManualQualityOptions,
  getTrickplayImageUrl,
  getActiveTranscodingReasons,
  redactPlaybackUrl,
  stopActiveTranscodeSession,
} from "../../lib/jellyfinApi";
import { attachSourceToVideo } from "../../lib/videoSource";
import type { AttachedVideoSource } from "../../lib/videoSource";
import { getDisplayTitle, getItemSubtitle } from "../../lib/format";
import {
  getDefaultAudioStreamIndexForSource,
  getDefaultSubtitleStreamIndexForSource,
} from "../../lib/playbackDefaults";
import {
  getVideoErrorDetails,
  type PlaybackTechnicalDetails,
} from "../../hooks/usePlaybackSource";
import { useAutoHideControls } from "../../hooks/useAutoHideControls";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useMediaSegments } from "../../hooks/useMediaSegments";
import { usePlayerProgress } from "../../hooks/usePlayerProgress";
import { useViewportCapabilities } from "../../hooks/useViewportCapabilities";
import { useLanguage } from "../../i18n/LanguageContext";
import type {
  JellyfinItem,
  JellyfinMediaStream,
  NormalizedMediaSegment,
  PlaybackQualityOption,
  PlaybackSourceCandidate,
  PlaybackSourceSettings,
} from "../../lib/types";
import type { TranslationKey } from "../../i18n/translations";
import { PlayerControls } from "./PlayerControls";
import { PlayerErrorOverlay } from "./PlayerErrorOverlay";
import { PlayerOverlay } from "./PlayerOverlay";
import { PlaybackInfoButton } from "./PlaybackInfoButton";
import { PlaybackInfoPanel } from "./PlaybackInfoPanel";
import { PartyWatchControls } from "../../features/partyWatch/PartyWatchControls";
import { PartyWatchOverlay } from "../../features/partyWatch/PartyWatchOverlay";
import { usePartyWatchController } from "../../features/partyWatch/usePartyWatchController";
import { Tooltip } from "../ui/Tooltip";

interface CustomVideoPlayerProps {
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
  enableDefaultNextEpisodeCountdown?: boolean;
  onAutoPlayNextEpisode?: (nextEpisode: JellyfinItem) => void;
}

interface PendingSourceRestore {
  token: number;
  currentTime: number;
  wasPlaying: boolean;
}

interface PendingAudioTranscodePlay {
  token: number;
  reason: string;
  wasPlaying: boolean;
  startedAt: number;
}

interface SubtitlePosition {
  x: number;
  y: number;
}

interface SubtitleDragState {
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

interface SubtitleSize {
  scale: number;
}

interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

type SeekFeedbackDirection = "backward" | "forward";
type TouchSeekSide = "left" | "right";

interface TouchSeekSessionState {
  lastTapTime: number;
  lastTapSide: TouchSeekSide | null;
  isActive: boolean;
  accumulatedSeconds: number;
  timeoutId: number | null;
}

interface SeekFeedbackItem {
  amount: number;
  visible: boolean;
  pulse: number;
  spinPulse: number;
}

interface SeekFeedbackState {
  backward: SeekFeedbackItem;
  forward: SeekFeedbackItem;
}

interface SeekFeedbackSpinState {
  isSpinning: boolean;
  hasPendingSpin: boolean;
  finishTimerId: number | null;
}

type PortraitPlayerRotation = -90 | 90;

function readPortraitPlayerRotation(): PortraitPlayerRotation {
  if (typeof window === "undefined") {
    return 90;
  }

  const deprecatedWindowOrientation = (
    window as Window & { orientation?: number }
  ).orientation;
  const orientationAngle =
    window.screen.orientation?.angle ?? deprecatedWindowOrientation ?? 0;

  return Math.abs(orientationAngle) === 180 ? -90 : 90;
}

interface SubtitleResizeState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScale: number;
  directionX: -1 | 1;
  directionY: -1 | 1;
}

const AUTO_QUALITY_ID = "auto";
const DEFAULT_SUBTITLE_SCALE = 1;
const MIN_SUBTITLE_SCALE = 0.7;
const MAX_SUBTITLE_SCALE = 2.4;

const TRICKPLAY_RESOLUTION = 320;
const TRICKPLAY_INTERVAL_SECONDS = 10;
const TRICKPLAY_COLUMNS = 10;
const TRICKPLAY_ROWS = 10;
const TRICKPLAY_IMAGES_PER_SHEET = TRICKPLAY_COLUMNS * TRICKPLAY_ROWS;
const TRICKPLAY_TILE_WIDTH = 320;
const TRICKPLAY_TILE_HEIGHT = 132;

const SEEK_FEEDBACK_OPPOSITE_HIDE_MS = 100;

const SEEK_FEEDBACK_HIDE_MS = 950;

const SEEK_FEEDBACK_FADE_RESET_MS = 260;

const SEEK_FEEDBACK_SPIN_MS = 1000;

const STARTUP_WATCHDOG_MS = 8000;

const VIEW_MODE_CURSOR_HIDE_MS = 1600;

const TOUCH_DOUBLE_TAP_THRESHOLD_MS = 320;
const TOUCH_SINGLE_TAP_DELAY_MS = 180;
const TOUCH_SEEK_SESSION_TIMEOUT_MS = 850;

const DEFAULT_NEXT_EPISODE_COUNTDOWN_SECONDS = 10;

const SKIPPABLE_SEGMENT_TYPES = new Set(["intro", "recap", "outro"]);

const PARTY_WATCH_DOT_POSITIONS = [
  "right-[0.5rem] top-[0.42rem]",
  "right-[0.15rem] top-[1.25rem]",
  "right-[0.5rem] top-[2.08rem]",
  "left-[0.5rem] top-[0.42rem]",
  "left-[0.5rem] top-[2.08rem]",
  "left-[0.15rem] top-[1.25rem]",
] as const;

const initialSeekFeedback: SeekFeedbackState = {
  backward: {
    amount: 0,
    visible: false,
    pulse: 0,
    spinPulse: 0,
  },
  forward: {
    amount: 0,
    visible: false,
    pulse: 0,
    spinPulse: 0,
  },
};

function getStreamsOfType(
  source: PlaybackSourceCandidate,
  type: "Audio" | "Subtitle",
): JellyfinMediaStream[] {
  return (
    source.mediaSource.MediaStreams?.filter(
      (stream) => stream.Type?.toLowerCase() === type.toLowerCase(),
    ) ?? []
  );
}

function getDefaultAudioStreamIndex(
  item: JellyfinItem,
  source: PlaybackSourceCandidate,
): number | undefined {
  return getDefaultAudioStreamIndexForSource(item, source);
}

function getMediaSourceDefaultAudioStreamIndex(
  source: PlaybackSourceCandidate,
): number | undefined {
  const audioStreams = getStreamsOfType(source, "Audio");

  return (
    source.mediaSource.DefaultAudioStreamIndex ??
    audioStreams.find((stream) => stream.IsDefault)?.Index ??
    audioStreams[0]?.Index
  );
}

interface NativeAudioTrack {
  enabled: boolean;
  id?: string;
  kind?: string;
  label?: string;
  language?: string;
}

interface NativeAudioTrackList {
  readonly length: number;
  [index: number]: NativeAudioTrack | undefined;
}

interface NativeAudioSyncResult {
  succeeded: boolean;
  streamIndex?: number;
  nativeTrackIndex?: number;
  reason: string;
}

type VideoElementWithAudioTracks = HTMLVideoElement & {
  audioTracks?: NativeAudioTrackList;
};

function isDirectBrowserPlaybackSource(
  source: PlaybackSourceCandidate,
): boolean {
  return (
    !source.isHls &&
    (source.mode === "DirectPlay" || source.mode === "DirectStream")
  );
}

function isAudioTranscodeSource(source: PlaybackSourceCandidate): boolean {
  return source.isHls && source.hlsKind === "audio-transcode";
}

function hasUsefulBufferedRangeAroundCurrentTime(
  video: HTMLVideoElement,
  minAheadSeconds = 1.2,
): boolean {
  const currentTime = Number.isFinite(video.currentTime)
    ? video.currentTime
    : 0;

  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);

    if (
      currentTime >= start - 0.25 &&
      currentTime <= end &&
      end - currentTime >= minAheadSeconds
    ) {
      return true;
    }
  }

  return false;
}

function isVideoReadyForAudioTranscodePlayback(
  video: HTMLVideoElement,
): boolean {
  return (
    video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
    hasUsefulBufferedRangeAroundCurrentTime(video, 1.2)
  );
}

function getAudioTracks(
  video: HTMLVideoElement,
): NativeAudioTrackList | undefined {
  return (video as VideoElementWithAudioTracks).audioTracks;
}

function getNativeAudioTrackSnapshot(video: HTMLVideoElement) {
  const audioTracks = getAudioTracks(video);

  return {
    length: audioTracks?.length ?? 0,
    tracks: Array.from({ length: audioTracks?.length ?? 0 }, (_, index) => {
      const track = audioTracks?.[index];

      return {
        index,
        id: track?.id,
        kind: track?.kind,
        label: track?.label,
        language: track?.language,
        enabled: track?.enabled,
      };
    }),
  };
}

function normalizeMatchText(value?: string): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeLanguage(value?: string): string {
  const normalized = normalizeMatchText(value).split(" ")[0] ?? "";
  const languageAliases: Record<string, string> = {
    en: "en",
    eng: "en",
    english: "en",
    es: "es",
    spa: "es",
    esp: "es",
    spanish: "es",
    castellano: "es",
    castilian: "es",
    fr: "fr",
    fra: "fr",
    fre: "fr",
    french: "fr",
    de: "de",
    deu: "de",
    ger: "de",
    german: "de",
    it: "it",
    ita: "it",
    italian: "it",
    pt: "pt",
    por: "pt",
    portuguese: "pt",
    ja: "ja",
    jpn: "ja",
    japanese: "ja",
  };

  return languageAliases[normalized] ?? normalized;
}

function getStreamMatchText(stream: JellyfinMediaStream): string {
  return [stream.Language, stream.DisplayTitle, stream.Title, stream.Codec]
    .map(normalizeMatchText)
    .filter(Boolean)
    .join(" ");
}

function getTrackMatchText(track: NativeAudioTrack): string {
  return [track.language, track.label, track.id, track.kind]
    .map(normalizeMatchText)
    .filter(Boolean)
    .join(" ");
}

function getNativeAudioTrackMatch(
  source: PlaybackSourceCandidate,
  streamIndex: number,
  audioTracks: NativeAudioTrackList,
): { nativeTrackIndex: number; reason: string } | null {
  const audioStreams = getStreamsOfType(source, "Audio");
  const jellyfinStream = audioStreams.find(
    (stream) => stream.Index === streamIndex,
  );

  if (!jellyfinStream) {
    return null;
  }

  const streamLanguage = normalizeLanguage(jellyfinStream.Language);

  if (streamLanguage) {
    for (let index = 0; index < audioTracks.length; index += 1) {
      const track = audioTracks[index];
      const trackLanguage = normalizeLanguage(track?.language);

      if (track && trackLanguage && trackLanguage === streamLanguage) {
        return { nativeTrackIndex: index, reason: "language" };
      }
    }
  }

  const streamText = getStreamMatchText(jellyfinStream);

  if (streamText.length > 1) {
    for (let index = 0; index < audioTracks.length; index += 1) {
      const track = audioTracks[index];

      if (!track) {
        continue;
      }

      const trackText = getTrackMatchText(track);

      if (
        trackText.length > 1 &&
        (trackText.includes(streamText) || streamText.includes(trackText))
      ) {
        return { nativeTrackIndex: index, reason: "label" };
      }
    }
  }

  const jellyfinOrdinal = audioStreams.findIndex(
    (stream) => stream.Index === streamIndex,
  );

  if (
    audioStreams.length === 2 &&
    audioTracks.length === 2 &&
    jellyfinOrdinal >= 0
  ) {
    return { nativeTrackIndex: jellyfinOrdinal, reason: "two-track-order" };
  }

  return null;
}

function getNativeActiveAudioStreamIndex(
  video: HTMLVideoElement,
  source: PlaybackSourceCandidate,
): number | undefined {
  const audioTracks = getAudioTracks(video);

  if (!audioTracks || audioTracks.length === 0) {
    return undefined;
  }

  for (let index = 0; index < audioTracks.length; index += 1) {
    const track = audioTracks[index];

    if (!track?.enabled) {
      continue;
    }

    const audioStreams = getStreamsOfType(source, "Audio");

    for (const stream of audioStreams) {
      if (stream.Index === undefined) {
        continue;
      }

      const match = getNativeAudioTrackMatch(source, stream.Index, audioTracks);

      if (match?.nativeTrackIndex === index) {
        return stream.Index;
      }
    }

    return undefined;
  }

  return undefined;
}

function tryApplyNativeAudioTrack(
  video: HTMLVideoElement,
  source: PlaybackSourceCandidate,
  streamIndex: number | undefined,
): NativeAudioSyncResult {
  const audioTracks = getAudioTracks(video);

  if (!audioTracks || audioTracks.length === 0) {
    return { succeeded: false, reason: "native-audio-tracks-unavailable" };
  }

  if (streamIndex === undefined) {
    return { succeeded: false, reason: "stream-index-missing" };
  }

  const match = getNativeAudioTrackMatch(source, streamIndex, audioTracks);

  if (!match) {
    return {
      succeeded: false,
      streamIndex,
      reason: "native-track-match-not-found",
    };
  }

  for (let index = 0; index < audioTracks.length; index += 1) {
    const track = audioTracks[index];

    if (track) {
      track.enabled = index === match.nativeTrackIndex;
    }
  }

  const enabledTrack = audioTracks[match.nativeTrackIndex];

  if (!enabledTrack?.enabled) {
    return {
      succeeded: false,
      streamIndex,
      nativeTrackIndex: match.nativeTrackIndex,
      reason: "native-track-enable-failed",
    };
  }

  return {
    succeeded: true,
    streamIndex,
    nativeTrackIndex: match.nativeTrackIndex,
    reason: match.reason,
  };
}

function getDebugAudioStreams(source: PlaybackSourceCandidate) {
  return getStreamsOfType(source, "Audio").map((stream) => ({
    Index: stream.Index,
    Language: stream.Language,
    DisplayTitle: stream.DisplayTitle,
    Title: stream.Title,
    Codec: stream.Codec,
    IsDefault: stream.IsDefault,
  }));
}

function getPlaybackUrlDebugParams(playbackUrl: string) {
  try {
    const url = new URL(playbackUrl);
    const getParam = (name: string) =>
      url.searchParams.get(name) ?? url.searchParams.get(name.toLowerCase());

    return {
      redactedUrl: redactPlaybackUrl(playbackUrl),
      SegmentContainer: getParam("SegmentContainer"),
      TranscodingContainer: getParam("TranscodingContainer"),
      TranscodingProtocol: getParam("TranscodingProtocol"),
      PlaySessionId: getParam("PlaySessionId"),
      MediaSourceId: getParam("MediaSourceId"),
      DeviceId: getParam("DeviceId"),
      VideoCodec: getParam("VideoCodec"),
      AudioCodec: getParam("AudioCodec"),
      AllowVideoStreamCopy: getParam("AllowVideoStreamCopy"),
      AllowAudioStreamCopy: getParam("AllowAudioStreamCopy"),
      EnableAutoStreamCopy: getParam("EnableAutoStreamCopy"),
      EnableAdaptiveBitrateStreaming: getParam(
        "EnableAdaptiveBitrateStreaming",
      ),
      AudioStreamIndex: getParam("AudioStreamIndex"),
      MaxHeight: getParam("MaxHeight"),
      MaxStreamingBitrate: getParam("MaxStreamingBitrate"),
      MinSegments: getParam("MinSegments"),
      SegmentLength: getParam("SegmentLength"),
      BreakOnNonKeyFrames: getParam("BreakOnNonKeyFrames"),
    };
  } catch {
    return {
      redactedUrl: redactPlaybackUrl(playbackUrl),
      SegmentContainer: undefined,
      TranscodingContainer: undefined,
      TranscodingProtocol: undefined,
      PlaySessionId: undefined,
      MediaSourceId: undefined,
      DeviceId: undefined,
      VideoCodec: undefined,
      AudioCodec: undefined,
      AllowVideoStreamCopy: undefined,
      AllowAudioStreamCopy: undefined,
      EnableAutoStreamCopy: undefined,
      EnableAdaptiveBitrateStreaming: undefined,
      AudioStreamIndex: undefined,
      MaxHeight: undefined,
      MaxStreamingBitrate: undefined,
      MinSegments: undefined,
      SegmentLength: undefined,
      BreakOnNonKeyFrames: undefined,
    };
  }
}

function isMasterHlsPlaybackUrl(playbackUrl: string): boolean {
  try {
    const baseUrl =
      typeof window === "undefined"
        ? "http://localhost"
        : window.location.origin;
    const url = new URL(playbackUrl, baseUrl);

    return url.pathname.toLowerCase().includes("/master.m3u8");
  } catch {
    return playbackUrl.toLowerCase().includes("/master.m3u8");
  }
}

function logAudioSourceDebug(
  label: string,
  video: HTMLVideoElement,
  source: PlaybackSourceCandidate,
  selectedAudioStreamIndex: number | undefined,
  extra?: Record<string, unknown>,
): void {
  console.info(`[Seyirlik Playback] ${label}`, {
    selectedAudioStreamIndex,
    defaultAudioStreamIndex: source.mediaSource.DefaultAudioStreamIndex,
    jellyfinAudioStreams: getDebugAudioStreams(source),
    nativeAudioTracks: getNativeAudioTrackSnapshot(video),
    activeSource: {
      mode: source.mode,
      isHls: source.isHls,
      hlsKind: source.hlsKind,
      mediaSourceId: source.mediaSourceId,
      url: redactPlaybackUrl(source.url),
      urlParams: getPlaybackUrlDebugParams(source.url),
    },
    ...extra,
  });
}

function getDefaultSubtitleStreamIndex(
  item: JellyfinItem,
  source: PlaybackSourceCandidate,
): number {
  return getDefaultSubtitleStreamIndexForSource(item, source);
}

function shouldForceDefaultAudioInPlaybackUrl(
  source: PlaybackSourceCandidate,
): boolean {
  return source.mode === "Transcoding" || source.isHls;
}

function canInjectDefaultAudioIntoStreamCopy(
  source: PlaybackSourceCandidate,
  defaultAudioIndex: number | undefined,
): boolean {
  return (
    defaultAudioIndex !== undefined &&
    source.isHls &&
    source.hlsKind === "stream-copy" &&
    source.mode !== "Transcoding"
  );
}

function didUserSelectNonDefaultAudio(
  selectedAudioStreamIndex: number | undefined,
  defaultAudioStreamIndex: number | undefined,
): boolean {
  return (
    selectedAudioStreamIndex !== undefined &&
    defaultAudioStreamIndex !== undefined &&
    selectedAudioStreamIndex !== defaultAudioStreamIndex
  );
}

function getAudioFallbackSource(
  source: PlaybackSourceCandidate,
  candidates: PlaybackSourceCandidate[],
): PlaybackSourceCandidate | null {
  if (
    source.mediaSource.Id &&
    (source.mediaSource.SupportsTranscoding || source.mode === "Transcoding")
  ) {
    return source;
  }

  return (
    candidates.find(
      (candidate) =>
        candidate.mediaSourceId === source.mediaSourceId &&
        candidate.mediaSource.Id &&
        (candidate.mode === "Transcoding" || candidate.isHls),
    ) ?? null
  );
}

function getStreamByIndex(
  source: PlaybackSourceCandidate,
  type: "Audio" | "Subtitle",
  streamIndex: number,
): JellyfinMediaStream | undefined {
  return getStreamsOfType(source, type).find(
    (stream) => stream.Index === streamIndex,
  );
}

function getQualitySettings(
  quality?: PlaybackQualityOption,
): PlaybackSourceSettings {
  if (!quality) {
    return {};
  }

  return {
    maxHeight: quality.maxHeight,
    maxWidth: quality.maxWidth,
    maxStreamingBitrate: quality.maxStreamingBitrate,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}

function isSkippableSegmentType(type: string): boolean {
  return SKIPPABLE_SEGMENT_TYPES.has(type.toLowerCase());
}

function isNextEpisodeSegmentType(type: string): boolean {
  const normalizedType = type.toLowerCase().replace(/[^a-z0-9]+/g, "");

  return (
    normalizedType.includes("nextup") ||
    normalizedType.includes("upnext") ||
    normalizedType.includes("nextepisode")
  );
}

function getSkipSegmentLabelKey(type: string): TranslationKey {
  switch (type.toLowerCase()) {
    case "intro":
      return "player.skipIntro";
    case "recap":
      return "player.skipRecap";
    case "outro":
      return "player.skipOutro";
    default:
      return "player.skipSegment";
  }
}

interface SkipSegmentButtonProps {
  segment: NormalizedMediaSegment | null;
  label: string;
  shouldReduceMotion: boolean;
  onSkip: (segment: NormalizedMediaSegment) => void;
  onControlsHoverStart?: () => void;
  onControlsHoverEnd?: () => void;
}

function SkipSegmentButton({
  segment,
  label,
  shouldReduceMotion,
  onSkip,
  onControlsHoverStart,
  onControlsHoverEnd,
}: SkipSegmentButtonProps) {
  return (
    <AnimatePresence initial={false}>
      {segment ? (
        <motion.div
          key={segment.id}
          className="pointer-events-auto absolute bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+5.6rem)] right-[max(0.85rem,env(safe-area-inset-right))] z-[38] sm:bottom-[calc(max(1.25rem,env(safe-area-inset-bottom))+7.2rem)] sm:right-[max(1.25rem,env(safe-area-inset-right))]"
          initial={
            shouldReduceMotion
              ? { opacity: 0 }
              : { opacity: 0, y: 14, scale: 0.98 }
          }
          animate={
            shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }
          }
          exit={
            shouldReduceMotion
              ? { opacity: 0 }
              : { opacity: 0, y: 8, scale: 0.98 }
          }
          transition={
            shouldReduceMotion
              ? { duration: 0.01 }
              : {
                  duration: 0.22,
                  ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
                }
          }
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSkip(segment);
            }}
            onMouseEnter={onControlsHoverStart}
            onMouseLeave={onControlsHoverEnd}
            onPointerEnter={onControlsHoverStart}
            onPointerLeave={onControlsHoverEnd}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/15 bg-black/70 px-4 py-2 text-sm font-black text-white shadow-button-glow backdrop-blur-xl transition duration-200 hover:-translate-y-0.5 hover:border-[var(--accent)]/70 hover:bg-[var(--accent)] hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black active:scale-[0.98] motion-reduce:hover:translate-y-0 sm:min-h-12 sm:px-5 sm:text-base"
            aria-label={label}
          >
            <ChevronsRight className="h-5 w-5 shrink-0" strokeWidth={2.5} />
            <span className="whitespace-nowrap">{label}</span>
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

interface NextEpisodeCountdownOverlayProps {
  nextEpisode: JellyfinItem;
  secondsRemaining: number;
  shouldReduceMotion: boolean;
  onPlayNow: () => void;
  onCancel: () => void;
  onControlsHoverStart?: () => void;
  onControlsHoverEnd?: () => void;
}

function NextEpisodeCountdownOverlay({
  nextEpisode,
  secondsRemaining,
  shouldReduceMotion,
  onPlayNow,
  onCancel,
  onControlsHoverStart,
  onControlsHoverEnd,
}: NextEpisodeCountdownOverlayProps) {
  const { t } = useLanguage();
  const nextEpisodeImageUrl = nextEpisode.ImageTags?.Primary
    ? getPrimaryImageUrl(nextEpisode.Id, nextEpisode.ImageTags.Primary, 320)
    : "";
  const nextEpisodeSeasonNumber =
    typeof nextEpisode.ParentIndexNumber === "number" &&
    Number.isFinite(nextEpisode.ParentIndexNumber)
      ? nextEpisode.ParentIndexNumber
      : null;
  const nextEpisodeNumber =
    typeof nextEpisode.IndexNumber === "number" &&
    Number.isFinite(nextEpisode.IndexNumber)
      ? nextEpisode.IndexNumber
      : null;
  const nextEpisodeContextParts =
    nextEpisodeSeasonNumber !== null && nextEpisodeNumber !== null
      ? [
          formatTemplate(t("media.seasonEpisodeNumber"), {
            seasonNumber: nextEpisodeSeasonNumber,
            episodeNumber: nextEpisodeNumber,
          }),
        ]
      : [
          nextEpisodeSeasonNumber !== null
            ? formatTemplate(t("media.seasonNumber"), {
                number: nextEpisodeSeasonNumber,
              })
            : nextEpisode.SeasonName,
          nextEpisodeNumber !== null
            ? formatTemplate(t("media.episodeNumber"), {
                number: nextEpisodeNumber,
              })
            : null,
        ].filter(Boolean);

  return (
    <motion.div
      className="pointer-events-auto absolute bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+5.9rem)] right-[max(0.85rem,env(safe-area-inset-right))] z-[39] flex w-[min(24rem,calc(100vw-1.7rem))] flex-col items-end gap-2 text-white sm:bottom-[calc(max(1.25rem,env(safe-area-inset-bottom))+7.5rem)] sm:right-[max(1.25rem,env(safe-area-inset-right))]"
      initial={
        shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }
      }
      animate={
        shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }
      }
      exit={
        shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }
      }
      transition={
        shouldReduceMotion
          ? { duration: 0.01 }
          : {
              duration: 0.22,
              ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
            }
      }
      onMouseEnter={onControlsHoverStart}
      onMouseLeave={onControlsHoverEnd}
      onPointerEnter={onControlsHoverStart}
      onPointerLeave={onControlsHoverEnd}
    >
      <div className="relative w-full overflow-hidden rounded-xl bg-zinc-950/90 shadow-player-controls">
        <Tooltip content={t("player.cancelNextEpisode")}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCancel();
            }}
            className="absolute right-2.5 top-2.5 z-20 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white/80 shadow-player-controls transition hover:bg-white/[0.14] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:right-3 sm:top-3"
            aria-label={t("player.cancelNextEpisode")}
          >
            <X className="h-3.5 w-3.5 sm:h-4 sm:w-4" strokeWidth={2.4} />
          </button>
        </Tooltip>

        <div className="relative h-28 w-full overflow-hidden bg-white/[0.06] sm:h-32">
          {nextEpisodeImageUrl ? (
            <img
              src={nextEpisodeImageUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              draggable={false}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[var(--accent)]/16 text-3xl font-black text-[var(--accent)]">
              {secondsRemaining}
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-zinc-950/70 via-zinc-950/18 to-transparent" />
          <div className="absolute bottom-3 left-3 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/45 text-lg font-black text-white shadow-lg">
            {secondsRemaining}
          </div>
        </div>

        <div className="px-3 pb-3 pt-3 sm:px-4 sm:pb-4">
          <p className="pr-10 text-xs font-black uppercase tracking-[0.16em] text-[var(--accent)]">
            {formatTemplate(t("player.nextEpisodeIn"), {
              seconds: secondsRemaining,
            })}
          </p>
          <p className="mt-1 line-clamp-2 pr-2 text-base font-black leading-6 text-white sm:text-lg">
            {nextEpisode.Name}
          </p>
          {nextEpisode.SeriesName || nextEpisodeContextParts.length > 0 ? (
            <p className="mt-1 truncate text-xs font-semibold text-white/55">
              {[nextEpisode.SeriesName, ...nextEpisodeContextParts]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onPlayNow();
        }}
        className="inline-flex min-h-9 items-center justify-center gap-2 rounded-full bg-white z-50 mt-2 px-4 text-xs font-black text-zinc-950 shadow-player-controls transition hover:bg-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black sm:min-h-10 sm:px-5 sm:text-sm"
      >
        <ChevronsRight className="h-4 w-4 shrink-0" strokeWidth={2.5} />
        <span>{t("player.playNow")}</span>
      </button>
    </motion.div>
  );
}

function decodeCueText(rawText: string): string {
  const textWithLineBreaks = rawText
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(b|i|u|c|lang|ruby|rt)[^>]*>/gi, "")
    .replace(/<\/?v[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");

  const textarea = document.createElement("textarea");
  textarea.innerHTML = textWithLineBreaks;
  return textarea.value.trim();
}

function parseSubtitleTimestamp(rawTimestamp: string): number | null {
  const timestamp = rawTimestamp.trim().replace(",", ".");
  const parts = timestamp.split(":");

  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length > 0 ? Number(parts.pop()) : 0;

  if (![hours, minutes, seconds].every(Number.isFinite)) {
    return null;
  }

  if (minutes < 0 || minutes > 59 || seconds < 0) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function parseSubtitleCues(rawText: string): SubtitleCue[] {
  const normalizedText = rawText
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const blocks = normalizedText.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  blocks.forEach((block) => {
    const lines = block
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line, index) => index > 0 || line.trim() !== "WEBVTT");

    const firstLine = lines[0]?.trim().toUpperCase() ?? "";

    if (
      !firstLine ||
      firstLine === "WEBVTT" ||
      firstLine.startsWith("NOTE") ||
      firstLine === "STYLE" ||
      firstLine === "REGION"
    ) {
      return;
    }

    const timingLineIndex = lines.findIndex((line) => line.includes("-->"));
    const timingLine = timingLineIndex >= 0 ? lines[timingLineIndex] : "";
    const timingMatch = timingLine.match(/^(.+?)\s*-->\s*(\S+)/);

    if (!timingMatch) {
      return;
    }

    const start = parseSubtitleTimestamp(timingMatch[1]);
    const end = parseSubtitleTimestamp(timingMatch[2]);
    const text = lines
      .slice(timingLineIndex + 1)
      .join("\n")
      .trim();

    if (start === null || end === null || end <= start || !text) {
      return;
    }

    cues.push({ start, end, text });
  });

  return cues.sort((left, right) => left.start - right.start);
}

function getActiveSubtitleTextForTime(
  cues: SubtitleCue[],
  currentTime: number,
): string {
  const activeTexts = cues
    .filter((cue) => cue.start <= currentTime && cue.end >= currentTime)
    .map((cue) => decodeCueText(cue.text))
    .filter(Boolean);

  return activeTexts.join("\n");
}

function disableNativeVideoTextTracks(video: HTMLVideoElement): void {
  for (let index = 0; index < video.textTracks.length; index += 1) {
    const track = video.textTracks[index];
    track.mode = "disabled";
  }
}

export function CustomVideoPlayer({
  item,
  source,
  playbackCandidates = [],
  notice,
  error,
  hasTranscodingFallback,
  initialStartSeconds = 0,
  onVideoFailure,
  onTryTranscodedPlayback,
  onRetryPlayback,
  onPlaybackStarted,
  onPlaybackProgress,
  onPlaybackStopped,
  onPlaybackBeforeUnload,
  nextEpisode = null,
  enableDefaultNextEpisodeCountdown = false,
  onAutoPlayNextEpisode,
}: CustomVideoPlayerProps) {
  const { t } = useLanguage();
  const viewport = useViewportCapabilities();
  const shouldReduceMotion = Boolean(useReducedMotion());
  const [portraitPlayerRotation, setPortraitPlayerRotation] =
    useState<PortraitPlayerRotation>(() => readPortraitPlayerRotation());

  useEffect(() => {
    const updatePortraitPlayerRotation = () => {
      setPortraitPlayerRotation(readPortraitPlayerRotation());
    };
    const screenOrientation = window.screen.orientation;

    updatePortraitPlayerRotation();
    window.addEventListener("orientationchange", updatePortraitPlayerRotation);
    screenOrientation?.addEventListener("change", updatePortraitPlayerRotation);

    return () => {
      window.removeEventListener(
        "orientationchange",
        updatePortraitPlayerRotation,
      );
      screenOrientation?.removeEventListener(
        "change",
        updatePortraitPlayerRotation,
      );
    };
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeAttachmentRef = useRef<AttachedVideoSource | null>(null);
  const touchSeekSessionRef = useRef<TouchSeekSessionState>({
    lastTapTime: 0,
    lastTapSide: null,
    isActive: false,
    accumulatedSeconds: 0,
    timeoutId: null,
  });
  const lastProgressReportRef = useRef(0);
  const latestPlaybackPositionRef = useRef(0);
  const hasStartedRef = useRef(false);
  const hasReportedStoppedRef = useRef(false);
  const hasAutoPlayedNextRef = useRef(false);
  const hasAppliedInitialStartRef = useRef(false);
  const sourceSwitchTokenRef = useRef(0);
  const pendingSourceRestoreRef = useRef<PendingSourceRestore | null>(null);
  const pendingAudioTranscodePlayRef = useRef<PendingAudioTranscodePlay | null>(
    null,
  );
  const audioTranscodeReadinessTimerRef = useRef<number | null>(null);
  const subtitleOverlayRef = useRef<HTMLDivElement | null>(null);
  const subtitleDragStateRef = useRef<SubtitleDragState | null>(null);
  const subtitleResizeStateRef = useRef<SubtitleResizeState | null>(null);
  const suppressPlayerTapUntilRef = useRef(0);
  const singleTapTimerRef = useRef<number | null>(null);
  const fullscreenSeekPreviewTokenRef = useRef(0);
  const pendingFullscreenSeekPreviewRef = useRef<{
    token: number;
    targetSeconds: number;
  } | null>(null);
  const fullscreenSeekPreviewFallbackTimerRef = useRef<number | null>(null);
  const seekFeedbackHideTimersRef = useRef<
    Record<SeekFeedbackDirection, number | null>
  >({
    backward: null,
    forward: null,
  });
  const seekFeedbackSpinStateRef = useRef<
    Record<SeekFeedbackDirection, SeekFeedbackSpinState>
  >({
    backward: {
      isSpinning: false,
      hasPendingSpin: false,
      finishTimerId: null,
    },
    forward: {
      isSpinning: false,
      hasPendingSpin: false,
      finishTimerId: null,
    },
  });
  const seekFeedbackChromeHideTimerRef = useRef<number | null>(null);
  const viewModeCursorHideTimerRef = useRef<number | null>(null);
  const clearSingleTapTimer = useCallback(() => {
    if (singleTapTimerRef.current !== null) {
      window.clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
    }
  }, []);
  const clearTouchSeekSessionTimeout = useCallback(() => {
    if (touchSeekSessionRef.current.timeoutId !== null) {
      window.clearTimeout(touchSeekSessionRef.current.timeoutId);
      touchSeekSessionRef.current.timeoutId = null;
    }
  }, []);
  const resetTouchSeekSession = useCallback(
    (clearPendingSingleTap = true) => {
      if (clearPendingSingleTap) {
        clearSingleTapTimer();
      }

      clearTouchSeekSessionTimeout();

      touchSeekSessionRef.current.lastTapTime = 0;
      touchSeekSessionRef.current.lastTapSide = null;
      touchSeekSessionRef.current.isActive = false;
      touchSeekSessionRef.current.accumulatedSeconds = 0;
    },
    [clearSingleTapTimer, clearTouchSeekSessionTimeout],
  );
  const mediaFormatLabels = useMemo(
    () => ({
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    [t],
  );
  const title = getDisplayTitle(item, mediaFormatLabels);

  const [isPlaybackInfoOpen, setIsPlaybackInfoOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPartyWatchOpen, setIsPartyWatchOpen] = useState(false);
  const [isSubtitleEditMode, setIsSubtitleEditMode] = useState(false);
  const [areControlsManuallyHidden, setAreControlsManuallyHidden] =
    useState(false);
  const [isViewModeEnabled, setIsViewModeEnabled] = useState(false);
  const [isViewModeCursorVisible, setIsViewModeCursorVisible] = useState(true);
  const [checkpointSeconds, setCheckpointSeconds] = useState<number | null>(
    null,
  );

  const progress = usePlayerProgress(videoRef);
  const refreshProgress = progress.refresh;
  const { segments: mediaSegments, activeSegment } = useMediaSegments(
    item.Id,
    progress.currentTime,
  );

  const controlsShouldStayVisible =
    isSettingsOpen || isPlaybackInfoOpen || isPartyWatchOpen;

  const {
    areControlsVisible,
    showControls,
    keepControlsVisible,
    releaseControlsHover,
  } = useAutoHideControls({
    isPlaying: progress.isPlaying,
    disabled: Boolean(error) || controlsShouldStayVisible,
    playStartDelayMs: 900,
    interactionDelayMs: 2400,
  });

  const shouldShowPlayerChrome =
    !isSubtitleEditMode &&
    !areControlsManuallyHidden &&
    (areControlsVisible || !progress.isPlaying || controlsShouldStayVisible);
  const shouldRenderPlayerChrome = shouldShowPlayerChrome && !isViewModeEnabled;
  const shouldShowPlayerCursor =
    shouldRenderPlayerChrome || (isViewModeEnabled && isViewModeCursorVisible);

  const revealPlayerChrome = useCallback(() => {
    if (seekFeedbackChromeHideTimerRef.current !== null) {
      window.clearTimeout(seekFeedbackChromeHideTimerRef.current);
      seekFeedbackChromeHideTimerRef.current = null;
    }

    setAreControlsManuallyHidden(false);
    showControls();
  }, [showControls]);

  const clearViewModeCursorHideTimer = useCallback(() => {
    if (viewModeCursorHideTimerRef.current !== null) {
      window.clearTimeout(viewModeCursorHideTimerRef.current);
      viewModeCursorHideTimerRef.current = null;
    }
  }, []);

  const revealViewModeCursor = useCallback(() => {
    clearViewModeCursorHideTimer();
    setIsViewModeCursorVisible(true);

    viewModeCursorHideTimerRef.current = window.setTimeout(() => {
      setIsViewModeCursorVisible(false);
      viewModeCursorHideTimerRef.current = null;
    }, VIEW_MODE_CURSOR_HIDE_MS);
  }, [clearViewModeCursorHideTimer]);

  const partyWatch = usePartyWatchController({
    videoRef,
    itemId: item.Id,
    title,
    currentTime: progress.currentTime,
    isPlaying: progress.isPlaying,
    refreshProgress,
    showControls: revealPlayerChrome,
  });
  const partyWatchMemberCount = partyWatch.isInGroup
    ? Math.max(
        1,
        partyWatch.participantCount ?? partyWatch.participantNames?.length ?? 0,
      )
    : 0;
  const visiblePartyWatchDotCount = partyWatch.isInGroup
    ? Math.min(partyWatchMemberCount, PARTY_WATCH_DOT_POSITIONS.length)
    : 1;
  const checkpointButtonLabel =
    checkpointSeconds === null
      ? t("player.setCheckpoint")
      : t("player.returnToCheckpoint");

  const enterViewMode = useCallback(() => {
    setIsViewModeEnabled(true);
    setIsSettingsOpen(false);
    setIsPlaybackInfoOpen(false);
    setIsPartyWatchOpen(false);
    setIsSubtitleEditMode(false);
    setAreControlsManuallyHidden(true);
    releaseControlsHover();
    revealViewModeCursor();
  }, [releaseControlsHover, revealViewModeCursor]);

  const exitViewMode = useCallback(() => {
    clearViewModeCursorHideTimer();
    setIsViewModeCursorVisible(true);
    setIsViewModeEnabled(false);
    revealPlayerChrome();
  }, [clearViewModeCursorHideTimer, revealPlayerChrome]);

  const toggleCheckpointMode = useCallback(() => {
    if (checkpointSeconds === null) {
      const video = videoRef.current;
      const currentSeconds =
        video && Number.isFinite(video.currentTime)
          ? video.currentTime
          : progress.currentTime;

      setCheckpointSeconds(Math.max(0, currentSeconds));

      if (!isViewModeEnabled) {
        revealPlayerChrome();
      }

      return;
    }

    const duration =
      Number.isFinite(progress.duration) && progress.duration > 0
        ? progress.duration
        : undefined;
    const target =
      duration !== undefined
        ? clamp(checkpointSeconds, 0, Math.max(0, duration - 0.25))
        : Math.max(0, checkpointSeconds);

    partyWatch.seekTo(target);
    setCheckpointSeconds(null);

    if (!isViewModeEnabled) {
      revealPlayerChrome();
    }
  }, [
    checkpointSeconds,
    isViewModeEnabled,
    partyWatch,
    progress.currentTime,
    progress.duration,
    revealPlayerChrome,
  ]);

  const [displayedPartyEventMessage, setDisplayedPartyEventMessage] = useState<
    string | null
  >(null);
  const [isPartyEventToastLeaving, setIsPartyEventToastLeaving] =
    useState(false);
  const [fullscreenSeekPreviewSeconds, setFullscreenSeekPreviewSeconds] =
    useState<number | null>(null);
  const [seekFeedback, setSeekFeedback] =
    useState<SeekFeedbackState>(initialSeekFeedback);
  const resetSeekFeedbackSpinState = useCallback(
    (direction: SeekFeedbackDirection) => {
      const spinState = seekFeedbackSpinStateRef.current[direction];

      if (spinState.finishTimerId !== null) {
        window.clearTimeout(spinState.finishTimerId);
      }

      spinState.isSpinning = false;
      spinState.hasPendingSpin = false;
      spinState.finishTimerId = null;
    },
    [],
  );
  const clearSeekFeedbackSpinTimers = useCallback(() => {
    (["backward", "forward"] as const).forEach(resetSeekFeedbackSpinState);
  }, [resetSeekFeedbackSpinState]);
  const startSeekFeedbackSpin = useCallback(
    (direction: SeekFeedbackDirection) => {
      const spinState = seekFeedbackSpinStateRef.current[direction];

      const beginSpin = () => {
        spinState.isSpinning = true;
        setSeekFeedback((current) => ({
          ...current,
          [direction]: {
            ...current[direction],
            spinPulse: current[direction].spinPulse + 1,
          },
        }));

        if (spinState.finishTimerId !== null) {
          window.clearTimeout(spinState.finishTimerId);
        }

        spinState.finishTimerId = window.setTimeout(() => {
          spinState.finishTimerId = null;

          if (spinState.hasPendingSpin) {
            spinState.hasPendingSpin = false;
            beginSpin();
            return;
          }

          spinState.isSpinning = false;
        }, SEEK_FEEDBACK_SPIN_MS);
      };

      beginSpin();
    },
    [],
  );
  const requestSeekFeedbackSpin = useCallback(
    (direction: SeekFeedbackDirection) => {
      const spinState = seekFeedbackSpinStateRef.current[direction];

      if (spinState.isSpinning) {
        spinState.hasPendingSpin = true;
        return;
      }

      startSeekFeedbackSpin(direction);
    },
    [startSeekFeedbackSpin],
  );
  const [dismissedSkipSegmentId, setDismissedSkipSegmentId] = useState<
    string | null
  >(null);
  const [
    dismissedDefaultNextEpisodeItemId,
    setDismissedDefaultNextEpisodeItemId,
  ] = useState<string | null>(null);

  const updateLatestPlaybackPosition = useCallback(() => {
    const currentTime =
      videoRef.current?.currentTime ?? latestPlaybackPositionRef.current;

    if (Number.isFinite(currentTime)) {
      latestPlaybackPositionRef.current = currentTime;
    }

    return latestPlaybackPositionRef.current;
  }, []);

  const reportStoppedOnce = useCallback(
    (useUnloadSafeReport = false) => {
      const positionSeconds = updateLatestPlaybackPosition();

      if (!hasStartedRef.current || hasReportedStoppedRef.current) {
        return;
      }

      hasReportedStoppedRef.current = true;

      if (useUnloadSafeReport) {
        onPlaybackBeforeUnload?.(positionSeconds);
        return;
      }

      onPlaybackStopped?.(positionSeconds);
    },
    [onPlaybackBeforeUnload, onPlaybackStopped, updateLatestPlaybackPosition],
  );

  const clearAudioTranscodeReadinessTimer = useCallback(() => {
    if (audioTranscodeReadinessTimerRef.current !== null) {
      window.clearTimeout(audioTranscodeReadinessTimerRef.current);
      audioTranscodeReadinessTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (
      dismissedSkipSegmentId &&
      activeSegment?.id !== dismissedSkipSegmentId
    ) {
      setDismissedSkipSegmentId(null);
    }
  }, [activeSegment?.id, dismissedSkipSegmentId]);

  useEffect(() => {
    if (partyWatch.partyEventMessage) {
      setDisplayedPartyEventMessage(partyWatch.partyEventMessage);
      setIsPartyEventToastLeaving(false);
      return undefined;
    }

    if (!displayedPartyEventMessage) {
      return undefined;
    }

    setIsPartyEventToastLeaving(true);

    const timer = window.setTimeout(() => {
      setDisplayedPartyEventMessage(null);
      setIsPartyEventToastLeaving(false);
    }, 260);

    return () => {
      window.clearTimeout(timer);
    };
  }, [partyWatch.partyEventMessage, displayedPartyEventMessage]);

  const [activeSource, setActiveSource] =
    useState<PlaybackSourceCandidate>(source);
  const [selectedQualityId, setSelectedQualityId] = useState(AUTO_QUALITY_ID);
  const [selectedAudioStreamIndex, setSelectedAudioStreamIndex] = useState<
    number | undefined
  >(() => getDefaultAudioStreamIndex(item, source));
  const [activeAudioStreamIndex, setActiveAudioStreamIndex] = useState<
    number | undefined
  >(() =>
    shouldForceDefaultAudioInPlaybackUrl(source)
      ? getDefaultAudioStreamIndex(item, source)
      : getStreamsOfType(source, "Audio").length <= 1
        ? getDefaultAudioStreamIndex(item, source)
        : undefined,
  );
  const [selectedSubtitleStreamIndex, setSelectedSubtitleStreamIndex] =
    useState<number>(() => getDefaultSubtitleStreamIndex(item, source));
  const [lastVideoError, setLastVideoError] = useState<string | null>(null);
  const [isWaitingForAudioTranscodeReady, setIsWaitingForAudioTranscodeReady] =
    useState(false);
  const [liveTranscodingReasons, setLiveTranscodingReasons] = useState<
    string[]
  >([]);
  const [activeSubtitleText, setActiveSubtitleText] = useState("");
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [subtitleDelaySeconds, setSubtitleDelaySeconds] = useState(0);
  const [subtitlePosition, setSubtitlePosition] =
    useState<SubtitlePosition | null>(null);
  const [subtitleSize, setSubtitleSize] = useState<SubtitleSize>({
    scale: DEFAULT_SUBTITLE_SCALE,
  });
  const [isDraggingSubtitle, setIsDraggingSubtitle] = useState(false);
  const [isResizingSubtitle, setIsResizingSubtitle] = useState(false);
  const availablePlaybackCandidates =
    playbackCandidates.length > 0 ? playbackCandidates : [source];
  const qualityOptions = useMemo(
    () => getManualQualityOptions(activeSource.mediaSource),
    [activeSource.mediaSource],
  );
  const audioStreams = useMemo(
    () => getStreamsOfType(activeSource, "Audio"),
    [activeSource],
  );
  const canSwitchAudio = Boolean(
    audioStreams.some((stream) => stream.Index !== undefined) &&
    (isDirectBrowserPlaybackSource(activeSource) ||
      activeSource.mediaSource.SupportsTranscoding ||
      activeSource.mode === "Transcoding"),
  );
  const canSwitchSubtitles = Boolean(activeSource.mediaSourceId);

  const initializeSubtitleEditPosition = useCallback(() => {
    const bounds = containerRef.current?.getBoundingClientRect();
    const overlayBounds = subtitleOverlayRef.current?.getBoundingClientRect();

    if (!bounds || !overlayBounds) {
      return;
    }

    const overlayCenterX = overlayBounds.left + overlayBounds.width / 2;
    const overlayCenterY = overlayBounds.top + overlayBounds.height / 2;

    setSubtitlePosition(
      (currentPosition) =>
        currentPosition ?? {
          x: clamp(
            ((overlayCenterX - bounds.left) / bounds.width) * 100,
            8,
            92,
          ),
          y: clamp(
            ((overlayCenterY - bounds.top) / bounds.height) * 100,
            10,
            90,
          ),
        },
    );
  }, []);

  const startSubtitleEditMode = useCallback(() => {
    initializeSubtitleEditPosition();
    setIsSettingsOpen(false);
    setIsPlaybackInfoOpen(false);
    setIsPartyWatchOpen(false);
    setIsDraggingSubtitle(false);
    setIsResizingSubtitle(false);
    setIsSubtitleEditMode(true);
    setAreControlsManuallyHidden(true);
    subtitleDragStateRef.current = null;
    subtitleResizeStateRef.current = null;
    suppressPlayerTapUntilRef.current = Date.now() + 350;
    resetTouchSeekSession();
    releaseControlsHover();
  }, [
    initializeSubtitleEditPosition,
    releaseControlsHover,
    resetTouchSeekSession,
  ]);

  const finishSubtitleEditMode = useCallback(() => {
    setIsSubtitleEditMode(false);
    setIsDraggingSubtitle(false);
    setIsResizingSubtitle(false);
    subtitleDragStateRef.current = null;
    subtitleResizeStateRef.current = null;
    suppressPlayerTapUntilRef.current = Date.now() + 350;
    resetTouchSeekSession();
    revealPlayerChrome();
  }, [resetTouchSeekSession, revealPlayerChrome]);

  const sourceWithLiveTranscodingReasons =
    useMemo<PlaybackSourceCandidate>(() => {
      if (liveTranscodingReasons.length === 0) {
        return activeSource;
      }

      const mergedTranscodeReasons = Array.from(
        new Set(
          [
            ...(activeSource.transcodeReasons ?? []),
            ...(activeSource.mediaSource.TranscodingReasons ?? []),
            ...liveTranscodingReasons,
          ].filter(Boolean),
        ),
      );

      return {
        ...activeSource,
        transcodeReasons: mergedTranscodeReasons,
        mediaSource: {
          ...activeSource.mediaSource,
          TranscodingReasons: mergedTranscodeReasons,
        },
      };
    }, [activeSource, liveTranscodingReasons]);

  const skippableActiveSegment = useMemo(() => {
    if (
      Boolean(error) ||
      isSettingsOpen ||
      isPlaybackInfoOpen ||
      isPartyWatchOpen ||
      isSubtitleEditMode ||
      (partyWatch.isInGroup && !partyWatch.canControl) ||
      !Number.isFinite(progress.currentTime)
    ) {
      return null;
    }

    return (
      mediaSegments.find(
        (segment) =>
          segment.id !== dismissedSkipSegmentId &&
          isSkippableSegmentType(segment.type) &&
          progress.currentTime >= segment.startSeconds &&
          progress.currentTime < segment.endSeconds &&
          segment.endSeconds - progress.currentTime > 1,
      ) ?? null
    );
  }, [
    dismissedSkipSegmentId,
    error,
    isPartyWatchOpen,
    isPlaybackInfoOpen,
    isSettingsOpen,
    isSubtitleEditMode,
    mediaSegments,
    partyWatch.canControl,
    partyWatch.isInGroup,
    progress.currentTime,
  ]);

  const skipSegmentLabel = skippableActiveSegment
    ? t(getSkipSegmentLabelKey(skippableActiveSegment.type))
    : t("player.skipSegment");

  const hasDataDrivenNextUp = useMemo(
    () =>
      mediaSegments.some((segment) => isNextEpisodeSegmentType(segment.type)),
    [mediaSegments],
  );
  const defaultNextEpisodeRemainingSeconds =
    Number.isFinite(progress.duration) && progress.duration > 0
      ? progress.duration - progress.currentTime
      : Number.POSITIVE_INFINITY;
  const defaultNextEpisodeCountdownSeconds =
    Number.isFinite(defaultNextEpisodeRemainingSeconds) &&
    defaultNextEpisodeRemainingSeconds > 0 &&
    defaultNextEpisodeRemainingSeconds <= DEFAULT_NEXT_EPISODE_COUNTDOWN_SECONDS
      ? clamp(
          Math.ceil(defaultNextEpisodeRemainingSeconds),
          1,
          DEFAULT_NEXT_EPISODE_COUNTDOWN_SECONDS,
        )
      : null;
  const isDefaultNextEpisodeDismissed =
    dismissedDefaultNextEpisodeItemId === item.Id;
  const isDefaultNextEpisodeCountdownEnabled = Boolean(
    enableDefaultNextEpisodeCountdown &&
    nextEpisode &&
    onAutoPlayNextEpisode &&
    !partyWatch.isInGroup &&
    !error &&
    Number.isFinite(progress.duration) &&
    progress.duration > 0,
  );
  const shouldShowDefaultNextEpisodeCountdown = Boolean(
    isDefaultNextEpisodeCountdownEnabled &&
    !isDefaultNextEpisodeDismissed &&
    defaultNextEpisodeCountdownSeconds !== null,
  );

  useEffect(() => {
    if (import.meta.env.DEV) {
      console.info("[Seyirlik Next Episode State Debug]", {
        itemId: item.Id,
        itemName: item.Name,
        itemType: item.Type,
        seriesId: item.SeriesId,
        seasonId: item.SeasonId,
        parentId: item.ParentId,
        indexNumber: item.IndexNumber,
        nextEpisode: nextEpisode
          ? { id: nextEpisode.Id, name: nextEpisode.Name }
          : null,
        progressDuration: progress.duration,
        progressCurrentTime: progress.currentTime,
        remainingSeconds: defaultNextEpisodeRemainingSeconds,
        countdownSeconds: defaultNextEpisodeCountdownSeconds,
        enableDefaultCountdown: enableDefaultNextEpisodeCountdown,
        partyWatchInGroup: partyWatch.isInGroup,
        error,
        hasDataDrivenNextUp,
        shouldShowDefaultNextEpisodeCountdown,
      });
    }
  }, [
    item,
    nextEpisode,
    progress.duration,
    progress.currentTime,
    defaultNextEpisodeRemainingSeconds,
    defaultNextEpisodeCountdownSeconds,
    enableDefaultNextEpisodeCountdown,
    partyWatch.isInGroup,
    error,
    hasDataDrivenNextUp,
    shouldShowDefaultNextEpisodeCountdown,
  ]);

  const fullscreenSeekPreview = useMemo(() => {
    if (
      fullscreenSeekPreviewSeconds === null ||
      !activeSource.mediaSourceId ||
      progress.duration <= 0
    ) {
      return null;
    }

    const globalTileIndex = Math.max(
      0,
      Math.floor(fullscreenSeekPreviewSeconds / TRICKPLAY_INTERVAL_SECONDS),
    );
    const sheetIndex = Math.floor(globalTileIndex / TRICKPLAY_IMAGES_PER_SHEET);
    const tileIndexOnSheet = globalTileIndex % TRICKPLAY_IMAGES_PER_SHEET;
    const column = tileIndexOnSheet % TRICKPLAY_COLUMNS;
    const row = Math.floor(tileIndexOnSheet / TRICKPLAY_COLUMNS);

    return {
      imageUrl: getTrickplayImageUrl(
        activeSource.itemId,
        activeSource.mediaSourceId,
        TRICKPLAY_RESOLUTION,
        sheetIndex,
      ),
      column,
      row,
    };
  }, [
    activeSource.itemId,
    activeSource.mediaSourceId,
    fullscreenSeekPreviewSeconds,
    progress.duration,
  ]);

  const fullscreenSeekPreviewRect = useMemo(() => {
    const video = videoRef.current;
    const container = containerRef.current;

    if (!video || !container) {
      return null;
    }

    const containerBounds = container.getBoundingClientRect();
    const videoAspect =
      video.videoWidth > 0 && video.videoHeight > 0
        ? video.videoWidth / video.videoHeight
        : TRICKPLAY_TILE_WIDTH / TRICKPLAY_TILE_HEIGHT;

    const containerAspect = containerBounds.width / containerBounds.height;

    let width = containerBounds.width;
    let height = containerBounds.height;
    let left = 0;
    let top = 0;

    if (containerAspect > videoAspect) {
      height = containerBounds.height;
      width = height * videoAspect;
      left = (containerBounds.width - width) / 2;
    } else {
      width = containerBounds.width;
      height = width / videoAspect;
      top = (containerBounds.height - height) / 2;
    }

    return {
      left,
      top,
      width,
      height,
    };
  }, [fullscreenSeekPreviewSeconds, progress.duration]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    const disableTracks = () => {
      disableNativeVideoTextTracks(video);
    };

    disableTracks();

    video.addEventListener("loadedmetadata", disableTracks);
    video.addEventListener("loadeddata", disableTracks);
    video.addEventListener("canplay", disableTracks);
    video.addEventListener("play", disableTracks);

    video.textTracks.addEventListener?.("addtrack", disableTracks);
    video.textTracks.addEventListener?.("change", disableTracks);

    const interval = window.setInterval(disableTracks, 500);

    return () => {
      video.removeEventListener("loadedmetadata", disableTracks);
      video.removeEventListener("loadeddata", disableTracks);
      video.removeEventListener("canplay", disableTracks);
      video.removeEventListener("play", disableTracks);

      video.textTracks.removeEventListener?.("addtrack", disableTracks);
      video.textTracks.removeEventListener?.("change", disableTracks);

      window.clearInterval(interval);
    };
  }, [activeSource.id, activeSource.url]);

  useEffect(() => {
    const defaultAudioIndex = getDefaultAudioStreamIndex(item, source);
    let nextSource = source;

    if (canInjectDefaultAudioIntoStreamCopy(source, defaultAudioIndex)) {
      try {
        nextSource = buildConfiguredHlsPlaybackSource(
          source,
          { audioStreamIndex: defaultAudioIndex },
          "Auto HLS",
          "Built a Jellyfin HLS URL using the file's default audio track.",
        );
      } catch (switchError) {
        console.warn(
          "[Seyirlik Playback] Could not force default audio stream for initial playback",
          switchError,
        );
      }
    }

    pendingSourceRestoreRef.current = null;
    latestPlaybackPositionRef.current = 0;
    hasReportedStoppedRef.current = false;
    hasAutoPlayedNextRef.current = false;
    setActiveSource(nextSource);
    setSelectedQualityId(AUTO_QUALITY_ID);
    setSelectedAudioStreamIndex(defaultAudioIndex);
    setActiveAudioStreamIndex(
      shouldForceDefaultAudioInPlaybackUrl(nextSource) ||
        getStreamsOfType(nextSource, "Audio").length <= 1
        ? defaultAudioIndex
        : undefined,
    );
    setSelectedSubtitleStreamIndex(
      getDefaultSubtitleStreamIndex(item, nextSource),
    );
    setLastVideoError(null);
    setLiveTranscodingReasons([]);
    setCheckpointSeconds(null);
    setIsViewModeCursorVisible(true);
    setIsViewModeEnabled(false);
  }, [item, source.id, source.mediaSourceId, source.url]);
  useEffect(() => {
    let isCancelled = false;
    let intervalId: number | null = null;

    const shouldFetchLiveReasons =
      activeSource.mode === "Transcoding" || activeSource.isHls;

    if (!shouldFetchLiveReasons) {
      setLiveTranscodingReasons([]);
      return undefined;
    }

    const fetchLiveReasons = async () => {
      try {
        const reasons = await getActiveTranscodingReasons(
          activeSource.itemId,
          activeSource.playSessionId,
        );

        if (isCancelled) {
          return;
        }

        setLiveTranscodingReasons((currentReasons) => {
          const nextReasons = Array.from(new Set(reasons.filter(Boolean)));

          if (
            currentReasons.length === nextReasons.length &&
            currentReasons.every(
              (reason, index) => reason === nextReasons[index],
            )
          ) {
            return currentReasons;
          }

          return nextReasons;
        });
      } catch (reasonError) {
        if (!isCancelled) {
          console.warn(
            "[Seyirlik Playback] Could not fetch live transcoding reasons",
            reasonError,
          );
        }
      }
    };

    void fetchLiveReasons();
    intervalId = window.setInterval(fetchLiveReasons, 3500);

    return () => {
      isCancelled = true;

      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [
    activeSource.itemId,
    activeSource.playSessionId,
    activeSource.mode,
    activeSource.isHls,
  ]);

  useEffect(() => {
    if (!isViewModeEnabled) {
      clearViewModeCursorHideTimer();
      setIsViewModeCursorVisible(true);
      return undefined;
    }

    revealViewModeCursor();

    return clearViewModeCursorHideTimer;
  }, [clearViewModeCursorHideTimer, isViewModeEnabled, revealViewModeCursor]);

  useEffect(() => {
    latestPlaybackPositionRef.current = 0;
    hasReportedStoppedRef.current = false;
    hasAutoPlayedNextRef.current = false;
    hasAppliedInitialStartRef.current = false;
    setActiveSubtitleText("");
    setSubtitlePosition(null);
    setSubtitleSize({ scale: DEFAULT_SUBTITLE_SCALE });
    setIsDraggingSubtitle(false);
    setIsResizingSubtitle(false);
    setIsSubtitleEditMode(false);
    setAreControlsManuallyHidden(false);
    setCheckpointSeconds(null);
    setDismissedDefaultNextEpisodeItemId(null);
    setIsViewModeCursorVisible(true);
    setIsViewModeEnabled(false);
    subtitleDragStateRef.current = null;
    subtitleResizeStateRef.current = null;
    suppressPlayerTapUntilRef.current = 0;
    resetTouchSeekSession();
  }, [item.Id, resetTouchSeekSession]);

  useEffect(() => {
    hasAutoPlayedNextRef.current = false;
  }, [activeSource.id, activeSource.url]);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void container.requestFullscreen?.();
    }
  }, []);

  const clearSeekFeedbackTimers = useCallback(() => {
    (["backward", "forward"] as const).forEach((direction) => {
      if (seekFeedbackHideTimersRef.current[direction] !== null) {
        window.clearTimeout(seekFeedbackHideTimersRef.current[direction]!);
        seekFeedbackHideTimersRef.current[direction] = null;
      }
    });
  }, []);

  const hidePlayerChromeWithSeekFeedback = useCallback(() => {
    if (seekFeedbackChromeHideTimerRef.current !== null) {
      window.clearTimeout(seekFeedbackChromeHideTimerRef.current);
      seekFeedbackChromeHideTimerRef.current = null;
    }

    if (!progress.isPlaying || controlsShouldStayVisible) {
      return;
    }

    seekFeedbackChromeHideTimerRef.current = window.setTimeout(() => {
      setAreControlsManuallyHidden(true);
      seekFeedbackChromeHideTimerRef.current = null;
    }, SEEK_FEEDBACK_HIDE_MS);
  }, [controlsShouldStayVisible, progress.isPlaying]);

  const triggerSeekFeedback = useCallback(
    (seconds: number) => {
      if (seconds === 0) {
        return;
      }

      const direction: SeekFeedbackDirection =
        seconds < 0 ? "backward" : "forward";
      const oppositeDirection: SeekFeedbackDirection =
        direction === "backward" ? "forward" : "backward";
      const amount = Math.abs(seconds);

      resetSeekFeedbackSpinState(oppositeDirection);

      if (seekFeedbackHideTimersRef.current[oppositeDirection] !== null) {
        window.clearTimeout(
          seekFeedbackHideTimersRef.current[oppositeDirection]!,
        );
      }

      seekFeedbackHideTimersRef.current[oppositeDirection] = window.setTimeout(
        () => {
          setSeekFeedback((current) => ({
            ...current,
            [oppositeDirection]: {
              ...current[oppositeDirection],
              visible: false,
            },
          }));

          window.setTimeout(() => {
            setSeekFeedback((current) => {
              if (current[oppositeDirection].visible) {
                return current;
              }

              return {
                ...current,
                [oppositeDirection]: {
                  ...current[oppositeDirection],
                  amount: 0,
                },
              };
            });
          }, SEEK_FEEDBACK_FADE_RESET_MS);

          seekFeedbackHideTimersRef.current[oppositeDirection] = null;
        },
        SEEK_FEEDBACK_OPPOSITE_HIDE_MS,
      );

      setSeekFeedback((current) => {
        const currentDirection = current[direction];

        return {
          ...current,
          [direction]: {
            ...currentDirection,
            amount: currentDirection.amount + amount,
            visible: true,
            pulse: currentDirection.pulse + 1,
          },
        };
      });

      requestSeekFeedbackSpin(direction);

      if (seekFeedbackHideTimersRef.current[direction] !== null) {
        window.clearTimeout(seekFeedbackHideTimersRef.current[direction]!);
      }

      seekFeedbackHideTimersRef.current[direction] = window.setTimeout(() => {
        setSeekFeedback((current) => ({
          ...current,
          [direction]: {
            ...current[direction],
            visible: false,
          },
        }));

        window.setTimeout(() => {
          setSeekFeedback((current) => {
            if (current[direction].visible) {
              return current;
            }

            return {
              ...current,
              [direction]: {
                ...current[direction],
                amount: 0,
              },
            };
          });
        }, SEEK_FEEDBACK_FADE_RESET_MS);

        seekFeedbackHideTimersRef.current[direction] = null;
      }, SEEK_FEEDBACK_HIDE_MS);
    },
    [requestSeekFeedbackSpin, resetSeekFeedbackSpinState],
  );

  const handleSeekBy = useCallback(
    (seconds: number) => {
      partyWatch.seekBy(seconds);
      triggerSeekFeedback(seconds);
      revealPlayerChrome();
      hidePlayerChromeWithSeekFeedback();
    },
    [
      hidePlayerChromeWithSeekFeedback,
      partyWatch,
      revealPlayerChrome,
      triggerSeekFeedback,
    ],
  );

  const handleSkipSegment = useCallback(
    (segment: NormalizedMediaSegment) => {
      const video = videoRef.current;
      const videoDuration = video?.duration;
      const duration =
        typeof videoDuration === "number" &&
        Number.isFinite(videoDuration) &&
        videoDuration > 0
          ? videoDuration
          : progress.duration;
      const rawTarget = segment.endSeconds + 0.15;
      const target =
        Number.isFinite(duration) && duration > 0
          ? clamp(rawTarget, 0, Math.max(0, duration - 0.25))
          : Math.max(0, rawTarget);

      setDismissedSkipSegmentId(segment.id);
      partyWatch.seekTo(target);
      revealPlayerChrome();
    },
    [partyWatch, progress.duration, revealPlayerChrome],
  );

  const handleDefaultNextEpisodePlay = useCallback(() => {
    if (
      !nextEpisode ||
      !isDefaultNextEpisodeCountdownEnabled ||
      isDefaultNextEpisodeDismissed ||
      hasAutoPlayedNextRef.current
    ) {
      return;
    }

    hasAutoPlayedNextRef.current = true;
    onAutoPlayNextEpisode?.(nextEpisode);
  }, [
    isDefaultNextEpisodeCountdownEnabled,
    isDefaultNextEpisodeDismissed,
    nextEpisode,
    onAutoPlayNextEpisode,
  ]);

  const handleDefaultNextEpisodeCancel = useCallback(() => {
    setDismissedDefaultNextEpisodeItemId(item.Id);
    revealPlayerChrome();
  }, [item.Id, revealPlayerChrome]);

  useKeyboardShortcuts({
    enabled: true,
    onTogglePlay: partyWatch.togglePlay,
    onSeekBy: handleSeekBy,
    onToggleMute: progress.toggleMute,
    onToggleFullscreen: toggleFullscreen,
  });

  useEffect(() => {
    if (!isSettingsOpen) {
      return undefined;
    }

    const handlePointerDownOutside = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement | null;

      if (target?.closest("[data-player-settings-root]")) {
        return;
      }

      setIsSettingsOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDownOutside);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDownOutside);
    };
  }, [isSettingsOpen]);

  useEffect(() => {
    if (!isPartyWatchOpen) {
      return undefined;
    }

    const handlePointerDownOutsidePartyWatch = (
      event: globalThis.PointerEvent,
    ) => {
      const target = event.target as HTMLElement | null;

      if (target?.closest("[data-party-watch-root]")) {
        return;
      }

      setIsPartyWatchOpen(false);
    };

    document.addEventListener(
      "pointerdown",
      handlePointerDownOutsidePartyWatch,
    );

    return () => {
      document.removeEventListener(
        "pointerdown",
        handlePointerDownOutsidePartyWatch,
      );
    };
  }, [isPartyWatchOpen]);

  useEffect(() => {
    if (!isSubtitleEditMode) {
      return undefined;
    }

    const handlePointerDownOutsideSubtitle = (
      event: globalThis.PointerEvent,
    ) => {
      const target = event.target as HTMLElement | null;

      if (
        target?.closest("[data-subtitle-editor-root]") ||
        target?.closest("[data-player-settings-root]")
      ) {
        return;
      }

      finishSubtitleEditMode();
    };

    document.addEventListener("pointerdown", handlePointerDownOutsideSubtitle);

    return () => {
      document.removeEventListener(
        "pointerdown",
        handlePointerDownOutsideSubtitle,
      );
    };
  }, [finishSubtitleEditMode, isSubtitleEditMode]);

  const stopCurrentPlaybackForSourceSwitch = useCallback(
    async (currentSource: PlaybackSourceCandidate) => {
      const video = videoRef.current;

      try {
        video?.pause();
      } catch {
        // Ignore pause errors during source switching.
      }

      try {
        activeAttachmentRef.current?.destroy();
      } catch (destroyError) {
        console.warn(
          "[Seyirlik Playback] Could not destroy current video attachment before source switch",
          destroyError,
        );
      } finally {
        activeAttachmentRef.current = null;
      }

      try {
        video?.removeAttribute("src");
        video?.load();
      } catch {
        // Ignore media reset errors during source switching.
      }

      if (currentSource.mode === "Transcoding" || currentSource.isHls) {
        try {
          await stopActiveTranscodeSession(currentSource.playSessionId);
        } catch (stopError) {
          console.warn(
            "[Seyirlik Playback] Could not stop active Jellyfin transcode session",
            stopError,
          );
        }
      }
    },
    [],
  );

  const switchPlayerSource = useCallback(
    async (nextSource: PlaybackSourceCandidate) => {
      const video = videoRef.current;

      if (
        nextSource.id === activeSource.id &&
        nextSource.url === activeSource.url
      ) {
        return;
      }

      sourceSwitchTokenRef.current += 1;

      const currentTime = video?.currentTime ?? progress.currentTime;
      const wasPlaying = video
        ? !video.paused && !video.ended
        : progress.isPlaying;

      pendingSourceRestoreRef.current = {
        token: sourceSwitchTokenRef.current,
        currentTime,
        wasPlaying,
      };
      pendingAudioTranscodePlayRef.current = null;
      clearAudioTranscodeReadinessTimer();
      setIsWaitingForAudioTranscodeReady(false);

      setLastVideoError(null);
      revealPlayerChrome();

      await stopCurrentPlaybackForSourceSwitch(activeSource);

      const cacheBustedUrl = (() => {
        try {
          const url = new URL(nextSource.url);
          url.searchParams.set(
            "seyirlikRestart",
            `${Date.now()}-${sourceSwitchTokenRef.current}`,
          );
          return url.toString();
        } catch {
          return nextSource.url;
        }
      })();

      setActiveSource({
        ...nextSource,
        url: cacheBustedUrl,
      });
    },
    [
      activeSource,
      clearAudioTranscodeReadinessTimer,
      progress.currentTime,
      progress.isPlaying,
      revealPlayerChrome,
      stopCurrentPlaybackForSourceSwitch,
    ],
  );

  const buildConfiguredSource = useCallback(
    (
      baseSource: PlaybackSourceCandidate,
      quality?: PlaybackQualityOption,
      audioStreamIndex = selectedAudioStreamIndex,
    ) => {
      const settings: PlaybackSourceSettings = {
        ...getQualitySettings(quality),
        audioStreamIndex,
      };

      return buildConfiguredHlsPlaybackSource(
        baseSource,
        settings,
        quality ? `${quality.label} HLS` : "Auto HLS",
        quality
          ? `Built a Jellyfin HLS URL capped at ${quality.label}.`
          : "Built a Jellyfin HLS URL for the selected audio track.",
      );
    },
    [selectedAudioStreamIndex],
  );

  const handleSelectAutoQuality = useCallback(() => {
    const bestSource = availablePlaybackCandidates[0] ?? source;
    const defaultAudioIndex = getDefaultAudioStreamIndex(item, bestSource);
    let nextSource = bestSource;

    if (canInjectDefaultAudioIntoStreamCopy(bestSource, defaultAudioIndex)) {
      try {
        nextSource = buildConfiguredSource(
          bestSource,
          undefined,
          defaultAudioIndex,
        );
      } catch (switchError) {
        console.warn(
          "[Seyirlik Playback] Could not build Auto quality source with default audio",
          switchError,
        );
      }
    }

    setSelectedQualityId(AUTO_QUALITY_ID);
    setSelectedAudioStreamIndex(defaultAudioIndex);
    setActiveAudioStreamIndex(
      shouldForceDefaultAudioInPlaybackUrl(nextSource) ||
        getStreamsOfType(nextSource, "Audio").length <= 1
        ? defaultAudioIndex
        : undefined,
    );

    void switchPlayerSource(nextSource).catch((switchError: unknown) => {
      console.warn(
        "[Seyirlik Playback] Could not return to Auto quality with default audio",
        switchError,
      );
      void switchPlayerSource(bestSource);
    });
  }, [
    availablePlaybackCandidates,
    buildConfiguredSource,
    item,
    source,
    switchPlayerSource,
  ]);

  const handleSelectQuality = useCallback(
    (quality: PlaybackQualityOption) => {
      let nextSource: PlaybackSourceCandidate;

      try {
        nextSource = buildConfiguredSource(activeSource, quality);
      } catch (switchError) {
        console.warn(
          "[Seyirlik Playback] Could not build quality source",
          switchError,
        );
        return;
      }

      setSelectedQualityId(quality.id);
      setActiveAudioStreamIndex(selectedAudioStreamIndex);

      void switchPlayerSource(nextSource).catch((switchError: unknown) => {
        console.warn(
          "[Seyirlik Playback] Could not switch quality",
          switchError,
        );
      });
    },
    [
      activeSource,
      buildConfiguredSource,
      selectedAudioStreamIndex,
      switchPlayerSource,
    ],
  );

  const handleSelectAudioStream = useCallback(
    (streamIndex: number) => {
      if (!canSwitchAudio) {
        return;
      }

      const video = videoRef.current;
      let shouldDeferActiveAudioUntilSourceSwitch = false;

      if (video && isDirectBrowserPlaybackSource(activeSource)) {
        const syncResult = tryApplyNativeAudioTrack(
          video,
          activeSource,
          streamIndex,
        );

        logAudioSourceDebug(
          "Native audio track switch attempted",
          video,
          activeSource,
          streamIndex,
          { syncResult },
        );

        if (syncResult.succeeded) {
          setSelectedAudioStreamIndex(streamIndex);
          setActiveAudioStreamIndex(streamIndex);
          revealPlayerChrome();
          return;
        }

        const mediaDefaultAudioIndex =
          getMediaSourceDefaultAudioStreamIndex(activeSource);

        if (
          syncResult.reason === "native-audio-tracks-unavailable" &&
          !didUserSelectNonDefaultAudio(streamIndex, mediaDefaultAudioIndex)
        ) {
          setSelectedAudioStreamIndex(streamIndex);
          setActiveAudioStreamIndex(streamIndex);
          console.info(
            "[Seyirlik Playback] Native audioTracks unavailable for the media default track; keeping direct playback.",
            {
              sourceMode: activeSource.mode,
              hlsKind: activeSource.hlsKind,
              selectedAudioStreamIndex: streamIndex,
              mediaDefaultAudioStreamIndex: mediaDefaultAudioIndex,
              nativeAudioTracks: getNativeAudioTrackSnapshot(video),
            },
          );
          revealPlayerChrome();
          return;
        }

        const currentNativeStreamIndex = getNativeActiveAudioStreamIndex(
          video,
          activeSource,
        );
        setActiveAudioStreamIndex(currentNativeStreamIndex);

        if (
          !getAudioFallbackSource(activeSource, availablePlaybackCandidates)
        ) {
          console.warn(
            "[Seyirlik Playback] Native audio switching failed and HLS fallback is unavailable",
            syncResult,
          );
          return;
        }

        shouldDeferActiveAudioUntilSourceSwitch = true;
      }

      const selectedQuality = qualityOptions.find(
        (quality) => quality.id === selectedQualityId,
      );
      const fallbackBaseSource =
        getAudioFallbackSource(activeSource, availablePlaybackCandidates) ??
        activeSource;
      let nextSource: PlaybackSourceCandidate;

      try {
        nextSource = buildConfiguredSource(
          fallbackBaseSource,
          selectedQuality,
          streamIndex,
        );
      } catch (switchError) {
        console.warn(
          "[Seyirlik Playback] Could not build audio stream source",
          switchError,
        );
        return;
      }

      setSelectedAudioStreamIndex(streamIndex);
      setActiveAudioStreamIndex(
        shouldDeferActiveAudioUntilSourceSwitch ? undefined : streamIndex,
      );

      void switchPlayerSource(nextSource).catch((switchError: unknown) => {
        console.warn(
          "[Seyirlik Playback] Could not switch audio stream",
          switchError,
        );
      });
    },
    [
      activeSource,
      availablePlaybackCandidates,
      buildConfiguredSource,
      canSwitchAudio,
      item,
      qualityOptions,
      revealPlayerChrome,
      selectedQualityId,
      switchPlayerSource,
    ],
  );

  const clearFullscreenSeekPreviewFallbackTimer = useCallback(() => {
    if (fullscreenSeekPreviewFallbackTimerRef.current !== null) {
      window.clearTimeout(fullscreenSeekPreviewFallbackTimerRef.current);
      fullscreenSeekPreviewFallbackTimerRef.current = null;
    }
  }, []);

  const hideFullscreenSeekPreviewAfterPaint = useCallback(
    (token: number) => {
      const video = videoRef.current;

      const finish = () => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            const pendingPreview = pendingFullscreenSeekPreviewRef.current;

            if (!pendingPreview || pendingPreview.token !== token) {
              return;
            }

            pendingFullscreenSeekPreviewRef.current = null;
            clearFullscreenSeekPreviewFallbackTimer();
            setFullscreenSeekPreviewSeconds(null);
          });
        });
      };

      const videoWithFrameCallback = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
      };

      if (videoWithFrameCallback?.requestVideoFrameCallback) {
        videoWithFrameCallback.requestVideoFrameCallback(finish);
        return;
      }

      finish();
    },
    [clearFullscreenSeekPreviewFallbackTimer],
  );

  const handleSeekPreview = useCallback(
    (seconds: number) => {
      fullscreenSeekPreviewTokenRef.current += 1;
      const token = fullscreenSeekPreviewTokenRef.current;

      pendingFullscreenSeekPreviewRef.current = {
        token,
        targetSeconds: seconds,
      };

      clearFullscreenSeekPreviewFallbackTimer();
      fullscreenSeekPreviewFallbackTimerRef.current = window.setTimeout(() => {
        const pendingPreview = pendingFullscreenSeekPreviewRef.current;

        if (!pendingPreview || pendingPreview.token !== token) {
          return;
        }

        pendingFullscreenSeekPreviewRef.current = null;
        setFullscreenSeekPreviewSeconds(null);
      }, 3500);

      setFullscreenSeekPreviewSeconds(seconds);
      revealPlayerChrome();
    },
    [clearFullscreenSeekPreviewFallbackTimer, revealPlayerChrome],
  );

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    const handleSeekFrameReady = () => {
      const pendingPreview = pendingFullscreenSeekPreviewRef.current;

      if (!pendingPreview) {
        return;
      }

      const currentTime = Number.isFinite(video.currentTime)
        ? video.currentTime
        : 0;

      if (
        !video.ended &&
        Math.abs(currentTime - pendingPreview.targetSeconds) > 1.5
      ) {
        return;
      }

      hideFullscreenSeekPreviewAfterPaint(pendingPreview.token);
    };

    video.addEventListener("seeked", handleSeekFrameReady);
    video.addEventListener("canplay", handleSeekFrameReady);
    video.addEventListener("playing", handleSeekFrameReady);

    return () => {
      video.removeEventListener("seeked", handleSeekFrameReady);
      video.removeEventListener("canplay", handleSeekFrameReady);
      video.removeEventListener("playing", handleSeekFrameReady);
    };
  }, [hideFullscreenSeekPreviewAfterPaint]);

  const handleSelectSubtitleStream = useCallback(
    (streamIndex: number) => {
      setActiveSubtitleText("");
      setSelectedSubtitleStreamIndex(streamIndex);
      revealPlayerChrome();
    },
    [revealPlayerChrome],
  );

  useEffect(() => {
    const video = videoRef.current;
    const sourceToAttach = activeSource;
    const selectedAudioIndexForSource =
      selectedAudioStreamIndex ??
      getDefaultAudioStreamIndex(item, sourceToAttach);

    if (!video) {
      return undefined;
    }

    hasStartedRef.current = false;
    lastProgressReportRef.current = 0;

    let attachment: AttachedVideoSource | undefined;
    let didRestore = false;
    let didRequestAudioFallback = false;
    let isDisposed = false;
    const pendingRestore = pendingSourceRestoreRef.current;
    const selectedQuality = qualityOptions.find(
      (quality) => quality.id === selectedQualityId,
    );

    const applyInitialStartPosition = () => {
      if (pendingRestore || hasAppliedInitialStartRef.current) {
        return;
      }

      hasAppliedInitialStartRef.current = true;

      const safeStartSeconds = Number.isFinite(initialStartSeconds)
        ? Math.max(0, initialStartSeconds)
        : 0;

      if (safeStartSeconds <= 0) {
        latestPlaybackPositionRef.current = 0;
        return;
      }

      try {
        const maxTime =
          Number.isFinite(video.duration) && video.duration > 0
            ? Math.max(0, video.duration - 0.25)
            : safeStartSeconds;

        const nextTime = Math.min(safeStartSeconds, maxTime);
        video.currentTime = nextTime;
        latestPlaybackPositionRef.current = nextTime;
      } catch (seekError) {
        console.warn(
          "[Seyirlik Playback] Could not apply saved playback position",
          seekError,
        );
      }
    };

    const requestPlayWhenAudioTranscodeReady = (
      reason: string,
      wasPlaying = true,
    ) => {
      if (!isAudioTranscodeSource(sourceToAttach)) {
        if (wasPlaying) {
          void video.play().catch((playError: unknown) => {
            console.info(
              "[Seyirlik Playback] Playback was blocked or deferred",
              playError,
            );
          });
        }
        return;
      }

      const token = sourceSwitchTokenRef.current;
      const existingPending = pendingAudioTranscodePlayRef.current;

      pendingAudioTranscodePlayRef.current =
        existingPending &&
        existingPending.token === token &&
        existingPending.reason === reason
          ? { ...existingPending, wasPlaying }
          : {
              token,
              reason,
              wasPlaying,
              startedAt: Date.now(),
            };
      setIsWaitingForAudioTranscodeReady(wasPlaying);

      const tryStart = () => {
        const pending = pendingAudioTranscodePlayRef.current;

        if (
          isDisposed ||
          !pending ||
          pending.token !== token ||
          pending.token !== sourceSwitchTokenRef.current
        ) {
          return;
        }

        if (!pending.wasPlaying) {
          pendingAudioTranscodePlayRef.current = null;
          clearAudioTranscodeReadinessTimer();
          setIsWaitingForAudioTranscodeReady(false);
          video.pause();
          return;
        }

        if (Date.now() - pending.startedAt > 7000) {
          pendingAudioTranscodePlayRef.current = null;
          clearAudioTranscodeReadinessTimer();
          setIsWaitingForAudioTranscodeReady(false);
          console.warn(
            "[Seyirlik Playback] Audio-transcode readiness wait timed out; starting anyway",
            {
              reason: pending.reason,
              readyState: video.readyState,
              currentTime: video.currentTime,
              buffered: Array.from(
                { length: video.buffered.length },
                (_, index) => ({
                  start: video.buffered.start(index),
                  end: video.buffered.end(index),
                }),
              ),
              source: {
                mode: sourceToAttach.mode,
                hlsKind: sourceToAttach.hlsKind,
                url: redactPlaybackUrl(sourceToAttach.url),
              },
            },
          );
          void video.play().catch((playError: unknown) => {
            console.info(
              "[Seyirlik Playback] Audio-transcode playback was blocked or deferred",
              playError,
            );
          });
          return;
        }

        if (!isVideoReadyForAudioTranscodePlayback(video)) {
          clearAudioTranscodeReadinessTimer();

          audioTranscodeReadinessTimerRef.current = window.setTimeout(() => {
            tryStart();
          }, 120);

          return;
        }

        pendingAudioTranscodePlayRef.current = null;
        clearAudioTranscodeReadinessTimer();
        setIsWaitingForAudioTranscodeReady(false);

        console.info(
          "[Seyirlik Playback] Audio-transcode HLS is ready; starting playback",
          {
            reason: pending.reason,
            readyState: video.readyState,
            currentTime: video.currentTime,
            buffered: Array.from(
              { length: video.buffered.length },
              (_, index) => ({
                start: video.buffered.start(index),
                end: video.buffered.end(index),
              }),
            ),
            source: {
              mode: sourceToAttach.mode,
              hlsKind: sourceToAttach.hlsKind,
              url: redactPlaybackUrl(sourceToAttach.url),
            },
          },
        );

        void video.play().catch((playError: unknown) => {
          console.info(
            "[Seyirlik Playback] Audio-transcode playback was blocked or deferred",
            playError,
          );
        });
      };

      clearAudioTranscodeReadinessTimer();
      tryStart();
    };

    const retryPendingAudioTranscodePlay = () => {
      const pending = pendingAudioTranscodePlayRef.current;

      if (!pending || pending.token !== sourceSwitchTokenRef.current) {
        return;
      }

      requestPlayWhenAudioTranscodeReady(pending.reason, pending.wasPlaying);
    };

    let wasPlayingBeforeAudioTranscodeSeek = false;

    const handleAudioTranscodeSeeking = () => {
      if (!isAudioTranscodeSource(sourceToAttach)) {
        return;
      }

      wasPlayingBeforeAudioTranscodeSeek = !video.paused && !video.ended;

      if (wasPlayingBeforeAudioTranscodeSeek) {
        video.pause();
      }

      pendingAudioTranscodePlayRef.current = {
        token: sourceSwitchTokenRef.current,
        reason: "seek-audio-transcode-buffering",
        wasPlaying: wasPlayingBeforeAudioTranscodeSeek,
        startedAt: Date.now(),
      };
      setIsWaitingForAudioTranscodeReady(wasPlayingBeforeAudioTranscodeSeek);

      console.info(
        "[Seyirlik Playback] Waiting for audio-transcode HLS after seek",
        {
          currentTime: video.currentTime,
          wasPlayingBeforeSeek: wasPlayingBeforeAudioTranscodeSeek,
          readyState: video.readyState,
          bufferedLength: video.buffered.length,
        },
      );
    };

    const handleAudioTranscodeSeeked = () => {
      if (!isAudioTranscodeSource(sourceToAttach)) {
        return;
      }

      requestPlayWhenAudioTranscodeReady(
        "seeked-audio-transcode-buffering",
        wasPlayingBeforeAudioTranscodeSeek,
      );
    };

    const restorePlayback = () => {
      if (
        !pendingRestore ||
        didRestore ||
        pendingRestore.token !== sourceSwitchTokenRef.current
      ) {
        return;
      }

      didRestore = true;

      try {
        if (pendingRestore.currentTime > 0) {
          const maxTime =
            Number.isFinite(video.duration) && video.duration > 0
              ? Math.max(0, video.duration - 0.25)
              : pendingRestore.currentTime;
          video.currentTime = Math.min(pendingRestore.currentTime, maxTime);
        }
      } catch (seekError) {
        console.warn(
          "[Seyirlik Playback] Could not restore playback position after source switch",
          seekError,
        );
      }

      pendingSourceRestoreRef.current = null;

      if (pendingRestore.wasPlaying) {
        requestPlayWhenAudioTranscodeReady(
          "restore-playback-after-source-switch",
          true,
        );
      } else {
        pendingAudioTranscodePlayRef.current = null;
        clearAudioTranscodeReadinessTimer();
        setIsWaitingForAudioTranscodeReady(false);
        video.pause();
      }

      refreshProgress();
    };

    const requestHlsAudioFallback = (reason: string) => {
      const fallbackBaseSource = getAudioFallbackSource(
        sourceToAttach,
        availablePlaybackCandidates,
      );

      if (
        didRequestAudioFallback ||
        isDisposed ||
        selectedAudioIndexForSource === undefined ||
        !fallbackBaseSource
      ) {
        return;
      }

      didRequestAudioFallback = true;

      let fallbackSource: PlaybackSourceCandidate;

      try {
        fallbackSource = buildConfiguredSource(
          fallbackBaseSource,
          selectedQuality,
          selectedAudioIndexForSource,
        );
      } catch (fallbackError) {
        console.warn(
          "[Seyirlik Playback] Could not build HLS fallback for default audio",
          fallbackError,
        );
        return;
      }

      setSelectedAudioStreamIndex(selectedAudioIndexForSource);
      setActiveAudioStreamIndex(undefined);

      console.info("[Seyirlik Playback] Falling back to HLS for audio track", {
        reason,
        selectedAudioStreamIndex: selectedAudioIndexForSource,
        sourceMode: sourceToAttach.mode,
        sourceUrl: redactPlaybackUrl(sourceToAttach.url),
        fallbackUrl: redactPlaybackUrl(fallbackSource.url),
      });

      void switchPlayerSource(fallbackSource).catch((switchError: unknown) => {
        console.warn(
          "[Seyirlik Playback] Could not switch to HLS fallback for audio track",
          switchError,
        );
        setActiveAudioStreamIndex(
          getNativeActiveAudioStreamIndex(video, sourceToAttach),
        );
      });
    };

    const syncNativeAudioTrack = (eventName: string) => {
      if (isDisposed || didRequestAudioFallback) {
        return;
      }

      const audioStreamCount = getStreamsOfType(sourceToAttach, "Audio").length;

      if (!isDirectBrowserPlaybackSource(sourceToAttach)) {
        setActiveAudioStreamIndex(selectedAudioIndexForSource);
        logAudioSourceDebug(
          `Audio source attached (${eventName})`,
          video,
          sourceToAttach,
          selectedAudioIndexForSource,
          { syncResult: { reason: "hls-or-transcoded-source" } },
        );
        return;
      }

      if (audioStreamCount <= 1) {
        setActiveAudioStreamIndex(selectedAudioIndexForSource);
        logAudioSourceDebug(
          `Audio source attached (${eventName})`,
          video,
          sourceToAttach,
          selectedAudioIndexForSource,
          { syncResult: { reason: "single-audio-stream" } },
        );
        return;
      }

      const syncResult = tryApplyNativeAudioTrack(
        video,
        sourceToAttach,
        selectedAudioIndexForSource,
      );

      const currentNativeStreamIndex = syncResult.succeeded
        ? selectedAudioIndexForSource
        : getNativeActiveAudioStreamIndex(video, sourceToAttach);

      setActiveAudioStreamIndex(
        currentNativeStreamIndex ?? selectedAudioIndexForSource,
      );

      logAudioSourceDebug(
        `Native audio sync (${eventName})`,
        video,
        sourceToAttach,
        selectedAudioIndexForSource,
        { syncResult, currentNativeStreamIndex },
      );

      if (syncResult.succeeded) {
        return;
      }

      const mediaDefaultAudioIndex =
        getMediaSourceDefaultAudioStreamIndex(sourceToAttach);
      const userNeedsDifferentAudio = didUserSelectNonDefaultAudio(
        selectedAudioIndexForSource,
        mediaDefaultAudioIndex,
      );
      const nativeAudioControlUnavailable =
        syncResult.reason === "native-audio-tracks-unavailable" ||
        syncResult.reason === "native-track-match-not-found";

      if (!userNeedsDifferentAudio && nativeAudioControlUnavailable) {
        setActiveAudioStreamIndex(
          mediaDefaultAudioIndex ?? selectedAudioIndexForSource,
        );
        console.info(
          "[Seyirlik Playback] Preserving DirectPlay because native audioTracks are unavailable and the default audio should already be selected by the media element",
          {
            reason: syncResult.reason,
            eventName,
            sourceMode: sourceToAttach.mode,
            hlsKind: sourceToAttach.hlsKind,
            selectedAudioStreamIndex: selectedAudioIndexForSource,
            mediaDefaultAudioStreamIndex: mediaDefaultAudioIndex,
            audioStreamCount,
            nativeAudioTracks: getNativeAudioTrackSnapshot(video),
          },
        );
        return;
      }

      if (userNeedsDifferentAudio) {
        requestHlsAudioFallback(syncResult.reason);
        return;
      }

      console.info(
        "[Seyirlik Playback] Keeping direct playback; native audioTracks unavailable is not a playback failure",
        {
          reason: syncResult.reason,
          eventName,
          sourceMode: sourceToAttach.mode,
          hlsKind: sourceToAttach.hlsKind,
          selectedAudioStreamIndex: selectedAudioIndexForSource,
          mediaDefaultAudioStreamIndex: mediaDefaultAudioIndex,
          audioStreamCount,
          nativeAudioTracks: getNativeAudioTrackSnapshot(video),
        },
      );
    };

    const handleLoadedMetadataAudio = () =>
      syncNativeAudioTrack("loadedmetadata");
    const handleLoadedDataAudio = () => syncNativeAudioTrack("loadeddata");
    const handleCanPlayAudio = () => syncNativeAudioTrack("canplay");
    const handleDurationChangeAudio = () =>
      syncNativeAudioTrack("durationchange");
    let startupWatchdogTimer: number | null = null;
    let hasStartupPlaybackSignal = false;

    const clearStartupWatchdog = () => {
      if (startupWatchdogTimer === null) {
        return;
      }

      window.clearTimeout(startupWatchdogTimer);
      startupWatchdogTimer = null;
    };

    const markStartupPlaybackSignal = () => {
      if (
        isAudioTranscodeSource(sourceToAttach) &&
        !isVideoReadyForAudioTranscodePlayback(video)
      ) {
        return;
      }

      hasStartupPlaybackSignal = true;
      clearStartupWatchdog();
    };

    const handleStartupTimeUpdate = () => {
      if (video.currentTime > 0) {
        markStartupPlaybackSignal();
      }
    };

    const handleStartupError = () => {
      clearStartupWatchdog();
    };

    const startStartupWatchdog = () => {
      clearStartupWatchdog();

      startupWatchdogTimer = window.setTimeout(() => {
        if (isDisposed || hasStartupPlaybackSignal || video.currentTime > 0) {
          return;
        }

        if (
          isAudioTranscodeSource(sourceToAttach) &&
          pendingAudioTranscodePlayRef.current
        ) {
          console.info(
            "[Seyirlik Playback] Startup watchdog extended while waiting for audio-transcode readiness",
            {
              readyState: video.readyState,
              currentTime: video.currentTime,
              bufferedLength: video.buffered.length,
              source: {
                mode: sourceToAttach.mode,
                hlsKind: sourceToAttach.hlsKind,
                url: redactPlaybackUrl(sourceToAttach.url),
              },
            },
          );

          startStartupWatchdog();
          return;
        }

        const detailsPayload = {
          message:
            "HLS attached but playback did not start within startup watchdog timeout.",
          source: {
            mode: sourceToAttach.mode,
            isHls: sourceToAttach.isHls,
            hlsKind: sourceToAttach.hlsKind,
            usingHlsJs: attachment?.usingHlsJs ?? sourceToAttach.usingHlsJs,
            url: redactPlaybackUrl(sourceToAttach.url),
            urlParams: getPlaybackUrlDebugParams(sourceToAttach.url),
          },
          video: {
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            currentTime: video.currentTime,
            duration: Number.isFinite(video.duration) ? video.duration : null,
          },
        };
        const details = JSON.stringify(detailsPayload, null, 2);

        console.warn(
          "[Seyirlik Playback] Startup watchdog detected stalled playback",
          detailsPayload,
        );
        setLastVideoError(details);
        onVideoFailure(details);
      }, STARTUP_WATCHDOG_MS);
    };

    try {
      const sourceUrlParams = getPlaybackUrlDebugParams(sourceToAttach.url);

      if (
        sourceToAttach.mode === "Transcoding" &&
        isMasterHlsPlaybackUrl(sourceToAttach.url) &&
        String(sourceUrlParams.EnableAutoStreamCopy).toLowerCase() === "true"
      ) {
        console.warn(
          "[Seyirlik Playback] Bad mixed transcoding/stream-copy source detected",
          {
            mode: sourceToAttach.mode,
            isHls: sourceToAttach.isHls,
            hlsKind: sourceToAttach.hlsKind,
            url: redactPlaybackUrl(sourceToAttach.url),
            urlParams: sourceUrlParams,
          },
        );
      }

      attachment = attachSourceToVideo(
        video,
        sourceToAttach.url,
        sourceToAttach.mimeType,
      );
      activeAttachmentRef.current = attachment;

      setActiveSource((currentSource) =>
        currentSource.id === sourceToAttach.id &&
        currentSource.url === sourceToAttach.url
          ? { ...currentSource, usingHlsJs: attachment?.usingHlsJs }
          : currentSource,
      );
      console.info("[Seyirlik Playback] Attached playback source", {
        mode: sourceToAttach.mode,
        isHls: sourceToAttach.isHls,
        hlsKind: sourceToAttach.hlsKind,
        usingHlsJs: attachment?.usingHlsJs,
        url: redactPlaybackUrl(sourceToAttach.url),
        urlParams: sourceUrlParams,
      });
      video.addEventListener("loadedmetadata", applyInitialStartPosition);
      video.addEventListener("canplay", applyInitialStartPosition);
      video.addEventListener("loadedmetadata", restorePlayback);
      video.addEventListener("canplay", restorePlayback);
      video.addEventListener("loadedmetadata", handleLoadedMetadataAudio);
      video.addEventListener("loadeddata", handleLoadedDataAudio);
      video.addEventListener("canplay", handleCanPlayAudio);
      video.addEventListener("durationchange", handleDurationChangeAudio);
      video.addEventListener("loadedmetadata", retryPendingAudioTranscodePlay);
      video.addEventListener("loadeddata", retryPendingAudioTranscodePlay);
      video.addEventListener("canplay", retryPendingAudioTranscodePlay);
      video.addEventListener("canplaythrough", retryPendingAudioTranscodePlay);
      video.addEventListener("progress", retryPendingAudioTranscodePlay);
      video.addEventListener("durationchange", retryPendingAudioTranscodePlay);
      video.addEventListener("seeking", handleAudioTranscodeSeeking);
      video.addEventListener("seeked", handleAudioTranscodeSeeked);
      video.addEventListener("loadeddata", markStartupPlaybackSignal);
      video.addEventListener("canplay", markStartupPlaybackSignal);
      video.addEventListener("playing", markStartupPlaybackSignal);
      video.addEventListener("timeupdate", handleStartupTimeUpdate);
      video.addEventListener("error", handleStartupError);
      syncNativeAudioTrack("source-attached");
      video.load();
      startStartupWatchdog();
      if (!pendingRestore && !partyWatch.shouldDeferAutoplay) {
        requestPlayWhenAudioTranscodeReady("initial-autoplay", true);
      }
    } catch (attachError) {
      onVideoFailure(
        attachError instanceof Error
          ? attachError.message
          : String(attachError),
      );
    }

    return () => {
      isDisposed = true;
      clearStartupWatchdog();
      pendingAudioTranscodePlayRef.current = null;
      clearAudioTranscodeReadinessTimer();
      setIsWaitingForAudioTranscodeReady(false);
      video.removeEventListener("loadedmetadata", applyInitialStartPosition);
      video.removeEventListener("canplay", applyInitialStartPosition);
      video.removeEventListener("loadedmetadata", restorePlayback);
      video.removeEventListener("canplay", restorePlayback);
      video.removeEventListener("loadedmetadata", handleLoadedMetadataAudio);
      video.removeEventListener("loadeddata", handleLoadedDataAudio);
      video.removeEventListener("canplay", handleCanPlayAudio);
      video.removeEventListener("durationchange", handleDurationChangeAudio);
      video.removeEventListener(
        "loadedmetadata",
        retryPendingAudioTranscodePlay,
      );
      video.removeEventListener("loadeddata", retryPendingAudioTranscodePlay);
      video.removeEventListener("canplay", retryPendingAudioTranscodePlay);
      video.removeEventListener(
        "canplaythrough",
        retryPendingAudioTranscodePlay,
      );
      video.removeEventListener("progress", retryPendingAudioTranscodePlay);
      video.removeEventListener(
        "durationchange",
        retryPendingAudioTranscodePlay,
      );
      video.removeEventListener("seeking", handleAudioTranscodeSeeking);
      video.removeEventListener("seeked", handleAudioTranscodeSeeked);
      video.removeEventListener("loadeddata", markStartupPlaybackSignal);
      video.removeEventListener("canplay", markStartupPlaybackSignal);
      video.removeEventListener("playing", markStartupPlaybackSignal);
      video.removeEventListener("timeupdate", handleStartupTimeUpdate);
      video.removeEventListener("error", handleStartupError);

      if (activeAttachmentRef.current === attachment) {
        activeAttachmentRef.current = null;
      }

      try {
        attachment?.destroy();
      } catch (destroyError) {
        console.warn(
          "[Seyirlik Playback] Could not destroy video attachment during cleanup",
          destroyError,
        );
      }
    };
  }, [
    activeSource.id,
    activeSource.hlsKind,
    activeSource.isHls,
    activeSource.mimeType,
    activeSource.mode,
    activeSource.url,
    clearAudioTranscodeReadinessTimer,
    initialStartSeconds,
    item,
    onVideoFailure,
    partyWatch.shouldDeferAutoplay,
    refreshProgress,
  ]);

  useEffect(() => {
    return () => {
      clearFullscreenSeekPreviewFallbackTimer();
      clearSeekFeedbackTimers();
      clearSeekFeedbackSpinTimers();

      if (seekFeedbackChromeHideTimerRef.current !== null) {
        window.clearTimeout(seekFeedbackChromeHideTimerRef.current);
        seekFeedbackChromeHideTimerRef.current = null;
      }

      resetTouchSeekSession();

      pendingAudioTranscodePlayRef.current = null;
      clearAudioTranscodeReadinessTimer();
      setIsWaitingForAudioTranscodeReady(false);

      reportStoppedOnce(false);
    };
  }, [
    clearAudioTranscodeReadinessTimer,
    clearFullscreenSeekPreviewFallbackTimer,
    clearSeekFeedbackSpinTimers,
    clearSeekFeedbackTimers,
    reportStoppedOnce,
    resetTouchSeekSession,
  ]);

  useEffect(() => {
    const handlePageExit = () => {
      reportStoppedOnce(true);
    };

    window.addEventListener("pagehide", handlePageExit);
    window.addEventListener("beforeunload", handlePageExit);

    return () => {
      window.removeEventListener("pagehide", handlePageExit);
      window.removeEventListener("beforeunload", handlePageExit);
    };
  }, [reportStoppedOnce]);

  useEffect(() => {
    setActiveSubtitleText("");
    setSubtitleCues([]);

    if (selectedSubtitleStreamIndex < 0 || !activeSource.mediaSourceId) {
      return undefined;
    }

    const subtitleStream = getStreamByIndex(
      activeSource,
      "Subtitle",
      selectedSubtitleStreamIndex,
    );

    if (!subtitleStream) {
      return undefined;
    }

    const abortController = new AbortController();
    const subtitleUrl = buildSubtitleStreamUrl(
      activeSource.itemId,
      activeSource.mediaSourceId,
      selectedSubtitleStreamIndex,
    );

    const loadSubtitleCues = async () => {
      try {
        const response = await fetch(subtitleUrl, {
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`Subtitle request failed with ${response.status}`);
        }

        const subtitleText = await response.text();

        if (!abortController.signal.aborted) {
          setSubtitleCues(parseSubtitleCues(subtitleText));
        }
      } catch (subtitleError) {
        if (!abortController.signal.aborted) {
          console.warn(
            "[Seyirlik Subtitles] Could not load subtitle stream",
            subtitleError,
          );
        }
      }
    };

    void loadSubtitleCues();

    return () => {
      abortController.abort();
    };
  }, [
    activeSource.itemId,
    activeSource.mediaSource,
    activeSource.mediaSourceId,
    selectedSubtitleStreamIndex,
  ]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || subtitleCues.length === 0) {
      setActiveSubtitleText("");
      return undefined;
    }

    const syncSubtitleText = () => {
      const nextSubtitleText = getActiveSubtitleTextForTime(
        subtitleCues,
        video.currentTime - subtitleDelaySeconds,
      );
      setActiveSubtitleText((currentSubtitleText) =>
        currentSubtitleText === nextSubtitleText
          ? currentSubtitleText
          : nextSubtitleText,
      );
    };

    syncSubtitleText();

    video.addEventListener("loadedmetadata", syncSubtitleText);
    video.addEventListener("play", syncSubtitleText);
    video.addEventListener("pause", syncSubtitleText);
    video.addEventListener("seeking", syncSubtitleText);
    video.addEventListener("seeked", syncSubtitleText);
    video.addEventListener("timeupdate", syncSubtitleText);

    const intervalId = window.setInterval(syncSubtitleText, 120);

    return () => {
      video.removeEventListener("loadedmetadata", syncSubtitleText);
      video.removeEventListener("play", syncSubtitleText);
      video.removeEventListener("pause", syncSubtitleText);
      video.removeEventListener("seeking", syncSubtitleText);
      video.removeEventListener("seeked", syncSubtitleText);
      video.removeEventListener("timeupdate", syncSubtitleText);
      window.clearInterval(intervalId);
    };
  }, [subtitleCues, subtitleDelaySeconds]);

  const handleVideoPlay = () => {
    if (!hasStartedRef.current) {
      hasStartedRef.current = true;
      onPlaybackStarted?.(videoRef.current?.currentTime ?? 0);
    }
  };

  const handleVideoPause = () => {
    const positionSeconds = updateLatestPlaybackPosition();
    onPlaybackProgress?.(positionSeconds, true);
  };

  const handleVideoSeeked = () => {
    updateLatestPlaybackPosition();
  };

  const handleTimeUpdate = () => {
    const positionSeconds = updateLatestPlaybackPosition();
    const now = Date.now();

    if (now - lastProgressReportRef.current < 15_000) {
      return;
    }

    lastProgressReportRef.current = now;
    onPlaybackProgress?.(positionSeconds, false);
  };

  const handleVideoError = () => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const details = getVideoErrorDetails(video, activeSource);
    setLastVideoError(details);
    console.error("[Seyirlik Playback] video element error", details);
    onVideoFailure(details);
  };

  const getTouchSeekSide = (clientX: number): TouchSeekSide | null => {
    const bounds = containerRef.current?.getBoundingClientRect();

    if (!bounds) {
      return null;
    }

    return clientX - bounds.left < bounds.width / 2 ? "left" : "right";
  };

  const scheduleTouchSeekSessionExpiry = () => {
    clearTouchSeekSessionTimeout();

    touchSeekSessionRef.current.timeoutId = window.setTimeout(() => {
      touchSeekSessionRef.current.lastTapTime = 0;
      touchSeekSessionRef.current.lastTapSide = null;
      touchSeekSessionRef.current.isActive = false;
      touchSeekSessionRef.current.accumulatedSeconds = 0;
      touchSeekSessionRef.current.timeoutId = null;
    }, TOUCH_SEEK_SESSION_TIMEOUT_MS);
  };

  const seekByTouchSide = (side: TouchSeekSide, now: number) => {
    const seconds = side === "left" ? -5 : 5;
    const session = touchSeekSessionRef.current;
    const isContinuingSameSide = session.lastTapSide === side;

    session.lastTapTime = now;
    session.lastTapSide = side;
    session.isActive = true;
    // The video seek uses only this tap's delta; feedback state accumulates
    // separately, while this ref keeps the session's direction/total current.
    session.accumulatedSeconds = isContinuingSameSide
      ? session.accumulatedSeconds + seconds
      : seconds;

    handleSeekBy(seconds);
    scheduleTouchSeekSessionExpiry();
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>): boolean => {
    if (
      isDraggingSubtitle ||
      isResizingSubtitle ||
      Date.now() < suppressPlayerTapUntilRef.current
    ) {
      return false;
    }

    const target = event.target as HTMLElement | null;

    const tappedInteractiveElement = target?.closest(
      "button, a, input, [role='slider'], [data-player-settings-root], [data-party-watch-root], [data-subtitle-editor-root]",
    );

    if (tappedInteractiveElement) {
      return false;
    }

    if (event.pointerType !== "touch") {
      return false;
    }

    const now = Date.now();
    const tappedSide = getTouchSeekSide(event.clientX);

    if (!tappedSide) {
      return false;
    }

    const session = touchSeekSessionRef.current;

    if (session.isActive) {
      if (session.lastTapSide === tappedSide) {
        clearSingleTapTimer();
        event.preventDefault();
        seekByTouchSide(tappedSide, now);
        return true;
      }

      resetTouchSeekSession();
    }

    if (
      touchSeekSessionRef.current.lastTapSide === tappedSide &&
      now - touchSeekSessionRef.current.lastTapTime <
        TOUCH_DOUBLE_TAP_THRESHOLD_MS
    ) {
      clearSingleTapTimer();
      event.preventDefault();
      touchSeekSessionRef.current.accumulatedSeconds = 0;
      seekByTouchSide(tappedSide, now);
      return true;
    }

    resetTouchSeekSession();
    touchSeekSessionRef.current.lastTapTime = now;
    touchSeekSessionRef.current.lastTapSide = tappedSide;

    singleTapTimerRef.current = window.setTimeout(() => {
      if (isViewModeEnabled) {
        partyWatch.togglePlay();
        singleTapTimerRef.current = null;
        return;
      }

      if (
        areControlsVisible ||
        controlsShouldStayVisible ||
        !progress.isPlaying
      ) {
        releaseControlsHover();
      } else {
        showControls();
      }

      singleTapTimerRef.current = null;
    }, TOUCH_SINGLE_TAP_DELAY_MS);

    return false;
  };

  const handlePlayerOverlayToggle = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        isDraggingSubtitle ||
        isResizingSubtitle ||
        Date.now() < suppressPlayerTapUntilRef.current
      ) {
        return;
      }

      const target = event.target as HTMLElement | null;

      const tappedInteractiveElement = target?.closest(
        "button, a, input, [role='slider'], [data-player-settings-root], [data-party-watch-root], [data-subtitle-editor-root]",
      );

      if (tappedInteractiveElement) {
        return;
      }

      if (isViewModeEnabled) {
        if (event.pointerType !== "touch") {
          partyWatch.togglePlay();
        }

        return;
      }

      if (shouldShowPlayerChrome) {
        setIsSettingsOpen(false);
        setIsPlaybackInfoOpen(false);
        setIsPartyWatchOpen(false);
        setIsSubtitleEditMode(false);
        setAreControlsManuallyHidden(true);
        releaseControlsHover();
        return;
      }

      revealPlayerChrome();
    },
    [
      isDraggingSubtitle,
      isResizingSubtitle,
      isViewModeEnabled,
      partyWatch,
      releaseControlsHover,
      revealPlayerChrome,
      shouldShowPlayerChrome,
    ],
  );

  const handlePlayerMouseMove = useCallback(() => {
    if (isViewModeEnabled) {
      revealViewModeCursor();
      return;
    }

    revealPlayerChrome();
  }, [isViewModeEnabled, revealPlayerChrome, revealViewModeCursor]);

  const releaseTouchFocusAndControlsHover = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch") {
        return;
      }

      const activeElement = document.activeElement;

      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }

      window.setTimeout(() => {
        releaseControlsHover();
      }, 120);
    },
    [releaseControlsHover],
  );

  const getSubtitlePositionFromPoint = useCallback(
    (clientX: number, clientY: number): SubtitlePosition | null => {
      const bounds = containerRef.current?.getBoundingClientRect();
      const dragState = subtitleDragStateRef.current;

      if (!bounds || !dragState) {
        return null;
      }

      return {
        x: clamp(
          ((clientX - bounds.left - dragState.offsetX) / bounds.width) * 100,
          8,
          92,
        ),
        y: clamp(
          ((clientY - bounds.top - dragState.offsetY) / bounds.height) * 100,
          10,
          90,
        ),
      };
    },
    [],
  );

  const handleSubtitleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    startSubtitleEditMode();
  };

  const handleSubtitleResizePointerDown = (
    event: PointerEvent<HTMLButtonElement>,
    directionX: -1 | 1,
    directionY: -1 | 1,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    event.currentTarget.setPointerCapture(event.pointerId);

    subtitleResizeStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScale: subtitleSize.scale,
      directionX,
      directionY,
    };

    setIsSubtitleEditMode(true);
    setIsResizingSubtitle(true);
    setIsDraggingSubtitle(false);
    subtitleDragStateRef.current = null;
    resetTouchSeekSession();
    revealPlayerChrome();
  };

  const handleSubtitleResizePointerMove = (
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    const resizeState = subtitleResizeStateRef.current;

    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const deltaX =
      (event.clientX - resizeState.startClientX) * resizeState.directionX;
    const deltaY =
      (event.clientY - resizeState.startClientY) * resizeState.directionY;
    const strongestDelta =
      Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    const nextScale = clamp(
      resizeState.startScale + strongestDelta / 220,
      MIN_SUBTITLE_SCALE,
      MAX_SUBTITLE_SCALE,
    );

    setSubtitleSize({ scale: nextScale });
  };

  const finishSubtitleResize = (event: PointerEvent<HTMLButtonElement>) => {
    const resizeState = subtitleResizeStateRef.current;

    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    subtitleResizeStateRef.current = null;
    setIsResizingSubtitle(false);
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    resetTouchSeekSession();
  };

  const handleSubtitleResizePointerCancel = (
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    if (subtitleResizeStateRef.current?.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    subtitleResizeStateRef.current = null;
    setIsResizingSubtitle(false);
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    resetTouchSeekSession();
  };

  const handleSubtitlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!isSubtitleEditMode) {
      return;
    }

    const bounds = containerRef.current?.getBoundingClientRect();
    const overlayBounds = subtitleOverlayRef.current?.getBoundingClientRect();

    if (!bounds || !overlayBounds) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const overlayCenterX = overlayBounds.left + overlayBounds.width / 2;
    const overlayCenterY = overlayBounds.top + overlayBounds.height / 2;

    subtitleDragStateRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - overlayCenterX,
      offsetY: event.clientY - overlayCenterY,
    };

    setSubtitlePosition(
      (currentPosition) =>
        currentPosition ?? {
          x: clamp(
            ((overlayCenterX - bounds.left) / bounds.width) * 100,
            8,
            92,
          ),
          y: clamp(
            ((overlayCenterY - bounds.top) / bounds.height) * 100,
            10,
            90,
          ),
        },
    );
    setIsDraggingSubtitle(true);
    setIsResizingSubtitle(false);
    subtitleResizeStateRef.current = null;
    resetTouchSeekSession();
    revealPlayerChrome();
  };

  const handleSubtitlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = subtitleDragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const nextPosition = getSubtitlePositionFromPoint(
      event.clientX,
      event.clientY,
    );

    if (nextPosition) {
      setSubtitlePosition(nextPosition);
    }
  };

  const finishSubtitleDrag = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = subtitleDragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const nextPosition = getSubtitlePositionFromPoint(
      event.clientX,
      event.clientY,
    );

    if (nextPosition) {
      setSubtitlePosition(nextPosition);
    }

    subtitleDragStateRef.current = null;
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    setIsDraggingSubtitle(false);
    resetTouchSeekSession();
  };

  const handleSubtitlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (subtitleDragStateRef.current?.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    subtitleDragStateRef.current = null;
    suppressPlayerTapUntilRef.current = Date.now() + 450;
    setIsDraggingSubtitle(false);
    setIsResizingSubtitle(false);
    resetTouchSeekSession();
  };

  const subtitle = getItemSubtitle(item, mediaFormatLabels);
  const titleLogoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 900)
    : "";
  const isSubtitleBeingEdited =
    isDraggingSubtitle || isResizingSubtitle || isSubtitleEditMode;
  const isShowingSubtitlePlaceholder =
    isSubtitleBeingEdited && activeSubtitleText.trim().length === 0;

  const subtitleLines = (
    isShowingSubtitlePlaceholder
      ? t("player.subtitleEditPlaceholder")
      : activeSubtitleText
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const subtitleOverlayStyle = subtitlePosition
    ? {
        left: `${subtitlePosition.x}%`,
        top: `${subtitlePosition.y}%`,
        transform: `translate(-50%, -50%) scale(${subtitleSize.scale})`,
      }
    : {
        transform: `translateX(-50%) scale(${subtitleSize.scale})`,
      };
  const isCenterPlayPauseLoading =
    (progress.isBuffering ||
      isWaitingForAudioTranscodeReady ||
      fullscreenSeekPreview !== null) &&
    !error;
  const isCompactPhonePlayer =
    Math.min(viewport.width, viewport.height) <= 520 &&
    Math.max(viewport.width, viewport.height) <= 980;
  const shouldRotatePortraitPlayer =
    viewport.isPortrait && isCompactPhonePlayer;
  const seekPointerAxis = shouldRotatePortraitPlayer
    ? portraitPlayerRotation === 90
      ? "vertical-forward"
      : "vertical-reverse"
    : "horizontal";
  const portraitPlayerStyle = shouldRotatePortraitPlayer
    ? ({
        "--seyirlik-player-rotation": `${portraitPlayerRotation}deg`,
      } as CSSProperties)
    : undefined;

  return (
    <div
      ref={containerRef}
      className={`seyirlik-player-shell select-none ${
        shouldRotatePortraitPlayer
          ? "seyirlik-player-shell--rotated-portrait"
          : "fixed inset-0"
      } ${isCompactPhonePlayer ? "seyirlik-player-shell--phone" : ""} z-50 min-h-0 overflow-hidden bg-black text-white ${
        shouldShowPlayerCursor ? "cursor-default" : "cursor-none"
      }`}
      style={portraitPlayerStyle}
      onMouseMove={handlePlayerMouseMove}
      onPointerUpCapture={releaseTouchFocusAndControlsHover}
      onPointerCancelCapture={releaseTouchFocusAndControlsHover}
      onPointerUp={(event) => {
        const wasTouchSeekHandled = handlePointerUp(event);

        if (!wasTouchSeekHandled) {
          handlePlayerOverlayToggle(event);
        }
      }}
    >
      <video
        ref={videoRef}
        controls={false}
        playsInline
        preload="auto"
        className="seyirlik-video h-full w-full bg-black object-contain"
        onPlay={handleVideoPlay}
        onPause={handleVideoPause}
        onTimeUpdate={handleTimeUpdate}
        onSeeked={handleVideoSeeked}
        onWaiting={revealPlayerChrome}
        onError={handleVideoError}
        onEnded={() => {
          const positionSeconds = updateLatestPlaybackPosition();
          onPlaybackProgress?.(positionSeconds, true);
          reportStoppedOnce(false);
          handleDefaultNextEpisodePlay();
        }}
      />

      {!isViewModeEnabled ? (
        <>
          <div
            aria-hidden="true"
            className={`seyirlik-player-gradient-top pointer-events-none absolute inset-x-0 top-0 z-[8] h-[26%] transition-opacity duration-300 ${
              shouldRenderPlayerChrome ? "opacity-100" : "opacity-0"
            }`}
          />
          <div
            aria-hidden="true"
            className={`seyirlik-player-gradient-bottom pointer-events-none absolute inset-x-0 bottom-0 z-[8] h-[38%] transition-opacity duration-300 ${
              shouldRenderPlayerChrome ? "opacity-100" : "opacity-0"
            }`}
          />
        </>
      ) : null}

      {fullscreenSeekPreview && fullscreenSeekPreviewRect ? (
        <div className="pointer-events-none absolute inset-0 z-[9] overflow-hidden">
          <div
            className="absolute overflow-hidden bg-black"
            style={{
              left: `${fullscreenSeekPreviewRect.left}px`,
              top: `${fullscreenSeekPreviewRect.top}px`,
              width: `${fullscreenSeekPreviewRect.width}px`,
              height: `${fullscreenSeekPreviewRect.height}px`,
            }}
          >
            <div
              className="origin-top-left opacity-95"
              style={{
                width: `${TRICKPLAY_TILE_WIDTH}px`,
                height: `${TRICKPLAY_TILE_HEIGHT}px`,
                transform: `scale(${fullscreenSeekPreviewRect.width / TRICKPLAY_TILE_WIDTH}, ${
                  fullscreenSeekPreviewRect.height / TRICKPLAY_TILE_HEIGHT
                })`,
                backgroundImage: `url("${fullscreenSeekPreview.imageUrl}")`,
                backgroundSize: `${TRICKPLAY_TILE_WIDTH * TRICKPLAY_COLUMNS}px ${
                  TRICKPLAY_TILE_HEIGHT * TRICKPLAY_ROWS
                }px`,
                backgroundPosition: `-${fullscreenSeekPreview.column * TRICKPLAY_TILE_WIDTH}px -${
                  fullscreenSeekPreview.row * TRICKPLAY_TILE_HEIGHT
                }px`,
                backgroundRepeat: "no-repeat",
              }}
            />

            <div className="absolute inset-0 bg-black/22" />
          </div>
        </div>
      ) : null}

      {subtitleLines.length > 0 ? (
        <div
          ref={subtitleOverlayRef}
          data-subtitle-editor-root
          className={`seyirlik-subtitle-overlay absolute z-[24] ${
            subtitlePosition
              ? ""
              : "seyirlik-subtitle-overlay--default bottom-[12%] left-1/2"
          } ${isSubtitleEditMode ? (isDraggingSubtitle ? "cursor-grabbing" : "cursor-grab") : "cursor-default"} ${
            isShowingSubtitlePlaceholder
              ? "seyirlik-subtitle-overlay--placeholder"
              : ""
          } ${isSubtitleEditMode ? "seyirlik-subtitle-overlay--editing" : ""}`}
          style={subtitleOverlayStyle}
          onPointerDown={handleSubtitlePointerDown}
          onPointerMove={handleSubtitlePointerMove}
          onPointerUp={finishSubtitleDrag}
          onPointerCancel={handleSubtitlePointerCancel}
          onLostPointerCapture={handleSubtitlePointerCancel}
          onDoubleClick={handleSubtitleDoubleClick}
          aria-label={t("player.dragSubtitles")}
        >
          {subtitleLines.map((line, index) => (
            <div
              key={`${line}-${index}`}
              className="seyirlik-subtitle-line-wrap"
            >
              <span className="seyirlik-subtitle-line">{line}</span>
            </div>
          ))}

          {isSubtitleEditMode ? (
            <>
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--tl"
                aria-label={t("player.resizeSubtitlesTopLeft")}
                onPointerDown={(event) =>
                  handleSubtitleResizePointerDown(event, -1, -1)
                }
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--tr"
                aria-label={t("player.resizeSubtitlesTopRight")}
                onPointerDown={(event) =>
                  handleSubtitleResizePointerDown(event, 1, -1)
                }
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--bl"
                aria-label={t("player.resizeSubtitlesBottomLeft")}
                onPointerDown={(event) =>
                  handleSubtitleResizePointerDown(event, -1, 1)
                }
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
              <button
                type="button"
                className="seyirlik-subtitle-resize-handle seyirlik-subtitle-resize-handle--br"
                aria-label={t("player.resizeSubtitlesBottomRight")}
                onPointerDown={(event) =>
                  handleSubtitleResizePointerDown(event, 1, 1)
                }
                onPointerMove={handleSubtitleResizePointerMove}
                onPointerUp={finishSubtitleResize}
                onPointerCancel={handleSubtitleResizePointerCancel}
                onLostPointerCapture={handleSubtitleResizePointerCancel}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {isSubtitleEditMode ? (
        <button
          type="button"
          data-subtitle-editor-root
          onClick={finishSubtitleEditMode}
          className="pointer-events-auto absolute right-[max(0.85rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-[72] rounded-full border border-white/15 bg-black/70 px-4 py-2 text-sm font-black text-white shadow-player-controls backdrop-blur-xl transition hover:bg-white/[0.14] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        >
          {t("player.finishSubtitleEdit")}
        </button>
      ) : null}

      {!isViewModeEnabled && !isSubtitleEditMode ? (
        <>
          <PlayerOverlay
            title={title}
            titleLogoUrl={titleLogoUrl}
            subtitle={subtitle}
            backTo={`/item/${item.Id}`}
            visible={shouldRenderPlayerChrome}
            isPlaying={progress.isPlaying}
            isPlayPausePending={
              partyWatch.isInGroup && partyWatch.isPlayPausePending
            }
            isPlayPauseLoading={isCenterPlayPauseLoading}
            notice={notice}
            onTogglePlay={partyWatch.togglePlay}
            onControlsHoverStart={keepControlsVisible}
            onControlsHoverEnd={releaseControlsHover}
            seekFeedback={seekFeedback}
            topRightControls={
              <div
                className="seyirlik-player-top-actions relative flex flex-col items-end gap-3"
                data-party-watch-root
              >
                <div className="seyirlik-player-top-actions-row flex items-center gap-2">
                  <Tooltip content={t("player.enterViewMode")}>
                    <button
                      type="button"
                      onClick={enterViewMode}
                      className="relative flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.12] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                      aria-label={t("player.enterViewMode")}
                    >
                      <EyeOff size={18} />
                    </button>
                  </Tooltip>

                  <Tooltip content={checkpointButtonLabel}>
                    <button
                      type="button"
                      onClick={toggleCheckpointMode}
                      className={`relative flex h-11 w-11 items-center justify-center rounded-full transition-colors duration-300 ease focus:outline-none focus:ring-2 focus:ring-[var(--accent)] ${
                        checkpointSeconds !== null
                          ? " text-[var(--accent)] ring-0 ring-[var(--accent)]/45 hover:bg-white/[0.12]"
                          : "text-white/85 hover:bg-white/[0.12] hover:text-white"
                      }`}
                      aria-label={checkpointButtonLabel}
                      aria-pressed={checkpointSeconds !== null}
                    >
                      <Bookmark
                        size={18}
                        fill={
                          checkpointSeconds !== null ? "currentColor" : "none"
                        }
                      />
                    </button>
                  </Tooltip>

                  <Tooltip content={t("party.title")}>
                    <button
                      type="button"
                      onClick={() => {
                        setIsPartyWatchOpen((current) => !current);
                        setIsSettingsOpen(false);
                        revealPlayerChrome();
                      }}
                      className="relative flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.12] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                      aria-label={t("party.title")}
                    >
                      <Users
                        size={18}
                        fill={partyWatch.isInGroup ? "#fff" : "none"}
                      />

                      <span
                        className="pointer-events-none absolute inset-0"
                        aria-hidden="true"
                      >
                        {partyWatch.isInGroup ? (
                          Array.from({ length: visiblePartyWatchDotCount }).map(
                            (_, index) => {
                              const dotPosition =
                                PARTY_WATCH_DOT_POSITIONS[index] ??
                                PARTY_WATCH_DOT_POSITIONS[0];

                              return (
                                <span
                                  key={`${dotPosition}-${index}`}
                                  className={`absolute ${dotPosition} h-1.5 w-1.5 rounded-full border border-white/85 bg-white/85 shadow-accent-dot`}
                                />
                              );
                            },
                          )
                        ) : (
                          <span className="absolute right-[0.35rem] top-[0.50rem] h-1.5 w-1.5 rounded-full border border-white/85 bg-transparent" />
                        )}
                      </span>
                    </button>
                  </Tooltip>

                  <PlaybackInfoButton
                    source={sourceWithLiveTranscodingReasons}
                    onClick={() => setIsPlaybackInfoOpen(true)}
                  />
                </div>

                {isPartyWatchOpen ? (
                  <div
                    className="seyirlik-party-panel-anchor absolute right-0 top-full mt-3"
                    data-party-watch-root
                  >
                    <PartyWatchControls controller={partyWatch} visible />
                  </div>
                ) : null}
              </div>
            }
          />

          <SkipSegmentButton
            segment={skippableActiveSegment}
            label={skipSegmentLabel}
            shouldReduceMotion={shouldReduceMotion}
            onSkip={handleSkipSegment}
            onControlsHoverStart={keepControlsVisible}
            onControlsHoverEnd={releaseControlsHover}
          />

          <AnimatePresence initial={false}>
            {shouldShowDefaultNextEpisodeCountdown &&
            nextEpisode &&
            defaultNextEpisodeCountdownSeconds !== null ? (
              <NextEpisodeCountdownOverlay
                key={`${item.Id}-${nextEpisode.Id}`}
                nextEpisode={nextEpisode}
                secondsRemaining={defaultNextEpisodeCountdownSeconds}
                shouldReduceMotion={shouldReduceMotion}
                onPlayNow={handleDefaultNextEpisodePlay}
                onCancel={handleDefaultNextEpisodeCancel}
                onControlsHoverStart={keepControlsVisible}
                onControlsHoverEnd={releaseControlsHover}
              />
            ) : null}
          </AnimatePresence>

          {isPartyWatchOpen ? (
            <PartyWatchOverlay controller={partyWatch} />
          ) : null}

          <PlayerControls
            visible={shouldRenderPlayerChrome}
            isPlaying={progress.isPlaying}
            playWaiting={partyWatch.isInGroup && partyWatch.isPlayPausePending}
            onControlsHoverStart={keepControlsVisible}
            onControlsHoverEnd={releaseControlsHover}
            seekPreviewLoading={fullscreenSeekPreview !== null}
            seekPointerAxis={seekPointerAxis}
            compactSeekPreview={isCompactPhonePlayer}
            compactLayout={isCompactPhonePlayer}
            currentTime={progress.currentTime}
            duration={progress.duration}
            bufferedEnd={progress.bufferedEnd}
            volume={progress.volume}
            muted={progress.muted}
            itemId={item.Id}
            mediaSourceId={activeSource.mediaSourceId}
            checkpointSeconds={checkpointSeconds}
            onTogglePlay={partyWatch.togglePlay}
            onSeek={partyWatch.seekTo}
            onSeekPreview={handleSeekPreview}
            onSeekBy={handleSeekBy}
            onToggleMute={progress.toggleMute}
            onVolumeChange={progress.setVolume}
            onToggleFullscreen={toggleFullscreen}
            onOpenSettings={() => {
              setIsSettingsOpen((current) => !current);
              setIsPartyWatchOpen(false);
              revealPlayerChrome();
            }}
            source={sourceWithLiveTranscodingReasons}
            qualityOptions={qualityOptions}
            selectedQualityId={selectedQualityId}
            selectedAudioStreamIndex={activeAudioStreamIndex}
            selectedSubtitleStreamIndex={selectedSubtitleStreamIndex}
            subtitleDelaySeconds={subtitleDelaySeconds}
            canSwitchAudio={canSwitchAudio}
            canSwitchSubtitles={canSwitchSubtitles}
            isSubtitleEditMode={isSubtitleEditMode}
            settingsOpen={isSettingsOpen}
            onSelectAutoQuality={handleSelectAutoQuality}
            onSelectQuality={handleSelectQuality}
            onSelectAudioStream={handleSelectAudioStream}
            onSelectSubtitleStream={handleSelectSubtitleStream}
            onSubtitleDelayChange={setSubtitleDelaySeconds}
            onStartSubtitleEdit={startSubtitleEditMode}
          />
        </>
      ) : null}

      {isViewModeEnabled ? (
        <div className="pointer-events-auto absolute left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[70] flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/25 p-1 text-white/35 opacity-25 backdrop-blur-md transition hover:bg-black/55 hover:text-white hover:opacity-100 focus-within:opacity-100">
          {checkpointSeconds !== null ? (
            <Tooltip content={t("player.returnToCheckpoint")}>
              <button
                type="button"
                onClick={toggleCheckpointMode}
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                aria-label={t("player.returnToCheckpoint")}
              >
                <Bookmark size={16} fill="currentColor" />
              </button>
            </Tooltip>
          ) : null}

          <Tooltip content={t("player.exitViewMode")}>
            <button
              type="button"
              onClick={exitViewMode}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              aria-label={t("player.exitViewMode")}
            >
              <Eye size={16} />
            </button>
          </Tooltip>
        </div>
      ) : null}

      {!isViewModeEnabled && displayedPartyEventMessage ? (
        <div className="pointer-events-none absolute bottom-[calc(max(1rem,env(safe-area-inset-bottom))+5.8rem)] left-[max(1rem,env(safe-area-inset-left))] z-40">
          <div
            className={`rounded-full border-[var(--accent)]/35 bg-black/72 px-3 py-1.5 text-xs font-bold text-white/[0.88] shadow-player-controls backdrop-blur-xl will-change-transform ${
              isPartyEventToastLeaving
                ? "animate-[partyToastExit_420ms_cubic-bezier(0.4,0,0.2,1)_forwards]"
                : "animate-[partyToastEnter_520ms_cubic-bezier(0.16,1,0.3,1)_forwards]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="relative flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent)]/18 text-[var(--accent)]">
                <span className="absolute h-2 w-2 rounded-full bg-[var(--accent)] shadow-accent-dot" />
              </span>

              <span>{displayedPartyEventMessage}</span>
            </div>
          </div>
        </div>
      ) : null}

      {!isViewModeEnabled && isPlaybackInfoOpen ? (
        <PlaybackInfoPanel
          source={sourceWithLiveTranscodingReasons}
          videoError={lastVideoError}
          onClose={() => setIsPlaybackInfoOpen(false)}
        />
      ) : null}

      {error ? (
        <PlayerErrorOverlay
          message={error.message}
          details={error.details}
          canTryTranscoded={hasTranscodingFallback}
          onTryTranscoded={onTryTranscodedPlayback}
          onRetry={onRetryPlayback}
        />
      ) : null}
    </div>
  );
}
