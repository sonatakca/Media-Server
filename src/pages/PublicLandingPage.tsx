import { useEffect } from "react";
import { Link } from "react-router-dom";
import appIcon from "../assets/AppIcon2.png";
import logoOnSide from "../assets/Seyirlik-Logo-OnSide-cropped.png";
import {
  DEFAULT_SEO_DESCRIPTION,
  DEFAULT_SEO_TITLE,
  PUBLIC_HOME_CANONICAL_PATH,
  PUBLIC_OG_LOCALE,
  PUBLIC_SEO_LANG,
  SEO_ROBOTS,
  setSeoMetadata,
} from "../lib/seo";

const features = [
  {
    title: "Film ve dizileri keşfet",
    description:
      "Kişisel medya arşivini modern, hızlı ve görsel olarak güçlü bir arayüzle gez.",
  },
  {
    title: "Sinematik izleme deneyimi",
    description:
      "Büyük ekran hissi veren oynatıcı, yumuşak geçişler ve dikkat dağıtmayan kontroller.",
  },
  {
    title: "Oynatma tanılama",
    description:
      "Transcoding, kaynak seçimi ve oynatma detaylarını gerektiğinde açıkça gör.",
  },
  {
    title: "Jellyfin ile çalışır",
    description:
      "Medya sunucusu Jellyfin olarak kalır; Seyirlik kişisel izleme arayüzüdür.",
  },
];

export function PublicLandingPage() {
  useEffect(() => {
    setSeoMetadata({
      title: DEFAULT_SEO_TITLE,
      description: DEFAULT_SEO_DESCRIPTION,
      canonicalPath: PUBLIC_HOME_CANONICAL_PATH,
      robots: SEO_ROBOTS.index,
      lang: PUBLIC_SEO_LANG,
      ogLocale: PUBLIC_OG_LOCALE,
    });
  }, []);

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <img
        src="/seyirlik-preview.png"
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover opacity-35"
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_24%_24%,rgba(255,153,31,0.22),transparent_34%),linear-gradient(90deg,rgba(0,0,0,0.92)_0%,rgba(0,0,0,0.74)_42%,rgba(0,0,0,0.28)_100%)]" />

      <section className="relative z-10 mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-8 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between">
          <img
            src={logoOnSide}
            alt="Seyirlik"
            className="h-11 w-auto object-contain"
            draggable={false}
          />
          <Link
            to="/app"
            className="rounded-full border border-white/15 bg-white/[0.08] px-4 py-2 text-sm font-semibold text-white transition hover:border-[var(--accent)]/70 hover:bg-[var(--accent)] hover:text-black focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          >
            Uygulamayı aç
          </Link>
        </header>

        <div className="flex flex-1 items-center py-16">
          <div className="max-w-3xl">
            <div className="mb-6 flex items-center gap-3">
              <img
                src={appIcon}
                alt=""
                aria-hidden="true"
                className="h-12 w-12 rounded-2xl shadow-cinematic-card"
                draggable={false}
              />
              <p className="text-sm font-bold uppercase tracking-[0.32em] text-[var(--accent)]">
                Seyirlik
              </p>
            </div>

            <h1 className="max-w-4xl text-5xl font-black leading-[0.96] text-white sm:text-6xl lg:text-7xl">
              Kişisel Film ve Dizi İzleme Deneyimi
            </h1>
            <p className="mt-6 max-w-2xl text-lg font-medium leading-8 text-white/72 sm:text-xl">
              Seyirlik, film ve dizileri modern, sinematik ve kişisel bir
              arayüzle keşfetmek ve izlemek için geliştirilen bir medya
              deneyimi uygulamasıdır.
            </p>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-white/54">
              Jellyfin arşivin senin altyapın olarak kalır; Seyirlik bu arşivi
              daha akıcı, okunabilir ve keyifli bir web istemcisine dönüştürür.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                to="/app"
                className="rounded-full bg-[var(--accent)] px-6 py-3 text-sm font-black text-black shadow-[0_20px_70px_rgba(255,153,31,0.24)] transition hover:bg-[var(--accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black"
              >
                Giriş yap veya devam et
              </Link>
              <Link
                to="/server"
                className="rounded-full border border-white/15 bg-white/[0.06] px-6 py-3 text-sm font-bold text-white transition hover:border-white/35 hover:bg-white/[0.12] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black"
              >
                Jellyfin sunucunu bağla
              </Link>
            </div>
          </div>
        </div>

        <div className="grid gap-3 pb-8 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature) => (
            <article
              key={feature.title}
              className="rounded-lg border border-white/10 bg-black/42 p-4 backdrop-blur-xl"
            >
              <h2 className="text-sm font-black text-white">{feature.title}</h2>
              <p className="mt-2 text-sm leading-6 text-white/58">
                {feature.description}
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
