import { useLanguage } from "../i18n/LanguageContext";

export function MediaCardSkeleton({ variant = "poster" }: { variant?: "poster" | "landscape" }) {
  return (
    <div className={variant === "landscape" ? "w-72 shrink-0 lg:w-96" : "w-44 shrink-0 sm:w-52 lg:w-60"}>
      <div className={`shimmer rounded-xl ${variant === "landscape" ? "aspect-video" : "aspect-[2/3]"}`} />
      <div className="mt-3 space-y-2">
        <div className="shimmer h-4 w-4/5 rounded-full" />
        <div className="shimmer h-3 w-1/2 rounded-full" />
      </div>
    </div>
  );
}

export function MediaRowSkeleton({ title }: { title: string }) {
  return (
    <section className="py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-black text-white sm:text-2xl">{title}</h2>
      </div>
      <div className="flex gap-5 overflow-hidden">
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
    <div className="-mt-6">
      <div className="shimmer -mx-4 h-[58svh] min-h-[28rem] rounded-b-3xl sm:-mx-6 lg:-mx-8" />
      <div className="mt-8 space-y-4">
        <MediaRowSkeleton title={t("home.continueWatching")} />
        <MediaRowSkeleton title={t("home.latestMedia")} />
      </div>
    </div>
  );
}

export function DetailsSkeleton() {
  return (
    <div className="-mx-4 -mt-6 min-h-[calc(100vh-4rem)] px-4 py-8 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="mx-auto grid max-w-[1500px] gap-8 md:grid-cols-[20rem_1fr]">
        <div className="shimmer aspect-[2/3] rounded-2xl" />
        <div className="space-y-4 pt-12">
          <div className="shimmer h-5 w-32 rounded-full" />
          <div className="shimmer h-14 w-4/5 rounded-xl" />
          <div className="shimmer h-5 w-1/2 rounded-full" />
          <div className="shimmer h-28 w-full max-w-3xl rounded-xl" />
        </div>
      </div>
    </div>
  );
}
