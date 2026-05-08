import { Check, ChevronRight } from "lucide-react";
import type { JellyfinMediaStream, PlaybackQualityOption, PlaybackSourceCandidate } from "../../lib/types";
import { getPlaybackModeLabel } from "../../lib/playbackDiagnostics";

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

function getStreamsOfType(source: PlaybackSourceCandidate, type: "Audio" | "Subtitle"): JellyfinMediaStream[] {
  return source.mediaSource.MediaStreams?.filter((stream) => stream.Type?.toLowerCase() === type.toLowerCase()) ?? [];
}

function getUniqueStreams(streams: JellyfinMediaStream[]): JellyfinMediaStream[] {
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

function getStreamLabel(stream: JellyfinMediaStream, fallback: string): string {
  const parts = [
    stream.DisplayTitle,
    stream.Title,
    stream.Language?.toUpperCase(),
    stream.Codec?.toUpperCase(),
    stream.Channels ? `${stream.Channels} ch` : undefined,
    stream.IsDefault ? "Default" : undefined,
    stream.IsForced ? "Forced" : undefined,
    stream.IsExternal ? "External" : undefined,
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
        <span className="block truncate text-sm font-bold text-white">{title}</span>
        {subtitle ? <span className="mt-0.5 block truncate text-xs text-white/45">{subtitle}</span> : null}
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
  const audioStreams = getUniqueStreams(getStreamsOfType(source, "Audio"));
  const subtitleStreams = getUniqueStreams(getStreamsOfType(source, "Subtitle"));

  return (
    <div className="absolute bottom-[4.25rem] right-0 z-[70] w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-[rgba(18,18,20,0.96)] shadow-[0_24px_90px_rgba(0,0,0,0.72)] backdrop-blur-2xl">
      <div className="border-b border-white/10 px-4 py-3">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--accent)]">Settings</p>
        <h2 className="mt-0.5 text-base font-black text-white">Playback options</h2>
      </div>

      <div className="max-h-[min(28rem,calc(100svh-12rem))] overflow-y-auto p-2">
        <div className="px-2 pb-1 pt-2 text-xs font-black uppercase tracking-[0.16em] text-white/40">
          Quality
        </div>

        <SettingsButton
          title={getPlaybackModeLabel(source.mode)}
          subtitle={
            source.mediaSource.Container
              ? `${source.mediaSource.Container.toUpperCase()} · Current source`
              : "Current source"
          }
          active
        />

        <SettingsButton
          title="Auto"
          subtitle={selectedQualityId === "auto" ? "Best Jellyfin source" : "Use Jellyfin's best source"}
          active={selectedQualityId === "auto"}
          onClick={onSelectAutoQuality}
        />

        {qualityOptions.length > 0 ? (
          qualityOptions.map((quality) => (
            <SettingsButton
              key={quality.id}
              title={quality.label}
              subtitle={selectedQualityId === quality.id ? "Current quality" : quality.subtitle}
              active={selectedQualityId === quality.id}
              onClick={() => onSelectQuality(quality)}
            />
          ))
        ) : (
          <SettingsButton title="Manual quality" subtitle="No alternate qualities returned" disabled hasSubmenu />
        )}

        <div className="mt-2 px-2 pb-1 pt-2 text-xs font-black uppercase tracking-[0.16em] text-white/40">
          Audio
        </div>

        {audioStreams.length > 0 ? (
          audioStreams.map((stream, index) => (
            <SettingsButton
              key={`${stream.Index ?? index}-audio`}
              title={getStreamLabel(stream, `Audio track ${index + 1}`)}
              subtitle={
                stream.Index === selectedAudioStreamIndex
                  ? "Current audio"
                  : canSwitchAudio
                    ? "Click to switch"
                    : "Requires Jellyfin transcoding"
              }
              active={stream.Index === selectedAudioStreamIndex}
              disabled={stream.Index === undefined || !canSwitchAudio}
              onClick={stream.Index === undefined || !canSwitchAudio ? undefined : () => onSelectAudioStream(stream.Index as number)}
            />
          ))
        ) : (
          <p className="mx-2 rounded-xl bg-white/[0.05] px-3 py-2 text-sm text-white/50">
            No audio tracks returned.
          </p>
        )}

        <div className="mt-2 px-2 pb-1 pt-2 text-xs font-black uppercase tracking-[0.16em] text-white/40">
          Subtitles
        </div>

        <SettingsButton
          title="Off"
          subtitle={selectedSubtitleStreamIndex === -1 ? "Subtitles off" : "Disable subtitles"}
          active={selectedSubtitleStreamIndex === -1}
          disabled={!canSwitchSubtitles}
          onClick={canSwitchSubtitles ? () => onSelectSubtitleStream(-1) : undefined}
        />

        {subtitleStreams.length > 0 ? (
          subtitleStreams.map((stream, index) => (
            <SettingsButton
              key={`${stream.Index ?? index}-subtitle`}
              title={getStreamLabel(stream, `Subtitle ${index + 1}`)}
              subtitle={
                stream.Index === selectedSubtitleStreamIndex
                  ? "Current subtitle"
                  : canSwitchSubtitles
                    ? "Click to enable"
                    : "Subtitle URL unavailable"
              }
              active={stream.Index === selectedSubtitleStreamIndex}
              disabled={stream.Index === undefined || !canSwitchSubtitles}
              onClick={stream.Index === undefined || !canSwitchSubtitles ? undefined : () => onSelectSubtitleStream(stream.Index as number)}
            />
          ))
        ) : (
          <p className="mx-2 rounded-xl bg-white/[0.05] px-3 py-2 text-sm text-white/50">
            No subtitles returned.
          </p>
        )}
      </div>
    </div>
  );
}
