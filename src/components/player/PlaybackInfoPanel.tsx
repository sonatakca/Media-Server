import { X } from "lucide-react";
import type { PlaybackSourceCandidate } from "../../lib/types";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  formatBitrate,
  formatBytes,
  getDirectPlayRecommendation,
  getPlaybackModeLabel,
  getPlaybackReasons,
  getSanitizedDebugPayload,
  getStreamOfType,
  getSubtitleStreams,
} from "../../lib/playbackDiagnostics";

interface PlaybackInfoPanelProps {
  source: PlaybackSourceCandidate;
  videoError?: string | null;
  onClose: () => void;
}

function InfoRow({ label, value, unknownLabel }: { label: string; value?: string | number | null; unknownLabel: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-white/[0.07] py-2 text-sm">
      <dt className="text-white/45">{label}</dt>
      <dd className="text-right font-semibold text-white/80">{value || unknownLabel}</dd>
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

export function PlaybackInfoPanel({ source, videoError, onClose }: PlaybackInfoPanelProps) {
  const { t } = useLanguage();
  const mediaSource = source.mediaSource;
  const video = getStreamOfType(mediaSource, "Video");
  const audio = getStreamOfType(mediaSource, "Audio");
  const subtitles = getSubtitleStreams(mediaSource);
  const reasons = getPlaybackReasons(source, t);
  const recommendations = getDirectPlayRecommendation(source, t);
  const debugPayload = getSanitizedDebugPayload(source, videoError);
  const unknownLabel = t("common.unknown");

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/62 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="max-h-[88svh] w-full overflow-hidden rounded-t-3xl border border-white/10 bg-[linear-gradient(145deg,rgba(24,24,27,0.96),rgba(5,5,5,0.96))] shadow-[0_30px_140px_rgba(0,0,0,0.78)] sm:max-w-3xl sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-[var(--accent)]">{t("playback.details")}</p>
            <h2 className="mt-1 text-xl font-black text-white">{getPlaybackModeLabel(source.mode, t)}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            aria-label={t("playback.closeDetails")}
          >
            <X size={20} />
          </button>
        </div>

        <div className="max-h-[calc(88svh-5rem)] overflow-y-auto px-5 py-5">
          <section>
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">{t("playback.section.playback")}</h3>
            <dl className="mt-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4">
              <InfoRow label={t("playback.mode")} value={getPlaybackModeLabel(source.mode, t)} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.mediaSource")} value={mediaSource.Name || mediaSource.Id} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.protocol")} value={mediaSource.Protocol} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.container")} value={mediaSource.Container} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.hls")} value={source.isHls ? t("common.yes") : t("common.no")} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.hlsEngine")} value={source.isHls ? (source.usingHlsJs ? "hls.js" : t("playback.nativeHls")) : t("playback.notUsed")} unknownLabel={unknownLabel} />
            </dl>
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">{t("playback.section.whyMode")}</h3>
            <ul className="mt-3 space-y-2">
              {reasons.map((reason) => (
                <li key={reason} className="rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3 text-sm leading-6 text-white/76">
                  {reason}
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">{t("playback.section.sourceMedia")}</h3>
            <dl className="mt-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4">
              <InfoRow label={t("playback.size")} value={formatBytes(mediaSource.Size, unknownLabel)} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.bitrate")} value={formatBitrate(mediaSource.Bitrate, unknownLabel)} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.videoCodec")} value={video?.Codec} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.videoProfile")} value={video?.Profile} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.videoLevel")} value={video?.Level} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.resolution")} value={video?.Width && video?.Height ? `${video.Width}x${video.Height}` : undefined} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.frameRate")} value={video?.AverageFrameRate || video?.RealFrameRate} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.range")} value={video?.VideoRange || video?.VideoRangeType} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.audioCodec")} value={audio?.Codec} unknownLabel={unknownLabel} />
              <InfoRow
                label={t("playback.audioChannels")}
                value={audio?.Channels ? t("details.audioChannelsShort").replace("{count}", String(audio.Channels)) : undefined}
                unknownLabel={unknownLabel}
              />
              <InfoRow label={t("playback.audioLanguage")} value={audio?.Language || audio?.DisplayTitle} unknownLabel={unknownLabel} />
            </dl>

            {subtitles.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {subtitles.map((subtitle, index) => (
                  <Chip key={`${subtitle.Index ?? index}-${subtitle.Codec}`}>
                    {[subtitle.Codec, subtitle.Language, subtitle.IsExternal ? "External" : undefined].filter(Boolean).join(" · ")}
                  </Chip>
                ))}
              </div>
            ) : null}
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">{t("playback.section.transcodingOutput")}</h3>
            <dl className="mt-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4">
              <InfoRow label={t("playback.transcodingContainer")} value={mediaSource.TranscodingContainer} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.subProtocol")} value={mediaSource.TranscodingSubProtocol} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.outputVideo")} value={source.mode === "Transcoding" ? t("playback.outputVideoH264") : t("playback.notTranscoding")} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.outputAudio")} value={source.mode === "Transcoding" ? t("playback.outputAudioAac") : t("playback.notTranscoding")} unknownLabel={unknownLabel} />
              <InfoRow label={t("playback.speed")} value={t("playback.speedUnavailable")} unknownLabel={unknownLabel} />
            </dl>
            <p className="mt-2 text-xs leading-5 text-white/42">
              {t("playback.speedNote")}
            </p>
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white/58">{t("playback.section.avoidTranscoding")}</h3>
            <ul className="mt-3 space-y-2">
              {recommendations.map((recommendation) => (
                <li key={recommendation} className="rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3 text-sm leading-6 text-white/76">
                  {recommendation}
                </li>
              ))}
            </ul>
          </section>

          <details className="mt-6 rounded-2xl border border-white/10 bg-black/40 p-4">
            <summary className="cursor-pointer text-sm font-bold text-white/82">{t("playback.rawDebug")}</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-white/58">
              {JSON.stringify(debugPayload, null, 2)}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
