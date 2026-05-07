import { FormEvent, useState } from "react";
import { Lock, Server, User } from "lucide-react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import appIcon from "../assets/AppIcon2.png";
import { Button } from "../components/Button";
import { ErrorMessage } from "../components/ErrorMessage";
import { useLanguage } from "../i18n/LanguageContext";
import { getOrCreateDeviceId } from "../lib/device";
import { authenticateByName } from "../lib/jellyfinApi";
import { getServerUrl, isAuthenticated, setAuthSession } from "../lib/authStorage";

export function LoginPage() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const serverUrl = getServerUrl();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!serverUrl) {
    return <Navigate to="/server" replace />;
  }

  if (isAuthenticated()) {
    return <Navigate to="/home" replace />;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const authResponse = await authenticateByName(username, password);
      setAuthSession({
        serverUrl,
        accessToken: authResponse.AccessToken,
        userId: authResponse.User.Id,
        username: authResponse.User.Name || username,
        deviceId: getOrCreateDeviceId(),
      });
      navigate("/home", { replace: true });
    } catch (loginError) {
      const message = loginError instanceof Error ? loginError.message : "Login failed.";
      setError(`${t("auth.failedMessagePrefix")} ${message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10 text-white">
      <section className="w-full max-w-md">
        <div className="mb-8 text-center">
          <img src={appIcon} alt="" className="mx-auto h-16 w-16 rounded-2xl object-cover shadow-2xl" />
          <p className="mt-4 text-sm font-semibold text-teal-200">Seyirlik Web</p>
          <h1 className="text-3xl font-black">{t("auth.signInToJellyfin")}</h1>
          <p className="mt-3 break-all text-sm text-zinc-400">{serverUrl}</p>
        </div>

        <form onSubmit={handleSubmit} className="rounded-lg border border-white/10 bg-black/[0.55] p-5 shadow-2xl backdrop-blur sm:p-6">
          <label htmlFor="username" className="block text-sm font-semibold text-zinc-100">
            {t("auth.username")}
          </label>
          <div className="relative mt-2">
            <User className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
            <input
              id="username"
              autoComplete="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="min-h-12 w-full rounded-lg border border-white/10 bg-white/10 py-3 pl-10 pr-4 text-white outline-none transition placeholder:text-zinc-500 focus:border-teal-300 focus:ring-2 focus:ring-teal-300/30"
            />
          </div>

          <label htmlFor="password" className="mt-5 block text-sm font-semibold text-zinc-100">
            {t("auth.password")}
          </label>
          <div className="relative mt-2">
            <Lock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Leave blank if this Jellyfin user has no password"
              className="min-h-12 w-full rounded-lg border border-white/10 bg-white/10 py-3 pl-10 pr-4 text-white outline-none transition placeholder:text-zinc-500 focus:border-teal-300 focus:ring-2 focus:ring-teal-300/30"
            />
          </div>

          {error ? (
            <div className="mt-5">
              <ErrorMessage title={t("auth.failedTitle")} message={error} />
            </div>
          ) : null}

          <Button type="submit" className="mt-6 w-full" disabled={isSubmitting}>
            {isSubmitting ? t("auth.signingIn") : t("auth.signIn")}
          </Button>

          <Link
            to="/server"
            className="mt-4 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
          >
            <Server size={17} />
            {t("auth.changeServerUrl")}
          </Link>
        </form>
      </section>
    </main>
  );
}
