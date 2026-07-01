import { lazy, Suspense } from "react";
import { useIsMobileView } from "../hooks/useIsMobileView";

const loadDesktopPlayerPage = () => import("./desktop/DesktopPlayerPage");
const loadMobilePlayerPage = () => import("./mobile/MobilePlayerPage");

const DesktopPlayerPage = lazy(() =>
  loadDesktopPlayerPage().then((module) => ({
    default: module.DesktopPlayerPage,
  })),
);
const MobilePlayerPage = lazy(() =>
  loadMobilePlayerPage().then((module) => ({
    default: module.MobilePlayerPage,
  })),
);

export function preloadPlayerPage(isMobile?: boolean): Promise<unknown> {
  if (isMobile === true) {
    return loadMobilePlayerPage();
  }

  if (isMobile === false) {
    return loadDesktopPlayerPage();
  }

  return Promise.all([loadDesktopPlayerPage(), loadMobilePlayerPage()]);
}

function PlayerPageLoading() {
  return <main className="min-h-screen bg-black" />;
}

export function PlayerPage() {
  const isMobile = useIsMobileView();

  if (isMobile) {
    return (
      <Suspense fallback={<PlayerPageLoading />}>
        <MobilePlayerPage />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<PlayerPageLoading />}>
      <DesktopPlayerPage />
    </Suspense>
  );
}
