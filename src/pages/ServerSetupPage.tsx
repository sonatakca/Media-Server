import { FormEvent, useState } from "react";
import { CheckCircle2, Server, Wifi } from "lucide-react";
import { useNavigate } from "react-router-dom";
import appIcon from "../assets/AppIcon2.png";
import { Button } from "../components/Button";
import { ErrorMessage } from "../components/ErrorMessage";
import { AnimatedText } from "../components/AnimatedText";
import { AnimatedWidth } from "../components/AnimatedWidth";
import { useLanguage } from "../i18n/LanguageContext";
import { clearAuthSession, getServerUrl, normalizeServerUrl, setServerUrl } from "../lib/authStorage";
import { testServerConnection } from "../lib/jellyfinApi";

const examples = [
  "http://localhost:8096",
  "http://192.168.1.50:8096",
  "https://jellyfin.mydomain.com",
  "https://mydomain.com/jellyfin",
];

export function ServerSetupPage() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const defaultServerUrl =
    (import.meta.env.VITE_DEFAULT_JELLYFIN_SERVER_URL as string | undefined)?.trim() ||
    "https://izle.sonatakca.com";
  const [serverUrlInput, setServerUrlInput] = useState(getServerUrl() ?? defaultServerUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [connectionInfo, setConnectionInfo] = useState<{ serverName: string; version: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    try {
      clearAuthSession();
      const normalizedServerUrl = setServerUrl(serverUrlInput);
      setConnectionInfo(null);
      navigate("/login", {
        replace: true,
        state: { serverUrl: normalizedServerUrl },
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("server.saveFailed"));
    }
  };

  const handleTestConnection = async () => {
    setError(null);
    setConnectionInfo(null);
    setIsTesting(true);

    try {
      const normalizedServerUrl = normalizeServerUrl(serverUrlInput);
      const publicInfo = await testServerConnection(normalizedServerUrl);
      const serverName = publicInfo.ServerName || publicInfo.ProductName || "Jellyfin";
      const version = publicInfo.Version ? ` ${publicInfo.Version}` : "";
      setConnectionInfo({ serverName, version });
    } catch (testError) {
      setError(
        testError instanceof Error
          ? testError.message
          : t("server.couldNotConnect"),
      );
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10 text-white">
      <section className="w-full max-w-2xl">
        <div className="mb-8 flex items-center gap-3">
          <img src={appIcon} alt="" className="h-12 w-12 rounded-2xl object-cover shadow-2xl" />
          <div>
            <p className="text-sm font-semibold text-[var(--accent)]">Seyirlik Web</p>
            <h1 className="text-3xl font-black sm:text-4xl">{t("server.connectJellyfin")}</h1>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="rounded-lg border border-white/10 bg-black/[0.55] p-5 shadow-2xl backdrop-blur sm:p-6">
          <label htmlFor="server-url" className="block text-sm font-semibold text-zinc-100">
            {t("server.jellyfinServerUrl")}
          </label>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <input
              id="server-url"
              type="url"
              required
              value={serverUrlInput}
              onChange={(event) => setServerUrlInput(event.target.value)}
              placeholder="http://192.168.1.50:8096"
              className="min-h-12 flex-1 rounded-lg border border-white/10 bg-white/10 px-4 text-base text-white outline-none transition placeholder:text-zinc-500 focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30"
            />
            <Button type="button" variant="secondary" onClick={handleTestConnection} disabled={isTesting}>
              <Wifi size={18} />
              <AnimatedWidth value={isTesting ? t("server.testing") : t("server.test")}>
                <AnimatedText value={isTesting ? t("server.testing") : t("server.test")} />
              </AnimatedWidth>
            </Button>
          </div>

          <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.045] p-4 text-sm text-zinc-300">
            <p>
              <code className="rounded bg-black/40 px-1 py-0.5 text-zinc-100">localhost</code> {t("server.localhostNote")}
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setServerUrlInput(example)}
                  className="min-h-10 rounded-lg border border-white/10 bg-black/30 px-3 text-left text-xs text-zinc-200 transition hover:border-[var(--accent)]/50 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>

          {connectionInfo ? (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-white/[0.12] bg-white/[0.08] p-3 text-sm text-zinc-100">
              <CheckCircle2 size={18} />
              {t("server.connectedTo")} {connectionInfo.serverName}
              {connectionInfo.version}.
            </div>
          ) : null}

          {error ? (
            <div className="mt-4">
              <ErrorMessage title={t("server.connectionIssue")} message={error} />
            </div>
          ) : null}

          <Button type="submit" className="mt-5 w-full">
            <Server size={18} />
            <AnimatedWidth value={t("server.continueToLogin")}>
              <AnimatedText value={t("server.continueToLogin")} />
            </AnimatedWidth>
          </Button>
        </form>
      </section>
    </main>
  );
}
