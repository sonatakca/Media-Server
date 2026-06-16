import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Bug,
  Database,
  DatabaseZap,
  Images,
  Languages,
  Lightbulb,
  ListOrdered,
  ShieldCheck,
} from "lucide-react";
import { setPageTitle } from "../lib/pageTitle";
import { useEffect } from "react";
import { RainbowAnimation } from "../components/animations/RainbowAnimation";
import { SparkleAnimation } from "../components/animations/SparkleAnimation";
import { useLanguage } from "../i18n/LanguageContext";

export function DevToolsPage() {
  const { t } = useLanguage();

  useEffect(() => {
    setPageTitle(`${t("devtools.title")} · Seyirlik`, {
      canonicalPath: "/dev",
      robots: "noindex, nofollow",
    });
  }, [t]);

  const tools = [
    {
      title: t("devtools.card.playbackAudit.title"),
      description: t("devtools.card.playbackAudit.description"),
      to: "/dev/playback-audit",
      icon: Activity,
      tag: t("devtools.card.playbackAudit.tag"),
    },
    {
      title: t("devtools.card.libraryMaintenance.title"),
      description: t("devtools.card.libraryMaintenance.description"),
      to: "/dev/library-maintenance",
      icon: DatabaseZap,
      tag: t("devtools.card.libraryMaintenance.tag"),
    },
    {
      title: t("devtools.card.tmdbArtwork.title"),
      description: t("devtools.card.tmdbArtwork.description"),
      to: "/dev/tmdb-artwork",
      icon: Images,
      tag: t("devtools.card.tmdbArtwork.tag"),
    },
    {
      title: t("devtools.card.contentExplorer.title"),
      description: t("devtools.card.contentExplorer.description"),
      to: "/dev/content",
      icon: Database,
      tag: t("devtools.card.contentExplorer.tag"),
    },
    {
      title: t("devtools.card.homeCuration.title"),
      description: t("devtools.card.homeCuration.description"),
      to: "/dev/home-curation",
      icon: ListOrdered,
      tag: t("devtools.card.homeCuration.tag"),
    },
    {
      title: t("devtools.card.playbackDefaults.title"),
      description: t("devtools.card.playbackDefaults.description"),
      to: "/dev/playback-defaults",
      icon: Languages,
      tag: t("devtools.card.playbackDefaults.tag"),
    },
    {
      title: t("devtools.card.knownBugs.title"),
      description: t("devtools.card.knownBugs.description"),
      to: "/dev/known-bugs",
      icon: Bug,
      tag: t("devtools.card.knownBugs.tag"),
    },
    {
      title: t("devtools.card.wantedFeatures.title"),
      description: t("devtools.card.wantedFeatures.description"),
      to: "/dev/wanted-features",
      icon: Lightbulb,
      tag: t("devtools.card.wantedFeatures.tag"),
    },
  ];

  return (
    <div className="relative mx-auto max-w-5xl space-y-6">
      <RainbowAnimation
        startDelay={0}
        fadeInDuration={2.5}
        holdDuration={5}
        fadeOutDuration={2.5}
        driftDuration={16.7}
        driftDistancePercent={35}
        startYPercent={-50}
        endYPercent={-38}
        startScale={0.92}
        endScale={1.08}
        maxOpacity={0.88}
        stripeAngleDeg={106}
        spinAngleDeg={2.2}
        spinSpeedDegPerSecond={0.035}
        blurPx={38}
        width="max(115vw, 82rem)"
        height="min(58rem, 82vh)"
        top="-1rem"
        glowFadeInDuration={2.2}
        glowHoldDuration={5}
        glowFadeOutDuration={2.2}
        glowMaxOpacity={0.72}
      />

      <SparkleAnimation startDelay={3} sparkleDuration={6} />

      <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] p-6 shadow-2xl backdrop-blur-xl">
        <div className="pointer-events-none absolute -right-20 -top-24 h-60 w-60 rounded-full bg-[var(--accent)]/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 left-8 h-60 w-60 rounded-full bg-white/10 blur-3xl" />

        <div className="relative">
          <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
            Seyirlik
          </p>

          <div className="mt-3 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[var(--accent)]/10 text-[var(--accent)]">
              <ShieldCheck size={22} />
            </div>

            <div>
              <h1 className="text-3xl font-black text-white sm:text-4xl">
                {t("devtools.title")}
              </h1>

              <p className="mt-1 text-sm font-semibold text-white/50">
                {t("devtools.pageDescription")}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map(({ title, description, to, icon: Icon, tag }) => (
          <Link
            key={to}
            to={to}
            className="group relative overflow-hidden rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl transition hover:border-[var(--accent)]/35 hover:bg-white/[0.075]"
          >
            <div className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-[var(--accent)]/0 blur-3xl transition group-hover:bg-[var(--accent)]/15" />

            <div className="relative">
              <div className="flex items-start justify-between gap-4">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-white/82 transition duration-300 ease-out group-hover:scale-110 group-hover:text-[var(--accent)]">
                  <Icon size={20} />
                </div>

                <ArrowRight
                  size={18}
                  className="mt-2 text-white/35 transition group-hover:translate-x-1 group-hover:text-[var(--accent)]"
                />
              </div>

              <p className="mt-5 w-fit rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs font-black uppercase tracking-[0.12em] text-white/40">
                {tag}
              </p>

              <h2 className="mt-3 text-xl font-black text-white transition group-hover:text-[var(--accent)]">
                {title}
              </h2>

              <p className="mt-2 text-sm font-medium leading-6 text-white/55">
                {description}
              </p>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
