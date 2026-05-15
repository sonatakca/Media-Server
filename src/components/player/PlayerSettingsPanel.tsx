import { Check, ChevronRight } from "lucide-react";
import type {
  JellyfinMediaStream,
  PlaybackQualityOption,
  PlaybackSourceCandidate,
} from "../../lib/types";
import { getPlaybackModeLabel } from "../../lib/playbackDiagnostics";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { AnimatedText } from "../AnimatedText";
import { AnimatedWidth } from "../AnimatedWidth";

interface PlayerSettingsPanelProps {
  source: PlaybackSourceCandidate;
  qualityOptions: PlaybackQualityOption[];
  selectedQualityId: string;
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex: number;
  canSwitchAudio: boolean;
  canSwitchSubtitles: boolean;
  onSelectAutoQuality: () => void;
  onSelectQuality: (quality: PlaybackQualityOption) => void;
  onSelectAudioStream: (streamIndex: number) => void;
  onSelectSubtitleStream: (streamIndex: number) => void;
}

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

function getUniqueStreams(
  streams: JellyfinMediaStream[],
): JellyfinMediaStream[] {
  const seenKeys = new Set<string>();

  return streams.filter((stream, index) => {
    const key =
      stream.Index !== undefined
        ? `index-${stream.Index}`
        : [
            stream.DisplayTitle,
            stream.Title,
            stream.Language,
            stream.Codec,
            stream.IsExternal,
            stream.IsDefault,
            index,
          ].join("-");

    if (seenKeys.has(key)) {
      return false;
    }

    seenKeys.add(key);
    return true;
  });
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

function getStreamLabel(
  stream: JellyfinMediaStream,
  fallback: string,
  t: (key: TranslationKey) => string,
): string {
  const parts = [
    stream.DisplayTitle,
    stream.Title,
    stream.Language?.toUpperCase(),
    stream.Codec?.toUpperCase(),
    stream.Channels
      ? t("details.audioChannelsShort").replace(
          "{count}",
          String(stream.Channels),
        )
      : undefined,
    stream.IsDefault ? t("stream.default") : undefined,
    stream.IsForced ? t("stream.forced") : undefined,
    stream.IsExternal ? t("stream.external") : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : fallback;
}

function SettingsButton({
  title,
  subtitle,
  active,
  disabled,
  hasSubmenu,
  onClick,
}: {
  title: string;
  subtitle?: string;
  active?: boolean;
  disabled?: boolean;
  hasSubmenu?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition ${
        disabled
          ? "cursor-not-allowed opacity-45"
          : "hover:bg-white/[0.09] focus:bg-white/[0.09] focus:outline-none"
      }`}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold text-white">
          <AnimatedWidth value={title}>
            <AnimatedText value={title} />
          </AnimatedWidth>
        </span>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-xs text-white/45">
            <AnimatedWidth value={subtitle}>
              <AnimatedText value={subtitle} />
            </AnimatedWidth>
          </span>
        ) : null}
      </span>

      <span className="flex shrink-0 items-center gap-2 text-white/55">
        {active ? <Check size={16} className="text-[var(--accent)]" /> : null}
        {hasSubmenu ? <ChevronRight size={16} /> : null}
      </span>
    </button>
  );
}

export function PlayerSettingsPanel({
  source,
  qualityOptions,
  selectedQualityId,
  selectedAudioStreamIndex,
  selectedSubtitleStreamIndex,
  canSwitchAudio,
  canSwitchSubtitles,
  onSelectAutoQuality,
  onSelectQuality,
  onSelectAudioStream,
  onSelectSubtitleStream,
}: PlayerSettingsPanelProps) {
  const { t } = useLanguage();
  const audioStreams = getUniqueStreams(getStreamsOfType(source, "Audio"));
  const subtitleStreams = getUniqueStreams(
    getStreamsOfType(source, "Subtitle"),
  );

  return (
    <div className="fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] z-[70] max-h-[calc(100dvh-1rem)] overflow-hidden rounded-2xl border border-white/10 bg-[rgba(18,18,20,0.96)] shadow-[0_24px_90px_rgba(0,0,0,0.72)] backdrop-blur-2xl sm:absolute sm:inset-x-auto sm:bottom-[4.25rem] sm:right-0 sm:w-[min(22rem,calc(100vw-2rem))]">
      <div className="border-b border-white/10 px-4 py-3">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--accent)]">
          {t("settings.settings")}
        </p>
        <h2 className="mt-0.5 text-base font-black text-white">
          {t("settings.playbackOptions")}
        </h2>
      </div>

      <div className="max-h-[calc(100dvh-5.25rem)] overflow-y-auto p-2 sm:max-h-[min(28rem,calc(100svh-12rem))]">
        <div className="px-2 pb-1 pt-2 text-xs font-black uppercase tracking-[0.16em] text-white/40">
          {t("settings.quality")}
        </div>

        <SettingsButton
          title={getPlaybackModeLabel(source.mode, t)}
          subtitle={
            source.mediaSource.Container
              ? `${source.mediaSource.Container.toUpperCase()} · ${t("settings.currentSource")}`
              : t("settings.currentSource")
          }
          active
        />

        <SettingsButton
          title={t("settings.auto")}
          subtitle={
            selectedQualityId === "auto"
              ? t("settings.bestJellyfinSource")
              : t("settings.useBestJellyfinSource")
          }
          active={selectedQualityId === "auto"}
          onClick={onSelectAutoQuality}
        />

        {qualityOptions.length > 0 ? (
          qualityOptions.map((quality) => (
            <SettingsButton
              key={quality.id}
              title={quality.label}
              subtitle={
                selectedQualityId === quality.id
                  ? t("settings.currentQuality")
                  : formatTemplate(t("settings.hlsUpTo"), {
                      mbps: Math.round(quality.maxStreamingBitrate / 1_000_000),
                    })
              }
              active={selectedQualityId === quality.id}
              onClick={() => onSelectQuality(quality)}
            />
          ))
        ) : (
          <SettingsButton
            title={t("settings.manualQuality")}
            subtitle={t("settings.noAlternateQualities")}
            disabled
            hasSubmenu
          />
        )}

        <div className="mt-2 px-2 pb-1 pt-2 text-xs font-black uppercase tracking-[0.16em] text-white/40">
          {t("settings.audio")}
        </div>

        {audioStreams.length > 0 ? (
          audioStreams.map((stream, index) => (
            <SettingsButton
              key={`${stream.Index ?? index}-audio`}
              title={getStreamLabel(
                stream,
                formatTemplate(t("settings.audioTrack"), { number: index + 1 }),
                t,
              )}
              subtitle={
                stream.Index === selectedAudioStreamIndex
                  ? t("settings.currentAudio")
                  : canSwitchAudio
                    ? t("settings.clickToSwitch")
                    : t("settings.requiresTranscoding")
              }
              active={stream.Index === selectedAudioStreamIndex}
              disabled={stream.Index === undefined || !canSwitchAudio}
              onClick={
                stream.Index === undefined || !canSwitchAudio
                  ? undefined
                  : () => onSelectAudioStream(stream.Index as number)
              }
            />
          ))
        ) : (
          <p className="mx-2 rounded-xl bg-white/[0.05] px-3 py-2 text-sm text-white/50">
            {t("settings.noAudioTracks")}
          </p>
        )}

        <div className="mt-2 px-2 pb-1 pt-2 text-xs font-black uppercase tracking-[0.16em] text-white/40">
          {t("settings.subtitles")}
        </div>

        <SettingsButton
          title={t("settings.off")}
          subtitle={
            selectedSubtitleStreamIndex === -1
              ? t("settings.subtitlesOff")
              : t("settings.disableSubtitles")
          }
          active={selectedSubtitleStreamIndex === -1}
          disabled={!canSwitchSubtitles}
          onClick={
            canSwitchSubtitles ? () => onSelectSubtitleStream(-1) : undefined
          }
        />

        {subtitleStreams.length > 0 ? (
          subtitleStreams.map((stream, index) => (
            <SettingsButton
              key={`${stream.Index ?? index}-subtitle`}
              title={getStreamLabel(
                stream,
                formatTemplate(t("settings.subtitle"), { number: index + 1 }),
                t,
              )}
              subtitle={
                stream.Index === selectedSubtitleStreamIndex
                  ? t("settings.currentSubtitle")
                  : canSwitchSubtitles
                    ? t("settings.clickToEnable")
                    : t("settings.subtitleUnavailable")
              }
              active={stream.Index === selectedSubtitleStreamIndex}
              disabled={stream.Index === undefined || !canSwitchSubtitles}
              onClick={
                stream.Index === undefined || !canSwitchSubtitles
                  ? undefined
                  : () => onSelectSubtitleStream(stream.Index as number)
              }
            />
          ))
        ) : (
          <p className="mx-2 rounded-xl bg-white/[0.05] px-3 py-2 text-sm text-white/50">
            {t("settings.noSubtitles")}
          </p>
        )}
      </div>
    </div>
  );
}
