import {
  Check,
  ChevronRight,
  SlidersHorizontal,
  Volume2,
  Subtitles,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
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

const HIDE_QUALITY_SETTINGS = true;
const HIDE_AUDIO_SETTINGS = true;
const DISABLE_AUDIO_SELECTION = false;
const SUBTITLE_DELAY_MIN_SECONDS = -40;
const SUBTITLE_DELAY_MAX_SECONDS = 40;
const SUBTITLE_DELAY_STEP_SECONDS = 0.25;

type SettingsSection = "quality" | "audio" | "subtitles";

const LANGUAGE_FLAG_COUNTRY_CODES: Record<string, string> = {
  ar: "sa",
  arabic: "sa",
  ara: "sa",
  bg: "bg",
  bul: "bg",
  bulgarian: "bg",
  ca: "es-ct",
  catalan: "es-ct",
  chi: "cn",
  chinese: "cn",
  cs: "cz",
  cze: "cz",
  ces: "cz",
  czech: "cz",
  da: "dk",
  dan: "dk",
  danish: "dk",
  de: "de",
  deu: "de",
  ger: "de",
  german: "de",
  el: "gr",
  ell: "gr",
  gre: "gr",
  greek: "gr",
  en: "gb",
  eng: "gb",
  english: "gb",
  es: "es",
  spa: "es",
  spanish: "es",
  castellano: "es",
  castilian: "es",
  fa: "ir",
  fas: "ir",
  per: "ir",
  persian: "ir",
  fi: "fi",
  fin: "fi",
  finnish: "fi",
  fr: "fr",
  fra: "fr",
  fre: "fr",
  french: "fr",
  he: "il",
  heb: "il",
  hebrew: "il",
  hi: "in",
  hin: "in",
  hindi: "in",
  hr: "hr",
  hrv: "hr",
  croatian: "hr",
  hu: "hu",
  hun: "hu",
  hungarian: "hu",
  id: "id",
  ind: "id",
  indonesian: "id",
  is: "is",
  ice: "is",
  isl: "is",
  icelandic: "is",
  it: "it",
  ita: "it",
  italian: "it",
  ja: "jp",
  jpn: "jp",
  japanese: "jp",
  ko: "kr",
  kor: "kr",
  korean: "kr",
  ms: "my",
  may: "my",
  msa: "my",
  malay: "my",
  nl: "nl",
  dut: "nl",
  nld: "nl",
  dutch: "nl",
  no: "no",
  nor: "no",
  nb: "no",
  nn: "no",
  norwegian: "no",
  pl: "pl",
  pol: "pl",
  polish: "pl",
  pt: "pt",
  por: "pt",
  portuguese: "pt",
  ro: "ro",
  rum: "ro",
  ron: "ro",
  romanian: "ro",
  ru: "ru",
  rus: "ru",
  russian: "ru",
  sk: "sk",
  slo: "sk",
  slk: "sk",
  slovak: "sk",
  sl: "si",
  slv: "si",
  slovenian: "si",
  sr: "rs",
  srp: "rs",
  serbian: "rs",
  sv: "se",
  swe: "se",
  swedish: "se",
  th: "th",
  tha: "th",
  thai: "th",
  tr: "tr",
  tur: "tr",
  turkish: "tr",
  uk: "ua",
  ukr: "ua",
  ukrainian: "ua",
  ur: "pk",
  urd: "pk",
  urdu: "pk",
  vi: "vn",
  vie: "vn",
  vietnamese: "vn",
  zh: "cn",
  zho: "cn",
};

const COUNTRY_NAME_FLAG_CODES: Record<string, string> = {
  brazil: "br",
  brazilian: "br",
  canada: "ca",
  canadian: "ca",
  china: "cn",
  france: "fr",
  germany: "de",
  japan: "jp",
  korea: "kr",
  mexico: "mx",
  mexican: "mx",
  portugal: "pt",
  spain: "es",
  turkey: "tr",
  turkiye: "tr",
  uk: "gb",
  us: "us",
  usa: "us",
};

interface PlayerSettingsPanelProps {
  source: PlaybackSourceCandidate;
  qualityOptions: PlaybackQualityOption[];
  selectedQualityId: string;
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex: number;
  subtitleDelaySeconds: number;
  canSwitchAudio: boolean;
  canSwitchSubtitles: boolean;
  onSelectAutoQuality: () => void;
  onSelectQuality: (quality: PlaybackQualityOption) => void;
  onSelectAudioStream: (streamIndex: number) => void;
  onSelectSubtitleStream: (streamIndex: number) => void;
  onSubtitleDelayChange: (seconds: number) => void;
  onStartSubtitleEdit?: () => void;
  compact?: boolean;
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

function normalizeFlagText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getFlagCountryCode(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeFlagText(value);
  const exactLanguageCode = LANGUAGE_FLAG_COUNTRY_CODES[normalized];

  if (exactLanguageCode) {
    return exactLanguageCode;
  }

  const exactCountryCode = COUNTRY_NAME_FLAG_CODES[normalized];

  if (exactCountryCode) {
    return exactCountryCode;
  }

  const localeRegion = normalized.match(/\b[a-z]{2,3}[-_ ]([a-z]{2})\b/);

  if (localeRegion?.[1]) {
    return localeRegion[1];
  }

  if (normalized.includes("united kingdom")) {
    return "gb";
  }

  if (normalized.includes("united states")) {
    return "us";
  }

  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const countryToken = tokens.find((token) => COUNTRY_NAME_FLAG_CODES[token]);

  if (countryToken) {
    return COUNTRY_NAME_FLAG_CODES[countryToken];
  }

  const languageToken = tokens.find(
    (token) => LANGUAGE_FLAG_COUNTRY_CODES[token],
  );

  return languageToken ? LANGUAGE_FLAG_COUNTRY_CODES[languageToken] : undefined;
}

function getStreamFlagCountryCode(
  stream: JellyfinMediaStream,
): string | undefined {
  return [stream.Language, stream.DisplayTitle, stream.Title]
    .map(getFlagCountryCode)
    .find(Boolean);
}

function StreamFlag({ stream }: { stream: JellyfinMediaStream }) {
  const countryCode = getStreamFlagCountryCode(stream);

  if (!countryCode) {
    return null;
  }

  return (
    <span
      className={`fi fi-${countryCode} block h-[18px] w-[25px] shrink-0 rounded-sm shadow-sm`}
      aria-hidden="true"
    />
  );
}

function getDefaultSettingsSection(): SettingsSection {
  if (!HIDE_QUALITY_SETTINGS) {
    return "quality";
  }

  if (!HIDE_AUDIO_SETTINGS) {
    return "audio";
  }

  return "subtitles";
}

function getSettingsTabButtonClass(active: boolean, disabled = false): string {
  if (disabled) {
    return "cursor-not-allowed bg-white/[0.03] text-white/25 opacity-60";
  }

  if (active) {
    return "bg-[var(--accent)] text-black";
  }

  return "bg-white/[0.06] text-white/65 hover:bg-white/[0.1] hover:text-white";
}

function formatSubtitleDelaySeconds(seconds: number): string {
  const roundedSeconds = Math.round(seconds * 100) / 100;
  const normalizedSeconds = Object.is(roundedSeconds, -0) ? 0 : roundedSeconds;
  const sign = normalizedSeconds > 0 ? "+" : "";
  const value = Number.isInteger(normalizedSeconds)
    ? normalizedSeconds.toFixed(1)
    : normalizedSeconds.toFixed(2).replace(/0$/, "");

  return `${sign}${value}s`;
}

function SettingsButton({
  title,
  subtitle,
  leading,
  active,
  disabled,
  hasSubmenu,
  compact,
  onClick,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  hasSubmenu?: boolean;
  compact?: boolean;
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
      <span className="flex min-w-0 items-center gap-3">
        {leading ? <span className="shrink-0">{leading}</span> : null}
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold text-white">
            {compact ? (
              title
            ) : (
              <AnimatedWidth value={title}>
                <AnimatedText value={title} />
              </AnimatedWidth>
            )}
          </span>
          {subtitle ? (
            <span className="mt-0.5 block truncate text-xs text-white/45">
              {compact ? (
                subtitle
              ) : (
                <AnimatedWidth value={subtitle}>
                  <AnimatedText value={subtitle} />
                </AnimatedWidth>
              )}
            </span>
          ) : null}
        </span>
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
  subtitleDelaySeconds,
  canSwitchAudio,
  canSwitchSubtitles,
  onSelectAutoQuality,
  onSelectQuality,
  onSelectAudioStream,
  onSelectSubtitleStream,
  onSubtitleDelayChange,
  onStartSubtitleEdit,
  compact = false,
}: PlayerSettingsPanelProps) {
  const { t } = useLanguage();
  const audioStreams = getUniqueStreams(getStreamsOfType(source, "Audio"));
  const subtitleStreams = getUniqueStreams(
    getStreamsOfType(source, "Subtitle"),
  );
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    getDefaultSettingsSection,
  );
  const canSelectAudio = canSwitchAudio && !DISABLE_AUDIO_SELECTION;

  return (
    <motion.div
      layout="size"
      transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
      className="seyirlik-player-settings-panel fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] z-[70] max-h-[calc(100dvh-1rem)] overflow-hidden rounded-2xl border border-white/10 bg-[rgba(18,18,20,0.96)] shadow-[0_24px_90px_rgba(0,0,0,0.72)] backdrop-blur-2xl sm:absolute sm:inset-x-auto sm:bottom-[5.25rem] sm:right-0 sm:w-[min(22rem,calc(100vw-2rem))]"
    >
      <div className="seyirlik-player-settings-header border-b border-white/10 px-4 py-3">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--accent)]">
          {t("settings.settings")}
        </p>
        <h2 className="mt-0.5 text-base font-black text-white">
          {t("settings.playbackOptions")}
        </h2>

        <div className="seyirlik-player-settings-tabs mt-3 grid grid-cols-3 gap-2">
          <button
            type="button"
            disabled={HIDE_QUALITY_SETTINGS}
            onClick={
              HIDE_QUALITY_SETTINGS
                ? undefined
                : () => setActiveSection("quality")
            }
            className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-bold transition ${getSettingsTabButtonClass(
              activeSection === "quality",
              HIDE_QUALITY_SETTINGS,
            )}`}
          >
            <SlidersHorizontal size={15} strokeWidth={2.2} />
            <span>{t("settings.quality")}</span>
          </button>

          <button
            type="button"
            disabled={HIDE_AUDIO_SETTINGS}
            onClick={
              HIDE_AUDIO_SETTINGS ? undefined : () => setActiveSection("audio")
            }
            className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-bold transition ${getSettingsTabButtonClass(
              activeSection === "audio",
              HIDE_AUDIO_SETTINGS,
            )}`}
          >
            <Volume2 size={15} strokeWidth={2.2} />
            <span>{t("settings.audio")}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveSection("subtitles")}
            className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-bold transition ${getSettingsTabButtonClass(
              activeSection === "subtitles",
            )}`}
          >
            <Subtitles size={15} strokeWidth={2.2} />
            <span>{t("settings.subtitles")}</span>
          </button>
        </div>
      </div>

      <motion.div
        layout="size"
        transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
        className="seyirlik-player-settings-content max-h-[calc(100dvh-8.75rem)] overflow-y-auto p-2 sm:max-h-[min(28rem,calc(100svh-15rem))]"
      >
        <AnimatePresence mode="wait" initial={false}>
          {!HIDE_QUALITY_SETTINGS && activeSection === "quality" ? (
            <motion.div
              key="quality"
              layout="size"
              initial={{ opacity: 0, height: 0, y: 8 }}
              animate={{ opacity: 1, height: "auto", y: 0 }}
              exit={{ opacity: 0, height: 0, y: -8 }}
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
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
                compact={compact}
              />

              <SettingsButton
                title={t("settings.auto")}
                subtitle={
                  selectedQualityId === "auto"
                    ? t("settings.bestJellyfinSource")
                    : t("settings.useBestJellyfinSource")
                }
                active={selectedQualityId === "auto"}
                compact={compact}
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
                            mbps: Math.round(
                              quality.maxStreamingBitrate / 1_000_000,
                            ),
                          })
                    }
                    active={selectedQualityId === quality.id}
                    compact={compact}
                    onClick={() => onSelectQuality(quality)}
                  />
                ))
              ) : (
                <SettingsButton
                  title={t("settings.manualQuality")}
                  subtitle={t("settings.noAlternateQualities")}
                  disabled
                  hasSubmenu
                  compact={compact}
                />
              )}
            </motion.div>
          ) : null}

          {!HIDE_AUDIO_SETTINGS && activeSection === "audio" ? (
            <motion.div
              key="audio"
              layout="size"
              initial={{ opacity: 0, height: 0, y: 8 }}
              animate={{ opacity: 1, height: "auto", y: 0 }}
              exit={{ opacity: 0, height: 0, y: -8 }}
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="px-2 pb-1 pt-2 text-xs font-black uppercase tracking-[0.16em] text-white/40">
                {t("settings.audio")}
              </div>

              {audioStreams.length > 0 ? (
                audioStreams.map((stream, index) => (
                  <SettingsButton
                    key={`${stream.Index ?? index}-audio`}
                    leading={<StreamFlag stream={stream} />}
                    title={getStreamLabel(
                      stream,
                      formatTemplate(t("settings.audioTrack"), {
                        number: index + 1,
                      }),
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
                    disabled={stream.Index === undefined || !canSelectAudio}
                    compact={compact}
                    onClick={
                      stream.Index === undefined || !canSelectAudio
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
            </motion.div>
          ) : null}

          {activeSection === "subtitles" ? (
            <motion.div
              key="subtitles"
              layout="size"
              initial={{ opacity: 0, height: 0, y: 8 }}
              animate={{ opacity: 1, height: "auto", y: 0 }}
              exit={{ opacity: 0, height: 0, y: -8 }}
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="px-2 pb-1 pt-2 text-xs font-black uppercase tracking-[0.16em] text-white/40">
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
                compact={compact}
                onClick={
                  canSwitchSubtitles
                    ? () => onSelectSubtitleStream(-1)
                    : undefined
                }
              />

              {subtitleStreams.length > 0 ? (
                subtitleStreams.map((stream, index) => (
                  <SettingsButton
                    key={`${stream.Index ?? index}-subtitle`}
                    leading={<StreamFlag stream={stream} />}
                    title={getStreamLabel(
                      stream,
                      formatTemplate(t("settings.subtitle"), {
                        number: index + 1,
                      }),
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
                    compact={compact}
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

              <div className="mx-2 mt-2 rounded-xl bg-white/[0.05] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-white">
                    {t("settings.subtitleDelay")}
                  </span>
                  <span className="shrink-0 rounded-full bg-white/[0.08] px-2 py-1 text-xs font-black text-[var(--accent)]">
                    {formatSubtitleDelaySeconds(subtitleDelaySeconds)}
                  </span>
                </div>
                <input
                  type="range"
                  min={SUBTITLE_DELAY_MIN_SECONDS}
                  max={SUBTITLE_DELAY_MAX_SECONDS}
                  step={SUBTITLE_DELAY_STEP_SECONDS}
                  value={subtitleDelaySeconds}
                  aria-label={t("settings.subtitleDelay")}
                  onChange={(event) =>
                    onSubtitleDelayChange(Number(event.currentTarget.value))
                  }
                  className="mt-3 h-2 w-full cursor-pointer accent-[var(--accent)]"
                />
                <div className="mt-1 flex items-center justify-between text-[0.65rem] font-bold text-white/35">
                  <span>
                    {formatSubtitleDelaySeconds(SUBTITLE_DELAY_MIN_SECONDS)}
                  </span>
                  <span>
                    {formatSubtitleDelaySeconds(SUBTITLE_DELAY_MAX_SECONDS)}
                  </span>
                </div>
              </div>

              <SettingsButton
                title={t("settings.editSubtitles")}
                subtitle={
                  selectedSubtitleStreamIndex >= 0
                    ? t("settings.dragResizeSubtitles")
                    : t("settings.enableSubtitlesToEdit")
                }
                disabled={
                  selectedSubtitleStreamIndex < 0 ||
                  !canSwitchSubtitles ||
                  !onStartSubtitleEdit
                }
                compact={compact}
                onClick={
                  selectedSubtitleStreamIndex < 0 ||
                  !canSwitchSubtitles ||
                  !onStartSubtitleEdit
                    ? undefined
                    : onStartSubtitleEdit
                }
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
