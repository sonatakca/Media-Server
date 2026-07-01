import { useEffect, useState } from "react";
import { getActiveTranscodingReasons } from "../../lib/jellyfinApi";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  FileVideo2,
  X,
  XCircle,
} from "lucide-react";
import type { PlaybackSourceCandidate } from "../../lib/types";
import type {
  AudioStreamAnalysis,
  ClientCapabilities,
  CodecCapability,
  PlaybackDiagnostics,
  PlaybackReason,
  VideoStreamAnalysis,
} from "../../lib/playback-planner/types";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  formatBitrate,
  formatBytes,
  getPlaybackModeLabel,
  getPrimaryTranscodeReasons,
  getReadableTranscodeReason,
  getSanitizedDebugPayload,
  getStreamOfType,
  getSubtitleStreams,
} from "../../lib/playbackDiagnostics";
import type { TranslationKey } from "../../i18n/translations";

interface PlaybackInfoPanelProps {
  source: PlaybackSourceCandidate;
  videoError?: string | null;
  onClose: () => void;
}

function InfoRow({
  label,
  value,
  unknownLabel,
}: {
  label: string;
  value?: string | number | null;
  unknownLabel: string;
}) {
  return (
    <div className="flex justify-between gap-4 border-b border-white/[0.07] py-2 text-sm">
      <dt className="text-white/45">{label}</dt>
      <dd className="text-right font-semibold text-white/80">
        {value || unknownLabel}
      </dd>
    </div>
  );
}

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/[0.08] px-2.5 py-1 text-xs font-semibold text-white/75">
      {children}
    </span>
  );
}

function StatusPill({
  active,
  positiveLabel,
  negativeLabel,
}: {
  active: boolean;
  positiveLabel: string;
  negativeLabel: string;
}) {
  const Icon = active ? CheckCircle2 : XCircle;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-black ${
        active
          ? "border-emerald-200/25 bg-emerald-300/12 text-emerald-100"
          : "border-rose-200/25 bg-rose-300/12 text-rose-100"
      }`}
    >
      <Icon size={13} />
      {active ? positiveLabel : negativeLabel}
    </span>
  );
}

function DiagnosticCard({
  title,
  value,
  tone = "default",
  subtitle,
}: {
  title: string;
  value: string;
  tone?: "default" | "good" | "warn" | "bad";
  subtitle?: string;
}) {
  const toneClass =
    tone === "good"
      ? "border-emerald-200/20 bg-emerald-300/[0.08] text-emerald-50"
      : tone === "warn"
        ? "border-amber-200/20 bg-amber-300/[0.08] text-amber-50"
        : tone === "bad"
          ? "border-rose-200/20 bg-rose-300/[0.08] text-rose-50"
          : "border-white/10 bg-white/[0.045] text-white";

  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <p className="text-[0.68rem] font-black uppercase tracking-[0.18em] opacity-55">
        {title}
      </p>
      <p className="mt-1 text-base font-black">{value}</p>
      {subtitle ? (
        <p className="mt-2 text-xs font-semibold leading-5 opacity-62">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

function formatCapabilityDetails(
  capability: CodecCapability | undefined,
  unknownLabel: string,
): string {
  if (!capability) {
    return unknownLabel;
  }

  if (!capability.supported) {
    return "Not supported";
  }

  const details = [
    capability.maxWidth && capability.maxHeight
      ? `${capability.maxWidth}x${capability.maxHeight}`
      : null,
    formatBitrate(capability.maxBitrate, ""),
    capability.maxFramerate ? `${capability.maxFramerate} fps` : null,
    capability.supports10Bit ? "10-bit" : null,
    capability.supportsHdr ? "HDR" : null,
    capability.powerEfficient ? "power efficient" : null,
  ].filter(Boolean);

  return details.length > 0 ? details.join(" · ") : "Supported";
}

function formatAudioCapabilityDetails(
  capability: ClientCapabilities["audio"][keyof ClientCapabilities["audio"]],
  unknownLabel: string,
): string {
  if (!capability) {
    return unknownLabel;
  }

  if (!capability.supported) {
    return "Not supported";
  }

  return capability.maxChannels
    ? `Supported · up to ${capability.maxChannels} ch`
    : "Supported";
}

function CapabilityPill({
  label,
  supported,
  details,
}: {
  label: string;
  supported?: boolean;
  details: string;
}) {
  return (
    <div
      className={`rounded-2xl border px-3 py-2 ${
        supported
          ? "border-emerald-200/18 bg-emerald-300/[0.07]"
          : "border-white/10 bg-black/24"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-black text-white">{label}</span>
        <span
          className={`h-2 w-2 rounded-full ${
            supported ? "bg-emerald-300" : "bg-white/20"
          }`}
        />
      </div>
      <p className="mt-1 text-xs font-semibold leading-5 text-white/52">
        {details}
      </p>
    </div>
  );
}

function formatStreamValue(value?: string | number | boolean | null): string {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }

  if (typeof value === "number") {
    return String(value);
  }

  return value || "";
}

function StreamCard({
  title,
  rows,
  selected,
}: {
  title: string;
  rows: Array<[string, string | number | boolean | undefined | null]>;
  selected?: boolean;
}) {
  const visibleRows = rows
    .map(([label, value]) => [label, formatStreamValue(value)] as const)
    .filter(([, value]) => Boolean(value));

  return (
    <div
      className={`rounded-2xl border p-4 ${
        selected
          ? "border-[var(--accent)]/35 bg-[var(--accent)]/[0.075]"
          : "border-white/10 bg-white/[0.045]"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-black text-white">{title}</h4>
        {selected ? (
          <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[0.62rem] font-black uppercase tracking-[0.12em] text-black">
            Selected
          </span>
        ) : null}
      </div>

      {visibleRows.length > 0 ? (
        <dl className="mt-3 space-y-1.5">
          {visibleRows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 text-xs">
              <dt className="text-white/42">{label}</dt>
              <dd className="text-right font-bold text-white/76">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function ReasonCard({ reason }: { reason: PlaybackReason }) {
  const tone =
    reason.severity === "blocking"
      ? "border-rose-200/18 bg-rose-300/[0.075] text-rose-50"
      : reason.severity === "warning"
        ? "border-amber-200/18 bg-amber-300/[0.075] text-amber-50"
        : "border-white/10 bg-white/[0.045] text-white/78";

  return (
    <li className={`rounded-2xl border px-4 py-3 ${tone}`}>
      <div className="flex items-start gap-3">
        {reason.severity === "blocking" ? (
          <XCircle size={16} className="mt-0.5 shrink-0" />
        ) : reason.severity === "warning" ? (
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        ) : (
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
        )}
        <div>
          <p className="text-xs font-black uppercase tracking-[0.14em] opacity-62">
            {reason.code}
          </p>
          <p className="mt-1 text-sm font-bold leading-6">{reason.message}</p>
        </div>
      </div>
    </li>
  );
}

const VIDEO_CAPABILITY_LABELS: Array<
  [keyof ClientCapabilities["video"], string]
> = [
  ["h264", "H.264"],
  ["hevc", "HEVC"],
  ["av1", "AV1"],
  ["vp9", "VP9"],
];

const AUDIO_CAPABILITY_LABELS: Array<
  [keyof ClientCapabilities["audio"], string]
> = [
  ["aac", "AAC"],
  ["mp3", "MP3"],
  ["opus", "Opus"],
  ["ac3", "AC-3"],
  ["eac3", "E-AC-3"],
  ["flac", "FLAC"],
];

function getVideoStreamTitle(stream: VideoStreamAnalysis, index: number) {
  return `Video ${index + 1} · ${stream.codecName.toUpperCase()}`;
}

function getAudioStreamTitle(stream: AudioStreamAnalysis, index: number) {
  return `Audio ${index + 1} · ${stream.codecName.toUpperCase()}`;
}

function PlaybackDiagnosticsSection({
  diagnostics,
  unknownLabel,
  yesLabel,
  noLabel,
}: {
  diagnostics: PlaybackDiagnostics;
  unknownLabel: string;
  yesLabel: string;
  noLabel: string;
}) {
  const { clientCapabilities, media, decision } = diagnostics;
  const supportedVideo = VIDEO_CAPABILITY_LABELS.filter(
    ([key]) => clientCapabilities.video[key]?.supported,
  ).map(([, label]) => label);
  const supportedAudio = AUDIO_CAPABILITY_LABELS.filter(
    ([key]) => clientCapabilities.audio[key]?.supported,
  ).map(([, label]) => label);
  const mediaContainer =
    media.container.extension || media.container.formatName || unknownLabel;
  const selectedVideoStreamIndex = decision.selectedVideoStreamIndex;
  const selectedAudioStreamIndex = decision.selectedAudioStreamIndex;

  return (
    <section className="mt-6">
      <div className="flex items-center gap-2">
        <Cpu size={17} className="text-[var(--accent)]" />
        <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">
          Device vs media diagnostics
        </h3>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <DiagnosticCard
          title="Direct play"
          value={decision.directPlaySupported ? yesLabel : noLabel}
          tone={decision.directPlaySupported ? "good" : "bad"}
          subtitle={
            decision.directPlaySupported
              ? "The selected container and streams can be played as-is."
              : "At least one selected container, stream, or subtitle condition blocks direct play."
          }
        />
        <DiagnosticCard
          title="Backend plan"
          value={decision.mode}
          tone={decision.requiresFfmpeg ? "warn" : "good"}
          subtitle={
            decision.requiresFfmpeg
              ? "FFmpeg is needed for this plan."
              : "No FFmpeg session is needed."
          }
        />
        <DiagnosticCard
          title="Original quality"
          value={decision.preservesOriginalVideoQuality ? yesLabel : noLabel}
          tone={decision.preservesOriginalVideoQuality ? "good" : "warn"}
          subtitle={`Startup: ${decision.expectedStartup}`}
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
          <h4 className="flex items-center gap-2 text-sm font-black text-white">
            <Cpu size={15} />
            Current device capability
          </h4>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Engine</dt>
              <dd className="text-right font-bold text-white/80">
                {clientCapabilities.playbackEngine ?? "browser"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Direct containers</dt>
              <dd className="text-right font-bold text-white/80">
                {clientCapabilities.directFileContainers.join(", ") ||
                  unknownLabel}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">MSE containers</dt>
              <dd className="text-right font-bold text-white/80">
                {clientCapabilities.mseContainers.join(", ") || unknownLabel}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Native HLS</dt>
              <dd>
                <StatusPill
                  active={clientCapabilities.supportsHlsNative}
                  positiveLabel={yesLabel}
                  negativeLabel={noLabel}
                />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">MediaSource</dt>
              <dd>
                <StatusPill
                  active={clientCapabilities.supportsMediaSource}
                  positiveLabel={yesLabel}
                  negativeLabel={noLabel}
                />
              </dd>
            </div>
          </dl>

          <div className="mt-4">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
              Supported video
            </p>
            <p className="mt-1 text-sm font-bold text-white/78">
              {supportedVideo.join(", ") || unknownLabel}
            </p>
          </div>

          <div className="mt-3">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
              Supported audio
            </p>
            <p className="mt-1 text-sm font-bold text-white/78">
              {supportedAudio.join(", ") || unknownLabel}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
          <h4 className="flex items-center gap-2 text-sm font-black text-white">
            <FileVideo2 size={15} />
            Actual media format
          </h4>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">File</dt>
              <dd className="max-w-[65%] truncate text-right font-bold text-white/80">
                {media.fileName ?? unknownLabel}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Container</dt>
              <dd className="text-right font-bold text-white/80">
                {mediaContainer}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Browser-direct container</dt>
              <dd>
                <StatusPill
                  active={media.container.isBrowserDirectPlayableContainer}
                  positiveLabel={yesLabel}
                  negativeLabel={noLabel}
                />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Overall bitrate</dt>
              <dd className="text-right font-bold text-white/80">
                {formatBitrate(media.overallBitrate, unknownLabel)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-white/45">Streams</dt>
              <dd className="text-right font-bold text-white/80">
                {media.videoStreams.length} video / {media.audioStreams.length}{" "}
                audio / {media.subtitleStreams.length} subs
              </dd>
            </div>
          </dl>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <DiagnosticCard
              title="Container"
              value={decision.containerAction}
              tone={decision.containerAction === "direct" ? "good" : "warn"}
            />
            <DiagnosticCard
              title="Video"
              value={decision.videoAction}
              tone={decision.videoAction === "copy" ? "good" : "warn"}
            />
            <DiagnosticCard
              title="Audio"
              value={decision.audioAction}
              tone={decision.audioAction === "copy" ? "good" : "warn"}
            />
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-black uppercase tracking-[0.16em] text-white/42">
            Video capability checks
          </h4>
          <div className="grid gap-2">
            {VIDEO_CAPABILITY_LABELS.map(([key, label]) => {
              const capability = clientCapabilities.video[key];

              return (
                <CapabilityPill
                  key={key}
                  label={label}
                  supported={capability?.supported}
                  details={formatCapabilityDetails(capability, unknownLabel)}
                />
              );
            })}
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-xs font-black uppercase tracking-[0.16em] text-white/42">
            Audio capability checks
          </h4>
          <div className="grid gap-2">
            {AUDIO_CAPABILITY_LABELS.map(([key, label]) => {
              const capability = clientCapabilities.audio[key];

              return (
                <CapabilityPill
                  key={key}
                  label={label}
                  supported={capability?.supported}
                  details={formatAudioCapabilityDetails(
                    capability,
                    unknownLabel,
                  )}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {media.videoStreams.map((stream, index) => (
          <StreamCard
            key={`video-${stream.index}-${index}`}
            title={getVideoStreamTitle(stream, index)}
            selected={stream.index === selectedVideoStreamIndex}
            rows={[
              ["Profile", stream.profile],
              ["Level", stream.level],
              [
                "Resolution",
                stream.width && stream.height
                  ? `${stream.width}x${stream.height}`
                  : "",
              ],
              ["Frame rate", stream.framerate ? `${stream.framerate} fps` : ""],
              ["Bitrate", formatBitrate(stream.bitrate, "")],
              ["Pixel format", stream.pixFmt],
              ["Bit depth", stream.bitDepth ? `${stream.bitDepth}-bit` : ""],
              ["HDR", stream.isHdr],
              ["Dolby Vision", stream.hasDolbyVision],
            ]}
          />
        ))}

        {media.audioStreams.map((stream, index) => (
          <StreamCard
            key={`audio-${stream.index}-${index}`}
            title={getAudioStreamTitle(stream, index)}
            selected={stream.index === selectedAudioStreamIndex}
            rows={[
              ["Channels", stream.channels],
              ["Layout", stream.channelLayout],
              ["Bitrate", formatBitrate(stream.bitrate, "")],
              [
                "Sample rate",
                stream.sampleRate ? `${stream.sampleRate} Hz` : "",
              ],
              ["Language", stream.language],
              ["Title", stream.title],
              ["Default", stream.isDefault],
            ]}
          />
        ))}
      </div>

      {media.subtitleStreams.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {media.subtitleStreams.map((stream) => (
            <Chip key={`diagnostic-subtitle-${stream.index}`}>
              {[
                `Subtitle ${stream.index}`,
                stream.codecName,
                stream.language,
                stream.isImageBased ? "image-based" : "text",
                stream.isForced ? "forced" : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Chip>
          ))}
        </div>
      ) : null}

      {decision.reasons.length > 0 ? (
        <div className="mt-4">
          <h4 className="mb-2 text-xs font-black uppercase tracking-[0.16em] text-white/42">
            Decision reasons
          </h4>
          <ul className="space-y-2">
            {decision.reasons.map((reason, index) => (
              <ReasonCard key={`${reason.code}-${index}`} reason={reason} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

type Translate = (key: TranslationKey) => string;

function getUrlType(source: PlaybackSourceCandidate, t: Translate): string {
  const url = source.url.toLowerCase();

  if (source.hlsKind === "direct" || url.includes("/stream.")) {
    return t("playback.urlType.directStreamUrl");
  }

  if (url.includes("/master.m3u8") && source.hlsKind === "audio-transcode") {
    return t("playback.urlType.masterAudioTranscode");
  }

  if (url.includes("/master.m3u8") && source.hlsKind === "stream-copy") {
    return t("playback.urlType.masterStreamCopy");
  }

  if (url.includes("/master.m3u8")) return t("playback.urlType.masterHls");
  if (url.includes("/main.m3u8"))
    return t("playback.urlType.mainForcedTranscode");
  if (source.hlsKind === "jellyfin-transcoding-url") {
    return t("playback.urlType.jellyfinTranscodingUrl");
  }

  return t("common.unknown");
}

function getOutputVideoLabel(
  source: PlaybackSourceCandidate,
  t: Translate,
): string {
  if (source.hlsKind === "forced-transcode") {
    return "H.264";
  }

  if (source.hlsKind === "audio-transcode") {
    return t("playback.output.streamCopyOriginal");
  }

  if (source.hlsKind === "jellyfin-transcoding-url") {
    return t("playback.output.jellyfinDecision");
  }

  if (source.hlsKind === "stream-copy") {
    return t("playback.output.streamCopyOriginal");
  }

  if (source.hlsKind === "direct") {
    return t("playback.output.directOriginal");
  }

  return source.mode === "Transcoding"
    ? t("playback.output.jellyfinTranscoding")
    : t("playback.output.originalCodec");
}

function getOutputAudioLabel(
  source: PlaybackSourceCandidate,
  t: Translate,
): string {
  if (source.hlsKind === "forced-transcode") {
    return "AAC";
  }

  if (source.hlsKind === "audio-transcode") {
    return "AAC";
  }

  if (source.hlsKind === "jellyfin-transcoding-url") {
    return t("playback.output.jellyfinDecision");
  }

  if (source.hlsKind === "stream-copy") {
    return t("playback.output.streamCopyOriginal");
  }

  if (source.hlsKind === "direct") {
    return t("playback.output.directOriginal");
  }

  return source.mode === "Transcoding"
    ? t("playback.output.jellyfinTranscoding")
    : t("playback.output.originalCodec");
}

export function PlaybackInfoPanel({
  source,
  videoError,
  onClose,
}: PlaybackInfoPanelProps) {
  const { t } = useLanguage();
  const mediaSource = source.mediaSource;
  const video = getStreamOfType(mediaSource, "Video");
  const audio = getStreamOfType(mediaSource, "Audio");
  const subtitles = getSubtitleStreams(mediaSource);
  const [activeTranscodingReasons, setActiveTranscodingReasons] = useState<
    string[]
  >([]);

  useEffect(() => {
    let isCancelled = false;

    async function loadActiveTranscodingReasons() {
      try {
        const reasons = await getActiveTranscodingReasons(
          source.itemId,
          source.playSessionId,
        );

        if (!isCancelled) {
          setActiveTranscodingReasons(reasons);
          console.info(
            "[Seyirlik Playback] Active Jellyfin transcoding reasons",
            reasons,
          );
        }
      } catch (error) {
        if (!isCancelled) {
          setActiveTranscodingReasons([]);
          console.warn(
            "[Seyirlik Playback] Could not load active Jellyfin transcoding reasons",
            error,
          );
        }
      }
    }

    void loadActiveTranscodingReasons();

    const intervalId = window.setInterval(() => {
      void loadActiveTranscodingReasons();
    }, 5000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [source.itemId, source.playSessionId]);

  const primaryTranscodeReasons =
    activeTranscodingReasons.length > 0
      ? activeTranscodingReasons.map((reason) =>
          getReadableTranscodeReason(reason, t),
        )
      : getPrimaryTranscodeReasons(source, t);
  const debugPayload = getSanitizedDebugPayload(source, videoError);
  const playbackDiagnostics = source.playbackDiagnostics;
  const unknownLabel = t("common.unknown");

  return (
    <div className="seyirlik-player-info-overlay fixed inset-0 z-[80] flex items-end justify-center bg-black/62 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="seyirlik-player-info-dialog max-h-[88svh] w-full overflow-hidden rounded-t-3xl border border-white/10 bg-[linear-gradient(145deg,rgba(24,24,27,0.96),rgba(5,5,5,0.96))] shadow-[0_30px_140px_rgba(0,0,0,0.78)] sm:max-w-5xl sm:rounded-3xl">
        <div className="seyirlik-player-info-header flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-[var(--accent)]">
              {t("playback.details")}
            </p>
            <h2 className="mt-1 text-xl font-black text-white">
              {getPlaybackModeLabel(source.mode, t)}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 min-h-10 min-w-10 shrink-0 aspect-square items-center justify-center overflow-hidden rounded-full bg-white/10 p-0 text-white transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            aria-label={t("playback.closeDetails")}
          >
            <X size={20} />
          </button>
        </div>

        <div className="seyirlik-player-info-body max-h-[calc(88svh-5rem)] overflow-y-auto px-5 py-5">
          <section>
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">
              {t("playback.section.playback")}
            </h3>
            <dl className="mt-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4">
              <InfoRow
                label={t("playback.mode")}
                value={getPlaybackModeLabel(source.mode, t)}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.mediaSource")}
                value={mediaSource.Name || mediaSource.Id}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.protocol")}
                value={mediaSource.Protocol}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.container")}
                value={mediaSource.Container}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.hls")}
                value={source.isHls ? t("common.yes") : t("common.no")}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.hlsEngine")}
                value={
                  source.isHls
                    ? source.usingHlsJs
                      ? "hls.js"
                      : t("playback.nativeHls")
                    : t("playback.notUsed")
                }
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.hlsKind")}
                value={source.hlsKind ?? t("playback.notApplicable")}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.urlType")}
                value={getUrlType(source, t)}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.selectionReason")}
                value={source.reason}
                unknownLabel={unknownLabel}
              />
            </dl>
          </section>

          {playbackDiagnostics ? (
            <PlaybackDiagnosticsSection
              diagnostics={playbackDiagnostics}
              unknownLabel={unknownLabel}
              yesLabel={t("common.yes")}
              noLabel={t("common.no")}
            />
          ) : null}

          {primaryTranscodeReasons.length > 0 ? (
            <section className="mt-6">
              <div className="rounded-3xl border border-amber-300/25 bg-amber-300/[0.085] p-4 shadow-[0_18px_70px_rgba(245,158,11,0.10)]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.22em] text-amber-200/80">
                      {t("playback.transcodingReason")}
                    </p>
                    <h3 className="mt-1 text-lg font-black text-amber-50">
                      {t("playback.transcodingReasonTitle")}
                    </h3>
                  </div>

                  <span className="shrink-0 rounded-full border border-amber-200/25 bg-amber-200/10 px-2.5 py-1 text-xs font-black text-amber-100">
                    {primaryTranscodeReasons.length}
                  </span>
                </div>

                <ul className="mt-4 space-y-2">
                  {primaryTranscodeReasons.map((reason) => (
                    <li
                      key={reason}
                      className="rounded-2xl border border-amber-200/15 bg-black/24 px-4 py-3 text-sm font-bold leading-6 text-amber-50"
                    >
                      {reason}
                    </li>
                  ))}
                </ul>

                <p className="mt-3 text-xs leading-5 text-amber-100/58">
                  {t("playback.transcodingReasonNote")}
                </p>
              </div>
            </section>
          ) : null}

          <section className="mt-6">
            {mediaSource.TranscodingReasons?.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {mediaSource.TranscodingReasons.map((reason) => (
                  <Chip key={reason}>{reason}</Chip>
                ))}
              </div>
            ) : null}
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">
              {t("playback.section.sourceMedia")}
            </h3>
            <dl className="mt-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4">
              <InfoRow
                label={t("playback.size")}
                value={formatBytes(mediaSource.Size, unknownLabel)}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.bitrate")}
                value={formatBitrate(mediaSource.Bitrate, unknownLabel)}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.videoCodec")}
                value={video?.Codec}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.videoProfile")}
                value={video?.Profile}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.videoLevel")}
                value={video?.Level}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.resolution")}
                value={
                  video?.Width && video?.Height
                    ? `${video.Width}x${video.Height}`
                    : undefined
                }
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.frameRate")}
                value={video?.AverageFrameRate || video?.RealFrameRate}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.range")}
                value={video?.VideoRange || video?.VideoRangeType}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.audioCodec")}
                value={audio?.Codec}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.audioChannels")}
                value={
                  audio?.Channels
                    ? t("details.audioChannelsShort").replace(
                        "{count}",
                        String(audio.Channels),
                      )
                    : undefined
                }
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.audioLanguage")}
                value={audio?.Language || audio?.DisplayTitle}
                unknownLabel={unknownLabel}
              />
            </dl>

            {subtitles.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {subtitles.map((subtitle, index) => (
                  <Chip key={`${subtitle.Index ?? index}-${subtitle.Codec}`}>
                    {[
                      subtitle.Codec,
                      subtitle.Language,
                      subtitle.IsExternal ? t("stream.external") : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Chip>
                ))}
              </div>
            ) : null}
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">
              {t("playback.section.transcodingOutput")}
            </h3>
            <dl className="mt-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4">
              <InfoRow
                label={t("playback.transcodingContainer")}
                value={mediaSource.TranscodingContainer}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.subProtocol")}
                value={mediaSource.TranscodingSubProtocol}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.outputVideo")}
                value={getOutputVideoLabel(source, t)}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.outputAudio")}
                value={getOutputAudioLabel(source, t)}
                unknownLabel={unknownLabel}
              />
              <InfoRow
                label={t("playback.speed")}
                value={t("playback.speedUnavailable")}
                unknownLabel={unknownLabel}
              />
            </dl>
            <p className="mt-2 text-xs leading-5 text-white/42">
              {t("playback.speedNote")}
            </p>
          </section>

          <details className="mt-6 rounded-2xl border border-white/10 bg-black/40 p-4">
            <summary className="cursor-pointer text-sm font-bold text-white/82">
              {t("playback.rawDebug")}
            </summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-white/58">
              {JSON.stringify(debugPayload, null, 2)}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
