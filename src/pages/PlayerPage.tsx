import { lazy, Suspense } from "react";
import { useIsMobileView } from "../hooks/useIsMobileView";

const DesktopPlayerPage = lazy(() =>
  import("./desktop/DesktopPlayerPage").then((module) => ({
    default: module.DesktopPlayerPage,
  })),
);
const MobilePlayerPage = lazy(() =>
  import("./mobile/MobilePlayerPage").then((module) => ({
    default: module.MobilePlayerPage,
  })),
);

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
