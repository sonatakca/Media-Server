import { useEffect, useMemo, useState } from "react";
import { Download, Play, RefreshCw, Search, ShieldCheck } from "lucide-react";
import {
  buildPlaybackCandidates,
  getActiveTranscodingReasons,
  getAllVideoItems,
  getPlaybackInfo,
  reportAuditPlaybackProgress,
  reportAuditPlaybackStart,
  reportAuditPlaybackStopped,
  stopActiveTranscodeSession,
} from "../lib/jellyfinApi";
import {
  formatBitrate,
  formatBytes,
  getPlaybackModeLabel,
  getReadableTranscodeReason,
  getStreamOfType,
  getSubtitleStreams,
} from "../lib/playbackDiagnostics";
import { useLanguage } from "../i18n/LanguageContext";
import type {
  JellyfinItem,
  PlaybackMode,
  PlaybackSourceCandidate,
} from "../lib/types";
import { setPageTitle } from "../lib/pageTitle";

interface PlaybackAuditRow {
  itemId: string;
  name: string;
  type: string;
  year?: number;
  seriesName?: string;
  seasonName?: string;
  selectedMode: PlaybackMode;
  container: string;
  videoCodec: string;
  audioCodec: string;
  audioChannels: string;
  resolution: string;
  range: string;
  bitrate: string;
  size: string;
  subtitleSummary: string;
  reasons: string[];
  rawTranscodingReasons: string[];
  sourceReason: string;
  error?: string;
}

type AuditStatus = "idle" | "loading-items" | "running" | "done" | "failed";

const PLAYBACK_AUDIT_STORAGE_KEY = "seyirlik.playbackAudit.history.v1";

interface StoredPlaybackAuditHistory {
  rows: PlaybackAuditRow[];
  savedAt: string;
  totalItems: number;
  processedItems: number;
}

function readStoredPlaybackAuditHistory(): StoredPlaybackAuditHistory | null {
  try {
    const rawHistory = localStorage.getItem(PLAYBACK_AUDIT_STORAGE_KEY);

    if (!rawHistory) {
      return null;
    }

    const parsed = JSON.parse(
      rawHistory,
    ) as Partial<StoredPlaybackAuditHistory>;

    if (!Array.isArray(parsed.rows)) {
      return null;
    }

    return {
      rows: parsed.rows as PlaybackAuditRow[],
      savedAt:
        typeof parsed.savedAt === "string"
          ? parsed.savedAt
          : new Date().toISOString(),
      totalItems:
        typeof parsed.totalItems === "number"
          ? parsed.totalItems
          : parsed.rows.length,
      processedItems:
        typeof parsed.processedItems === "number"
          ? parsed.processedItems
          : parsed.rows.length,
    };
  } catch (error) {
    console.warn("[Playback Audit] Could not read stored audit history", error);
    return null;
  }
}

function savePlaybackAuditHistory(
  rows: PlaybackAuditRow[],
  totalItems: number,
  processedItems: number,
): void {
  try {
    const payload: StoredPlaybackAuditHistory = {
      rows,
      savedAt: new Date().toISOString(),
      totalItems,
      processedItems,
    };

    localStorage.setItem(PLAYBACK_AUDIT_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("[Playback Audit] Could not save audit history", error);
  }
}

function clearPlaybackAuditHistory(): void {
  try {
    localStorage.removeItem(PLAYBACK_AUDIT_STORAGE_KEY);
  } catch (error) {
    console.warn("[Playback Audit] Could not clear audit history", error);
  }
}

function formatSavedAt(savedAt: string | null): string | null {
  if (!savedAt) {
    return null;
  }

  const date = new Date(savedAt);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleString();
}

function getBestSource(
  itemId: string,
  source: PlaybackSourceCandidate | null,
  transcodingReasons: string[] = [],
): PlaybackAuditRow {
  if (!source) {
    return {
      itemId,
      name: "Unknown",
      type: "Unknown",
      selectedMode: "Unknown",
      container: "Unknown",
      videoCodec: "Unknown",
      audioCodec: "Unknown",
      audioChannels: "Unknown",
      resolution: "Unknown",
      range: "Unknown",
      bitrate: "Unknown",
      size: "Unknown",
      subtitleSummary: "Unknown",
      reasons: ["No playback source candidate was returned."],
      rawTranscodingReasons: [],
      sourceReason: "No candidate",
    };
  }

  const mediaSource = source.mediaSource;
  const video = getStreamOfType(mediaSource, "Video");
  const audio = getStreamOfType(mediaSource, "Audio");
  const subtitles = getSubtitleStreams(mediaSource);

  const isTranscoding = source.mode === "Transcoding";

  const fallbackTranscodingReasons = isTranscoding
    ? [
        ...(source.transcodeReasons ?? []),
        ...(source.mediaSource.TranscodingReasons ?? []),
      ]
    : [];

  const finalRawReasons = isTranscoding
    ? Array.from(
        new Set(
          [...(transcodingReasons ?? []), ...fallbackTranscodingReasons].filter(
            Boolean,
          ),
        ),
      )
    : [];

  return {
    itemId,
    name: mediaSource.Name || itemId,
    type: "Video",
    selectedMode: source.mode,
    container: mediaSource.Container || "Unknown",
    videoCodec: video?.Codec || "Unknown",
    audioCodec: audio?.Codec || "Unknown",
    audioChannels: audio?.Channels ? `${audio.Channels} ch` : "Unknown",
    resolution:
      video?.Width && video?.Height
        ? `${video.Width}x${video.Height}`
        : "Unknown",
    range: video?.VideoRange || video?.VideoRangeType || "Unknown",
    bitrate: formatBitrate(mediaSource.Bitrate),
    size: formatBytes(mediaSource.Size),
    subtitleSummary:
      subtitles.length > 0
        ? subtitles
            .map((subtitle) =>
              [
                subtitle.Codec,
                subtitle.Language,
                subtitle.IsExternal ? "External" : undefined,
              ]
                .filter(Boolean)
                .join(" · "),
            )
            .join(" | ")
        : "None",
    reasons: finalRawReasons.map((reason) =>
      getReadableTranscodeReason(reason),
    ),
    rawTranscodingReasons: finalRawReasons,
    sourceReason: isTranscoding ? source.reason : "",
  };
}

function enrichRowWithItem(
  row: PlaybackAuditRow,
  item: JellyfinItem,
): PlaybackAuditRow {
  return {
    ...row,
    name:
      item.Type === "Episode" && item.SeriesName
        ? `${item.SeriesName} S${item.ParentIndexNumber ?? "?"}E${item.IndexNumber ?? "?"} - ${item.Name}`
        : item.Name,
    type: item.Type || item.MediaType || row.type,
    year: item.ProductionYear,
    seriesName: item.SeriesName,
    seasonName: item.SeasonName,
  };
}

function downloadTextFile(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

function escapeCsvCell(value: unknown): string {
  const text = Array.isArray(value) ? value.join(" | ") : String(value ?? "");

  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function rowsToCsv(rows: PlaybackAuditRow[]): string {
  const headers: Array<keyof PlaybackAuditRow> = [
    "name",
    "type",
    "year",
    "selectedMode",
    "container",
    "videoCodec",
    "audioCodec",
    "audioChannels",
    "resolution",
    "range",
    "bitrate",
    "size",
    "subtitleSummary",
    "rawTranscodingReasons",
    "reasons",
    "sourceReason",
    "itemId",
    "seriesName",
    "seasonName",
    "error",
  ];

  return [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((header) => escapeCsvCell(row[header])).join(","),
    ),
  ].join("\n");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

function resolveManifestUrl(baseUrl: string, pathOrUrl: string): string {
  return new URL(pathOrUrl.trim(), baseUrl).toString();
}

function getFirstPlayableManifestLine(manifestText: string): string | null {
  return (
    manifestText
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) ?? null
  );
}

async function touchHlsTranscodeUrl(sourceUrl: string): Promise<void> {
  const masterResponse = await fetch(sourceUrl, {
    method: "GET",
    cache: "no-store",
  }).catch(() => null);

  if (!masterResponse?.ok) {
    return;
  }

  const masterText = await masterResponse.text().catch(() => "");
  const firstManifestLine = getFirstPlayableManifestLine(masterText);

  if (!firstManifestLine) {
    return;
  }

  const variantOrSegmentUrl = resolveManifestUrl(sourceUrl, firstManifestLine);

  const variantResponse = await fetch(variantOrSegmentUrl, {
    method: "GET",
    cache: "no-store",
  }).catch(() => null);

  if (!variantResponse?.ok) {
    return;
  }

  const variantText = await variantResponse.text().catch(() => "");
  const firstSegmentLine = getFirstPlayableManifestLine(variantText);

  if (!firstSegmentLine) {
    return;
  }

  const segmentUrl = resolveManifestUrl(variantOrSegmentUrl, firstSegmentLine);

  // This is the important part: requesting the first segment usually forces
  // Jellyfin to create the real active transcoding session.
  await fetch(segmentUrl, {
    method: "GET",
    cache: "no-store",
    headers: {
      Range: "bytes=0-1024",
    },
  }).catch(() => undefined);
}

async function waitForTranscodingReasons(
  itemId: string,
  playSessionId?: string,
  timeoutMs = 12_000,
  intervalMs = 750,
): Promise<string[]> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const reasons = await getActiveTranscodingReasons(
      itemId,
      playSessionId,
    ).catch(() => []);

    if (reasons.length > 0) {
      return Array.from(new Set(reasons.filter(Boolean)));
    }

    await sleep(intervalMs);
  }

  return [];
}

async function probeTranscodingReasons(
  source: PlaybackSourceCandidate,
): Promise<string[]> {
  if (source.mode !== "Transcoding") {
    return [];
  }

  try {
    console.info("[Playback Audit] probing transcode reasons", {
      itemId: source.itemId,
      playSessionId: source.playSessionId,
      mediaSourceId: source.mediaSourceId,
      url: source.url,
    });

    await reportAuditPlaybackStart(source).catch((error) => {
      console.warn("[Playback Audit] reportAuditPlaybackStart failed", error);
    });

    await sleep(300);

    await touchHlsTranscodeUrl(source.url);

    await sleep(500);

    await reportAuditPlaybackProgress(source).catch((error) => {
      console.warn(
        "[Playback Audit] reportAuditPlaybackProgress failed",
        error,
      );
    });

    const reasons = await waitForTranscodingReasons(
      source.itemId,
      source.playSessionId,
      12_000,
      750,
    );

    console.info("[Playback Audit] active transcoding reasons result", {
      itemId: source.itemId,
      playSessionId: source.playSessionId,
      mediaSourceId: source.mediaSourceId,
      reasons,
    });

    return reasons;
  } finally {
    await reportAuditPlaybackStopped(source).catch(() => undefined);
    await stopActiveTranscodeSession(source.playSessionId).catch(
      () => undefined,
    );
  }
}

export function PlaybackAuditPage() {
  const { t } = useLanguage();
  const storedHistory = useMemo(readStoredPlaybackAuditHistory, []);
  const [status, setStatus] = useState<AuditStatus>(
    storedHistory ? "done" : "idle",
  );
  const [rows, setRows] = useState<PlaybackAuditRow[]>(
    () => storedHistory?.rows ?? [],
  );
  const [totalItems, setTotalItems] = useState(
    () => storedHistory?.totalItems ?? 0,
  );
  const [processedItems, setProcessedItems] = useState(
    () => storedHistory?.processedItems ?? 0,
  );
  const [savedAt, setSavedAt] = useState<string | null>(
    () => storedHistory?.savedAt ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<"all" | PlaybackMode>("all");
  const [skipTranscodeReasonWait, setSkipTranscodeReasonWait] = useState(true);

  useEffect(() => {
    setPageTitle("Playback Audit · Seyirlik");
  }, []);

  const summary = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        acc.total += 1;

        if (row.error) {
          acc.errors += 1;
        } else if (row.selectedMode === "DirectPlay") {
          acc.directPlay += 1;
        } else if (row.selectedMode === "DirectStream") {
          acc.directStream += 1;
        } else if (row.selectedMode === "Transcoding") {
          acc.transcoding += 1;
        } else {
          acc.unknown += 1;
        }

        return acc;
      },
      {
        total: 0,
        directPlay: 0,
        directStream: 0,
        transcoding: 0,
        unknown: 0,
        errors: 0,
      },
    );
  }, [rows]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return rows.filter((row) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        row.name.toLowerCase().includes(normalizedQuery) ||
        row.container.toLowerCase().includes(normalizedQuery) ||
        row.videoCodec.toLowerCase().includes(normalizedQuery) ||
        row.audioCodec.toLowerCase().includes(normalizedQuery) ||
        row.reasons.join(" ").toLowerCase().includes(normalizedQuery);

      const matchesMode =
        modeFilter === "all" || row.selectedMode === modeFilter;

      return matchesQuery && matchesMode;
    });
  }, [modeFilter, query, rows]);

  const runAudit = async () => {
    setStatus("loading-items");
    setRows([]);
    setTotalItems(0);
    setProcessedItems(0);
    setSavedAt(null);
    setError(null);

    try {
      const items = await getAllVideoItems();

      setTotalItems(items.length);
      setStatus("running");

      const nextRows: PlaybackAuditRow[] = [];

      for (const item of items) {
        try {
          const playbackInfo = await getPlaybackInfo(item.Id);
          const candidates = buildPlaybackCandidates(item.Id, playbackInfo);
          const selectedSource = candidates[0] ?? null;

          const activeReasons =
            selectedSource?.mode === "Transcoding" && !skipTranscodeReasonWait
              ? await probeTranscodingReasons(selectedSource)
              : [];

          const row = enrichRowWithItem(
            getBestSource(item.Id, selectedSource, activeReasons),
            item,
          );

          nextRows.push(row);
        } catch (auditError) {
          nextRows.push({
            itemId: item.Id,
            name: item.Name,
            type: item.Type || item.MediaType || "Video",
            year: item.ProductionYear,
            seriesName: item.SeriesName,
            seasonName: item.SeasonName,
            selectedMode: "Unknown",
            container: "Unknown",
            videoCodec: "Unknown",
            audioCodec: "Unknown",
            audioChannels: "Unknown",
            resolution: "Unknown",
            range: "Unknown",
            bitrate: "Unknown",
            size: "Unknown",
            subtitleSummary: "Unknown",
            reasons: [],
            rawTranscodingReasons: [],
            sourceReason: "PlaybackInfo request failed.",
            error:
              auditError instanceof Error
                ? auditError.message
                : String(auditError),
          });
        }

        const updatedRows = [...nextRows];
        setRows(updatedRows);
        setProcessedItems(updatedRows.length);
        savePlaybackAuditHistory(updatedRows, items.length, updatedRows.length);
        setSavedAt(new Date().toISOString());
      }

      setStatus("done");
    } catch (auditError) {
      setStatus("failed");
      setError(
        auditError instanceof Error ? auditError.message : String(auditError),
      );
    }
  };

  const isRunning = status === "loading-items" || status === "running";

  const clearHistory = () => {
    clearPlaybackAuditHistory();
    setRows([]);
    setTotalItems(0);
    setProcessedItems(0);
    setSavedAt(null);
    setStatus("idle");
    setError(null);
  };

  const savedAtLabel = formatSavedAt(savedAt);

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-white/10 bg-white/[0.055] p-5 shadow-2xl backdrop-blur-xl sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
              Devtool
            </p>
            <h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">
              Playback Audit
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-white/62">
              Scans Jellyfin video items with PlaybackInfo and documents the
              selected mode and source media. Fast scan only marks whether an
              item transcodes; turning Fast scan off waits for detailed
              transcoding reasons.
            </p>
            {savedAtLabel ? (
              <p className="mt-2 text-xs font-semibold text-white/42">
                Last saved scan: {savedAtLabel}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <label className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full border border-white/10 bg-white/10 px-5 text-sm font-black text-white/78 transition hover:bg-white/15 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55">
              <input
                type="checkbox"
                checked={skipTranscodeReasonWait}
                onChange={(event) =>
                  setSkipTranscodeReasonWait(event.target.checked)
                }
                disabled={isRunning}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Fast scan
            </label>

            <button
              type="button"
              onClick={runAudit}
              disabled={isRunning}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-5 text-sm font-black text-black shadow-2xl transition hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {isRunning ? (
                <RefreshCw className="animate-spin" size={17} />
              ) : (
                <Play size={17} fill="currentColor" />
              )}
              {isRunning
                ? "Auditing..."
                : rows.length > 0
                  ? "Run again"
                  : "Start audit"}
            </button>

            {rows.length > 0 && !isRunning ? (
              <button
                type="button"
                onClick={clearHistory}
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/10 bg-white/10 px-5 text-sm font-black text-white/78 transition hover:bg-white/15"
              >
                Clear history
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-white/42">
              Total
            </p>
            <p className="mt-1 text-2xl font-black text-white">
              {summary.total}
            </p>
          </div>
          <div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-100/62">
              Direct Play
            </p>
            <p className="mt-1 text-2xl font-black text-emerald-50">
              {summary.directPlay}
            </p>
          </div>
          <div className="rounded-2xl border border-sky-300/20 bg-sky-300/10 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-100/62">
              Direct Stream
            </p>
            <p className="mt-1 text-2xl font-black text-sky-50">
              {summary.directStream}
            </p>
          </div>
          <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-100/62">
              Transcoding
            </p>
            <p className="mt-1 text-2xl font-black text-amber-50">
              {summary.transcoding}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-white/42">
              Unknown
            </p>
            <p className="mt-1 text-2xl font-black text-white">
              {summary.unknown}
            </p>
          </div>
          <div className="rounded-2xl border border-red-300/20 bg-red-300/10 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-100/62">
              Errors
            </p>
            <p className="mt-1 text-2xl font-black text-red-50">
              {summary.errors}
            </p>
          </div>
        </div>

        {isRunning ? (
          <div className="mt-5 rounded-2xl border border-white/10 bg-black/30 p-4">
            <div className="flex items-center justify-between gap-4 text-sm font-bold text-white/72">
              <span>
                {status === "loading-items"
                  ? "Loading video items..."
                  : `Processed ${processedItems} / ${totalItems}${skipTranscodeReasonWait ? " · fast scan" : " · waiting for reasons"}`}
              </span>
              <span>
                {totalItems > 0
                  ? `${Math.round((processedItems / totalItems) * 100)}%`
                  : "0%"}
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-all"
                style={{
                  width:
                    totalItems > 0
                      ? `${(processedItems / totalItems) * 100}%`
                      : "0%",
                }}
              />
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="mt-5 rounded-2xl border border-red-300/20 bg-red-300/10 p-4 text-sm font-semibold text-red-50">
            {error}
          </div>
        ) : null}
      </section>

      {rows.length > 0 ? (
        <section className="rounded-3xl border border-white/10 bg-white/[0.045] p-4 backdrop-blur-xl sm:p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-1 flex-col gap-3 sm:flex-row">
              <label className="relative flex-1">
                <Search
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/40"
                  size={18}
                />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search title, codec, container, reason..."
                  className="min-h-11 w-full rounded-2xl border border-white/10 bg-black/35 py-2 pl-11 pr-4 text-sm font-semibold text-white outline-none placeholder:text-white/35 focus:border-[var(--accent)]"
                />
              </label>

              <select
                value={modeFilter}
                onChange={(event) =>
                  setModeFilter(event.target.value as "all" | PlaybackMode)
                }
                className="min-h-11 rounded-2xl border border-white/10 bg-black/35 px-4 text-sm font-bold text-white outline-none focus:border-[var(--accent)]"
              >
                <option value="all">All modes</option>
                <option value="DirectPlay">Direct Play</option>
                <option value="DirectStream">Direct Stream</option>
                <option value="Transcoding">Transcoding</option>
                <option value="Unknown">Unknown</option>
              </select>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  downloadTextFile(
                    "seyirlik-playback-audit.csv",
                    rowsToCsv(rows),
                    "text/csv;charset=utf-8",
                  )
                }
                className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-white/10 bg-white/10 px-4 text-sm font-bold text-white/82 transition hover:bg-white/15"
              >
                <Download size={16} />
                CSV
              </button>

              <button
                type="button"
                onClick={() =>
                  downloadTextFile(
                    "seyirlik-playback-audit.json",
                    JSON.stringify(rows, null, 2),
                    "application/json;charset=utf-8",
                  )
                }
                className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-white/10 bg-white/10 px-4 text-sm font-bold text-white/82 transition hover:bg-white/15"
              >
                <Download size={16} />
                JSON
              </button>
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-2xl border border-white/10">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full min-w-[1200px] border-collapse text-left text-sm">
                <thead className="sticky top-0 z-10 bg-zinc-950 text-xs uppercase tracking-[0.14em] text-white/48">
                  <tr>
                    <th className="px-4 py-3">Title</th>
                    <th className="px-4 py-3">Mode</th>
                    <th className="px-4 py-3">Container</th>
                    <th className="px-4 py-3">Video</th>
                    <th className="px-4 py-3">Audio</th>
                    <th className="px-4 py-3">Resolution</th>
                    <th className="px-4 py-3">Range</th>
                    <th className="px-4 py-3">Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr
                      key={row.itemId}
                      className="border-t border-white/[0.07] bg-black/20 align-top"
                    >
                      <td className="max-w-sm px-4 py-3">
                        <p className="font-black text-white">{row.name}</p>
                        <p className="mt-1 text-xs text-white/42">
                          {[row.type, row.year, row.seriesName]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        {row.error ? (
                          <p className="mt-2 rounded-xl border border-red-300/20 bg-red-300/10 px-3 py-2 text-xs font-semibold text-red-50">
                            {row.error}
                          </p>
                        ) : null}
                      </td>

                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-black ${
                            row.selectedMode === "DirectPlay"
                              ? "border-emerald-300/25 bg-emerald-300/12 text-emerald-100"
                              : row.selectedMode === "DirectStream"
                                ? "border-sky-300/25 bg-sky-300/12 text-sky-100"
                                : row.selectedMode === "Transcoding"
                                  ? "border-amber-300/30 bg-amber-300/14 text-amber-100"
                                  : "border-white/15 bg-white/10 text-white/70"
                          }`}
                        >
                          <ShieldCheck size={13} />
                          {getPlaybackModeLabel(row.selectedMode)}
                        </span>
                      </td>

                      <td className="px-4 py-3 font-semibold text-white/78">
                        {row.container}
                      </td>
                      <td className="px-4 py-3 text-white/72">
                        <p className="font-bold">{row.videoCodec}</p>
                        <p className="mt-1 text-xs text-white/42">
                          {row.bitrate}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-white/72">
                        <p className="font-bold">{row.audioCodec}</p>
                        <p className="mt-1 text-xs text-white/42">
                          {row.audioChannels}
                        </p>
                      </td>
                      <td className="px-4 py-3 font-semibold text-white/72">
                        {row.resolution}
                      </td>
                      <td className="px-4 py-3 font-semibold text-white/72">
                        {row.range}
                      </td>
                      <td className="max-w-md px-4 py-3">
                        {row.selectedMode === "Transcoding" &&
                        row.reasons.length > 0 ? (
                          <div className="space-y-2">
                            {row.reasons.map((reason) => (
                              <p
                                key={reason}
                                className="rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs font-semibold leading-5 text-amber-50"
                              >
                                {reason}
                              </p>
                            ))}
                          </div>
                        ) : row.selectedMode === "Transcoding" ? (
                          <span className="rounded-xl border border-amber-300/15 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-100/70">
                            Transcoding detected · reasons skipped
                          </span>
                        ) : (
                          <span className="text-xs text-white/25">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
