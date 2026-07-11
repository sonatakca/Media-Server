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
  showEpisodeCount = false,
  hideTags = false,
}: {
  variant?: "poster" | "landscape";
  showEpisodeCount?: boolean;
  hideTags?: boolean;
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
        className={`relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.055] ${
          isLandscape ? "aspect-video" : "aspect-[2/3]"
        }`}
      >
        <div className="shimmer absolute inset-0" />

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-1/2 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

        <div
          className={`shimmer !absolute left-1/2 z-20 -translate-x-1/2 overflow-hidden rounded-lg ${
            isLandscape
              ? "bottom-12 h-10 w-1/2"
              : ` ${!hideTags ? "h-20 bottom-14" : "h-28 bottom-3"} w-11/12`
          }`}
        >
          <div className="shimmer absolute inset-0" />
        </div>
        {!hideTags && (
          <div className="absolute inset-x-4 bottom-4 z-30 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="shimmer h-5 w-14 rounded-full" />
              <div className="shimmer h-5 w-12 rounded-full" />
            </div>

            {showEpisodeCount && (
              <div className="shimmer h-5 w-16 rounded-full" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function EpisodeCardSkeleton() {
  return (
    <div className="w-72 shrink-0 sm:w-80 lg:w-96">
      <div className="shimmer aspect-video rounded-xl" />

      <div className="px-1 pt-3">
        <div className="shimmer h-5 w-4/5 rounded-md" />
        <div className="shimmer mt-2 h-4 w-2/5 rounded-md" />
      </div>
    </div>
  );
}

export function ContinueWatchingCardSkeleton() {
  return (
    <div className="w-80 shrink-0 sm:w-[24rem] lg:w-[30rem]">
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-white/[0.055]">
        <div className="shimmer absolute inset-0" />
        <div className="absolute inset-y-0 right-0 w-1/2 bg-black/20" />
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-t from-transparent via-white/30 to-transparent" />
        <div className="absolute inset-y-0 left-1/2 right-0 flex flex-col p-3 sm:p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="shimmer h-4 w-20 mt-3 rounded-md" />

            <div className="flex items-center gap-4">
              <div className="shimmer size-8 rounded-full" />
              <div className="shimmer size-8 rounded-full" />
            </div>
          </div>

          <div className="shimmer mt-4 h-5 w-full rounded-md" />
          <div className="shimmer mt-1 h-3 w-full rounded-md" />

          <div className="mt-3 space-y-1">
            <div className="shimmer h-4 w-full rounded-md" />
            <div className="shimmer h-4 w-11/12 rounded-md" />
            <div className="shimmer h-4 w-11/12 rounded-md" />
            <div className="shimmer h-4 w-4/5 rounded-md" />
          </div>

          <div className="mt-auto flex items-center gap-2 pb-1">
            <div className="shimmer h-4 w-12 rounded-full" />
            <div className="shimmer h-4 w-14 rounded-full" />
          </div>
        </div>

        {/* Playback progress */}
        <div className="absolute inset-x-0 bottom-0 h-[0.2rem] bg-[#555556]">
          <div className="h-full w-2/5 rounded-r-full bg-white/30" />
        </div>
      </div>
    </div>
  );
}

function SkeletonRow({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="py-6">
      <div className="flex items-end justify-between gap-4">
        <h2 className="text-xl font-black text-white sm:text-2xl">
          <AnimatedWidth value={title}>
            <AnimatedText value={title} />
          </AnimatedWidth>
        </h2>
      </div>

      <div className="media-scroll flex snap-x gap-5 overflow-x-auto overflow-y-visible pb-8 pt-6">
        {children}
      </div>
    </section>
  );
}

export function MediaRowSkeleton({ title }: { title: string }) {
  return (
    <SkeletonRow title={title}>
      {Array.from({ length: 7 }, (_, index) => (
        <MediaCardSkeleton key={index} />
      ))}
    </SkeletonRow>
  );
}

export function ShowRowSkeleton({ title }: { title: string }) {
  return (
    <SkeletonRow title={title}>
      {Array.from({ length: 7 }, (_, index) => (
        <MediaCardSkeleton key={index} showEpisodeCount />
      ))}
    </SkeletonRow>
  );
}

export function BookRowSkeleton({ title }: { title: string }) {
  return (
    <SkeletonRow title={title}>
      {Array.from({ length: 7 }, (_, index) => (
        <MediaCardSkeleton key={index} hideTags />
      ))}
    </SkeletonRow>
  );
}

export function EpisodeRowSkeleton({ title }: { title: string }) {
  return (
    <SkeletonRow title={title}>
      {Array.from({ length: 6 }, (_, index) => (
        <EpisodeCardSkeleton key={index} />
      ))}
    </SkeletonRow>
  );
}

export function ContinueWatchingRowSkeleton({ title }: { title: string }) {
  return (
    <SkeletonRow title={title}>
      {Array.from({ length: 5 }, (_, index) => (
        <ContinueWatchingCardSkeleton key={index} />
      ))}
    </SkeletonRow>
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

          <div className="relative z-20 mx-auto flex min-h-[100svh] w-full max-w-[1600px] flex-col justify-end px-4 pb-[clamp(2rem,6vh,4rem)] pt-28 sm:px-6 lg:px-8">
            <div className="max-w-3xl">
              <div className="shimmer h-32 w-[min(45rem,72vw)] rounded-lg sm:h-40 lg:h-60" />
              <div className="flex gap-1 mt-2 max-w-2xl origin-left text-xs font-semibold leading-5 tracking-[0.01em] text-white/[0.84] drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] sm:mt-3 sm:text-sm sm:leading-6">
                <div className="shimmer mt-2 h-5 w-[10%] max-w-2xl rounded-md" />
                .
                <div className="shimmer mt-2 h-5 w-[15%] max-w-2xl rounded-md" />
                .
                <div className="shimmer mt-2 h-5 w-[12.5%] max-w-2xl rounded-md" />
              </div>
              <div className="mt-10 space-y-2">
                <div className="shimmer h-5 w-10/12 max-w-2xl rounded-md" />
                <div className="shimmer h-5 w-full max-w-2xl rounded-md" />
                <div className="shimmer h-5 w-full max-w-xl rounded-md" />
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                <div className="shimmer h-8 w-20 rounded-full" />
                <div className="shimmer h-8 w-24 rounded-full" />
                <div className="shimmer h-8 w-20 rounded-full" />
              </div>

              <div className="mt-5 flex gap-3">
                <div className="shimmer h-16 w-48 rounded-xl" />
                <div className="shimmer h-16 w-48 rounded-xl" />
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="mx-auto w-full  max-w-[1600px] px-4 sm:px-6 lg:px-8 2xl:mt-0">
        <ContinueWatchingRowSkeleton title={t("home.continueWatching")} />
        <MediaRowSkeleton title={t("home.latestAddedMovies")} />
        <ShowRowSkeleton title={t("home.latestAddedShows")} />
        <BookRowSkeleton title={t("home.latestAddedBooks")} />
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
