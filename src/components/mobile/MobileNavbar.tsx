import { useEffect, useState } from "react";
import { Film, Home, LogOut, Palette, Tv } from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import logoOnSide from "../../assets/Seyirlik-Logo-OnSide-cropped.png";
import { useLanguage } from "../../i18n/LanguageContext";
import { clearAuthSession, getAuthSession } from "../../lib/authStorage";
import { getUserViews } from "../../lib/jellyfinApi";
import { LanguageSwitch } from "../LanguageSwitch";
import { ROUTE_COLOR_TRANSITION_FORCE_EVENT } from "../RouteColorTransition";

function getTabClassName(isActive: boolean): string {
  const colorClass = isActive ? "text-white" : "text-white/52";
  const backgroundClass = isActive ? "bg-white/[0.08]" : "bg-transparent";

  return `relative mx-0.5 mt-1 flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl text-[0.68rem] font-bold transition-[background-color,color] ${colorClass} ${backgroundClass}`;
}

export function MobileNavbar() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = getAuthSession();
  const { t } = useLanguage();
  const [logoFailed, setLogoFailed] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [libraryRoutes, setLibraryRoutes] = useState({
    movies: "/movies",
    series: "/series",
  });

  useEffect(() => {
    const updateScrolledState = () => {
      setHasScrolled(window.scrollY > 10);
    };

    updateScrolledState();
    window.addEventListener("scroll", updateScrolledState, { passive: true });

    return () => {
      window.removeEventListener("scroll", updateScrolledState);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadLibraryRoutes = async () => {
      if (!session) {
        return;
      }

      try {
        const libraries = await getUserViews();
        const moviesLibrary = libraries.find(
          (library) => library.CollectionType === "movies",
        );
        const seriesLibrary = libraries.find(
          (library) => library.CollectionType === "tvshows",
        );

        if (!isMounted) {
          return;
        }

        setLibraryRoutes({
          movies: moviesLibrary?.Id
            ? `/library/${moviesLibrary.Id}`
            : "/movies",
          series: seriesLibrary?.Id
            ? `/library/${seriesLibrary.Id}`
            : "/series",
        });
      } catch (error) {
        console.warn(
          "[Seyirlik Navbar] Could not load Jellyfin library routes",
          error,
        );
      }
    };

    void loadLibraryRoutes();

    return () => {
      isMounted = false;
    };
  }, [session?.userId]);

  const handleLogout = () => {
    clearAuthSession();
    navigate("/login", { replace: true });
  };

  const handleThemeChange = () => {
    window.dispatchEvent(new Event(ROUTE_COLOR_TRANSITION_FORCE_EVENT));
  };
  const headerOverArtwork =
    location.pathname === "/home" || location.pathname.startsWith("/item/");
  const showHeaderSurface = hasScrolled || !headerOverArtwork;
  const headerSurfaceClass = showHeaderSurface
    ? "border-white/[0.08] bg-black/88 backdrop-blur-xl"
    : "border-transparent bg-gradient-to-b from-black/60 to-transparent";

  return (
    <>
      <header
        className={`fixed inset-x-0 top-0 z-40 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-end justify-between border-b px-4 pb-2 pt-[env(safe-area-inset-top)] transition-[background-color,border-color,backdrop-filter] duration-300 ${headerSurfaceClass}`}
      >
        <Link
          to="/home"
          aria-label={t("nav.brandHome")}
          className="flex h-10 items-center"
        >
          {!logoFailed ? (
            <img
              src={logoOnSide}
              alt="Seyirlik"
              draggable={false}
              className="h-7 w-auto max-w-28 object-contain object-left"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <span className="text-base font-black tracking-wide text-white">
              Seyirlik
            </span>
          )}
        </Link>

        <div className="flex items-center gap-1">
          <LanguageSwitch />
          {session ? (
            <button
              type="button"
              onClick={handleLogout}
              aria-label={t("nav.logout")}
              title={t("nav.logout")}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/72 transition hover:bg-white/10 hover:text-white"
            >
              <LogOut size={18} />
            </button>
          ) : null}
        </div>
      </header>

      <nav className="fixed inset-x-0 bottom-0 z-50 flex h-[calc(4.25rem+env(safe-area-inset-bottom))] items-start border-t border-white/10 bg-black/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl">
        <NavLink
          to="/home"
          className={({ isActive }) => getTabClassName(isActive)}
        >
          <Home size={20} />
          <span>{t("nav.home")}</span>
        </NavLink>
        <NavLink
          to={libraryRoutes.movies}
          className={({ isActive }) => getTabClassName(isActive)}
        >
          <Film size={20} />
          <span>{t("nav.movies")}</span>
        </NavLink>
        <NavLink
          to={libraryRoutes.series}
          className={({ isActive }) => getTabClassName(isActive)}
        >
          <Tv size={20} />
          <span>{t("nav.series")}</span>
        </NavLink>
        <button
          type="button"
          onClick={handleThemeChange}
          aria-label={t("nav.changeTheme")}
          title={t("nav.changeTheme")}
          className={getTabClassName(false)}
        >
          <Palette size={20} />
          <span>{t("nav.changeTheme")}</span>
        </button>
      </nav>
    </>
  );
}
