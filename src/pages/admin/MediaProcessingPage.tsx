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
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { setPageTitle } from "../../lib/pageTitle";
import { notify } from "../../lib/notifications/notificationStore";
import { getVideoItemsForLibrary, getUserViews } from "../../lib/mediaApi";
import type { MediaItem, MediaLibrary } from "../../lib/types";
import { getDisplayTitle } from "../../lib/format";
import {
  cancelProcessingJob,
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
  audioDecisionKey,
  audioFormatLabel,
  canCancel,
  canPause,
  canResume,
  canRetry,
  formatBytes,
  formatDuration,
  formatSpeed,
  lastSequence,
  mergeEvents,
  mergeJobFrame,
  PROCESSING_STAGE_ORDER,
  progressPercent,
  localisedLanguageName,
  stageStateFor,
  subtitleDecisionKey,
  summariseLanguages,
} from "./processingModel";
import { formatTemplate } from "./libraryMaintenanceModel";

const CARD = "rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5";
const LABEL =
  "text-[11px] font-black uppercase tracking-[0.14em] text-white/40";

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

export function MediaProcessingPage() {
  const { t } = useLanguage();
  const [overview, setOverview] = useState<ProcessingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState("");
  const [preview, setPreview] = useState<ProcessingPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [openJob, setOpenJob] = useState<ProcessingJob | null>(null);
  const [events, setEvents] = useState<ProcessingJobEvent[]>([]);
  const [streamState, setStreamState] = useState<
    "idle" | "live" | "reconnecting"
  >("idle");
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setPageTitle(t("processing.title"));
  }, [t]);

  const refreshOverview = useCallback(async () => {
    try {
      setOverview(await getProcessingOverview());
    } catch {
      notify({ tone: "error", title: t("common.somethingWentWrong") });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshOverview();
    const timer = window.setInterval(() => void refreshOverview(), 5000);
    return () => window.clearInterval(timer);
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
        // The picker is a convenience; the page still works without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const runPreview = useCallback(async () => {
    if (!selectedItemId) return;
    setPreviewing(true);
    try {
      setPreview(await previewProcessing(selectedItemId));
    } catch (error) {
      notify({
        tone: "error",
        title:
          error instanceof Error
            ? error.message
            : t("common.somethingWentWrong"),
      });
    } finally {
      setPreviewing(false);
    }
  }, [selectedItemId, t]);

  const startJob = useCallback(async () => {
    if (!selectedItemId) return;
    setStarting(true);
    try {
      const { job } = await enqueueProcessing(selectedItemId);
      setOpenJobId(job.id);
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
      setStarting(false);
    }
  }, [selectedItemId, refreshOverview, t]);

  const itemTitleFor = useCallback(
    (itemId: string) =>
      items.find((item) => item.Id === itemId)
        ? getDisplayTitle(items.find((item) => item.Id === itemId)!)
        : itemId.slice(0, 8),
    [items],
  );

  const jobs = overview?.jobs ?? [];
  const counts = overview?.counts;
  const hardware = overview?.hardware;
  const detail = openJob;
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

        {/* ------------------------------------------------- start a job */}
        <section className={`${CARD} flex flex-col gap-3`}>
          <span className={LABEL}>{t("processing.chooseTitle")}</span>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedItemId}
              onChange={(event) => {
                setSelectedItemId(event.target.value);
                setPreview(null);
              }}
              aria-label={t("processing.chooseTitle")}
              className="min-w-[16rem] flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <option value="">—</option>
              {items.map((item) => (
                <option key={item.Id} value={item.Id}>
                  {getDisplayTitle(item)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void runPreview()}
              disabled={!selectedItemId || previewing}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 text-sm font-semibold transition hover:bg-white/[0.1] disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {previewing ? (
                <Loader2
                  size={15}
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Sparkles size={15} aria-hidden="true" />
              )}
              {t("processing.preview")}
            </button>
            <button
              type="button"
              onClick={() => void startJob()}
              disabled={!selectedItemId || starting}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-sm font-bold text-black transition hover:brightness-110 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              {starting ? (
                <Loader2
                  size={15}
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Play size={15} aria-hidden="true" />
              )}
              {t("processing.start")}
            </button>
          </div>

          {preview ? (
            <div className="mt-1 flex flex-col gap-3 rounded-xl border border-white/10 bg-black/30 p-4">
              <p className="text-sm font-semibold text-white/90">
                {preview.decision.summary}
              </p>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat
                  label={t("processing.source")}
                  value={`${preview.decision.source.width}×${preview.decision.source.height}${preview.decision.source.isHdr ? " HDR" : ""}`}
                />
                <Stat
                  label={t("processing.ladder")}
                  value={preview.decision.ladder
                    .map((rung) => `${rung.qualityHeight}p`)
                    .join(" · ")}
                />
                <Stat
                  label={t("processing.encoder")}
                  value={preview.decision.videoEncoder}
                />
                <Stat
                  label={t("processing.estimate")}
                  value={formatBytes(preview.decision.estimate.outputBytes)}
                />
              </div>
              <ul className="flex flex-col gap-1 text-xs text-white/60">
                {preview.decision.streams.audio.map((entry) => (
                  <li key={`a-${entry.streamIndex}`}>
                    {entry.keep ? "✓ " : "· "}
                    {formatTemplate(t(audioDecisionKey(entry) as never), {
                      language: localisedLanguageName(entry, (key) =>
                        t(key as never),
                      ),
                      format: audioFormatLabel(entry),
                    })}
                  </li>
                ))}
                {preview.decision.streams.subtitles.map((entry) => (
                  <li key={`s-${entry.streamIndex}`}>
                    {entry.keep ? "✓ " : "· "}
                    {formatTemplate(t(subtitleDecisionKey(entry) as never), {
                      language: localisedLanguageName(entry, (key) =>
                        t(key as never),
                      ),
                    })}
                    {entry.keep && entry.requiresOcr
                      ? ` (${t("processing.subtitle.needsOcr")})`
                      : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        {/* ------------------------------------------------------- queue */}
        <section className="flex flex-col gap-3">
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

                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
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
                        label={t("processing.actualOutput")}
                        value={formatBytes(
                          job.outputBytes ?? job.estimatedOutputBytes,
                        )}
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
                value={formatBytes(detail.outputBytes)}
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
