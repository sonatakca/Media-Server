import { lazy, Suspense } from "react";
import { useIsMobileView } from "../hooks/useIsMobileView";
import type { LibraryPageProps } from "./libraryPageTypes";

const DesktopLibraryPage = lazy(() =>
  import("./desktop/DesktopLibraryPage").then((module) => ({
    default: module.DesktopLibraryPage,
  })),
);
const MobileLibraryPage = lazy(() =>
  import("./mobile/MobileLibraryPage").then((module) => ({
    default: module.MobileLibraryPage,
  })),
);

function LibraryPageLoading() {
  return <div className="shimmer h-72 rounded-2xl" />;
}

export function LibraryPage(props: LibraryPageProps) {
  const isMobile = useIsMobileView();

  if (isMobile) {
    return (
      <Suspense fallback={<LibraryPageLoading />}>
        <MobileLibraryPage {...props} />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<LibraryPageLoading />}>
      <DesktopLibraryPage {...props} />
    </Suspense>
  );
}
