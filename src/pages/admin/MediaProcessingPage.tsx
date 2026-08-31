import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Cpu,
  Loader2,
  Pause,
  Play,
  RefreshCcw,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { setPageTitle } from "../../lib/pageTitle";
import { notify } from "../../lib/notifications/notificationStore";
import {
  getPrimaryImageUrl,
  getVideoItemsForLibrary,
  getUserViews,
} from "../../lib/mediaApi";
import type { MediaItem, MediaLibrary } from "../../lib/types";
import { getDisplayTitle } from "../../lib/format";
import {
  cancelProcessingJob,
  deleteProcessingJob,
  pauseProcessingJob,
  resumeProcessingJob,
  enqueueProcessing,
  getProcessingJob,
  getProcessingOverview,
  previewProcessing,
  processingStreamUrl,
  retryProcessingJob,
  type ProcessingJob,
  type ProcessingJobEvent,
  type ProcessingOverview,
  type ProcessingPreview,
} from "../../lib/processingApi";
import {
  canCancel,
  canPause,
  canResume,
  canRetry,
  formatBytes,
  formatDuration,
  formatFinishedAt,
  formatSpeed,
  lastSequence,
  mergeEvents,
  mergeJobFrame,
  PROCESSING_STAGE_ORDER,
  progressPercent,
  processingDurationSeconds,
  processingElapsedSeconds,
  stageStateFor,
  summariseLanguages,
} from "./processingModel";
import { formatTemplate } from "./libraryMaintenanceModel";

const CARD = "rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5";
const LABEL =
  "text-[11px] font-black uppercase tracking-[0.14em] text-white/40";
/*
 * A running encode reports speed, frame rate and progress several times a
 * second, so a five-second poll showed a figure that was already stale by the
 * time it was painted — and a job that started and failed inside one interval
 * never appeared to run at all.
 */
const PROCESSING_REFRESH_MS = 1_000;

type PreviewLoadState =
  | { status: "waiting" | "loading" }
  | { status: "ready"; value: ProcessingPreview }
  | { status: "error"; message: string };

// React's development Strict Mode starts effects twice. Sharing only in-flight
// probes keeps that safety check from analysing the same media file twice,
// while still allowing a fresh preview after the probe settles.
const previewRequests = new Map<string, Promise<ProcessingPreview>>();

function loadProcessingPreview(itemId: string): Promise<ProcessingPreview> {
  const current = previewRequests.get(itemId);
  if (current) return current;
  const request = previewProcessing(itemId);
  previewRequests.set(itemId, request);
  const clear = () => {
    if (previewRequests.get(itemId) === request) previewRequests.delete(itemId);
  };
  void request.then(clear, clear);
  return request;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={LABEL}>{label}</span>
      <span className="text-sm font-semibold text-white/90 tabular-nums">
        {value}
      </span>
    </div>
  );
}

function Chip({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "muted";
  children: React.ReactNode;
}) {
  const tones = {
    ok: "bg-emerald-400/15 text-emerald-200 border-emerald-400/25",
    warn: "bg-amber-400/15 text-amber-200 border-amber-400/25",
    bad: "bg-rose-400/15 text-rose-200 border-rose-400/25",
    muted: "bg-white/[0.06] text-white/60 border-white/10",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * The ladder as a list of rungs, each saying whether it already exists.
 *
 * This replaces a single joined line that listed the whole ladder in one
 * colour: it could say "already packaged" beside a ladder containing a rung
 * the title did not have, and nothing in the text distinguished the two. A
 * rung is the unit the decision is actually made in, so it is the unit shown.
 *
 * Green is what will be reused; amber is what this run would encode. Amber
 * rather than red on purpose — a rung that does not exist yet is planned work,
 * not a fault, and the page keeps red for things that actually went wrong.
 */
function LadderRungs({
  planned,
  present,
  keptLabel,
  buildLabel,
}: {
  planned: readonly number[];
  present: readonly number[];
  keptLabel: string;
  buildLabel: string;
}) {
  const owned = new Set(present);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {planned.map((height) => {
          const kept = owned.has(height);
          return (
            <span
              key={height}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-bold tabular-nums ${
                kept
                  ? "border-emerald-400/25 bg-emerald-400/15 text-emerald-200"
                  : "border-amber-400/30 bg-amber-400/15 text-amber-100"
              }`}
            >
              <span aria-hidden="true" className="text-[10px] leading-none">
                {kept ? "\u2713" : "+"}
              </span>
              {height}p
            </span>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-white/45">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
          {keptLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-amber-400/70" />
          {buildLabel}
        </span>
      </div>
    </div>
  );
}

export function MediaProcessingPage() {
  const { language, t } = useLanguage();
  const [activeTab, setActiveTab] = useState<"titles" | "processes">("titles");
  const [overview, setOverview] = useState<ProcessingOverview | null>(null);
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [titlesLoading, setTitlesLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [previews, setPreviews] = useState<Record<string, PreviewLoadState>>(
    {},
  );
  const [startingItemId, setStartingItemId] = useState<string | null>(null);
  const [removingJobIds, setRemovingJobIds] = useState<Set<string>>(new Set());
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [openJob, setOpenJob] = useState<ProcessingJob | null>(null);
  const [events, setEvents] = useState<ProcessingJobEvent[]>([]);
  const [streamState, setStreamState] = useState<
    "idle" | "live" | "reconnecting"
  >("idle");
  const sourceRef = useRef<EventSource | null>(null);
  const overviewRequestRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    setPageTitle(t("processing.title"));
  }, [t]);

  const refreshOverview = useCallback(async () => {
    if (overviewRequestRef.current) return overviewRequestRef.current;
    const request = (async () => {
      try {
        setOverview(await getProcessingOverview());
        setRefreshedAt(Date.now());
      } catch {
        notify({ tone: "error", title: t("common.somethingWentWrong") });
      } finally {
        setLoading(false);
      }
    })();
    overviewRequestRef.current = request;
    await request.finally(() => {
      if (overviewRequestRef.current === request) {
        overviewRequestRef.current = null;
      }
    });
  }, [t]);

  useEffect(() => {
    void refreshOverview();
    const timer = window.setInterval(
      () => void refreshOverview(),
      PROCESSING_REFRESH_MS,
    );
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshOverview();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [refreshOverview]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const views: MediaLibrary[] = await getUserViews();
        const movies = views.find((view) => view.CollectionType === "movies");
        if (!movies) return;
        const found = await getVideoItemsForLibrary(movies.Id);
        if (!cancelled) setItems(found);
      } catch {
        // History and running jobs still work when the catalogue is offline.
      } finally {
        if (!cancelled) setTitlesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Previewing can probe a large media file, so titles are deliberately
   * analysed one at a time. The catalogue cards render before this loop starts
   * yielding results, keeping initial page load independent of ffprobe speed.
   */
  useEffect(() => {
    if (items.length === 0) return undefined;
    let cancelled = false;
    setPreviews(
      Object.fromEntries(items.map((item) => [item.Id, { status: "waiting" }])),
    );

    void (async () => {
      for (const item of items) {
        if (cancelled) return;
        setPreviews((current) => ({
          ...current,
          [item.Id]: { status: "loading" },
        }));
        try {
          const value = await loadProcessingPreview(item.Id);
          if (cancelled) return;
          setPreviews((current) => ({
            ...current,
            [item.Id]: { status: "ready", value },
          }));
        } catch (error) {
          if (cancelled) return;
          setPreviews((current) => ({
            ...current,
            [item.Id]: {
              status: "error",
              message: error instanceof Error ? error.message : "",
            },
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [items]);

  /**
   * Live progress for the open job.
   *
   * Reconnects resume from the last sequence the page already has, so a refresh
   * mid-encode continues the timeline instead of replaying or losing it.
   */
  useEffect(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    if (!openJobId) {
      setStreamState("idle");
      return undefined;
    }

    let closed = false;
    void (async () => {
      const snapshot = await getProcessingJob(openJobId).catch(() => null);
      if (closed || !snapshot) return;
      setOpenJob(snapshot.job);
      setEvents(snapshot.events);

      const connect = (from: number) => {
        if (closed) return;
        const source = new EventSource(processingStreamUrl(openJobId, from), {
          withCredentials: true,
        });
        sourceRef.current = source;
        source.addEventListener("open", () => setStreamState("live"));
        source.addEventListener("progress", (event) => {
          const frame = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as ProcessingJob;
          setOpenJob((previous) => mergeJobFrame(previous ?? undefined, frame));
        });
        source.addEventListener("stage", (event) => {
          const entry = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as ProcessingJobEvent;
          setEvents((previous) => mergeEvents(previous, [entry]));
        });
        source.addEventListener("done", (event) => {
          const frame = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as ProcessingJob;
          setOpenJob((previous) => mergeJobFrame(previous ?? undefined, frame));
          setStreamState("idle");
          source.close();
          void refreshOverview();
        });
        source.addEventListener("error", () => {
          if (closed) return;
          setStreamState("reconnecting");
          source.close();
          // The browser's own retry would replay from the start, so the
          // reconnect is made explicitly from the last sequence seen.
          window.setTimeout(() => {
            setEvents((current) => {
              connect(lastSequence(current));
              return current;
            });
          }, 1500);
        });
      };

      connect(lastSequence(snapshot.events));
    })();

    return () => {
      closed = true;
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [openJobId, refreshOverview]);

  const runPreview = useCallback(
    async (itemId: string) => {
      setPreviews((current) => ({
        ...current,
        [itemId]: { status: "loading" },
      }));
      try {
        const value = await loadProcessingPreview(itemId);
        setPreviews((current) => ({
          ...current,
          [itemId]: { status: "ready", value },
        }));
      } catch (error) {
        setPreviews((current) => ({
          ...current,
          [itemId]: {
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : t("processing.previewUnavailable"),
          },
        }));
      }
    },
    [t],
  );

  const startJob = useCallback(
    async (itemId: string) => {
      setStartingItemId(itemId);
      try {
        const { job } = await enqueueProcessing(itemId);
        setOpenJobId(job.id);
        await refreshOverview();
        await runPreview(itemId);
      } catch (error) {
        notify({
          tone: "error",
          title:
            error instanceof Error
              ? error.message
              : t("common.somethingWentWrong"),
        });
      } finally {
        setStartingItemId(null);
      }
    },
    [refreshOverview, runPreview, t],
  );

  const removeJob = useCallback(
    async (jobId: string) => {
      setRemovingJobIds((current) => new Set(current).add(jobId));
      try {
        await deleteProcessingJob(jobId);
        if (openJobId === jobId) setOpenJobId(null);
        await refreshOverview();
      } catch (error) {
        notify({
          tone: "error",
          title:
            error instanceof Error
              ? error.message
              : t("common.somethingWentWrong"),
        });
      } finally {
        setRemovingJobIds((current) => {
          const next = new Set(current);
          next.delete(jobId);
          return next;
        });
      }
    },
    [openJobId, refreshOverview, t],
  );

  const itemTitleFor = useCallback(
    (itemId: string) =>
      items.find((item) => item.Id === itemId)
        ? getDisplayTitle(items.find((item) => item.Id === itemId)!)
        : itemId.slice(0, 8),
    [items],
  );

  const jobs = overview?.jobs ?? [];
  const activeItemIds = useMemo(
    () =>
      new Set(
        jobs
          .filter((job) =>
            ["pending", "queued", "running", "paused"].includes(job.state),
          )
          .map((job) => job.itemId),
      ),
    [jobs],
  );
  const counts = overview?.counts;
  const hardware = overview?.hardware;
  const detail = openJob;
  const filteredItems = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase(language);
    return [...items]
      .sort((left, right) =>
        getDisplayTitle(left).localeCompare(getDisplayTitle(right), language),
      )
      .filter((item) =>
        query
          ? getDisplayTitle(item).toLocaleLowerCase(language).includes(query)
          : true,
      );
  }, [items, language, searchTerm]);
  const dateLocale = language === "tr" ? "tr-TR" : "en-US";
  const languages = useMemo(
    () =>
      summariseLanguages(
        detail?.decision?.streams.audio,
        detail?.decision?.streams.subtitles,
        (key) => t(key as never),
        t("processing.forced"),
      ),
    [detail, t],
  );

  return (
    <div className="min-h-screen bg-black px-4 pb-24 pt-6 text-white sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-3">
          <Link
            to="/dev"
            className="inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-1 text-sm text-white/50 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <ChevronLeft size={16} aria-hidden="true" />
            {t("processing.back")}
          </Link>
          <div>
            <h1 className="text-3xl font-black tracking-tight">
              {t("processing.title")}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-white/50">
              {t("processing.subtitle")}
            </p>
          </div>
        </header>

        <div
          role="tablist"
          aria-label={t("processing.title")}
          className="grid w-full grid-cols-2 rounded-2xl border border-white/10 bg-white/[0.03] p-1 sm:w-fit sm:min-w-80"
        >
          {(["titles", "processes"] as const).map((tab) => {
            const selected = activeTab === tab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`processing-tab-${tab}`}
                aria-selected={selected}
                aria-controls={`processing-panel-${tab}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveTab(tab)}
                className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  selected
                    ? "bg-white/[0.1] text-white shadow-sm"
                    : "text-white/45 hover:bg-white/[0.05] hover:text-white/75"
                }`}
              >
                {t(`processing.tabs.${tab}`)}
                {tab === "processes" && jobs.length > 0 ? (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                      selected
                        ? "bg-[var(--accent)] text-black"
                        : "bg-white/10 text-white/55"
                    }`}
                  >
                    {jobs.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* ------------------------------------------------ health strip */}
        <section
          className={`${CARD} flex flex-wrap items-center gap-x-8 gap-y-4`}
        >
          <div className="flex items-center gap-2">
            <Cpu
              size={18}
              className="text-[var(--accent)]"
              aria-hidden="true"
            />
            <span className={LABEL}>{t("processing.hardware")}</span>
          </div>
          {loading && !hardware ? (
            <div
              className="h-5 w-40 animate-pulse rounded bg-white/10"
              aria-label={t("processing.loading")}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {hardware?.adapters.map((adapter) => (
                <Chip
                  key={adapter.id}
                  tone={adapter.available ? "ok" : "muted"}
                >
                  <span title={adapter.detail ?? undefined}>
                    {adapter.label}
                    {!adapter.available && adapter.reason
                      ? ` — ${t(`processing.reason.${adapter.reason}` as never)}`
                      : ""}
                  </span>
                </Chip>
              ))}
            </div>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-6">
            <Stat
              label={t("processing.counts.queued")}
              value={String((counts?.queued ?? 0) + (counts?.pending ?? 0))}
            />
            <Stat
              label={t("processing.counts.running")}
              value={String(counts?.running ?? 0)}
            />
            <Stat
              label={t("processing.counts.succeeded")}
              value={String(counts?.succeeded ?? 0)}
            />
            <Stat
              label={t("processing.counts.failed")}
              value={String(counts?.failed ?? 0)}
            />
          </div>
        </section>

        {/* --------------------------------------- searchable title catalogue */}
        {activeTab === "titles" ? (
          <section
            id="processing-panel-titles"
            role="tabpanel"
            aria-labelledby="processing-tab-titles"
            className="flex flex-col gap-3"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className={LABEL}>{t("processing.chooseTitle")}</span>
              <label className="relative block w-full sm:max-w-sm">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/35"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder={t("processing.search")}
                  aria-label={t("processing.search")}
                  className="w-full rounded-xl border border-white/10 bg-white/[0.04] py-2.5 pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-white/30 hover:border-white/20 focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
                />
              </label>
            </div>

            {titlesLoading ? (
              <div
                className="flex flex-col gap-3"
                aria-label={t("processing.loadingTitles")}
              >
                {[0, 1, 2].map((row) => (
                  <div key={row} className={`${CARD} flex gap-4`}>
                    <div className="aspect-[2/3] w-24 shrink-0 animate-pulse rounded-xl bg-white/[0.07] sm:w-28" />
                    <div className="flex flex-1 flex-col gap-3 py-2">
                      <div className="h-5 w-44 animate-pulse rounded bg-white/[0.07]" />
                      <div className="h-16 animate-pulse rounded-xl bg-white/[0.05]" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredItems.length === 0 ? (
              <div className={`${CARD} text-center text-sm text-white/55`}>
                {searchTerm.trim()
                  ? t("processing.noSearchResults")
                  : t("processing.emptyTitles")}
              </div>
            ) : (
              <ul className="flex flex-col gap-3">
                {filteredItems.map((item) => {
                  const title = getDisplayTitle(item);
                  const state = previews[item.Id] ?? { status: "waiting" };
                  const itemPreview =
                    state.status === "ready" ? state.value : null;
                  const imageUrl = item.ImageTags?.Primary
                    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 360)
                    : "";
                  const isStarting = startingItemId === item.Id;
                  const hasActiveJob = loading
                    ? Boolean(itemPreview?.activeJobId)
                    : activeItemIds.has(item.Id);
                  return (
                    <li
                      key={item.Id}
                      className={`${CARD} grid grid-cols-[6rem,minmax(0,1fr)] gap-4 sm:grid-cols-[7rem,minmax(0,1fr)] sm:gap-5`}
                    >
                      <div className="media-card-cinematic relative aspect-[2/3] w-24 self-start overflow-hidden rounded-xl border border-white/10 bg-[var(--surface)] sm:w-28">
                        {imageUrl ? (
                          <img
                            src={imageUrl}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center bg-[linear-gradient(145deg,#27272a,#09090b)] p-3 text-center text-xs font-bold text-white/80">
                            {title}
                          </div>
                        )}
                        {item.ProductionYear ? (
                          <span className="absolute bottom-2 left-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white/75 backdrop-blur">
                            {item.ProductionYear}
                          </span>
                        ) : null}
                      </div>

                      <div className="flex min-w-0 flex-col gap-3">
                        <div className="flex flex-wrap items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <h2 className="truncate text-base font-black text-white sm:text-lg">
                              {title}
                            </h2>
                            {itemPreview ? (
                              <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-white/45">
                                {itemPreview.decision.summary}
                              </p>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            onClick={() => void startJob(item.Id)}
                            disabled={
                              isStarting ||
                              state.status !== "ready" ||
                              hasActiveJob
                            }
                            className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-black text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                          >
                            {isStarting ? (
                              <Loader2
                                size={14}
                                className="animate-spin motion-reduce:animate-none"
                                aria-hidden="true"
                              />
                            ) : (
                              <Play size={14} aria-hidden="true" />
                            )}
                            {hasActiveJob
                              ? t("processing.activeJob")
                              : t("processing.start")}
                          </button>
                        </div>

                        {state.status === "waiting" ||
                        state.status === "loading" ? (
                          <div className="flex min-h-24 items-center justify-center rounded-xl border border-white/[0.07] bg-black/25 text-xs text-white/40">
                            {state.status === "loading" ? (
                              <span className="inline-flex items-center gap-2">
                                <Loader2
                                  size={14}
                                  className="animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                                {t("processing.loadingPreview")}
                              </span>
                            ) : (
                              t("processing.loadingPreview")
                            )}
                          </div>
                        ) : state.status === "error" ? (
                          <div className="flex min-h-24 flex-col items-start justify-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-3">
                            <p className="line-clamp-2 text-xs text-rose-200/80">
                              {state.message ||
                                t("processing.previewUnavailable")}
                            </p>
                            <button
                              type="button"
                              onClick={() => void runPreview(item.Id)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-xs font-bold text-white/70 transition hover:bg-white/[0.08]"
                            >
                              <RefreshCcw size={12} aria-hidden="true" />
                              {t("processing.tryAgain")}
                            </button>
                          </div>
                        ) : itemPreview ? (
                          <div className="flex flex-col gap-3 rounded-xl border border-white/[0.07] bg-black/25 p-3 sm:p-4">
                            {itemPreview.existing?.present &&
                            !itemPreview.existing.current ? (
                              <p className="text-xs font-semibold text-white/55">
                                {formatTemplate(t("processing.rebuildReason"), {
                                  reason: itemPreview.existing.sourceMatches
                                    ? t("processing.rebuildProfile")
                                    : t("processing.rebuildSource"),
                                })}
                              </p>
                            ) : null}
                            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                              <Stat
                                label={t("processing.source")}
                                value={`${itemPreview.decision.source.width}×${itemPreview.decision.source.height}${itemPreview.decision.source.isHdr ? " HDR" : ""}`}
                              />
                              <Stat
                                label={t("processing.encoder")}
                                value={itemPreview.decision.videoEncoder}
                              />
                              <Stat
                                label={t("processing.estimate")}
                                value={formatBytes(
                                  itemPreview.decision.estimate.outputBytes,
                                )}
                              />
                            </div>
                            <div className="flex flex-col gap-2">
                              <span className={LABEL}>
                                {t("processing.ladder")}
                              </span>
                              <LadderRungs
                                planned={itemPreview.decision.ladder.map(
                                  (rung) => rung.qualityHeight,
                                )}
                                present={
                                  itemPreview.existing?.present
                                    ? itemPreview.existing.rungs
                                    : []
                                }
                                keptLabel={t("processing.rungKept")}
                                buildLabel={t("processing.rungBuild")}
                              />
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {/* ------------------------------------------------------- queue */}
        {activeTab === "processes" ? (
          <section
            id="processing-panel-processes"
            role="tabpanel"
            aria-labelledby="processing-tab-processes"
            className="flex flex-col gap-3"
          >
            <span className={LABEL}>{t("processing.queue")}</span>
            {loading ? (
              <div className={`${CARD} flex flex-col gap-3`}>
                {[0, 1].map((row) => (
                  <div
                    key={row}
                    className="h-14 animate-pulse rounded-xl bg-white/[0.06]"
                  />
                ))}
              </div>
            ) : jobs.length === 0 ? (
              <div className={`${CARD} text-center`}>
                <p className="text-sm font-semibold text-white/70">
                  {t("processing.empty")}
                </p>
                <p className="mt-1 text-xs text-white/40">
                  {t("processing.emptyHint")}
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {jobs.map((job) => {
                  const percent = progressPercent(job);
                  const isFinished = [
                    "succeeded",
                    "failed",
                    "cancelled",
                  ].includes(job.state);
                  return (
                    <li key={job.id} className={`${CARD} flex flex-col gap-3`}>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-sm font-bold">
                          {itemTitleFor(job.itemId)}
                        </span>
                        <Chip
                          tone={
                            job.state === "succeeded"
                              ? "ok"
                              : job.state === "failed"
                                ? "bad"
                                : job.state === "cancelled"
                                  ? "muted"
                                  : "warn"
                          }
                        >
                          {t(`processing.state.${job.state}` as never)}
                        </Chip>
                        {job.pausedReason ? (
                          <Chip tone="muted">
                            {t(
                              job.pausedReason === "storage-unavailable"
                                ? "processing.pausedByStorage"
                                : "processing.pausedByOperator",
                            )}
                          </Chip>
                        ) : null}
                        {job.warnings.length > 0 ? (
                          <Chip tone="warn">
                            <AlertTriangle size={11} aria-hidden="true" />
                            {job.warnings.length}
                          </Chip>
                        ) : null}
                        <span className="text-xs text-white/40">
                          {t(`processing.stage.${job.stage}` as never)}
                        </span>
                        <div className="ml-auto flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setOpenJobId(job.id)}
                            className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                          >
                            {t("processing.inspect")}
                          </button>
                          {canPause(job) ? (
                            <button
                              type="button"
                              onClick={async () => {
                                await pauseProcessingJob(job.id).catch(
                                  () => undefined,
                                );
                                await refreshOverview();
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                            >
                              <Pause size={12} aria-hidden="true" />
                              {t("processing.pause")}
                            </button>
                          ) : null}
                          {canResume(job) ? (
                            <button
                              type="button"
                              onClick={async () => {
                                await resumeProcessingJob(job.id).catch(
                                  () => undefined,
                                );
                                await refreshOverview();
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                            >
                              <Play size={12} aria-hidden="true" />
                              {t("processing.resume")}
                            </button>
                          ) : null}
                          {canCancel(job) ? (
                            <button
                              type="button"
                              onClick={async () => {
                                await cancelProcessingJob(job.id).catch(
                                  () => undefined,
                                );
                                await refreshOverview();
                              }}
                              className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                            >
                              {t("processing.cancel")}
                            </button>
                          ) : null}
                          {canRetry(job) ? (
                            <button
                              type="button"
                              onClick={async () => {
                                await retryProcessingJob(job.id).catch(
                                  () => undefined,
                                );
                                await refreshOverview();
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                            >
                              <RefreshCcw size={12} aria-hidden="true" />
                              {t("processing.retry")}
                            </button>
                          ) : null}
                          {isFinished ? (
                            <button
                              type="button"
                              onClick={() => void removeJob(job.id)}
                              disabled={removingJobIds.has(job.id)}
                              aria-label={
                                removingJobIds.has(job.id)
                                  ? t("processing.removing")
                                  : `${t("processing.remove")}: ${itemTitleFor(job.itemId)}`
                              }
                              title={t("processing.remove")}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-white/40 transition hover:border-rose-300/30 hover:bg-rose-400/10 hover:text-rose-200 disabled:opacity-35 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
                            >
                              {removingJobIds.has(job.id) ? (
                                <Loader2
                                  size={13}
                                  className="animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                              ) : (
                                <X size={14} aria-hidden="true" />
                              )}
                            </button>
                          ) : null}
                        </div>
                      </div>

                      <div
                        className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]"
                        role="progressbar"
                        aria-valuenow={percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={itemTitleFor(job.itemId)}
                      >
                        <div
                          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500 motion-reduce:transition-none"
                          style={{ width: `${percent}%` }}
                        />
                      </div>

                      {/*
                        * Nine figures now rather than eight, so the row gains a
                        * column at the widest breakpoint instead of squeezing
                        * every value narrower.
                        */}
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
                        <Stat label="%" value={`${percent}%`} />
                        <Stat
                          label={t("processing.speed")}
                          value={formatSpeed(job.speed)}
                        />
                        <Stat
                          label={t("processing.fps")}
                          value={job.fps ? job.fps.toFixed(0) : "—"}
                        />
                        <Stat
                          label={t("processing.eta")}
                          value={formatDuration(job.etaSeconds)}
                        />
                        <Stat
                          label={t("processing.encoding")}
                          value={
                            job.decision?.renditionsToEncode?.length
                              ? job.decision.renditionsToEncode
                                  .map((height) => `${height}p`)
                                  .join(" · ")
                              : t("processing.fullPackage")
                          }
                        />
                        {/*
                          * Two separate questions: what this job has written,
                          * and how large it will end up. Falling back from the
                          * first to the second is what labelled a planning
                          * estimate as though it were bytes on disk.
                          */}
                        <Stat
                          label={t("processing.actualOutput")}
                          value={formatBytes(job.actualOutputBytes)}
                        />
                        <Stat
                          label={t("processing.estimatedOutput")}
                          value={formatBytes(job.estimatedOutputBytes)}
                        />
                        <Stat
                          label={t("processing.duration")}
                          value={formatDuration(
                            isFinished
                              ? processingDurationSeconds(job)
                              : processingElapsedSeconds(job, refreshedAt),
                          )}
                        />
                        <Stat
                          label={t("processing.finishedAt")}
                          value={formatFinishedAt(job.finishedAt, dateLocale)}
                        />
                      </div>

                      {job.errorMessage ? (
                        <p className="rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
                          {job.errorMessage}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}
      </div>

      {/* ------------------------------------------------- detail drawer */}
      {openJobId && detail ? (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={itemTitleFor(detail.itemId)}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpenJobId(null);
          }}
        >
          <div className="flex h-full w-full max-w-xl flex-col gap-5 overflow-y-auto border-l border-white/10 bg-[#0a0b0e] p-6 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <h2 className="text-xl font-black">
                  {itemTitleFor(detail.itemId)}
                </h2>
                <p className="mt-0.5 text-xs text-white/40">
                  {t(`processing.state.${detail.state}` as never)}
                  {streamState === "reconnecting"
                    ? ` · ${t("processing.reconnecting")}`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpenJobId(null)}
                aria-label={t("processing.close")}
                className="rounded-lg p-1.5 text-white/50 transition hover:bg-white/[0.08] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <ol className="flex flex-col gap-1.5">
              {PROCESSING_STAGE_ORDER.map((stage) => {
                const state = stageStateFor(stage, detail);
                return (
                  <li key={stage} className="flex items-center gap-2.5 text-sm">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        state === "done"
                          ? "bg-emerald-400"
                          : state === "active"
                            ? "bg-[var(--accent)]"
                            : "bg-white/15"
                      }`}
                      aria-hidden="true"
                    />
                    <span
                      className={
                        state === "pending"
                          ? "text-white/30"
                          : state === "active"
                            ? "font-bold text-white"
                            : "text-white/60"
                      }
                    >
                      {t(`processing.stage.${stage}` as never)}
                    </span>
                    {state === "active" && detail.state === "running" ? (
                      <Loader2
                        size={13}
                        className="animate-spin text-white/40 motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>

            <div className="grid grid-cols-2 gap-4">
              <Stat
                label={t("processing.encoder")}
                value={detail.videoEncoder ?? "—"}
              />
              <Stat
                label={t("processing.hardware")}
                value={detail.hardwareAdapter ?? "—"}
              />
              <Stat
                label={t("processing.inputSize")}
                value={formatBytes(detail.decision?.source.sizeBytes)}
              />
              <Stat
                label={t("processing.estimate")}
                value={formatBytes(detail.estimatedOutputBytes)}
              />
              <Stat
                label={t("processing.actualOutput")}
                value={formatBytes(detail.actualOutputBytes)}
              />
              <Stat
                label={t("processing.staging")}
                value={formatBytes(detail.estimatedStagingBytes)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Stat
                label={t("processing.audioKept")}
                value={languages.audioKept.join(", ") || "—"}
              />
              <Stat
                label={t("processing.audioDropped")}
                value={languages.audioDropped.join(", ") || "—"}
              />
              <Stat
                label={t("processing.subtitlesKept")}
                value={languages.subtitlesKept.join(", ") || "—"}
              />
            </div>

            {detail.validation ? (
              <div className="flex items-center gap-2">
                <span className={LABEL}>{t("processing.validation")}</span>
                {detail.validation.ok ? (
                  <Chip tone="ok">
                    <CheckCircle2 size={11} aria-hidden="true" />
                    {t("processing.validationPassed")}
                  </Chip>
                ) : (
                  <Chip tone="bad">
                    <XCircle size={11} aria-hidden="true" />
                    {t("processing.validationFailed")}
                  </Chip>
                )}
              </div>
            ) : null}

            {detail.warnings.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className={LABEL}>{t("processing.warnings")}</span>
                <ul className="flex flex-col gap-1 text-xs text-amber-200/80">
                  {detail.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <details className="rounded-xl border border-white/10 bg-black/30 p-3">
              <summary className="cursor-pointer text-xs font-bold uppercase tracking-[0.14em] text-white/40">
                {t("processing.diagnostics")}
              </summary>
              <ul className="mt-3 flex flex-col gap-1 font-mono text-[11px] leading-relaxed text-white/55">
                {events.map((entry) => (
                  <li
                    key={entry.sequence}
                    className={
                      entry.level === "error"
                        ? "text-rose-300"
                        : entry.level === "warning"
                          ? "text-amber-200"
                          : undefined
                    }
                  >
                    <span className="text-white/25">
                      {String(entry.sequence).padStart(2, "0")}{" "}
                    </span>
                    [{entry.stage}] {entry.message}
                  </li>
                ))}
              </ul>
            </details>

            {detail.publishedVersion ? (
              <p className="text-xs text-white/40">
                {t("processing.published")}:{" "}
                <span className="font-mono">{detail.publishedVersion}</span>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
