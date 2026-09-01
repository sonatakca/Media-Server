import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { LoadingSpinner } from "./components/LoadingSpinner";
import { RouteColorTransition } from "./components/RouteColorTransition";
import { RouteTransitionOutlet } from "./components/RouteTransitionOutlet";
import { NonPlayerHistoryTracker } from "./components/BackButton";
import { ScrollToTop } from "./components/ScrollToTop";
import { ServerConnectionErrorPage } from "./components/ServerConnectionErrorPage";
import {
  clearAuthSession,
  isAuthenticated,
  setAuthSession,
} from "./lib/authStorage";
import {
  SERVER_UNAVAILABLE_EVENT,
  type ServerUnavailableEvent,
  type ServerUnavailableEventDetail,
} from "./lib/mediaApi";
import { checkServerAvailability } from "./lib/serverAvailability";
import { bootstrapIdentity } from "./lib/identityBootstrap";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { LibraryAliasPage } from "./pages/LibraryAliasPage";
import { LoginPage } from "./pages/LoginPage";
import { PlayerPage } from "./pages/PlayerPage";
import { ReaderPage } from "./pages/ReaderPage";
import { NotificationHost } from "./components/notifications/NotificationHost";
import { useTaskNotifications } from "./hooks/useTaskNotifications";
import { setPageTitle } from "./lib/pageTitle";
import {
  PUBLIC_HOME_CANONICAL_PATH,
  SEO_ROBOTS,
  setPublicRootSeoMetadata,
} from "./lib/seo";

const DEFAULT_SERVER_CHECK_TIMEOUT_MS = 6000;

const RequireAdminAuth = lazy(async () => {
  const module = await import("./components/admin/RequireAdminAuth");

  return { default: module.RequireAdminAuth };
});

// Admin/dev pages are only reachable behind RequireAdminAuth, so they stay out
// of the initial bundle. They resolve inside the Suspense boundary that already
// wraps RequireAdminAuth.
const PlaybackAuditPage = lazy(async () => ({
  default: (await import("./pages/PlaybackAuditPage")).PlaybackAuditPage,
}));
const DevToolsPage = lazy(async () => ({
  default: (await import("./pages/DevToolsPage")).DevToolsPage,
}));
const DevToolsBoardPage = lazy(async () => ({
  default: (await import("./pages/DevToolsBoardPage")).DevToolsBoardPage,
}));
const MediaProcessingPage = lazy(async () => ({
  default: (await import("./pages/admin/MediaProcessingPage"))
    .MediaProcessingPage,
}));
const LibraryMaintenancePage = lazy(async () => ({
  default: (await import("./pages/LibraryMaintenancePage"))
    .LibraryMaintenancePage,
}));
const TmdbArtworkPage = lazy(() => import("./pages/TmdbArtworkPage"));
const MyListPage = lazy(async () => ({
  default: (await import("./pages/MyListPage")).MyListPage,
}));
const ContentExplorerPage = lazy(async () => ({
  default: (await import("./pages/ContentExplorerPage")).ContentExplorerPage,
}));
const HomeCurationPage = lazy(async () => ({
  default: (await import("./pages/HomeCurationPage")).HomeCurationPage,
}));
const PlaybackDefaultsPage = lazy(async () => ({
  default: (await import("./pages/PlaybackDefaultsPage")).PlaybackDefaultsPage,
}));
const PlaybackHealthPage = lazy(async () => ({
  default: (await import("./pages/PlaybackHealthPage")).PlaybackHealthPage,
}));
const SkeletonLabPage = lazy(async () => ({
  default: (await import("./pages/SkeletonLabPage")).SkeletonLabPage,
}));
const ServerControlPage = lazy(async () => ({
  default: (await import("./pages/ServerControlPage")).ServerControlPage,
}));
const UserManagementPage = lazy(async () => ({
  default: (await import("./pages/UserManagementPage")).UserManagementPage,
}));

type DefaultServerState = "checking" | "ready" | "failed";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`Default server check timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => {
        window.clearTimeout(timeoutId);
      });
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createConnectionFailureDetail(
  error: unknown,
  requestUrl = "/ownAPI/v1/health",
): ServerUnavailableEventDetail {
  return {
    requestUrl,
    reason: "network",
    message: getErrorMessage(error),
  };
}

export function DefaultServerGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  // Seyirlik serves its own API from this origin, so the startup check is
  // unconditional: there is no server to configure and none to skip.
  const [state, setState] = useState<DefaultServerState>("checking");
  const [renderSpinner, setRenderSpinner] = useState(true);
  const [isVisible, setIsVisible] = useState(false);
  const [connectionFailure, setConnectionFailure] =
    useState<ServerUnavailableEventDetail | null>(null);

  // Trigger fade-in after initial mount
  useEffect(() => {
    if (!renderSpinner) return;

    const timer = setTimeout(() => setIsVisible(true), 10);
    return () => clearTimeout(timer);
  }, [renderSpinner]);

  // Handle transition unmounting when state changes from "checking"
  useEffect(() => {
    if (state !== "checking") {
      setIsVisible(false);
      const timer = setTimeout(() => {
        setRenderSpinner(false);
      }, 300); // Wait for the 300ms CSS fade-out transition to complete
      return () => clearTimeout(timer);
    }
  }, [state]);

  useEffect(() => {
    if (state !== "checking") {
      return;
    }

    if (location.pathname === "/") {
      setPublicRootSeoMetadata();
      return;
    }

    setPageTitle("Seyirlik", {
      canonicalPath:
        location.pathname === "/app"
          ? PUBLIC_HOME_CANONICAL_PATH
          : location.pathname,
      robots: SEO_ROBOTS.noindex,
    });
  }, [location.pathname, state]);

  useEffect(() => {
    let isMounted = true;

    async function prepareServer() {
      let requestUrl = "/ownAPI/v1/health";

      try {
        await withTimeout(
          checkServerAvailability(),
          DEFAULT_SERVER_CHECK_TIMEOUT_MS,
        );
        requestUrl = "/ownAPI/v1/auth/me";
        const identity = await withTimeout(
          bootstrapIdentity(),
          DEFAULT_SERVER_CHECK_TIMEOUT_MS,
        );

        if (!isMounted) return;

        // The cookie is the real credential and the cache is only a hint, so
        // the server's answer wins. Reconciling here means an expired session
        // lands on the login page instead of on a home screen that 401s.
        if (identity.status === "authenticated") {
          setAuthSession({
            userId: identity.user.id,
            username: identity.user.username,
            displayName: identity.user.displayName,
            isAdministrator: identity.user.isAdministrator,
          });
        } else {
          clearAuthSession();
        }

        setState("ready");
      } catch (error) {
        console.warn("[Seyirlik] Startup server check failed", error);

        if (isMounted) {
          setConnectionFailure(
            createConnectionFailureDetail(error, requestUrl),
          );
          setState("failed");
        }
      }
    }

    void prepareServer();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    function handleServerUnavailable(event: Event) {
      const detail =
        "detail" in event ? (event as ServerUnavailableEvent).detail : null;

      console.warn("[Seyirlik] The server became temporarily unavailable.");
      setConnectionFailure(
        detail ?? {
          reason: "network",
          message: "The server became temporarily unavailable.",
        },
      );
      setState("ready");
    }

    window.addEventListener(SERVER_UNAVAILABLE_EVENT, handleServerUnavailable);

    return () => {
      window.removeEventListener(
        SERVER_UNAVAILABLE_EVENT,
        handleServerUnavailable,
      );
    };
  }, []);

  const retryConnection = async () => {
    await checkServerAvailability();
    await bootstrapIdentity();
  };

  if (renderSpinner) {
    return (
      <main
        className={`flex min-h-screen items-center justify-center px-4 text-white transition-opacity duration-300 ease-in-out ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="text-center">
          <LoadingSpinner label="" />
        </div>
      </main>
    );
  }

  if (connectionFailure) {
    return (
      <ServerConnectionErrorPage
        failure={connectionFailure}
        testConnection={retryConnection}
        onRetrySuccess={() => {
          setConnectionFailure(null);
          setState("ready");
        }}
      />
    );
  }

  if (state === "failed") {
    return (
      <ServerConnectionErrorPage
        testConnection={retryConnection}
        onRetrySuccess={() => {
          setState("ready");
        }}
      />
    );
  }

  return <>{children}</>;
}

function RootRedirect() {
  const location = useLocation();

  useEffect(() => {
    if (location.pathname === "/") {
      setPublicRootSeoMetadata();
      return;
    }

    setPageTitle("Seyirlik", {
      canonicalPath:
        location.pathname === "/app"
          ? PUBLIC_HOME_CANONICAL_PATH
          : location.pathname,
      robots: SEO_ROBOTS.noindex,
    });
  }, [location.pathname]);

  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  return <Navigate to="/home" replace />;
}

function RequireAuth() {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

export default function App() {
  // Background work is only reported to somebody who is signed in: the task
  // list is an admin surface, and polling it from the login screen would be a
  // guaranteed 401 every fifteen seconds.
  useTaskNotifications(isAuthenticated());

  return (
    <>
      <ScrollToTop />
      <NonPlayerHistoryTracker />
      <NotificationHost />

      <RouteColorTransition />
      <Routes>
        <Route element={<RouteTransitionOutlet />}>
          <Route path="/login" element={<LoginPage />} />
        </Route>

        <Route
          element={
            <DefaultServerGate>
              <Outlet />
            </DefaultServerGate>
          }
        >
          <Route path="/" element={<RootRedirect />} />
          <Route path="/app" element={<RootRedirect />} />

          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route path="/home" element={<HomePage />} />
              <Route
                element={
                  <Suspense
                    fallback={
                      <main className="flex min-h-[calc(100dvh-8rem)] items-center justify-center">
                        <LoadingSpinner label="" />
                      </main>
                    }
                  >
                    <RequireAdminAuth />
                  </Suspense>
                }
              >
                <Route path="/dev" element={<DevToolsPage />} />
                <Route
                  path="/dev/playback-audit"
                  element={<PlaybackAuditPage />}
                />
                <Route
                  path="/dev/playback-health"
                  element={<PlaybackHealthPage />}
                />
                <Route
                  path="/dev/media-processing"
                  element={<MediaProcessingPage />}
                />
                <Route
                  path="/dev/library-maintenance"
                  element={<LibraryMaintenancePage />}
                />
                <Route path="/dev/tmdb-artwork" element={<TmdbArtworkPage />} />
                <Route path="/dev/content" element={<ContentExplorerPage />} />
                <Route path="/dev/users" element={<UserManagementPage />} />
                <Route
                  path="/dev/home-curation"
                  element={<HomeCurationPage />}
                />
                {import.meta.env.DEV ? (
                  <Route
                    path="/dev/skeleton-lab"
                    element={<SkeletonLabPage />}
                  />
                ) : null}
                <Route
                  path="/dev/playback-defaults"
                  element={<PlaybackDefaultsPage />}
                />
                <Route
                  path="/dev/server-control"
                  element={<ServerControlPage />}
                />
                <Route
                  path="/dev/known-bugs"
                  element={<DevToolsBoardPage type="bugs" />}
                />
                <Route
                  path="/dev/wanted-features"
                  element={<DevToolsBoardPage type="features" />}
                />
              </Route>
              <Route
                path="/my-list"
                element={
                  <Suspense fallback={<LoadingSpinner label="" />}>
                    <MyListPage />
                  </Suspense>
                }
              />
              <Route
                path="/library/:libraryId"
                element={<LibraryPage mode="library" />}
              />
              <Route
                path="/movies"
                element={<LibraryAliasPage slug="movies" />}
              />
              <Route
                path="/shows"
                element={<LibraryAliasPage slug="shows" />}
              />
              <Route
                path="/books"
                element={<LibraryAliasPage slug="books" />}
              />
              <Route
                path="/collections"
                element={<LibraryAliasPage slug="collections" />}
              />
              <Route
                path="/movies/:libraryId"
                element={
                  <LibraryPage mode="library" libraryRouteKind="movie" />
                }
              />
              <Route
                path="/shows/:seriesId"
                element={<LibraryPage mode="series" libraryRouteKind="show" />}
              />
              <Route
                path="/shows/:seriesId/season/:seasonId"
                element={<LibraryPage mode="season" libraryRouteKind="show" />}
              />
              <Route
                path="/shows/season/:seasonId"
                element={<LibraryPage mode="season" libraryRouteKind="show" />}
              />
              <Route
                path="/collections/:libraryId"
                element={
                  <LibraryPage mode="library" libraryRouteKind="collection" />
                }
              />
              <Route
                path="/series/:seriesId"
                element={<LibraryPage mode="series" />}
              />
              <Route
                path="/series/:seriesId/season/:seasonId"
                element={<LibraryPage mode="season" />}
              />
              <Route
                path="/season/:seasonId"
                element={<LibraryPage mode="season" />}
              />
            </Route>
            <Route element={<RouteTransitionOutlet variant="player" />}>
              <Route path="/watch/:itemId" element={<PlayerPage />} />
              <Route path="/read/:itemId" element={<ReaderPage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
