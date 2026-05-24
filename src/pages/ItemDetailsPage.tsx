import { lazy, Suspense } from "react";
import { useIsMobileView } from "../hooks/useIsMobileView";

const DesktopItemDetailsPage = lazy(() =>
  import("./desktop/DesktopItemDetailsPage").then((module) => ({
    default: module.DesktopItemDetailsPage,
  })),
);
const MobileItemDetailsPage = lazy(() =>
  import("./mobile/MobileItemDetailsPage").then((module) => ({
    default: module.MobileItemDetailsPage,
  })),
);

function DetailsPageLoading() {
  return (
    <div className="layout-no-offset min-h-screen">
      <div className="shimmer full-bleed h-[28rem]" />
    </div>
  );
}

export function ItemDetailsPage() {
  const isMobile = useIsMobileView();

  if (isMobile) {
    return (
      <Suspense fallback={<DetailsPageLoading />}>
        <MobileItemDetailsPage />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<DetailsPageLoading />}>
      <DesktopItemDetailsPage />
    </Suspense>
  );
}
