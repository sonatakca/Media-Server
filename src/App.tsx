import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { LoadingSpinner } from "./components/LoadingSpinner";
import { RouteColorTransition } from "./components/RouteColorTransition";
import { RouteTransitionOutlet } from "./components/RouteTransitionOutlet";
import { NonPlayerHistoryTracker } from "./components/BackButton";
import { ScrollToTop } from "./components/ScrollToTop";
import { useLanguage } from "./i18n/LanguageContext";
import { getServerUrl, isAuthenticated, setServerUrl } from "./lib/authStorage";
import { testServerConnection } from "./lib/jellyfinApi";
import { HomePage } from "./pages/HomePage";
import { ItemDetailsPage } from "./pages/ItemDetailsPage";
import { LibraryPage } from "./pages/LibraryPage";
import { LoginPage } from "./pages/LoginPage";
import { PlayerPage } from "./pages/PlayerPage";
import { PlaybackAuditPage } from "./pages/PlaybackAuditPage";
import { DevToolsPage } from "./pages/DevToolsPage";
import { DevToolsBoardPage } from "./pages/DevToolsBoardPage";
import { PublicLandingPage } from "./pages/PublicLandingPage";
import { ServerSetupPage } from "./pages/ServerSetupPage";
import { LibraryMaintenancePage } from "./pages/LibraryMaintenancePage";
import { ContentExplorerPage } from "./pages/ContentExplorerPage";
import { setDefaultPageTitle, setPageTitle } from "./lib/pageTitle";

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

function DefaultServerGate({ children }: { children: React.ReactNode }) {
  const { t } = useLanguage();
  const location = useLocation();
  const [state, setState] = useState<DefaultServerState>(() => {
    return getServerUrl() ? "ready" : "checking";
  });

  useEffect(() => {
    if (state !== "checking") {
      return;
    }

    setPageTitle("Seyirlik", {
      canonicalPath: location.pathname,
      robots: "noindex, nofollow",
    });
  }, [location.pathname, state]);

  useEffect(() => {
    let isMounted = true;

    async function prepareDefaultServer() {
      if (getServerUrl()) {
        setState("ready");
        return;
      }

      try {
        await withTimeout(
          testServerConnection(DEFAULT_SERVER_URL),
          DEFAULT_SERVER_CHECK_TIMEOUT_MS,
        );
        setServerUrl(DEFAULT_SERVER_URL);

        if (isMounted) {
          setState("ready");
        }
      } catch (error) {
        console.warn("[Seyirlik] Default server connection failed", error);

        if (isMounted) {
          setState("failed");
        }
      }
    }

    void prepareDefaultServer();

    return () => {
      isMounted = false;
    };
  }, []);

  if (state === "checking") {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 text-white">
        <div className="text-center">
          <LoadingSpinner />
          <p className="mt-4 text-sm text-white/58">
            {t("app.connectingDefaultServer")}
          </p>
        </div>
      </main>
    );
  }

  if (state === "failed" && !getServerUrl()) {
    return <Navigate to="/server" replace />;
  }

  return <>{children}</>;
}

function RootRedirect() {
  useEffect(() => {
    setPageTitle("Seyirlik", {
      canonicalPath: "/app",
      robots: "noindex, nofollow",
    });
  }, []);

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
  const location = useLocation();

  useEffect(() => {
    if (location.pathname === "/") {
      setDefaultPageTitle(false);
    }
  }, [location.pathname]);

  return (
    <>
      <ScrollToTop />
      <NonPlayerHistoryTracker />

      <RouteColorTransition />
      <Routes>
        <Route path="/" element={<PublicLandingPage />} />

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
                path="/dev/library-maintenance"
                element={<LibraryMaintenancePage />}
              />
              <Route path="/dev/content" element={<ContentExplorerPage />} />
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
              <Route path="/item/:itemId" element={<ItemDetailsPage />} />
            </Route>
            <Route element={<RouteTransitionOutlet variant="player" />}>
              <Route path="/watch/:itemId" element={<PlayerPage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
