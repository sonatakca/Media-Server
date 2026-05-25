import { useEffect, FormEvent, useState } from "react";
import { Lock, Server, User } from "lucide-react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import appIcon from "../assets/AppIcon2.png";
import { Button } from "../components/Button";
import { ErrorMessage } from "../components/ErrorMessage";
import { AnimatedText } from "../components/AnimatedText";
import { AnimatedWidth } from "../components/AnimatedWidth";
import { useLanguage } from "../i18n/LanguageContext";
import { getOrCreateDeviceId } from "../lib/device";
import { authenticateByName } from "../lib/jellyfinApi";
import {
  getServerUrl,
  isAuthenticated,
  setAuthSession,
} from "../lib/authStorage";
import { markLoginConfettiPending } from "../lib/homeConfetti";
import { setPageTitle } from "../lib/pageTitle";
import { RainbowAnimation } from "../components/animations/RainbowAnimation";

export function LoginPage() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const serverUrl = getServerUrl();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setPageTitle(`${t("auth.login")} · Seyirlik`, {
      canonicalPath: "/login",
      robots: "index, follow",
    });
  }, [t]);

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
      markLoginConfettiPending();
      navigate("/home", { replace: true });
    } catch (loginError) {
      const message =
        loginError instanceof Error
          ? loginError.message
          : t("auth.loginFailed");
      setError(`${t("auth.failedMessagePrefix")} ${message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10 text-white">
      <RainbowAnimation
        startDelay={0}
        fadeInDuration={2.5}
        holdDuration={5}
        fadeOutDuration={2.5}
        driftDuration={16.7}
        driftDistancePercent={35}
        startYPercent={-50}
        endYPercent={-50}
        startScale={0.92}
        endScale={1.08}
        maxOpacity={0.5}
        stripeAngleDeg={106}
        spinAngleDeg={2.2}
        spinSpeedDegPerSecond={0.035}
        blurPx={22}
        width="max(80vw, 62rem)"
        height="min(20rem, 35vh)"
        top="2rem"
        glowFadeInDuration={2.2}
        glowHoldDuration={5}
        glowFadeOutDuration={2.2}
        glowMaxOpacity={0.72}
        glowTop="-10rem"
        side="top"
      />

      <RainbowAnimation
        startDelay={0.5} // Slight delay so it follows the top
        fadeInDuration={2.5}
        holdDuration={5.5}
        fadeOutDuration={2.5}
        driftDuration={16}
        driftDistancePercent={-60}
        startYPercent={-56}
        endYPercent={-44}
        startScale={0.96}
        endScale={1.03}
        maxOpacity={0.45}
        stripeAngleDeg={75}
        spinAngleDeg={-3}
        spinSpeedDegPerSecond={-0.04}
        blurPx={34}
        width="max(80vw, 62rem)"
        height="min(20rem, 35vh)"
        top="2rem"
        glowFadeInDuration={2}
        glowHoldDuration={5.5}
        glowFadeOutDuration={2}
        glowMaxOpacity={0.5}
        glowTop="-10rem"
        side="bottom"
      />

      <RainbowAnimation
        startDelay={1}
        fadeInDuration={2.5}
        holdDuration={5}
        fadeOutDuration={2.5}
        driftDuration={15}
        driftDistancePercent={24}
        startYPercent={-50}
        endYPercent={-50}
        startScale={0.98}
        endScale={1.02}
        maxOpacity={0.3}
        stripeAngleDeg={108}
        spinAngleDeg={0.8}
        spinSpeedDegPerSecond={0.012}
        blurPx={30}
        width="max(64vw, 48rem)"
        height="min(20rem, 35vh)"
        top="2rem"
        glowFadeInDuration={2}
        glowHoldDuration={5}
        glowFadeOutDuration={2}
        glowMaxOpacity={0.28}
        glowTop="-7rem"
        glowWidth="min(32rem, 64vw)"
        glowHeight="min(8rem, 18vh)"
        glowBlurPx={22}
        side="left"
      />

      {/* --- RIGHT: Gentle sweeping, opposite rotation --- */}
      <RainbowAnimation
        startDelay={1.5}
        fadeInDuration={3}
        holdDuration={5}
        fadeOutDuration={3}
        driftDuration={17}
        driftDistancePercent={-50}
        startYPercent={-54}
        endYPercent={-46}
        startScale={0.95}
        endScale={1.04}
        maxOpacity={0.42}
        stripeAngleDeg={35}
        spinAngleDeg={-2.5}
        spinSpeedDegPerSecond={-0.03}
        blurPx={36}
        width="max(80vw, 62rem)"
        height="min(20rem, 35vh)"
        top="2rem"
        glowFadeInDuration={2.5}
        glowHoldDuration={5}
        glowFadeOutDuration={2.5}
        glowMaxOpacity={0.5}
        glowTop="-10rem"
        side="right"
      />

      <section className="w-full max-w-md">
        <div className="mb-8 text-center">
          <img
            src={appIcon}
            alt=""
            className="mx-auto h-16 w-16 rounded-2xl object-cover shadow-2xl"
          />
          <p className="mt-4 text-sm font-semibold text-[var(--accent)]">
            Seyirlik
          </p>
          <h1 className="text-3xl font-black">{t("auth.signInToJellyfin")}</h1>
          <p className="mt-3 break-all text-sm text-zinc-400">{serverUrl}</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-white/10 bg-black/[0.55] p-5 shadow-2xl backdrop-blur sm:p-6"
        >
          <label
            htmlFor="username"
            className="block text-sm font-semibold text-zinc-100"
          >
            {t("auth.username")}
          </label>
          <div className="relative mt-2">
            <User
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
              size={18}
            />
            <input
              id="username"
              autoComplete="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="min-h-12 w-full rounded-lg border border-white/10 bg-white/10 py-3 pl-10 pr-4 text-white outline-none transition placeholder:text-zinc-500 focus:border-[var(--accent)] focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
            />
          </div>

          <label
            htmlFor="password"
            className="mt-5 block text-sm font-semibold text-zinc-100"
          >
            {t("auth.password")}
          </label>
          <div className="relative mt-2">
            <Lock
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
              size={18}
            />
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("auth.noPasswordPlaceholder")}
              className="min-h-12 w-full rounded-lg border border-white/10 bg-white/10 py-3 pl-10 pr-4 text-white outline-none transition placeholder:text-zinc-500 focus:border-[var(--accent)] focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
            />
          </div>

          {error ? (
            <div className="mt-5">
              <ErrorMessage title={t("auth.failedTitle")} message={error} />
            </div>
          ) : null}

          <Button type="submit" className="mt-6 w-full" disabled={isSubmitting}>
            <AnimatedWidth
              value={isSubmitting ? t("auth.signingIn") : t("auth.signIn")}
            >
              <span className="inline-flex py-1 leading-normal">
                <AnimatedText
                  value={isSubmitting ? t("auth.signingIn") : t("auth.signIn")}
                />
              </span>
            </AnimatedWidth>
          </Button>

          <Link
            to="/server"
            className="mt-4 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
          >
            <Server size={17} />
            <AnimatedWidth value={t("auth.changeServerUrl")}>
              <span className="inline-flex py-1 leading-normal">
                <AnimatedText value={t("auth.changeServerUrl")} />
              </span>
            </AnimatedWidth>
          </Link>
        </form>
      </section>
    </main>
  );
}
