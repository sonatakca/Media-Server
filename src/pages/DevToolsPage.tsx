import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Bug,
  Database,
  DatabaseZap,
  Download,
  FileVideo,
  HardDrive,
  HeartPulse,
  Images,
  Languages,
  Lightbulb,
  ListOrdered,
  PanelsTopLeft,
  Plug,
  Save,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  Subtitles,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";
import { setPageTitle } from "../lib/pageTitle";
import { useEffect, useState } from "react";
import { SparkleAnimation } from "../components/animations/SparkleAnimation";
import { useLanguage } from "../i18n/LanguageContext";
import { ConfettiAnimation } from "../components/animations/ConfettiAnimation";
import { visibleGroups, type AdminIconName } from "../lib/adminSections";

/**
 * The icon set, resolved here rather than in the registry.
 *
 * The registry names an icon; this page knows what to draw. That keeps the
 * description of the administration surface free of a UI dependency, so it can
 * be read by a test without pulling in an icon library.
 */
const ICONS: Record<AdminIconName, LucideIcon> = {
  activity: Activity,
  bug: Bug,
  database: Database,
  databaseZap: DatabaseZap,
  download: Download,
  fileVideo: FileVideo,
  hardDrive: HardDrive,
  heartPulse: HeartPulse,
  images: Images,
  languages: Languages,
  lightbulb: Lightbulb,
  listOrdered: ListOrdered,
  panelsTopLeft: PanelsTopLeft,
  plug: Plug,
  save: Save,
  serverCog: ServerCog,
  shieldAlert: ShieldAlert,
  subtitles: Subtitles,
  target: Target,
  users: Users,
};

export function DevToolsPage() {
  const { t } = useLanguage();
  // The route arrives while its own chunk, the admin check and the icon set are
  // still landing, so a run started at mount is a run started underneath a page
  // that is still changing. Waiting for the document's load event — and then a
  // frame, for the case where the document was already complete and this is a
  // client-side navigation — means the pieces fall over a page that has settled
  // and painted, and the celebration is seen from its first frame.
  const [canCelebrate, setCanCelebrate] = useState(false);

  useEffect(() => {
    let animationFrame = 0;
    let isCancelled = false;

    function armCelebration() {
      animationFrame = window.requestAnimationFrame(() => {
        if (!isCancelled) {
          setCanCelebrate(true);
        }
      });
    }

    if (document.readyState === "complete") {
      armCelebration();
    } else {
      window.addEventListener("load", armCelebration, { once: true });
    }

    return () => {
      isCancelled = true;
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("load", armCelebration);
    };
  }, []);

  useEffect(() => {
    setPageTitle(`${t("admin.title")} · Seyirlik`, {
      canonicalPath: "/admin",
      robots: "noindex, nofollow",
    });
  }, [t]);

  const groups = visibleGroups({ includeDevOnly: import.meta.env.DEV });

  return (
    <div className="relative mx-auto max-w-5xl space-y-6">
      {canCelebrate ? (
        <>
          <ConfettiAnimation startDelay={0} pieceCount={250} />

          <SparkleAnimation startDelay={1} sparkleDuration={1.5} />
        </>
      ) : null}

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
                {t("admin.title")}
              </h1>

              <p className="mt-1 text-sm font-semibold text-white/50">
                {t("admin.pageDescription")}
              </p>
            </div>
          </div>
        </div>
      </section>

      {groups.map(({ group, sections }) => (
        <section key={group.id} aria-labelledby={`admin-group-${group.id}`}>
          <div className="px-1">
            <h2
              id={`admin-group-${group.id}`}
              className="text-lg font-black text-white"
            >
              {t(group.titleKey)}
            </h2>

            <p className="mt-1 text-sm font-medium text-white/45">
              {t(group.descriptionKey)}
            </p>
          </div>

          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sections.map((section) => {
              const Icon = ICONS[section.icon];

              return (
                <Link
                  key={section.id}
                  to={section.path}
                  className="group relative overflow-hidden rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl transition hover:border-[var(--accent)]/35 hover:bg-white/[0.075] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
                      {t(section.tagKey)}
                    </p>

                    <h3 className="mt-3 text-xl font-black text-white transition group-hover:text-[var(--accent)]">
                      {t(section.titleKey)}
                    </h3>

                    <p className="mt-2 text-sm font-medium leading-6 text-white/55">
                      {t(section.descriptionKey)}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
