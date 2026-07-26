import { useEffect, useState } from "react";
import { Book, Boxes, LogOut, Palette } from "lucide-react";
import { GoHomeFill } from "react-icons/go";
import { RiMovie2Fill } from "react-icons/ri";
import { TbDeviceTv } from "react-icons/tb";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import logoOnSide from "../../assets/Seyirlik-Logo-OnSide-cropped.png";
import { useLanguage } from "../../i18n/LanguageContext";
import { clearAuthSession, getAuthSession } from "../../lib/authStorage";
import { LanguageSwitch } from "../LanguageSwitch";
import { ROUTE_COLOR_TRANSITION_FORCE_EVENT } from "../RouteColorTransition";
import { Tooltip } from "../ui/Tooltip";

function ActiveTabBorder() {
  const mask =
    "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)";

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-2xl p-px"
      style={{
        background:
          "conic-gradient(from 305deg, rgb(255 255 255 / 30%) 0deg, transparent 90deg, rgb(255 255 255 / 30%) 180deg, transparent 270deg, rgb(255 255 255 / 30%) 360deg)",
        mask,
        maskComposite: "exclude",
        WebkitMask: mask,
        WebkitMaskComposite: "xor",
      }}
    />
  );
}

function ActiveTabDot() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -bottom-1.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white/75"
    />
  );
}

function getTabClassName(isActive: boolean): string {
  const colorClass = isActive ? "text-white" : "text-white/52";
  const sizeClass = isActive ? "mt-0 min-h-[3.75rem]" : "mt-1 min-h-14";

  return `relative mx-0.5 flex min-w-0 flex-1 overflow-visible flex-col items-center justify-center gap-1 rounded-2xl bg-transparent text-[0.68rem] font-bold transition-[color,height,margin] duration-200 ${colorClass} ${sizeClass}`;
}

export function MobileNavbar() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = getAuthSession();
  const { t } = useLanguage();
  const [logoFailed, setLogoFailed] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [bottomNavBlurred, setBottomNavBlurred] = useState(false);
  const libraryRoutes = {
    movies: "/movies",
    series: "/shows",
    collections: "/collections",
    books: "/books",
  };

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
    const timeoutId = window.setTimeout(() => {
      setBottomNavBlurred(true);
    }, 3000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  const handleLogout = () => {
    clearAuthSession();
    navigate("/login", { replace: true });
  };

  const handleThemeChange = () => {
    window.dispatchEvent(new Event(ROUTE_COLOR_TRANSITION_FORCE_EVENT));
  };
  const headerOverArtwork = location.pathname === "/home";
  const showHeaderSurface = hasScrolled || !headerOverArtwork;
  const headerSurfaceClass = showHeaderSurface
    ? "bg-black/75 backdrop-blur-2xl"
    : "bg-transparent";

  return (
    <>
      <header
        className={`fixed inset-x-0 top-0 z-40 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-end justify-between  px-4 pb-2 pt-[env(safe-area-inset-top)] transition-[background-color,border-color,backdrop-filter] duration-300 ${headerSurfaceClass}`}
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
              className="h-12 w-auto max-w-40 object-contain object-left"
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
          <Tooltip content={t("nav.changeTheme")}>
            <button
              type="button"
              onClick={handleThemeChange}
              aria-label={t("nav.changeTheme")}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/72 transition hover:bg-white/10 hover:text-white"
            >
              <Palette size={18} />
            </button>
          </Tooltip>
          {session ? (
            <Tooltip content={t("nav.logout")}>
              <button
                type="button"
                onClick={handleLogout}
                aria-label={t("nav.logout")}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/72 transition hover:bg-white/10 hover:text-white"
              >
                <LogOut size={18} />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </header>

      <nav
        className={`fixed inset-x-0 bottom-0 z-50 flex h-[calc(5rem+env(safe-area-inset-bottom))] items-start px-2 pt-2 pb-[env(safe-area-inset-bottom)] transition-[background-color,backdrop-filter] duration-[1000ms] landscape:hidden ${
          bottomNavBlurred
            ? "bg-black/75 backdrop-blur-2xl"
            : "bg-black backdrop-blur-none"
        }`}
      >
        <NavLink
          to="/home"
          className={({ isActive }) => getTabClassName(isActive)}
        >
          {({ isActive }) => (
            <>
              {isActive ? <ActiveTabBorder /> : null}
              {isActive ? <ActiveTabDot /> : null}
              <GoHomeFill size={30} className="relative z-10" />
              <span className="relative z-10">{t("nav.home")}</span>
            </>
          )}
        </NavLink>
        <NavLink
          to={libraryRoutes.movies}
          className={({ isActive }) => getTabClassName(isActive)}
        >
          {({ isActive }) => (
            <>
              {isActive ? <ActiveTabBorder /> : null}
              {isActive ? <ActiveTabDot /> : null}
              <RiMovie2Fill size={30} className="relative z-10" />
              <span className="relative z-10">{t("nav.movies")}</span>
            </>
          )}
        </NavLink>
        <NavLink
          to={libraryRoutes.series}
          className={({ isActive }) => getTabClassName(isActive)}
        >
          {({ isActive }) => (
            <>
              {isActive ? <ActiveTabBorder /> : null}
              {isActive ? <ActiveTabDot /> : null}
              <TbDeviceTv size={30} className="relative z-10" />
              <span className="relative z-10">{t("nav.series")}</span>
            </>
          )}
        </NavLink>

        <NavLink
          to={libraryRoutes.books}
          className={({ isActive }) => getTabClassName(isActive)}
        >
          {({ isActive }) => (
            <>
              {isActive ? <ActiveTabBorder /> : null}
              {isActive ? <ActiveTabDot /> : null}
              <Book size={30} className="relative z-10" />
              <span className="relative z-10">{t("nav.books")}</span>
            </>
          )}
        </NavLink>

        {/* <NavLink
          to={libraryRoutes.collections}
          className={({ isActive }) => getTabClassName(isActive)}
        >
          {({ isActive }) => (
            <>
              {isActive ? <ActiveTabBorder /> : null}
              <Boxes size={28} className="relative z-10" />
              <span className="relative z-10">{t("nav.collections")}</span>
            </>
          )}
        </NavLink> */}
      </nav>
    </>
  );
}
