import { NotificationHistoryButton } from "../notifications/NotificationHistoryButton";
import { useEffect, useRef, useState } from "react";
import { LogOut, Palette, Search, ShieldCheck, UserRound } from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import { clearAuthSession, getCachedSession } from "../../lib/authStorage";
import { AnimatedText } from "../AnimatedText";
import { AnimatedWidth } from "../AnimatedWidth";
import { LanguageSwitch } from "../LanguageSwitch";
import { NavbarWordmark } from "../NavbarWordmark";
import { ROUTE_COLOR_TRANSITION_FORCE_EVENT } from "../RouteColorTransition";
import { openSearchOverlay } from "../../lib/searchModel";
import { SlidingIndicator } from "../ui/SlidingIndicator";
import { Tooltip } from "../ui/Tooltip";

// Only affects which modifier the shortcut hint spells out, so a userAgent
// sniff is enough and never blocks the shortcut itself.
const isMacPlatform =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

export function DesktopNavbar() {
  const navigate = useNavigate();
  const session = getCachedSession();
  const { t } = useLanguage();
  const [hasScrolled, setHasScrolled] = useState(false);
  const libraryRoutes = {
    movies: "/movies",
    series: "/shows",
    collections: "/collections",
    books: "/books",
  };
  const location = useLocation();
  const navLinksRef = useRef<HTMLDivElement | null>(null);
  const navLinks = [
    { to: "/home", label: t("nav.home") },
    { to: libraryRoutes.movies, label: t("nav.movies") },
    { to: libraryRoutes.series, label: t("nav.series") },
    { to: libraryRoutes.books, label: t("nav.books") },
    { to: "/my-list", label: t("myList.title") },
    // Only where the bar has room: at the narrowest desktop widths a sixth
    // link runs into the icons. The mobile menu always carries it.
    {
      to: libraryRoutes.collections,
      label: t("nav.collections"),
      className: "hidden min-[1120px]:inline",
    },
  ];
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
          ? "duration-700 border-b border-white/[0.08] bg-black/75 shadow-navbar-glass backdrop-blur-2xl"
          : "duration-500 border-b border-transparent bg-transparent shadow-none backdrop-blur-0"
      }`}
    >
      <nav className="mx-auto flex h-16 w-full max-w-[1600px] items-center gap-3 px-4 sm:h-20 sm:gap-8 sm:px-6 lg:px-8">
        <Link
          to="/home"
          className="flex min-w-0 shrink-0 items-center"
          aria-label={t("nav.brandHome")}
        >
          <span className="flex h-10 shrink-0 items-center sm:h-12">
            <NavbarWordmark className="h-8 sm:h-11" />
          </span>
        </Link>

        <div
          ref={navLinksRef}
          className="relative hidden min-w-0 flex-1 items-center gap-7 md:flex"
        >
          {navLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                `text-sm font-semibold transition-colors duration-200 ${
                  isActive ? "text-white" : "text-white/72 hover:text-white"
                } ${"className" in link ? link.className : ""}`
              }
            >
              <AnimatedWidth value={link.label}>
                {/* What the underline measures: the text itself. The
                    AnimatedWidth frame around it is a few pixels wider on
                    the right, so centring on the link was centring off it. */}
                <span data-nav-label>
                  <AnimatedText value={link.label} />
                </span>
              </AnimatedWidth>
            </NavLink>
          ))}

          {/* Travels between links so a route change reads as a move along
              the bar, not a highlight that blinks out and back in. White, not
              the accent: "you are here" is never a signal colour. */}
          <SlidingIndicator
            containerRef={navLinksRef}
            activeSelector='a[aria-current="page"] [data-nav-label]'
            measureKey={location.pathname}
          >
            <span className="absolute -bottom-2 left-1/2 h-[2px] w-[calc(100%+0.25rem)] -translate-x-1/2 rounded-full bg-white/90 shadow-[0_0_12px_rgba(255,255,255,0.35)]" />
          </SlidingIndicator>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-3">
          <Tooltip
            content={t("search.open")}
            shortcut={isMacPlatform ? "⌘K" : "Ctrl K"}
          >
            <button
              type="button"
              onClick={openSearchOverlay}
              aria-label={t("search.open")}
              className="inline-flex min-h-9 w-9 items-center justify-center rounded-full text-white/72 transition-[background-color,color,box-shadow,transform] duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black sm:min-h-10 sm:w-10"
            >
              <Search size={18} className="shrink-0" />
            </button>
          </Tooltip>

          <LanguageSwitch />

          <NotificationHistoryButton />
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

          {session?.isAdministrator ? (
            /*
             * The way in. Administration was reachable only by clicking the
             * user name five times, which is a fine easter egg and was the
             * only door — so every tool behind it may as well not have
             * existed. The easter egg stays; this is the door.
             */
            <Tooltip content={t("admin.entry")}>
              <Link
                to="/admin"
                aria-label={t("admin.entry")}
                className="inline-flex min-h-9 w-9 items-center justify-center rounded-full text-white/72 transition-[background-color,color,box-shadow,transform] duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black sm:min-h-10 sm:w-10"
              >
                <ShieldCheck size={17} className="shrink-0" />
              </Link>
            </Tooltip>
          ) : null}

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
