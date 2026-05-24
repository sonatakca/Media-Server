import { lazy, Suspense } from "react";
import { useIsMobileView } from "../hooks/useIsMobileView";

const DesktopHomePage = lazy(() =>
  import("./desktop/DesktopHomePage").then((module) => ({
    default: module.DesktopHomePage,
  })),
);
const MobileHomePage = lazy(() =>
  import("./mobile/MobileHomePage").then((module) => ({
    default: module.MobileHomePage,
  })),
);

function HomePageLoading() {
  return (
    <div className="layout-no-offset min-h-screen">
      <div className="shimmer full-bleed h-[min(62svh,31rem)] min-h-[27rem]" />
    </div>
  );
}

export function HomePage() {
  const isMobile = useIsMobileView();

  if (isMobile) {
    return (
      <Suspense fallback={<HomePageLoading />}>
        <MobileHomePage />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<HomePageLoading />}>
      <DesktopHomePage />
    </Suspense>
  );
}
