import { useCallback, useEffect, useState } from "react";
import { Ban, RefreshCw, SearchCheck } from "lucide-react";
import { setPageTitle } from "../../lib/pageTitle";
import { useLanguage } from "../../i18n/LanguageContext";
import { WorkflowSteps } from "../../components/admin/WorkflowSteps";
import {
  actionsFor,
  bucketOf,
  progressStep,
  remedyFor,
  type AcquisitionBucket,
} from "../../lib/acquisitionPresentation";
import {
  blocklistAcquisition,
  cancelAcquisition,
  getAcquisition,
  listAcquisitions,
  listBlocklist,
  removeBlocklistEntry,
  retryAcquisition,
  type Acquisition,
  type AcquisitionDetail,
  type BlocklistEntry,
} from "../../lib/acquisitionsApi";

/**
 * Every download Seyirlik has asked for, and why.
 *
 * The question this page exists to answer is not "what is downloading" — the
 * download client already shows that — but "why does this exist, which release
 * was chosen, and what happened to it". So the decision is given as much room
 * as the progress, and a failure is shown with what it asks of the reader
 * rather than as a code.
 */

const ACTION_BUTTON =
  "inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.08] px-3 py-1.5 text-xs font-black text-white/80 transition hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

/** What the last blocklisting did, said once, above the list. */
type Notice =
  | { kind: "blocklisted" }
  | { kind: "replaced"; releaseTitle: string }
  | { kind: "nothingElse" }
  | { kind: "noProfile" }
  | { kind: "failed" };

const BUCKET_ORDER: AcquisitionBucket[] = [
  "needsAttention",
  "active",
  "finished",
];

export function AcquisitionsPage() {
  const { t } = useLanguage();
  const [acquisitions, setAcquisitions] = useState<Acquisition[] | null>(null);
  const [selected, setSelected] = useState<AcquisitionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [blocklist, setBlocklist] = useState<BlocklistEntry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const loadBlocklist = useCallback(async () => {
    try {
      setBlocklist(await listBlocklist());
    } catch {
      // The blocklist is secondary here; the acquisitions still load.
    }
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setFailure(null);
    void loadBlocklist();
    try {
      setAcquisitions(await listAcquisitions());
    } catch {
      // The message from a failed request can carry a URL; the page says that
      // it could not load rather than repeating whatever the client threw.
      setFailure("admin.acquisitions.loadFailed");
    } finally {
      setIsLoading(false);
    }
  }, [loadBlocklist]);

  useEffect(() => {
    setPageTitle(`${t("admin.acquisitions.title")} · Seyirlik`, {
      canonicalPath: "/admin/acquisitions",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let isCancelled = false;

    void (async () => {
      try {
        void listBlocklist()
          .then((entries) => {
            if (!isCancelled) setBlocklist(entries);
          })
          .catch(() => undefined);
        const rows = await listAcquisitions();
        if (!isCancelled) setAcquisitions(rows);
      } catch {
        if (!isCancelled) setFailure("admin.acquisitions.loadFailed");
      } finally {
        if (!isCancelled) setIsLoading(false);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, []);

  const open = useCallback(async (id: string) => {
    setSelected(await getAcquisition(id));
  }, []);

  const act = useCallback(
    async (id: string, action: "retry" | "cancel") => {
      await (action === "retry" ? retryAcquisition(id) : cancelAcquisition(id));
      await load();
      setSelected(await getAcquisition(id));
    },
    [load],
  );

  /*
   * Searching again runs the indexer search inside the request, so it takes
   * seconds. The row's buttons stay disabled for that long, which is also
   * what keeps a second press from asking twice.
   */
  const blocklistRow = useCallback(
    async (id: string, searchAgain: boolean) => {
      setBusyId(id);
      setNotice(null);
      try {
        const outcome = await blocklistAcquisition(id, searchAgain);
        setNotice(
          outcome.replacement
            ? {
                kind: "replaced",
                releaseTitle: outcome.replacement.releaseTitle,
              }
            : !searchAgain
              ? { kind: "blocklisted" }
              : outcome.reason === "no-profile"
                ? { kind: "noProfile" }
                : { kind: "nothingElse" },
        );
      } catch {
        setNotice({ kind: "failed" });
      } finally {
        setBusyId(null);
        await load();
      }
    },
    [load],
  );

  const unblock = useCallback(
    async (entryId: string) => {
      try {
        await removeBlocklistEntry(entryId);
      } finally {
        await loadBlocklist();
      }
    },
    [loadBlocklist],
  );

  const rows = acquisitions ?? [];

  return (
    <div className="w-full space-y-6">
      <WorkflowSteps current="/admin/acquisitions" />
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => void load()}
          disabled={isLoading}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-bold text-white/70 transition hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <RefreshCw size={15} className={isLoading ? "animate-spin" : ""} />
          {t("admin.acquisitions.refresh")}
        </button>
      </div>

      <header>
        <h1 className="text-3xl font-black text-white">
          {t("admin.acquisitions.title")}
        </h1>

        <p className="mt-1 text-sm font-semibold text-white/50">
          {t("admin.acquisitions.description")}
        </p>
      </header>

      {failure ? (
        <p
          role="alert"
          className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm font-bold text-red-200"
        >
          {t(failure as "admin.acquisitions.loadFailed")}
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className={`rounded-2xl border px-4 py-3 text-sm font-bold ${
            notice.kind === "replaced" || notice.kind === "blocklisted"
              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
              : "border-amber-400/30 bg-amber-400/10 text-amber-100"
          }`}
        >
          {t(
            `admin.acquisitions.notice.${notice.kind}` as "admin.acquisitions.notice.blocklisted",
          )}
          {/* Provider text, rendered as text. */}
          {notice.kind === "replaced" ? (
            <span className="mt-1 block break-all text-xs font-medium opacity-80">
              {notice.releaseTitle}
            </span>
          ) : null}
        </p>
      ) : null}

      {!isLoading && rows.length === 0 && !failure ? (
        <p className="rounded-3xl border border-white/10 bg-white/[0.04] px-5 py-8 text-center text-sm font-semibold text-white/45">
          {t("admin.acquisitions.empty")}
        </p>
      ) : null}

      {BUCKET_ORDER.map((bucket) => {
        const inBucket = rows.filter((row) => bucketOf(row.state) === bucket);
        if (inBucket.length === 0) return null;

        return (
          <section key={bucket} aria-labelledby={`bucket-${bucket}`}>
            <h2
              id={`bucket-${bucket}`}
              className="px-1 text-lg font-black text-white"
            >
              {t(
                `admin.acquisitions.bucket.${bucket}` as "admin.acquisitions.bucket.active",
              )}
            </h2>

            <ul className="mt-3 space-y-2">
              {inBucket.map((row) => {
                const step = progressStep(row.state);
                const actions = actionsFor(row.state, row.failureClass);
                const isBusy = busyId === row.id;

                return (
                  <li
                    key={row.id}
                    className="rounded-2xl border border-white/10 bg-black/25 p-4"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <button
                        type="button"
                        onClick={() => void open(row.id)}
                        className="text-left text-base font-black text-white transition hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        {row.target.title}
                      </button>

                      <span className="text-sm font-bold text-white/60">
                        {t(
                          `admin.acquisitions.state.${row.state}` as "admin.acquisitions.state.queued",
                        )}
                        {step ? ` · ${step.step}/${step.of}` : ""}
                      </span>
                    </div>

                    {/* The release name is provider text: rendered as text. */}
                    <p className="mt-1 break-all text-xs font-medium text-white/45">
                      {row.releaseTitle}
                    </p>

                    <p className="mt-1 text-xs font-medium text-white/35">
                      {t("admin.acquisitions.origin")}:{" "}
                      {t(
                        `admin.acquisitions.originValue.${row.origin}` as "admin.acquisitions.originValue.manual",
                      )}
                      {row.attempt > 1
                        ? ` · ${t("admin.acquisitions.attempt")} ${row.attempt}`
                        : ""}
                    </p>

                    {row.failureClass ? (
                      <p className="mt-2 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs font-bold text-amber-200">
                        {t(
                          `admin.acquisitions.failure.${row.failureClass}` as "admin.acquisitions.failure.unknown",
                        )}
                        {/* A superseded row was already acted on: what to do
                            about it no longer applies. */}
                        {row.state === "superseded"
                          ? null
                          : ` — ${t(
                              `admin.acquisitions.remedy.${remedyFor(row.failureClass)}` as "admin.acquisitions.remedy.waits",
                            )}`}
                      </p>
                    ) : null}

                    <div className="mt-3 flex flex-wrap gap-2">
                      {actions.canBlocklist ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void blocklistRow(row.id, true)}
                          className={ACTION_BUTTON}
                        >
                          <SearchCheck size={13} aria-hidden="true" />
                          {isBusy
                            ? t("admin.acquisitions.searching")
                            : t("admin.acquisitions.blocklistAndSearch")}
                        </button>
                      ) : null}

                      {actions.canBlocklist ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void blocklistRow(row.id, false)}
                          className={ACTION_BUTTON}
                        >
                          <Ban size={13} aria-hidden="true" />
                          {t("admin.acquisitions.blocklist")}
                        </button>
                      ) : null}

                      {actions.canRetry ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void act(row.id, "retry")}
                          className={ACTION_BUTTON}
                        >
                          {t("admin.acquisitions.retry")}
                        </button>
                      ) : null}

                      {actions.canCancel ? (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void act(row.id, "cancel")}
                          className={ACTION_BUTTON}
                        >
                          {t("admin.acquisitions.cancel")}
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {blocklist.length > 0 ? (
        <section aria-labelledby="blocklist-heading">
          <h2
            id="blocklist-heading"
            className="px-1 text-lg font-black text-white"
          >
            {t("admin.acquisitions.blocklistHeading")}
          </h2>
          <p className="mt-1 px-1 text-sm font-semibold text-white/50">
            {t("admin.acquisitions.blocklistDescription")}
          </p>

          <ul className="mt-3 space-y-2">
            {blocklist.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/25 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  {entry.targetTitle ? (
                    <p className="text-sm font-black text-white">
                      {entry.targetTitle}
                    </p>
                  ) : null}
                  {/* Provider text, rendered as text. */}
                  <p className="break-all text-xs font-medium text-white/45">
                    {entry.releaseTitle}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void unblock(entry.id)}
                  className={ACTION_BUTTON}
                >
                  {t("admin.acquisitions.unblock")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {selected ? (
        <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-5">
          <h2 className="text-lg font-black text-white">
            {t("admin.acquisitions.why")}
          </h2>

          {selected.decision ? (
            <>
              <p className="mt-2 text-sm font-semibold text-white/70">
                {selected.decision.profileName} ·{" "}
                {t("admin.acquisitions.score")} {selected.decision.score}
              </p>

              {selected.decision.reasons.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {selected.decision.reasons.map((reason, index) => (
                    <li
                      key={`${reason.code ?? "reason"}-${index}`}
                      className="text-sm font-medium text-white/55"
                    >
                      {reason.detail ?? reason.code}
                    </li>
                  ))}
                </ul>
              ) : null}

              {selected.decision.rejected.length > 0 ? (
                <>
                  <h3 className="mt-4 text-sm font-black text-white/70">
                    {t("admin.acquisitions.rejected")}
                  </h3>

                  <ul className="mt-1 space-y-1">
                    {selected.decision.rejected.map((entry, index) => (
                      <li
                        key={`${entry.title ?? "release"}-${index}`}
                        className="break-all text-xs font-medium text-white/45"
                      >
                        {entry.title} — {entry.reason}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-sm font-medium text-white/45">
              {t("admin.acquisitions.noDecision")}
            </p>
          )}

          <h3 className="mt-5 text-sm font-black text-white/70">
            {t("admin.acquisitions.history")}
          </h3>

          <ol className="mt-2 space-y-1">
            {selected.events.map((event, index) => (
              <li
                key={`${event.toState}-${index}`}
                className="text-xs font-medium text-white/45"
              >
                {new Date(event.at).toLocaleString()} · {event.toState}
                {event.detail ? ` — ${event.detail}` : ""}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
