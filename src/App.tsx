import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { LoadingSpinner } from "./components/LoadingSpinner";
import { RouteColorTransition } from "./components/RouteColorTransition";
import { RouteTransitionOutlet } from "./components/RouteTransitionOutlet";
import { NonPlayerHistoryTracker } from "./components/BackButton";
import { ScrollToTop } from "./components/ScrollToTop";
import { ServerConnectionErrorPage } from "./components/ServerConnectionErrorPage";
import { getServerUrl, isAuthenticated, setServerUrl } from "./lib/authStorage";
import {
  buildJellyfinUrl,
  JELLYFIN_SERVER_UNAVAILABLE_EVENT,
  type JellyfinServerUnavailableEvent,
  type JellyfinServerUnavailableEventDetail,
  testServerConnection,
} from "./lib/jellyfinApi";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { LibraryAliasPage } from "./pages/LibraryAliasPage";
import { LoginPage } from "./pages/LoginPage";
import { PlayerPage } from "./pages/PlayerPage";
import { ReaderPage } from "./pages/ReaderPage";
import { PlaybackAuditPage } from "./pages/PlaybackAuditPage";
import { DevToolsPage } from "./pages/DevToolsPage";
import { DevToolsBoardPage } from "./pages/DevToolsBoardPage";
import { ServerSetupPage } from "./pages/ServerSetupPage";
import { LibraryMaintenancePage } from "./pages/LibraryMaintenancePage";
import { ContentExplorerPage } from "./pages/ContentExplorerPage";
import { HomeCurationPage } from "./pages/HomeCurationPage";
import { PlaybackDefaultsPage } from "./pages/PlaybackDefaultsPage";
import { TmdbArtworkPage } from "./pages/TmdbArtworkPage";
import { PlaybackHealthPage } from "./pages/PlaybackHealthPage";
import { SkeletonLabPage } from "./pages/SkeletonLabPage";
import { setPageTitle } from "./lib/pageTitle";
import {
  PUBLIC_HOME_CANONICAL_PATH,
  SEO_ROBOTS,
  setPublicRootSeoMetadata,
} from "./lib/seo";

const DEFAULT_SERVER_URL =
  (
    import.meta.env.VITE_DEFAULT_JELLYFIN_SERVER_URL as string | undefined
  )?.trim() || "https://izle.sonatakca.com";

const DEFAULT_SERVER_CHECK_TIMEOUT_MS = 6000;

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
  serverUrl: string,
  error: unknown,
): JellyfinServerUnavailableEventDetail {
  return {
    serverUrl,
    requestUrl: buildJellyfinUrl(serverUrl, "/System/Info/Public"),
    reason: "network",
    message: getErrorMessage(error),
  };
}

function DefaultServerGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [state, setState] = useState<DefaultServerState>("checking");
  const [renderSpinner, setRenderSpinner] = useState(true);
  const [isVisible, setIsVisible] = useState(false);
  const [connectionFailure, setConnectionFailure] =
    useState<JellyfinServerUnavailableEventDetail | null>(null);

  // Trigger fade-in after initial mount
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 10);
    return () => clearTimeout(timer);
  }, []);

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

    async function prepareDefaultServer() {
      const savedServerUrl = getServerUrl();
      const serverUrl = savedServerUrl ?? DEFAULT_SERVER_URL;

      try {
        await withTimeout(
          testServerConnection(serverUrl),
          DEFAULT_SERVER_CHECK_TIMEOUT_MS,
        );

        if (!savedServerUrl) {
          setServerUrl(DEFAULT_SERVER_URL);
        }

        if (isMounted) {
          setState("ready");
        }
      } catch (error) {
        console.warn("[Seyirlik] Server connection failed", error);

        if (isMounted) {
          setConnectionFailure(createConnectionFailureDetail(serverUrl, error));
          setState(savedServerUrl ? "ready" : "failed");
        }
      }
    }

    void prepareDefaultServer();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    function handleServerUnavailable(event: Event) {
      const detail =
        "detail" in event
          ? (event as JellyfinServerUnavailableEvent).detail
          : null;

      console.warn(
        "[Seyirlik] Jellyfin server became temporarily unavailable.",
      );
      setConnectionFailure(
        detail ?? {
          serverUrl: getServerUrl() ?? DEFAULT_SERVER_URL,
          reason: "network",
          message: "Jellyfin server became temporarily unavailable.",
        },
      );
      setState("ready");
    }

    window.addEventListener(
      JELLYFIN_SERVER_UNAVAILABLE_EVENT,
      handleServerUnavailable,
    );

    return () => {
      window.removeEventListener(
        JELLYFIN_SERVER_UNAVAILABLE_EVENT,
        handleServerUnavailable,
      );
    };
  }, []);

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
        serverUrl={connectionFailure.serverUrl}
        failure={connectionFailure}
        onRetrySuccess={() => {
          if (!getServerUrl()) {
            setServerUrl(connectionFailure.serverUrl);
          }

          setConnectionFailure(null);
          setState("ready");
        }}
      />
    );
  }

  if (state === "failed" && !getServerUrl()) {
    return (
      <ServerConnectionErrorPage
        serverUrl={DEFAULT_SERVER_URL}
        onRetrySuccess={() => {
          setServerUrl(DEFAULT_SERVER_URL);
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

  if (!getServerUrl()) {
    return <Navigate to="/server" replace />;
  }

  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  return <Navigate to="/home" replace />;
}

function RequireAuth() {
  if (!getServerUrl()) {
    return <Navigate to="/server" replace />;
  }

  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

export default function App() {
  return (
    <>
      <ScrollToTop />
      <NonPlayerHistoryTracker />

      <RouteColorTransition />
      <Routes>
        <Route element={<RouteTransitionOutlet />}>
          <Route path="/server" element={<ServerSetupPage />} />
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
                path="/dev/library-maintenance"
                element={<LibraryMaintenancePage />}
              />
              <Route path="/dev/tmdb-artwork" element={<TmdbArtworkPage />} />
              <Route path="/dev/content" element={<ContentExplorerPage />} />
              <Route path="/dev/home-curation" element={<HomeCurationPage />} />
              {import.meta.env.DEV ? (
                <Route path="/dev/skeleton-lab" element={<SkeletonLabPage />} />
              ) : null}
              <Route
                path="/dev/playback-defaults"
                element={<PlaybackDefaultsPage />}
              />
              <Route
                path="/dev/known-bugs"
                element={<DevToolsBoardPage type="bugs" />}
              />
              <Route
                path="/dev/wanted-features"
                element={<DevToolsBoardPage type="features" />}
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
