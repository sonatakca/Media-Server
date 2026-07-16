import { lazy, Suspense } from "react";
import {
  LibrarySkeleton,
  MovieLibrarySkeleton,
  ShowLibrarySkeleton,
} from "../components/Skeletons";
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

function LibraryPageLoading({
  isMobile,
  mode,
  libraryRouteKind,
}: LibraryPageProps & { isMobile: boolean }) {
  if (libraryRouteKind === "movie") {
    return <MovieLibrarySkeleton mobile={isMobile} />;
  }

  if (libraryRouteKind === "show" || mode === "series" || mode === "season") {
    return <ShowLibrarySkeleton mobile={isMobile} />;
  }

  return <LibrarySkeleton />;
}

export function LibraryPage(props: LibraryPageProps) {
  const isMobile = useIsMobileView();

  if (isMobile) {
    return (
      <Suspense fallback={<LibraryPageLoading {...props} isMobile />}>
        <MobileLibraryPage {...props} />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<LibraryPageLoading {...props} isMobile={false} />}>
      <DesktopLibraryPage {...props} />
    </Suspense>
  );
}
