import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  CloudOff,
  HelpCircle,
  RefreshCw,
  Server,
  ServerCrash,
  Wrench,
  XCircle,
} from "lucide-react";
import { LoadingSpinner } from "./LoadingSpinner";
import { useLanguage } from "../i18n/LanguageContext";
import type { Language } from "../i18n/translations";
import type { ServerUnavailableEventDetail } from "../lib/mediaApi";
import {
  diagnoseServerConnection,
  probeIsOnline,
  type ServerConnectionDiagnosis,
  type ServerConnectionProblem,
  type ServerProbe,
} from "../lib/serverConnectionDiagnostics";
import { testServerConnection } from "../lib/mediaApi";

interface ServerConnectionErrorPageProps {
  /** Retained only for the diagnostics copy; there is one server, at this origin. */
  serverUrl?: string;
  failure?: ServerUnavailableEventDetail | null;
  onRetrySuccess: () => void;
  mode?: "jellyfin" | "own-api";
  diagnoseConnection?: typeof diagnoseServerConnection;
  testConnection?: (serverUrl: string) => Promise<unknown>;
}

type DiagnosticState =
  | { status: "checking" }
  | { status: "ready"; diagnosis: ServerConnectionDiagnosis }
  | { status: "failed"; message: string };

type ServiceState = "online" | "offline" | "issue" | "unknown";

const COPY = {
  en: {
    checkingTitle: "Checking the server connection",
    checkingMessage: "Testing the public tunnel and local Jellyfin separately.",
    eyebrow: "Server Connection",
    retry: "Retry",
    retrying: "Checking",
    changeServer: "Change server",
    cloudflareTunnel: "Tunnel Connection",
    jellyfinServer: "Jellyfin Server",
    seyirlikServer: "Seyirlik Server",
    publicUrl: "Public URL",
    localProbe: "Local probe",
    checkedByBackend: "Checked by backend diagnostics",
    checkedByBrowser: "Checked by browser diagnostics",
    online: "Running",
    offline: "Not running",
    issue: "Needs attention",
    unknown: "Unknown",
    technicalDetails: "Technical details",
    noLocalProbe: "No local Jellyfin probe URL was available.",
    statusLine: "HTTP {status} {statusText}",
    source: "Source",
    checked: "Checked",
    problems: {
      "jellyfin-down": {
        label: "Problem 1",
        title: "Cloudflared tunnel is running, but Jellyfin is not running.",
        message:
          "Cloudflare is answering through the tunnel, but the tunnel cannot reach Jellyfin.",
        action: "Start the Jellyfin server, then retry this page.",
      },
      "cloudflared-down": {
        label: "Problem 2",
        title:
          "Jellyfin is running, but the cloudflared tunnel is not running.",
        message:
          "The local Jellyfin probe answered, but the public tunnel did not.",
        action: "Start the cloudflared tunnel, then retry this page.",
      },
      "both-down": {
        label: "Problem 3",
        title: "Cloudflared tunnel and Jellyfin are both not running.",
        message:
          "The public tunnel did not answer and Jellyfin could not be reached locally.",
        action:
          "Start Jellyfin first, then start the cloudflared tunnel and retry.",
      },
      "tunnel-origin-error": {
        label: "Origin issue",
        title: "The tunnel is running, but it cannot reach Jellyfin.",
        message:
          "Jellyfin answered locally, while Cloudflare returned a gateway error.",
        action:
          "Check the cloudflared origin URL, firewall rules, and Jellyfin bind address.",
      },
      unknown: {
        label: "Connection issue",
        title: "Seyirlik could not identify the exact server state.",
        message:
          "The browser could not get enough detail from the failed request.",
        action: "Check Jellyfin and cloudflared, then retry this page.",
      },
      none: {
        label: "Recovered",
        title: "The server connection is back.",
        message: "Jellyfin answered successfully.",
        action: "Retrying will reopen the current page.",
      },
    },
  },
  tr: {
    checkingTitle: "Sunucu bağlantısı kontrol ediliyor",
    checkingMessage: "Public tunnel ve yerel Jellyfin ayrı ayrı test ediliyor.",
    eyebrow: "Sunucu Bağlantısı",
    retry: "Tekrar dene",
    retrying: "Kontrol ediliyor",
    changeServer: "Sunucuyu değiştir",
    cloudflareTunnel: "Tunnel Bağlantısı",
    jellyfinServer: "Jellyfin Sunucusu",
    seyirlikServer: "Seyirlik Sunucusu",
    publicUrl: "Public adres",
    localProbe: "Yerel kontrol",
    checkedByBackend: "Backend tanısıyla kontrol edildi",
    checkedByBrowser: "Tarayıcı tanısıyla kontrol edildi",
    online: "Aktif",
    offline: "Aktif Değil",
    issue: "Kontrol gerekli",
    unknown: "Bilinmiyor",
    technicalDetails: "Teknik detaylar",
    noLocalProbe: "Yerel Jellyfin kontrol adresi bulunamadı.",
    statusLine: "HTTP {status} {statusText}",
    source: "Kaynak",
    checked: "Kontrol zamanı",
    problems: {
      "jellyfin-down": {
        label: "Problem 1",
        title:
          "cloudflared tunnel çalışıyor, ama Jellyfin sunucusu çalışmıyor.",
        message:
          "Cloudflare tunnel üzerinden cevap veriyor, fakat tunnel Jellyfin'e ulaşamıyor.",
        action: "Jellyfin sunucusunu başlat, sonra bu sayfayı tekrar dene.",
      },
      "cloudflared-down": {
        label: "Problem 2",
        title: "Jellyfin çalışıyor, ama cloudflared tunnel çalışmıyor.",
        message:
          "Yerel Jellyfin kontrolü cevap verdi, fakat public tunnel cevap vermedi.",
        action: "cloudflared tunnel'ı başlat, sonra bu sayfayı tekrar dene.",
      },
      "both-down": {
        label: "Problem 3",
        title: "cloudflared tunnel ve Jellyfin ikisi de çalışmıyor.",
        message:
          "Public tunnel cevap vermedi ve Jellyfin'e yerel olarak ulaşılamadı.",
        action:
          "Önce Jellyfin'i, sonra cloudflared tunnel'ı başlat ve tekrar dene.",
      },
      "tunnel-origin-error": {
        label: "Origin sorunu",
        title: "Tunnel çalışıyor, ama Jellyfin'e ulaşamıyor.",
        message:
          "Jellyfin yerel olarak cevap verdi, fakat Cloudflare gateway hatası döndürdü.",
        action:
          "cloudflared origin adresini, güvenlik duvarını ve Jellyfin bind ayarını kontrol et.",
      },
      unknown: {
        label: "Bağlantı sorunu",
        title: "Seyirlik sunucunun tam durumunu belirleyemedi.",
        message: "Tarayıcı başarısız istekten yeterli teknik detay alamadı.",
        action:
          "Jellyfin ve cloudflared durumunu kontrol edip bu sayfayı tekrar dene.",
      },
      none: {
        label: "Düzeldi",
        title: "Sunucu bağlantısı geri geldi.",
        message: "Jellyfin başarıyla cevap verdi.",
        action: "Tekrar denemek mevcut sayfayı yeniden açar.",
      },
    },
  },
} satisfies Record<
  Language,
  {
    checkingTitle: string;
    checkingMessage: string;
    eyebrow: string;
    retry: string;
    retrying: string;
    changeServer: string;
    cloudflareTunnel: string;
    jellyfinServer: string;
    seyirlikServer: string;
    publicUrl: string;
    localProbe: string;
    checkedByBackend: string;
    checkedByBrowser: string;
    online: string;
    offline: string;
    issue: string;
    unknown: string;
    technicalDetails: string;
    noLocalProbe: string;
    statusLine: string;
    source: string;
    checked: string;
    problems: Record<
      ServerConnectionProblem,
      {
        label: string;
        title: string;
        message: string;
        action: string;
      }
    >;
  }
>;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getTunnelState(
  problem: ServerConnectionProblem,
  publicProbe: ServerProbe,
): ServiceState {
  if (problem === "none" || problem === "jellyfin-down") {
    return "online";
  }

  if (problem === "tunnel-origin-error") {
    return "issue";
  }

  if (problem === "cloudflared-down" || problem === "both-down") {
    return "offline";
  }

  if (publicProbe.kind === "cloudflare-bad-gateway") {
    return "issue";
  }

  return "unknown";
}

function getJellyfinState(
  problem: ServerConnectionProblem,
  localProbe: ServerProbe | null,
): ServiceState {
  if (
    problem === "none" ||
    problem === "cloudflared-down" ||
    problem === "tunnel-origin-error"
  ) {
    return "online";
  }

  if (problem === "jellyfin-down" || problem === "both-down") {
    return "offline";
  }

  return probeIsOnline(localProbe) ? "online" : "unknown";
}

function statusStyles(status: ServiceState): {
  icon: typeof CheckCircle2;
  className: string;
} {
  switch (status) {
    case "online":
      return {
        icon: CheckCircle2,
        className: "border-emerald-300/25 bg-emerald-300/10 text-emerald-100",
      };
    case "offline":
      return {
        icon: XCircle,
        className: "border-rose-300/25 bg-rose-300/10 text-rose-100",
      };
    case "issue":
      return {
        icon: AlertTriangle,
        className: "border-amber-300/25 bg-amber-300/10 text-amber-100",
      };
    case "unknown":
      return {
        icon: HelpCircle,
        className: "border-white/15 bg-white/[0.07] text-white/78",
      };
  }
}

function ServiceStatusCard({
  icon: Icon,
  title,
  status,
  statusLabel,
  detail,
}: {
  icon: typeof Cloud;
  title: string;
  status: ServiceState;
  statusLabel: string;
  detail: string;
}) {
  const styles = statusStyles(status);
  const StatusIcon = styles.icon;

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.055] p-5 shadow-floating-panel">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/30 text-white/86">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-black text-white">{title}</h2>
            <p className="mt-1 break-words text-sm leading-6 text-white/58">
              {detail}
            </p>
          </div>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-black ${styles.className}`}
        >
          <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {statusLabel}
        </span>
      </div>
    </section>
  );
}

function LoadingView() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 transition-opacity duration-300 ease-in-out">
      <div className="text-center">
        <LoadingSpinner label="" />
      </div>
    </main>
  );
}

export function ServerConnectionErrorPage({
  serverUrl,
  failure,
  onRetrySuccess,
  mode = "jellyfin",
  diagnoseConnection = diagnoseServerConnection,
  testConnection = testServerConnection,
}: ServerConnectionErrorPageProps) {
  const { language } = useLanguage();
  const copy = COPY[language];
  const [state, setState] = useState<DiagnosticState>({ status: "checking" });
  const [isRetrying, setIsRetrying] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      setIsVisible(true);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  const finishWithFadeOut = useCallback(() => {
    setIsVisible(false);

    window.setTimeout(() => {
      onRetrySuccess();
    }, 300);
  }, [onRetrySuccess]);

  const runDiagnostics = useCallback(async () => {
    setState({ status: "checking" });

    try {
      const diagnosis = await diagnoseConnection({ serverUrl, failure });

      if (diagnosis.problem === "none") {
        finishWithFadeOut();
        return;
      }

      setState({ status: "ready", diagnosis });
    } catch (error) {
      setState({
        status: "failed",
        message: getErrorMessage(error),
      });
    }
  }, [diagnoseConnection, failure, finishWithFadeOut, serverUrl]);

  useEffect(() => {
    void runDiagnostics();
  }, [runDiagnostics]);

  const handleRetry = useCallback(async () => {
    setIsRetrying(true);

    try {
      await testConnection(serverUrl ?? "");
      finishWithFadeOut();
      return;
    } catch {
      await runDiagnostics();
    } finally {
      setIsRetrying(false);
    }
  }, [finishWithFadeOut, runDiagnostics, serverUrl, testConnection]);

  const fallbackDiagnosis = useMemo<ServerConnectionDiagnosis | null>(() => {
    if (state.status !== "failed") {
      return null;
    }

    return {
      problem: "unknown",
      serverUrl: serverUrl ?? "",
      checkedAt: new Date().toISOString(),
      source: "browser",
      publicProbe: {
        url: serverUrl ?? "",
        ok: false,
        reachable: false,
        kind: "network-error",
        message: state.message,
      },
      localProbe: null,
      localProbeUrls: [],
    };
  }, [serverUrl, state]);

  if (state.status === "checking") {
    return <LoadingView />;
  }

  const diagnosis =
    state.status === "ready" ? state.diagnosis : fallbackDiagnosis;

  if (!diagnosis) {
    return <LoadingView />;
  }

  const tunnelState = getTunnelState(diagnosis.problem, diagnosis.publicProbe);
  const jellyfinState = getJellyfinState(
    diagnosis.problem,
    diagnosis.localProbe,
  );
  const tunnelIcon =
    tunnelState === "offline"
      ? CloudOff
      : tunnelState === "issue"
        ? Wrench
        : Cloud;
  const jellyfinIcon =
    jellyfinState === "offline"
      ? ServerCrash
      : jellyfinState === "issue"
        ? Wrench
        : Server;
  const nativeServerState: ServiceState = probeIsOnline(diagnosis.publicProbe)
    ? "online"
    : "offline";

  return (
    <main className="min-h-screen bg-[#050505] px-5 py-10 text-white sm:px-8 lg:px-12">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-6xl items-center">
        <div className="w-full">
          <div
            className={`mb-8 flex justify-center transition-all duration-500 ease-out ${
              isVisible
                ? "translate-y-0 opacity-100 delay-75"
                : "translate-y-3 opacity-0 delay-0"
            }`}
          >
            <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.06] px-5 py-3 text-md font-black uppercase tracking-[0.18em] text-white/62">
              <AlertTriangle className="h-6 w-6 text-amber-200" />
              {copy.eyebrow}
            </div>
          </div>

          <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-5">
            <aside
              className={`grid w-full gap-3 transition-all duration-500 ease-out ${
                isVisible
                  ? "translate-y-0 opacity-100 delay-200"
                  : "translate-y-4 opacity-0 delay-0"
              }`}
            >
              {mode === "own-api" ? (
                <ServiceStatusCard
                  icon={nativeServerState === "online" ? Server : ServerCrash}
                  title={copy.seyirlikServer}
                  status={nativeServerState}
                  statusLabel={copy[nativeServerState]}
                  detail=""
                />
              ) : (
                <>
                  <ServiceStatusCard
                    icon={tunnelIcon}
                    title={copy.cloudflareTunnel}
                    status={tunnelState}
                    statusLabel={copy[tunnelState]}
                    detail=""
                  />
                  <ServiceStatusCard
                    icon={jellyfinIcon}
                    title={copy.jellyfinServer}
                    status={jellyfinState}
                    statusLabel={copy[jellyfinState]}
                    detail=""
                  />
                </>
              )}
            </aside>

            <div
              className={`flex w-full max-w-sm items-center gap-2.5 transition-all duration-500 ease-out ${
                isVisible
                  ? "translate-y-0 opacity-100 delay-[350ms]"
                  : "translate-y-4 opacity-0 delay-0"
              }`}
            >
              <button
                type="button"
                onClick={() => void handleRetry()}
                disabled={isRetrying}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-white px-5 text-sm font-black text-zinc-950 shadow-button-glow transition hover:bg-white/86 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-wait disabled:opacity-70"
              >
                <RefreshCw
                  className={`h-4 w-4 ${isRetrying ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {isRetrying ? copy.retrying : copy.retry}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
