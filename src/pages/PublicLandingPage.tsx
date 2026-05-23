import { useEffect } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Clapperboard,
  Film,
  Server,
  Sparkles,
} from "lucide-react";
import appIcon from "../assets/AppIcon2.png";
import logoOnSide from "../assets/Seyirlik-Logo-OnSide-cropped.png";
import {
  DEFAULT_SEO_DESCRIPTION,
  DEFAULT_SEO_TITLE,
  setSeoMetadata,
} from "../lib/seo";

const features = [
  {
    title: "Browse movies and TV shows",
    description:
      "Move through your Jellyfin library with rich artwork, cinematic rows, and focused media details.",
    icon: Film,
  },
  {
    title: "Playback diagnostics",
    description:
      "Understand Direct Play, Direct Stream, transcoding, codecs, sources, and browser playback choices.",
    icon: Activity,
  },
  {
    title: "Cinematic media experience",
    description:
      "A dark, polished interface built around posters, backdrops, smooth motion, and distraction-free playback.",
    icon: Clapperboard,
  },
  {
    title: "Jellyfin stays the backend",
    description:
      "Seyirlik is the web frontend/client. Your Jellyfin server remains the media source and API backend.",
    icon: Server,
  },
];

export function PublicLandingPage() {
  useEffect(() => {
    setSeoMetadata({
      title: DEFAULT_SEO_TITLE,
      description: DEFAULT_SEO_DESCRIPTION,
      canonicalPath: "/",
      robots: "index, follow",
    });
  }, []);

  return (
    <main className="min-h-screen overflow-hidden bg-black text-white">
      <section className="relative flex min-h-screen items-center px-4 py-20 sm:px-6 lg:px-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.13),transparent_34%),linear-gradient(180deg,rgba(0,0,0,0.35),#000_88%)]" />
        <img
          src={logoOnSide}
          alt=""
          className="pointer-events-none absolute left-1/2 top-[12%] w-[min(64rem,135vw)] -translate-x-1/2 select-none opacity-[0.13] blur-[1px]"
        />
        <div className="pointer-events-none absolute -left-24 top-20 h-80 w-80 rounded-full bg-[var(--accent)]/22 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-96 w-96 rounded-full bg-white/10 blur-3xl" />

        <div className="relative z-10 mx-auto w-full max-w-6xl">
          <div className="flex items-center gap-3">
            <img
              src={appIcon}
              alt=""
              className="h-12 w-12 rounded-2xl object-cover shadow-2xl"
            />
            <span className="text-sm font-black uppercase tracking-[0.24em] text-[var(--accent)]">
              Built by Sonat Akça
            </span>
          </div>

          <div className="mt-10 max-w-4xl">
            <p className="text-sm font-black uppercase tracking-[0.24em] text-white/54">
              Modern Jellyfin Media Client
            </p>
            <h1 className="mt-4 text-5xl font-black leading-[0.95] text-white sm:text-6xl lg:text-7xl">
              Seyirlik
            </h1>
            <p className="mt-6 max-w-2xl text-xl font-bold leading-8 text-white/78 sm:text-2xl">
              A cinematic web frontend for Jellyfin, built for browsing movies,
              TV shows, playback diagnostics, and a modern home media
              experience.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/app"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-6 text-sm font-black text-black shadow-[0_16px_40px_var(--accent-soft)] transition hover:bg-[var(--accent-hover)]"
              >
                Open App
                <ArrowRight size={18} />
              </Link>
              <Link
                to="/server"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/14 bg-white/10 px-6 text-sm font-black text-white/82 backdrop-blur transition hover:bg-white/15 hover:text-white"
              >
                Connect Jellyfin Server
                <Server size={18} />
              </Link>
            </div>
          </div>

          <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {features.map(({ title, description, icon: Icon }) => (
              <article
                key={title}
                className="rounded-2xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-xl"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-[var(--accent)]">
                  <Icon size={21} />
                </div>
                <h2 className="mt-4 text-base font-black text-white">
                  {title}
                </h2>
                <p className="mt-2 text-sm font-semibold leading-6 text-white/54">
                  {description}
                </p>
              </article>
            ))}
          </div>

          <p className="mt-8 flex max-w-3xl items-center gap-2 text-sm font-semibold leading-6 text-white/44">
            <Sparkles size={16} className="shrink-0 text-[var(--accent)]" />
            Seyirlik does not replace Jellyfin. It gives your existing Jellyfin
            server a cinematic, browser-based client experience.
          </p>
        </div>
      </section>
    </main>
  );
}
