import { useLanguage } from "../i18n/LanguageContext";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";

export function BackButtonSkeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`shimmer h-10 w-[5.25rem] rounded-full ${className}`} />
  );
}

export function MediaCardSkeleton({
  variant = "poster",
}: {
  variant?: "poster" | "landscape";
}) {
  const isLandscape = variant === "landscape";

  return (
    <div
      className={
        isLandscape
          ? "w-72 shrink-0 sm:w-80 lg:w-96"
          : "w-44 shrink-0 sm:w-52 lg:w-60"
      }
    >
      <div
        className={`shimmer rounded-xl ${isLandscape ? "aspect-video" : "aspect-[2/3]"}`}
      />

      <div className="flex min-h-[5.9rem] flex-col p-3.5">
        <div className="flex flex-1 items-center">
          <div className="shimmer mx-auto h-12 w-4/5 rounded-lg" />
        </div>

        <div className="mt-auto pt-3">
          <div className="shimmer h-5 w-4/5 rounded-full" />
          <div className="shimmer mt-1 h-4 w-1/2 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export function MediaRowSkeleton({ title }: { title: string }) {
  return (
    <section className="py-6">
      <div className="mb-0 flex items-end justify-between gap-4">
        <h2 className="text-xl font-black text-white sm:text-2xl">
          <AnimatedWidth value={title}>
            <AnimatedText value={title} />
          </AnimatedWidth>
        </h2>
      </div>

      <div className="media-scroll flex snap-x gap-5 overflow-x-auto overflow-y-visible pb-8 pt-6">
        {Array.from({ length: 7 }, (_, index) => (
          <MediaCardSkeleton key={index} />
        ))}
      </div>
    </section>
  );
}

export function HomeSkeleton() {
  const { t } = useLanguage();

  return (
    <div className="layout-no-offset">
      <div className="min-h-[100svh] full-bleed">
        <section className="relative min-h-[100svh] w-full overflow-hidden bg-zinc-950">
          <div className="shimmer absolute inset-0" />
          <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/[0.55] to-black/20" />
          <div className="absolute inset-0 bg-gradient-to-t from-[var(--background)] via-black/10 to-black/[0.24]" />
          <div className="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-[var(--background)] to-transparent" />

          <div className="relative z-20 mx-auto flex min-h-[100svh] w-full max-w-[1600px] flex-col justify-end px-4 pb-[clamp(3rem,8vh,6rem)] pt-28 sm:px-6 lg:px-8">
            <div className="max-w-3xl">
              <div className="shimmer h-32 w-[min(50rem,92vw)] rounded-2xl sm:h-40 lg:h-60" />

              <div className="mt-16 space-y-2">
                <div className="shimmer h-5 w-10/12 max-w-2xl rounded-full" />
                <div className="shimmer h-5 w-full max-w-2xl rounded-full" />
                <div className="shimmer h-5 w-full max-w-xl rounded-full" />
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                <div className="shimmer h-8 w-20 rounded-full" />
                <div className="shimmer h-8 w-28 rounded-full" />
                <div className="shimmer h-8 w-20 rounded-full" />
                <div className="shimmer h-8 w-24 rounded-full" />
              </div>

              <div className="mt-7 flex gap-3">
                <div className="shimmer h-12 w-32 rounded-xl" />
                <div className="shimmer h-12 w-32 rounded-xl" />
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="mx-auto w-full max-w-[1600px] px-4 sm:px-6 lg:px-8">
        <MediaRowSkeleton title={t("home.latestMedia")} />
        <MediaRowSkeleton title={t("home.continueWatching")} />

        <section className="group/row relative py-6">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-[var(--accent)]/82">
                <AnimatedWidth value={t("home.browse")}>
                  <AnimatedText value={t("home.browse")} />
                </AnimatedWidth>
              </p>

              <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">
                <AnimatedWidth value={t("home.libraries")}>
                  <AnimatedText value={t("home.libraries")} />
                </AnimatedWidth>
              </h2>
            </div>
          </div>

          <div className="media-scroll -mx-4 flex snap-x gap-5 overflow-x-auto px-4 pb-5 pt-1 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            {Array.from({ length: 5 }, (_, index) => (
              <div
                key={index}
                className="shimmer h-32 w-56 shrink-0 rounded-2xl border border-white/10 bg-white/[0.055] sm:w-64"
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export function DetailsSkeleton() {
  return (
    <article className="relative -mx-4 -mt-6 min-h-[calc(100vh-4rem)] overflow-hidden px-4 pb-16 pt-6 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="absolute inset-0 bg-[linear-gradient(145deg,#18181b,#050506)]" />
      <div className="absolute inset-0 bg-gradient-to-r from-black via-black/[0.78] to-black/[0.28]" />
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--background)] via-black/[0.34] to-black/40" />

      <div className="relative mx-auto max-w-[1500px]">
        <BackButtonSkeleton className="mb-10" />

        <div className="grid gap-8 md:grid-cols-[minmax(16rem,22rem)_1fr] md:items-end lg:gap-12">
          <div className="shimmer aspect-[2/3] overflow-hidden rounded-2xl border border-white/[0.12] bg-zinc-900 shadow-[0_30px_120px_rgba(0,0,0,0.64)]" />

          <div className="max-w-4xl">
            <div className="shimmer h-5 w-28 rounded-full" />
            <div className="shimmer mt-3 h-20 w-[min(42rem,92vw)] rounded-2xl sm:h-28 lg:h-32" />

            <div className="mt-5 flex flex-wrap gap-2">
              <div className="shimmer h-9 w-20 rounded-full" />
              <div className="shimmer h-9 w-20 rounded-full" />
              <div className="shimmer h-9 w-16 rounded-full" />
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <div className="shimmer h-8 w-20 rounded-full" />
              <div className="shimmer h-8 w-24 rounded-full" />
              <div className="shimmer h-8 w-28 rounded-full" />
            </div>

            <div className="mt-8">
              <div className="shimmer h-12 w-28 rounded-full" />
            </div>
          </div>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-[1.4fr_0.8fr]">
          <section className="rounded-2xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-xl sm:p-6">
            <div className="shimmer h-7 w-28 rounded-full" />
            <div className="mt-4 space-y-3">
              <div className="shimmer h-5 w-full rounded-full" />
              <div className="shimmer h-5 w-11/12 rounded-full" />
              <div className="shimmer h-5 w-4/5 rounded-full" />
            </div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-xl sm:p-6">
            <div className="shimmer h-7 w-36 rounded-full" />
            <div className="mt-4 grid gap-3">
              <div className="shimmer h-8 w-full rounded-lg" />
              <div className="shimmer h-8 w-full rounded-lg" />
              <div className="shimmer h-8 w-full rounded-lg" />
            </div>
          </section>
        </div>
      </div>
    </article>
  );
}

export function LibrarySkeleton() {
  return (
    <div>
      <section className="relative -mx-4 -mt-6 mb-8 overflow-hidden rounded-b-3xl px-4 pb-8 pt-8 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="absolute inset-0 bg-[linear-gradient(145deg,#18181b,#050506)]" />
        <div className="absolute inset-0 bg-gradient-to-t from-[var(--background)] via-black/[0.62] to-black/30" />

        <div className="relative mx-auto max-w-[1600px]">
          <BackButtonSkeleton className="mb-14" />

          <div className="max-w-4xl">
            <div className="shimmer h-5 w-32 rounded-full" />
            <div className="shimmer mt-2 h-14 w-72 rounded-xl sm:h-16 sm:w-96" />
            <div className="shimmer mt-4 h-5 w-36 rounded-full" />
          </div>
        </div>
      </section>

      <div className="mb-7 flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.055] p-3 backdrop-blur md:flex-row md:items-center md:justify-between">
        <div className="shimmer min-h-12 flex-1 rounded-xl" />
        <div className="shimmer min-h-12 w-full rounded-xl md:w-32" />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6">
        {Array.from({ length: 12 }, (_, index) => (
          <div key={index} className="w-full">
            <MediaCardSkeleton variant="poster" />
          </div>
        ))}
      </div>
    </div>
  );
}
