import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  formatBytes,
  type HoldingFacts,
  type HoldingTone,
} from "../../lib/libraryAdminApi";
import { languages, TONE_STYLE } from "./libraryStyle";
import type { Notice } from "./useTitleActions";

/**
 * How the library is drawn, shared by the list and the title workspace.
 *
 * Colour is the first read: green is on disk, purple is on its way, red is
 * wanted and absent. Everything else — size, languages, trickplay, what
 * subtitles are still being looked for — is the second.
 */

export function Facts({ facts }: { facts: HoldingFacts }) {
  const { t } = useLanguage();
  const parts = [
    facts.resolution ? `${facts.resolution}p` : null,
    facts.sizeBytes > 0 ? formatBytes(facts.sizeBytes) : null,
    languages(facts.audioLanguages)
      ? `${t("library.audio")} ${languages(facts.audioLanguages)}`
      : null,
    languages(facts.subtitleLanguages)
      ? `${t("library.subtitles")} ${languages(facts.subtitleLanguages)}`
      : facts.hasMedia
        ? `${t("library.subtitles")} —`
        : null,
    facts.pendingSubtitles.length
      ? `${t("library.lookingFor")} ${languages(facts.pendingSubtitles)}`
      : null,
    facts.files > 0
      ? `${t("library.trickplay")} ${facts.trickplayFiles}/${facts.files}`
      : null,
    facts.processing ? t("library.processing") : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p className="mt-1 text-xs font-medium tabular-nums text-white/55">
      {parts.join(" · ")}
    </p>
  );
}

export function StatusPill({ tone }: { tone: HoldingTone }) {
  const { t } = useLanguage();
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-black uppercase tracking-wide ${TONE_STYLE[tone].pill}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${TONE_STYLE[tone].dot}`}
      />
      {t(`library.tone.${tone}` as TranslationKey)}
    </span>
  );
}

export function NoticeLine({ notice }: { notice: Notice }) {
  const { t } = useLanguage();
  if (!notice) return null;
  return (
    <p
      role={notice.tone === "error" ? "alert" : "status"}
      className={`text-sm ${notice.tone === "error" ? "text-red-200" : "text-emerald-200"}`}
    >
      {notice.text}{" "}
      {notice.text === t("library.subtitlesUnconfigured") ? (
        <Link className="underline" to="/admin/integrations">
          {t("admin.integrations.title")}
        </Link>
      ) : null}
    </p>
  );
}
