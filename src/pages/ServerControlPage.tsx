import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ChevronLeft,
  Loader2,
  Power,
  RotateCcw,
  ServerCog,
} from "lucide-react";
import { Button } from "../components/Button";
import { ErrorMessage } from "../components/ErrorMessage";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useLanguage } from "../i18n/LanguageContext";
import { setPageTitle } from "../lib/pageTitle";
import {
  getServerRestartStatus,
  requestServerRestart,
  waitForServerRestart,
  type ServerRestartPhase,
  type ServerRestartStatus,
} from "../lib/serverControl";

/**
 * Restarting the server, and getting the page back afterwards.
 *
 * The page deliberately stays on screen through the outage rather than showing
 * an error the moment the connection drops: for the ten or so seconds the
 * server is gone, the only thing that can tell the operator what is happening
 * is this page, and a blank failure would leave them wondering whether to
 * restart it again by hand.
 */

type Stage = "idle" | "confirming" | "requesting" | "waiting" | "failed";

export function ServerControlPage() {
  const { t } = useLanguage();
  const [status, setStatus] = useState<ServerRestartStatus | null>(null);
  /*
   * The raw failure, translated at render rather than here.
   *
   * Keeping `t` out of this state is what keeps it out of the effect's
   * dependencies. `t` is a new function on every render of the language
   * provider, so an effect that depends on it and also sets state re-runs
   * itself for ever, aborting its own request each time and never settling on
   * an answer.
   */
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [phase, setPhase] = useState<ServerRestartPhase | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // A restart in flight must not be cancelled by a re-render, and the reload
  // must not fire from a component that has gone away.
  const restarting = useRef(false);

  useEffect(() => {
    setPageTitle(`${t("serverControl.title")} · Seyirlik`, {
      canonicalPath: "/dev/server-control",
      robots: "noindex, nofollow",
    });
  }, [t]);

  const [reloadStatusKey, setReloadStatusKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    getServerRestartStatus({ signal: controller.signal })
      .then((next) => {
        if (!active) return;
        setStatus(next);
        setLoadFailure(null);
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        // Empty string means "it failed but said nothing useful"; null means
        // it has not failed. The two have to stay distinguishable.
        setLoadFailure(error instanceof Error ? error.message : "");
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadStatusKey]);

  const retryStatus = useCallback(() => {
    setStatus(null);
    setLoadFailure(null);
    setReloadStatusKey((key) => key + 1);
  }, []);

  const loadError =
    loadFailure === null ? null : loadFailure || t("serverControl.loadFailed");

  const restart = useCallback(async () => {
    if (restarting.current) return;
    restarting.current = true;

    setStage("requesting");
    setActionError(null);
    setPhase(null);

    try {
      await requestServerRestart();
    } catch (error) {
      restarting.current = false;
      setStage("failed");
      setActionError(
        error instanceof Error
          ? error.message
          : t("serverControl.requestFailed"),
      );
      return;
    }

    setStage("waiting");

    const outcome = await waitForServerRestart({ onPhase: setPhase });

    if (outcome === "ready") {
      // A full reload rather than a router navigation: the point of the restart
      // is usually that the server is running different code or configuration,
      // and a bundle loaded from the old process should not survive it.
      window.location.reload();
      return;
    }

    restarting.current = false;
    setStage("failed");
    setActionError(t("serverControl.timedOut"));
  }, [t]);

  if (!status && !loadError) {
    return (
      <div className="mx-auto flex max-w-4xl justify-center py-24">
        <LoadingSpinner label={t("serverControl.loading")} />
      </div>
    );
  }

  const busy = stage === "requesting" || stage === "waiting";
  /*
   * An unreadable status is not the same as a restart that is unavailable.
   *
   * The status call fails for reasons that have nothing to do with whether the
   * feature exists — the server being mid-restart is the obvious one. Hiding
   * the button on a failed read leaves a section with nothing in it and no way
   * forward, which is exactly what a stale server produced here. Unknown
   * therefore means "let them try": pressing it either works or comes back
   * with the server's own reason.
   */
  const available = status ? status.available : true;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <section className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] p-6 shadow-2xl backdrop-blur-xl">
        <Link
          to="/dev"
          className="inline-flex items-center gap-2 text-sm font-black text-white/55 transition hover:text-white"
        >
          <ChevronLeft size={16} />
          {t("devtools.backToDevtools")}
        </Link>

        <div className="mt-5 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[var(--accent)]/10 text-[var(--accent)]">
            <ServerCog size={22} />
          </div>

          <div>
            <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
              {t("serverControl.eyebrow")}
            </p>
            <h1 className="mt-1 text-3xl font-black text-white sm:text-4xl">
              {t("serverControl.title")}
            </h1>
          </div>
        </div>

        <p className="mt-3 max-w-2xl text-sm font-semibold leading-6 text-white/55">
          {t("serverControl.description")}
        </p>
      </section>

      {loadError ? (
        <ErrorMessage
          title={t("serverControl.statusUnavailable")}
          message={loadError}
          onRetry={retryStatus}
        />
      ) : null}

      <section className="rounded-3xl border border-white/10 bg-black/30 p-6 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-white">
              {t("serverControl.restart.title")}
            </h2>
            <p className="mt-2 max-w-xl text-sm font-medium leading-6 text-white/55">
              {t("serverControl.restart.description")}
            </p>
          </div>

          {status ? (
            <p className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-white/45">
              {t(`serverControl.mode.${status.mode}`)}
            </p>
          ) : null}
        </div>

        {status && !status.available ? (
          <div className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] p-4">
            <AlertTriangle
              size={18}
              className="mt-0.5 shrink-0 text-amber-200"
            />
            <p className="text-sm font-semibold leading-6 text-amber-100/85">
              {t("serverControl.unavailable")}
            </p>
          </div>
        ) : null}

        {available ? (
          <div className="mt-6">
            {stage === "confirming" ? (
              <div className="rounded-2xl border border-rose-300/25 bg-rose-300/[0.07] p-4">
                <p className="text-sm font-bold leading-6 text-rose-100/90">
                  {t("serverControl.confirm.question")}
                </p>
                <p className="mt-1 text-sm font-medium leading-6 text-white/55">
                  {t("serverControl.confirm.consequence")}
                </p>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="danger"
                    onClick={() => void restart()}
                    title={t("serverControl.confirm.accept")}
                  >
                    <Power size={16} />
                    {t("serverControl.confirm.accept")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setStage("idle")}
                    title={t("serverControl.confirm.cancel")}
                  >
                    {t("serverControl.confirm.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setActionError(null);
                  setStage("confirming");
                }}
                title={t("serverControl.restart.action")}
              >
                {busy ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <RotateCcw size={16} />
                )}
                {t("serverControl.restart.action")}
              </Button>
            )}

            {busy ? (
              <div
                className="mt-5 flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.045] p-4"
                role="status"
                aria-live="polite"
              >
                <Loader2
                  size={18}
                  className="shrink-0 animate-spin text-[var(--accent)]"
                />
                <div>
                  <p className="text-sm font-bold text-white/85">
                    {t(
                      phase === "starting"
                        ? "serverControl.progress.starting"
                        : phase === "ready"
                          ? "serverControl.progress.ready"
                          : "serverControl.progress.stopping",
                    )}
                  </p>
                  <p className="mt-1 text-sm font-medium text-white/50">
                    {t("serverControl.progress.hint")}
                  </p>
                </div>
              </div>
            ) : null}

            {actionError ? (
              <div className="mt-5">
                <ErrorMessage message={actionError} />
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
