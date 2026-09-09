import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, KeyRound, RefreshCw } from "lucide-react";
import { setPageTitle } from "../../lib/pageTitle";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  listSubtitleAttempts,
  resumeSubtitleAttempt,
  type SubtitleAttempt,
} from "../../lib/subtitlesApi";

/**
 * What the subtitle system is doing, and what it is waiting for.
 *
 * The state that shapes the page is `needs-authentication`. An attempt sitting
 * there is not failing and not progressing: a provider wants somebody to sign
 * in, and until they do nothing will change however long it is left. Saying
 * that plainly is the whole job, because the alternative — showing it as
 * "working" — is a queue that appears busy and is in fact stopped.
 */

/** In progress, waiting on a person, finished. */
function bucketOf(state: SubtitleAttempt["state"]): 0 | 1 | 2 {
  if (state === "needs-authentication") return 0;
  if (state === "installed" || state === "failed" || state === "superseded") {
    return 2;
  }
  return 1;
}

export function SubtitlesPage() {
  const { t } = useLanguage();
  const [attempts, setAttempts] = useState<SubtitleAttempt[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [resumeFailed, setResumeFailed] = useState<string | null>(null);

  useEffect(() => {
    setPageTitle(`${t("admin.subtitles.title")} · Seyirlik`, {
      canonicalPath: "/admin/subtitles",
      robots: "noindex, nofollow",
    });
  }, [t]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setFailure(null);
    try {
      setAttempts(await listSubtitleAttempts());
    } catch {
      setFailure("admin.subtitles.loadFailed");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let isCancelled = false;

    void (async () => {
      try {
        const rows = await listSubtitleAttempts();
        if (!isCancelled) setAttempts(rows);
      } catch {
        if (!isCancelled) setFailure("admin.subtitles.loadFailed");
      } finally {
        if (!isCancelled) setIsLoading(false);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, []);

  const resume = useCallback(
    async (attemptId: string) => {
      setResumeFailed(null);
      try {
        await resumeSubtitleAttempt(attemptId);
        await load();
      } catch {
        /*
         * The server refuses a resume unless the attempt really is waiting for
         * authentication, and it is the authority on that. Nothing here marks
         * an attempt as signed in on its own.
         */
        setResumeFailed(attemptId);
      }
    },
    [load],
  );

  const rows = [...(attempts ?? [])].sort(
    (a, b) => bucketOf(a.state) - bucketOf(b.state),
  );
  const waiting = rows.filter(
    (row) => row.state === "needs-authentication",
  ).length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Link
          to="/admin"
          className="inline-flex items-center gap-2 text-sm font-bold text-white/50 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <ArrowLeft size={16} />
          {t("admin.title")}
        </Link>

        <button
          type="button"
          onClick={() => void load()}
          disabled={isLoading}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-bold text-white/70 transition hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <RefreshCw size={15} className={isLoading ? "animate-spin" : ""} />
          {t("admin.subtitles.refresh")}
        </button>
      </div>

      <header>
        <h1 className="text-3xl font-black text-white">
          {t("admin.subtitles.title")}
        </h1>

        <p className="mt-1 text-sm font-semibold text-white/50">
          {t("admin.subtitles.description")}
        </p>
      </header>

      {waiting > 0 ? (
        <p className="rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm font-bold text-amber-200">
          {t("admin.subtitles.waitingBanner")} ({waiting})
        </p>
      ) : null}

      {failure ? (
        <p
          role="alert"
          className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm font-bold text-red-200"
        >
          {t(failure as "admin.subtitles.loadFailed")}
        </p>
      ) : null}

      {!isLoading && rows.length === 0 && !failure ? (
        <p className="rounded-3xl border border-white/10 bg-white/[0.04] px-5 py-8 text-center text-sm font-semibold text-white/45">
          {t("admin.subtitles.empty")}
        </p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.attemptId}
            className={`rounded-2xl border p-4 ${
              row.state === "needs-authentication"
                ? "border-amber-400/30 bg-amber-400/[0.07]"
                : "border-white/10 bg-black/25"
            }`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-sm font-black text-white">
                {row.language.toUpperCase()}
                {row.forced ? ` · ${t("admin.subtitles.forced")}` : ""}
                {row.hearingImpaired === "prefer"
                  ? ` · ${t("admin.subtitles.sdh")}`
                  : ""}
              </span>

              <span className="text-sm font-bold text-white/60">
                {t(
                  `admin.subtitles.state.${row.state}` as "admin.subtitles.state.installed",
                )}
              </span>
            </div>

            <p className="mt-1 text-xs font-medium text-white/35">
              {row.providerId ? `${row.providerId} · ` : ""}
              {row.score !== null
                ? `${t("admin.subtitles.score")} ${row.score} · `
                : ""}
              {t("admin.subtitles.attempt")} {row.attempt}
            </p>

            {row.failureClass ? (
              <p className="mt-2 text-xs font-bold text-amber-200">
                {row.failureClass}
              </p>
            ) : null}

            {row.state === "needs-authentication" ? (
              <div className="mt-3">
                {/*
                  Deliberately truthful. There is no embedded browser to open
                  yet, so the page says the operation is waiting for a sign-in
                  that has to happen elsewhere, rather than offering a button
                  that would pretend to perform one.
                */}
                <p className="text-xs font-medium text-white/60">
                  {t("admin.subtitles.authExplanation")}
                  {row.awaitingProviderId ? ` (${row.awaitingProviderId})` : ""}
                </p>

                <button
                  type="button"
                  onClick={() => void resume(row.attemptId)}
                  className="mt-2 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.08] px-3 py-1.5 text-xs font-black text-white/80 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <KeyRound size={13} />
                  {t("admin.subtitles.resume")}
                </button>

                {resumeFailed === row.attemptId ? (
                  <p
                    role="alert"
                    className="mt-2 text-xs font-bold text-red-200"
                  >
                    {t("admin.subtitles.resumeRefused")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
