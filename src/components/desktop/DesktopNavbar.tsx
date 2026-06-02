import { useEffect, useRef, useState } from "react";
import { LogOut, Palette, UserRound } from "lucide-react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import logoOnSide from "../../assets/Seyirlik-Logo-OnSide-cropped.png";
import { useLanguage } from "../../i18n/LanguageContext";
import { clearAuthSession, getAuthSession } from "../../lib/authStorage";
import { getUserViews } from "../../lib/jellyfinApi";
import { AnimatedText } from "../AnimatedText";
import { AnimatedWidth } from "../AnimatedWidth";
import { LanguageSwitch } from "../LanguageSwitch";
import { ROUTE_COLOR_TRANSITION_FORCE_EVENT } from "../RouteColorTransition";
import { useStandaloneWebApp } from "../../hooks/useStandaloneWebApp";
import { Tooltip } from "../ui/Tooltip";

export function DesktopNavbar() {
  const navigate = useNavigate();
  const session = getAuthSession();
  const { t } = useLanguage();
  const isWebApp = useStandaloneWebApp();
  const [desktopLogoFailed, setDesktopLogoFailed] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [libraryRoutes, setLibraryRoutes] = useState({
    movies: "/movies",
    series: "/series",
  });
  const devClickCountRef = useRef(0);
  const devClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const updateScrolledState = () => {
      setHasScrolled(window.scrollY > 12);
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

  const handleBrandEasterEggClick = () => {
    devClickCountRef.current += 1;

    if (devClickTimerRef.current !== null) {
      window.clearTimeout(devClickTimerRef.current);
    }

    devClickTimerRef.current = window.setTimeout(() => {
      devClickCountRef.current = 0;
      devClickTimerRef.current = null;
    }, 1400);

    if (devClickCountRef.current >= 5) {
      devClickCountRef.current = 0;

      if (devClickTimerRef.current !== null) {
        window.clearTimeout(devClickTimerRef.current);
        devClickTimerRef.current = null;
      }

      navigate("/dev");
    }
  };

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 select-none pt-[env(safe-area-inset-top)] transition-[background-color,border-color,box-shadow,backdrop-filter] ease-out [-webkit-tap-highlight-color:transparent] ${
        hasScrolled
          ? "duration-700 border-b border-white/[0.08] bg-black/95 shadow-navbar-glass backdrop-blur-2xl"
          : "duration-500 border-b border-transparent bg-transparent shadow-none backdrop-blur-0"
      }`}
    >
      <nav className="mx-auto flex h-16 w-full max-w-[1600px] items-center gap-3 px-4 sm:h-20 sm:gap-8 sm:px-6 lg:px-8">
        <Link
          to="/home"
          className="flex min-w-0 shrink-0 items-center"
          aria-label={t("nav.brandHome")}
        >
          <span className="flex h-10 w-[6.25rem] shrink-0 items-center max-[360px]:w-[5.65rem] sm:h-12 sm:w-[10.5rem] lg:w-[11.5rem]">
            {!desktopLogoFailed ? (
              <img
                src={logoOnSide}
                alt="Seyirlik"
                draggable={false}
                className="h-8 w-full object-contain object-left sm:h-11"
                onError={() => setDesktopLogoFailed(true)}
              />
            ) : (
              <span className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white text-sm font-black text-zinc-950 shadow-cinematic-card">
                  S
                </span>
                <span className="text-base font-black tracking-wide text-white sm:text-lg">
                  Seyirlik
                </span>
              </span>
            )}
          </span>
        </Link>

        <div className="hidden min-w-0 flex-1 items-center gap-7 md:flex">
          <NavLink
            to="/home"
            className={({ isActive }) =>
              `text-sm font-semibold transition-colors duration-200 ${
                isActive ? "text-white" : "text-white/72 hover:text-white"
              }`
            }
          >
            <AnimatedWidth value={t("nav.home")}>
              <AnimatedText value={t("nav.home")} />
            </AnimatedWidth>
          </NavLink>

          <NavLink
            to={libraryRoutes.movies}
            className={({ isActive }) =>
              `text-sm font-semibold transition-colors duration-200 ${
                isActive ? "text-white" : "text-white/72 hover:text-white"
              }`
            }
          >
            <AnimatedWidth value={t("nav.movies")}>
              <AnimatedText value={t("nav.movies")} />
            </AnimatedWidth>
          </NavLink>

          <NavLink
            to={libraryRoutes.series}
            className={({ isActive }) =>
              `text-sm font-semibold transition-colors duration-200 ${
                isActive ? "text-white" : "text-white/72 hover:text-white"
              }`
            }
          >
            <AnimatedWidth value={t("nav.series")}>
              <AnimatedText value={t("nav.series")} />
            </AnimatedWidth>
          </NavLink>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-3">
          <LanguageSwitch />

          <Tooltip content={t("nav.changeTheme")}>
            <button
              type="button"
              onClick={handleThemeChange}
              aria-label={t("nav.changeTheme")}
              className="inline-flex min-h-9 w-9 items-center justify-center rounded-full text-white/72 transition-[background-color,color,box-shadow,transform] duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black sm:min-h-10 sm:w-10"
            >
              <Palette size={18} className="shrink-0" />
            </button>
          </Tooltip>

          {session ? (
            <>
              <div
                onClick={handleBrandEasterEggClick}
                className="hidden w-fit max-w-40 cursor-default select-none items-center gap-2 rounded-full px-3 py-2 text-sm font-semibold text-white/72 transition-colors hover:text-white lg:flex [-webkit-tap-highlight-color:transparent]"
              >
                <UserRound size={16} className="shrink-0" />
                <span className="min-w-0 truncate">{session.username}</span>
              </div>
              <Tooltip content={t("nav.logout")}>
                <button
                  type="button"
                  onClick={handleLogout}
                  aria-label={t("nav.logout")}
                  className="inline-flex min-h-9 w-9 items-center justify-center rounded-full text-white/72 transition-[background-color,color,box-shadow,transform] duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black sm:min-h-10 sm:w-10"
                >
                  <LogOut size={17} className="shrink-0" />
                </button>
              </Tooltip>
            </>
          ) : null}
        </div>
      </nav>
    </header>
  );
}
