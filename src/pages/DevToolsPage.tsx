import { Link } from "react-router-dom";
import { Activity, ArrowRight, ShieldCheck } from "lucide-react";
import { setPageTitle } from "../lib/pageTitle";
import { useEffect } from "react";
import { RainbowAnimation } from "../components/animations/RainbowAnimation";
import { SparkleAnimation } from "../components/animations/SparkleAnimation";
import { ConfettiAnimation } from "../components/animations/ConfettiAnimation";
import { AuroraSparkleAnimation } from "../components/animations/AuraSparklesAnimation";

export function DevToolsPage() {
  useEffect(() => {
    setPageTitle("Devtools · Seyirlik");
  }, []);

  const tools = [
    {
      title: "Playback Audit",
      description:
        "Scan Jellyfin media and document Direct Play, Direct Stream, Transcoding, and transcode reasons.",
      to: "/dev/playback-audit",
      icon: Activity,
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

        <SparkleAnimation
            startDelay={3}
            sparkleDuration={6}
        />

      <section className="rounded-3xl border border-white/10 bg-white/[0.055] p-6 shadow-2xl backdrop-blur-xl">
        <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
          Seyirlik
        </p>

        <div className="mt-3 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[var(--accent)]/10 text-[var(--accent)]">
            <ShieldCheck size={22} />
          </div>

          <div>
            <h1 className="text-3xl font-black text-white sm:text-4xl">
              Devtools
            </h1>

            <p className="mt-1 text-sm font-semibold text-white/50">
              Tools for debugging and maintenance.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {tools.map(({ title, description, to, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="group rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl transition hover:border-[var(--accent)]/35 hover:bg-white/[0.075]"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-white/82 transition group-hover:text-[var(--accent)]">
                <Icon size={20} />
              </div>

              <ArrowRight
                size={18}
                className="mt-2 text-white/35 transition group-hover:translate-x-1 group-hover:text-[var(--accent)]"
              />
            </div>

            <h2 className="mt-5 text-xl font-black text-white transition group-hover:text-[var(--accent)]">
              {title}
            </h2>

            <p className="mt-2 text-sm font-medium leading-6 text-white/55">
              {description}
            </p>
          </Link>
        ))}
      </section>
    </div>
  );
}