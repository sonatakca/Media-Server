import { lazy, Suspense, useEffect, useState } from "react";
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
} from "./lib/jellyfinApi";
import {
  checkServerAvailability,
  parseServerBootstrapProvider,
} from "./lib/serverAvailability";
import {
  bootstrapIdentity,
  parseIdentityProvider,
  type IdentityBootstrapResult,
} from "./lib/identityBootstrap";
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
import { UserManagementPage } from "./pages/UserManagementPage";
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
const CONFIGURED_SERVER_BOOTSTRAP_PROVIDER = parseServerBootstrapProvider(
  import.meta.env.VITE_SERVER_BOOTSTRAP_PROVIDER as string | undefined,
);
const IDENTITY_PROVIDER = parseIdentityProvider(
  import.meta.env.VITE_IDENTITY_PROVIDER as string | undefined,
);
const SERVER_BOOTSTRAP_PROVIDER =
  IDENTITY_PROVIDER === "native"
    ? "own-api"
    : CONFIGURED_SERVER_BOOTSTRAP_PROVIDER;

const RequireAdminAuth = lazy(async () => {
  const module = await import("./components/admin/RequireAdminAuth");

  return { default: module.RequireAdminAuth };
});

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
  requestUrl?: string,
): JellyfinServerUnavailableEventDetail {
  return {
    serverUrl,
    requestUrl:
      requestUrl ??
      (SERVER_BOOTSTRAP_PROVIDER === "own-api"
        ? "/ownAPI/v1/health"
        : buildJellyfinUrl(serverUrl, "/System/Info/Public")),
    reason: "network",
    message: getErrorMessage(error),
  };
}

function NativeIdentityFoundationGate({
  identity,
}: {
  identity: IdentityBootstrapResult;
}) {
  const message =
    identity.status === "authenticated"
      ? "Native identity session verified. The native catalogue is not available in this migration phase."
      : "Native identity is enabled, but the native sign-in and catalogue UI are not available in this migration phase.";

  return (
    <main className="flex min-h-screen items-center justify-center px-6 text-white">
      <p
        data-testid="native-identity-foundation"
        className="max-w-xl text-center"
      >
        {message}
      </p>
    </main>
  );
}

export function DefaultServerGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [shouldCheckDefaultServer] = useState(
    () =>
      IDENTITY_PROVIDER === "native" ||
      SERVER_BOOTSTRAP_PROVIDER === "own-api" ||
      !getServerUrl(),
  );
  const [state, setState] = useState<DefaultServerState>(() =>
    shouldCheckDefaultServer ? "checking" : "ready",
  );
  const [renderSpinner, setRenderSpinner] = useState(shouldCheckDefaultServer);
  const [isVisible, setIsVisible] = useState(false);
  const [connectionFailure, setConnectionFailure] =
    useState<JellyfinServerUnavailableEventDetail | null>(null);
  const [nativeIdentity, setNativeIdentity] =
    useState<IdentityBootstrapResult | null>(null);

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
    if (!shouldCheckDefaultServer) return;

    let isMounted = true;

    async function prepareDefaultServer() {
      const savedServerUrl = getServerUrl();
      const serverUrl = savedServerUrl ?? DEFAULT_SERVER_URL;
      let requestUrl =
        SERVER_BOOTSTRAP_PROVIDER === "own-api"
          ? "/ownAPI/v1/health"
          : buildJellyfinUrl(serverUrl, "/System/Info/Public");

      try {
        await withTimeout(
          checkServerAvailability({
            provider: SERVER_BOOTSTRAP_PROVIDER,
            serverUrl,
          }),
          DEFAULT_SERVER_CHECK_TIMEOUT_MS,
        );
        requestUrl = "/ownAPI/v1/auth/me";
        const identity = await withTimeout(
          bootstrapIdentity({ provider: IDENTITY_PROVIDER }),
          DEFAULT_SERVER_CHECK_TIMEOUT_MS,
        );

        if (!savedServerUrl && IDENTITY_PROVIDER !== "native") {
          setServerUrl(DEFAULT_SERVER_URL);
        }

        if (isMounted) {
          setNativeIdentity(identity);
          setState("ready");
        }
      } catch (error) {
        console.warn("[Seyirlik] Bootstrap server connection failed", error);

        if (isMounted) {
          setConnectionFailure(
            createConnectionFailureDetail(serverUrl, error, requestUrl),
          );
          setState(
            IDENTITY_PROVIDER === "native" || !savedServerUrl
              ? "failed"
              : "ready",
          );
        }
      }
    }

    void prepareDefaultServer();

    return () => {
      isMounted = false;
    };
  }, [shouldCheckDefaultServer]);

  useEffect(() => {
    if (IDENTITY_PROVIDER === "native") return;

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

  const testConfiguredConnection = async (serverUrl: string) => {
    await checkServerAvailability({
      provider: SERVER_BOOTSTRAP_PROVIDER,
      serverUrl,
    });
    const identity = await bootstrapIdentity({ provider: IDENTITY_PROVIDER });
    setNativeIdentity(identity);
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
        serverUrl={connectionFailure.serverUrl}
        failure={connectionFailure}
        mode={SERVER_BOOTSTRAP_PROVIDER}
        diagnoseConnection={
          SERVER_BOOTSTRAP_PROVIDER === "own-api"
            ? async (options) => {
                throw new Error(
                  options?.failure?.message ??
                    "Seyirlik's native server is unavailable.",
                );
              }
            : undefined
        }
        testConnection={testConfiguredConnection}
        onRetrySuccess={() => {
          if (!getServerUrl() && IDENTITY_PROVIDER !== "native") {
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
        mode={SERVER_BOOTSTRAP_PROVIDER}
        diagnoseConnection={
          SERVER_BOOTSTRAP_PROVIDER === "own-api"
            ? async () => {
                throw new Error("Seyirlik's native server is unavailable.");
              }
            : undefined
        }
        testConnection={testConfiguredConnection}
        onRetrySuccess={() => {
          if (IDENTITY_PROVIDER !== "native") {
            setServerUrl(DEFAULT_SERVER_URL);
          }
          setState("ready");
        }}
      />
    );
  }

  if (IDENTITY_PROVIDER === "native" && nativeIdentity) {
    return <NativeIdentityFoundationGate identity={nativeIdentity} />;
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
                  path="/dev/known-bugs"
                  element={<DevToolsBoardPage type="bugs" />}
                />
                <Route
                  path="/dev/wanted-features"
                  element={<DevToolsBoardPage type="features" />}
                />
              </Route>
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
