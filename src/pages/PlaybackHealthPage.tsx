import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  FileJson,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { setPageTitle } from "../lib/pageTitle";
import {
  runPlaybackEnvironmentHealthCheck,
  type PlaybackEnvironmentHealthReport,
  type PlaybackHealthProbe,
  type PlaybackHealthSourceSummary,
  type PlaybackHealthStatus,
} from "../lib/playbackEnvironmentDiagnostics";

function getStatusTone(status: PlaybackHealthStatus): string {
  if (status === "pass") {
    return "border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-100";
  }

  if (status === "warn") {
    return "border-amber-300/25 bg-amber-300/[0.08] text-amber-100";
  }

  if (status === "fail") {
    return "border-rose-300/25 bg-rose-300/[0.08] text-rose-100";
  }

  return "border-white/10 bg-white/[0.055] text-white/55";
}

function getStatusIcon(status: PlaybackHealthStatus) {
  if (status === "pass") return CheckCircle2;
  if (status === "fail") return XCircle;
  if (status === "warn") return AlertTriangle;
  return Activity;
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value).catch(() => {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  });
}

function InfoPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-100"
      : tone === "warn"
        ? "border-amber-300/25 bg-amber-300/[0.08] text-amber-100"
        : tone === "bad"
          ? "border-rose-300/25 bg-rose-300/[0.08] text-rose-100"
          : "border-white/10 bg-white/[0.055] text-white/68";

  return (
    <div className={`rounded-2xl border px-4 py-3 ${toneClass}`}>
      <p className="text-[0.67rem] font-black uppercase tracking-[0.18em] opacity-60">
        {label}
      </p>
      <p className="mt-1 break-words text-sm font-black">{value}</p>
    </div>
  );
}

function ProbeRow({ probe }: { probe: PlaybackHealthProbe }) {
  const Icon = getStatusIcon(probe.status);

  return (
    <article
      className={`rounded-2xl border p-4 ${getStatusTone(probe.status)}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-current/18 bg-black/24">
            <Icon size={18} />
          </span>
          <div>
            <h3 className="text-base font-black text-white">{probe.label}</h3>
            <p className="mt-1 text-sm font-semibold leading-5 text-white/62">
              {probe.message}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs font-black">
          {probe.method ? (
            <span className="rounded-full bg-black/24 px-2.5 py-1">
              {probe.method}
            </span>
          ) : null}
          {probe.statusCode ? (
            <span className="rounded-full bg-black/24 px-2.5 py-1">
              {probe.statusCode}
            </span>
          ) : null}
          {probe.durationMs !== undefined ? (
            <span className="rounded-full bg-black/24 px-2.5 py-1">
              {probe.durationMs}ms
            </span>
          ) : null}
        </div>
      </div>

      {probe.url ? (
        <p className="mt-3 break-all rounded-xl bg-black/26 px-3 py-2 text-xs font-semibold text-white/54">
          {probe.url}
        </p>
      ) : null}

      {probe.headers ? (
        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          {Object.entries(probe.headers)
            .filter(([, value]) => value)
            .map(([key, value]) => (
              <div
                key={key}
                className="flex min-w-0 justify-between gap-3 rounded-xl bg-black/18 px-3 py-2"
              >
                <dt className="truncate text-white/40">{key}</dt>
                <dd className="break-all text-right font-bold text-white/66">
                  {value}
                </dd>
              </div>
            ))}
        </dl>
      ) : null}

      {probe.bodyExcerpt ? (
        <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/28 p-3 text-xs leading-5 text-white/48">
          {probe.bodyExcerpt}
        </pre>
      ) : null}
    </article>
  );
}

function SourceSummary({
  title,
  source,
}: {
  title: string;
  source?: PlaybackHealthSourceSummary;
}) {
  if (!source) {
    return (
      <section className="rounded-3xl border border-white/10 bg-white/[0.045] p-5">
        <h2 className="text-lg font-black text-white">{title}</h2>
        <p className="mt-2 text-sm font-semibold text-white/50">
          No source was selected for this path.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.045] p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-black text-white">{title}</h2>
        <span className="w-fit rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/12 px-3 py-1 text-xs font-black text-[var(--accent)]">
          {source.mode}
          {source.isHls ? " / HLS" : ""}
        </span>
      </div>

      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        {[
          ["Media source", source.mediaSourceId],
          ["Container", source.container],
          ["Video", source.videoCodec],
          ["Audio", source.audioCodec],
          ["HLS kind", source.hlsKind],
          ["MIME", source.mimeType],
          ["Direct play", source.directPlaySupported ? "yes" : "no"],
          ["Direct stream", source.directStreamSupported ? "yes" : "no"],
          ["Transcoding", source.transcodingSupported ? "yes" : "no"],
          ["Diagnostics", source.diagnosticsPresent ? "yes" : "no"],
        ].map(([label, value]) => (
          <div
            key={label}
            className="flex min-w-0 justify-between gap-3 rounded-xl border border-white/8 bg-black/18 px-3 py-2"
          >
            <dt className="text-white/42">{label}</dt>
            <dd className="break-all text-right font-bold text-white/72">
              {value || "Unknown"}
            </dd>
          </div>
        ))}
      </dl>

      {source.reason ? (
        <p className="mt-3 rounded-xl bg-black/22 px-3 py-2 text-sm font-semibold leading-6 text-white/58">
          {source.reason}
        </p>
      ) : null}

      <p className="mt-3 break-all rounded-xl bg-black/22 px-3 py-2 text-xs font-semibold text-white/48">
        {source.url}
      </p>
    </section>
  );
}

export function PlaybackHealthPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialItemId = searchParams.get("itemId") ?? "";
  const [itemId, setItemId] = useState(initialItemId);
  const [report, setReport] = useState<PlaybackEnvironmentHealthReport | null>(
    null,
  );
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPageTitle("Playback Health · Devtools · Seyirlik", {
      canonicalPath: "/dev/playback-health",
      robots: "noindex, nofollow",
    });
  }, []);

  const runCheck = useCallback(
    async (nextItemId = itemId) => {
      setIsRunning(true);
      setError(null);

      try {
        const normalizedItemId = nextItemId.trim();
        const nextParams = new URLSearchParams(searchParams);

        if (normalizedItemId) {
          nextParams.set("itemId", normalizedItemId);
        } else {
          nextParams.delete("itemId");
        }

        setSearchParams(nextParams, { replace: true });
        setReport(await runPlaybackEnvironmentHealthCheck(normalizedItemId));
      } catch (healthError) {
        setError(
          healthError instanceof Error
            ? healthError.message
            : String(healthError),
        );
      } finally {
        setIsRunning(false);
      }
    },
    [itemId, searchParams, setSearchParams],
  );

  useEffect(() => {
    void runCheck(initialItemId);
    // Run once with the URL value from first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = useMemo(() => {
    const probes = report?.probes ?? [];

    return {
      pass: probes.filter((probe) => probe.status === "pass").length,
      warn: probes.filter((probe) => probe.status === "warn").length,
      fail: probes.filter((probe) => probe.status === "fail").length,
      skip: probes.filter((probe) => probe.status === "skip").length,
    };
  }, [report]);

  const reportJson = report ? JSON.stringify(report, null, 2) : "";
  const context = report?.context;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link
          to="/dev"
          className="inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 text-sm font-bold text-white/78 transition hover:bg-white/[0.10] hover:text-white"
        >
          <ArrowLeft size={16} />
          Devtools
        </Link>
      </div>

      <section className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] p-5 shadow-2xl backdrop-blur-xl sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
              Network Diagnostics
            </p>
            <div className="mt-3 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent)]">
                <ShieldAlert size={23} />
              </div>
              <div>
                <h1 className="text-3xl font-black text-white sm:text-4xl">
                  Playback Health
                </h1>
                <p className="mt-1 text-sm font-semibold text-white/52">
                  Origin, CORS, range, HLS, and selected-source checks.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 sm:w-80">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-white/45">
                Media item id
              </span>
              <input
                value={itemId}
                onChange={(event) => setItemId(event.target.value)}
                placeholder="Optional Jellyfin item id"
                className="h-12 w-full rounded-2xl border border-white/10 bg-black/28 px-4 text-sm font-bold text-white outline-none transition placeholder:text-white/32 focus:border-[var(--accent)]/45"
              />
            </label>

            <button
              type="button"
              onClick={() => void runCheck()}
              disabled={isRunning}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-5 text-sm font-black text-black shadow-[0_18px_60px_rgba(245,158,11,0.20)] transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRunning ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black" />
              ) : (
                <RefreshCw size={18} />
              )}
              Run
            </button>

            <button
              type="button"
              onClick={() => copyText(reportJson)}
              disabled={!report}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.07] px-5 text-sm font-black text-white transition hover:bg-white/[0.11] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Copy size={18} />
              Copy JSON
            </button>
          </div>
        </div>
      </section>

      {error ? (
        <section className="rounded-3xl border border-rose-300/25 bg-rose-300/[0.08] p-5 text-rose-50">
          <h2 className="text-lg font-black">Health check failed</h2>
          <p className="mt-2 text-sm font-semibold">{error}</p>
        </section>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-4">
        <InfoPill label="Passed" value={String(summary.pass)} tone="good" />
        <InfoPill
          label="Warnings"
          value={String(summary.warn)}
          tone={summary.warn > 0 ? "warn" : undefined}
        />
        <InfoPill
          label="Failed"
          value={String(summary.fail)}
          tone={summary.fail > 0 ? "bad" : undefined}
        />
        <InfoPill label="Skipped" value={String(summary.skip)} />
      </section>

      {context ? (
        <section className="grid gap-3 lg:grid-cols-3">
          <InfoPill label="Frontend origin" value={context.pageOrigin} />
          <InfoPill
            label="Secure context"
            value={context.isSecureContext ? "yes" : "no"}
            tone={context.isSecureContext ? "good" : "warn"}
          />
          <InfoPill
            label="Service worker"
            value={context.serviceWorkerAvailable ? "available" : "not available"}
          />
          <InfoPill
            label="Jellyfin"
            value={context.jellyfin.redactedUrl ?? "Not configured"}
            tone={context.jellyfin.mixedContentRisk ? "bad" : undefined}
          />
          <InfoPill
            label="Custom backend"
            value={context.customPlaybackBackend.redactedUrl ?? "Not configured"}
            tone={
              context.customPlaybackBackend.mixedContentRisk ? "bad" : undefined
            }
          />
          <InfoPill
            label="HLS/MSE"
            value={`native ${context.capabilities.hlsNative ? "yes" : "no"} / MSE ${context.capabilities.mediaSource ? "yes" : "no"}`}
            tone={
              context.capabilities.hlsNative || context.capabilities.mediaSource
                ? "good"
                : "bad"
            }
          />
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2">
        <SourceSummary title="Jellyfin selected source" source={report?.jellyfinSource} />
        <SourceSummary title="Custom backend selected source" source={report?.customSource} />
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-white/80">
            <PlayCircle size={19} />
          </div>
          <div>
            <h2 className="text-xl font-black text-white">Probe Results</h2>
            <p className="text-sm font-semibold text-white/45">
              CORS failures appear as fetch errors because the browser blocks the response.
            </p>
          </div>
        </div>

        {isRunning && !report ? (
          <div className="flex min-h-40 items-center justify-center rounded-3xl border border-white/10 bg-white/[0.045]">
            <LoadingSpinner />
          </div>
        ) : null}

        {report?.probes.map((probe) => (
          <ProbeRow key={probe.id} probe={probe} />
        ))}
      </section>

      {report ? (
        <section className="rounded-3xl border border-white/10 bg-black/24 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-white/80">
              <FileJson size={19} />
            </div>
            <div>
              <h2 className="text-xl font-black text-white">Redacted Payload</h2>
              <p className="text-sm font-semibold text-white/45">
                Same object copied by the JSON button.
              </p>
            </div>
          </div>
          <pre className="mt-4 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-black/40 p-4 text-xs leading-5 text-white/54">
            {reportJson}
          </pre>
        </section>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <InfoPill
          label="Auth transport"
          value="Authorization / X-Emby headers"
        />
        <InfoPill label="Range probe" value="bytes=0-1023" />
        <InfoPill label="Media token display" value="redacted" />
        <InfoPill label="Generated" value={report?.generatedAt ?? "Not yet"} />
      </section>

    </div>
  );
}
