import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RouteColorTransition } from "./components/RouteColorTransition";
import { RouteTransitionOutlet } from "./components/RouteTransitionOutlet";
import { ScrollToTop } from "./components/ScrollToTop";
import { getServerUrl, isAuthenticated } from "./lib/authStorage";
import { HomePage } from "./pages/HomePage";
import { ItemDetailsPage } from "./pages/ItemDetailsPage";
import { LibraryPage } from "./pages/LibraryPage";
import { LoginPage } from "./pages/LoginPage";
import { PlayerPage } from "./pages/PlayerPage";
import { ServerSetupPage } from "./pages/ServerSetupPage";

function RootRedirect() {
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
      <RouteColorTransition />
      <ScrollToTop />

      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route element={<RouteTransitionOutlet />}>
          <Route path="/server" element={<ServerSetupPage />} />
          <Route path="/login" element={<LoginPage />} />
        </Route>

        <Route element={<RequireAuth />}>
          <Route element={<Layout />}>
            <Route path="/home" element={<HomePage />} />
            <Route path="/library/:libraryId" element={<LibraryPage mode="library" />} />
            <Route path="/series/:seriesId" element={<LibraryPage mode="series" />} />
            <Route path="/series/:seriesId/season/:seasonId" element={<LibraryPage mode="season" />} />
            <Route path="/season/:seasonId" element={<LibraryPage mode="season" />} />
            <Route path="/item/:itemId" element={<ItemDetailsPage />} />
          </Route>
          <Route element={<RouteTransitionOutlet variant="player" />}>
            <Route path="/watch/:itemId" element={<PlayerPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
