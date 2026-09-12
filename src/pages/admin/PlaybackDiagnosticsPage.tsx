import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";

const PlaybackHealthPage = lazy(async () => ({
  default: (await import("../PlaybackHealthPage")).PlaybackHealthPage,
}));
const PlaybackAuditPage = lazy(async () => ({
  default: (await import("../PlaybackAuditPage")).PlaybackAuditPage,
}));

type Tab = "titles" | "network";

/**
 * Why something will not play, from either end.
 *
 * Playback Audit asked the server what it would do with each title; Playback
 * Health asked whether this browser can reach the server at all. They were two
 * tools for one question, so they are two tabs of one now. The old addresses
 * open the matching tab.
 */
export function PlaybackDiagnosticsPage({
  initialTab = "titles",
}: {
  initialTab?: Tab;
}) {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab: Tab =
    requested === "network" || requested === "titles" ? requested : initialTab;

  return (
    <div className="w-full space-y-6">
      <div
        role="tablist"
        aria-label={t("devtools.card.playbackDiagnostics.title")}
        className="inline-flex rounded-2xl border border-white/10 bg-black/30 p-1"
      >
        {(["titles", "network"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            onClick={() => setSearchParams({ tab: candidate })}
            className={`rounded-xl px-4 py-2 text-sm font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              tab === candidate
                ? "bg-[var(--accent)] text-black"
                : "text-white/55 hover:text-white"
            }`}
          >
            {t(
              candidate === "titles"
                ? "devtools.card.playbackAudit.title"
                : "devtools.card.playbackHealth.title",
            )}
          </button>
        ))}
      </div>
      <Suspense fallback={null}>
        {tab === "titles" ? <PlaybackAuditPage /> : <PlaybackHealthPage />}
      </Suspense>
    </div>
  );
}
