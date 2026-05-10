import { useState } from "react";
import { Home, LogOut, Palette, Server, UserRound } from "lucide-react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import appIcon from "../assets/AppIcon2.png";
import logoOnSide from "../assets/Seyirlik-Logo-OnSide-cropped.png";
import { useLanguage } from "../i18n/LanguageContext";
import { clearAuthSession, getAuthSession } from "../lib/authStorage";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";
import { LanguageSwitch } from "./LanguageSwitch";
import { ROUTE_COLOR_TRANSITION_FORCE_EVENT } from "./RouteColorTransition";

export function Navbar() {
  const navigate = useNavigate();
  const session = getAuthSession();
  const { t } = useLanguage();
  const [desktopLogoFailed, setDesktopLogoFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  const handleLogout = () => {
    clearAuthSession();
    navigate("/login", { replace: true });
  };

  const handleThemeChange = () => {
    window.dispatchEvent(new Event(ROUTE_COLOR_TRANSITION_FORCE_EVENT));
  };

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-black/[0.45] pt-[env(safe-area-inset-top)] shadow-[0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-2xl">
      <nav className="mx-auto flex h-16 w-full max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link to="/home" className="flex min-w-0 items-center gap-3" aria-label={t("nav.brandHome")}>
          {!iconFailed ? (
            <img src={appIcon} alt="" className="h-10 w-10 shrink-0 rounded-xl object-cover shadow-xl md:hidden" onError={() => setIconFailed(true)} />
          ) : null}
          {!desktopLogoFailed ? (
            <span className="hidden h-12 w-[10.5rem] shrink-0 items-center md:flex">
              <img
                src={logoOnSide}
                alt="Seyirlik"
                className="h-11 w-full object-contain object-left"
                onError={() => setDesktopLogoFailed(true)}
              />
            </span>
          ) : (
            <span className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white text-sm font-black text-zinc-950 shadow-xl">
                S
              </span>
              <span className="text-base font-black tracking-wide text-white sm:text-lg">Seyirlik</span>
            </span>
          )}
          {iconFailed && !desktopLogoFailed ? (
            <span className="text-base font-black tracking-wide text-white md:hidden">Seyirlik</span>
          ) : null}
        </Link>

        <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-white/[0.055] p-1 md:flex">
          <NavLink
            to="/home"
            className={({ isActive }) =>
              `inline-flex min-h-9 items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition-[width,min-width,padding,background-color,border-color,color,box-shadow,transform] duration-300 ease-out ${
                isActive ? "bg-[var(--accent)] text-black shadow-[0_10px_30px_var(--accent-soft)] hover:bg-[var(--accent-hover)]" : "text-zinc-300 hover:bg-white/10 hover:text-white"
              }`
            }
          >
            <Home size={17} className="shrink-0" />
            <AnimatedWidth value={t("nav.home")}>
              <AnimatedText value={t("nav.home")} />
            </AnimatedWidth>
          </NavLink>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <NavLink
            to="/server"
            className={({ isActive }) =>
              `inline-flex min-h-10 w-10 items-center justify-center gap-2 whitespace-nowrap rounded-full px-0 text-sm font-semibold transition-[width,padding,background-color,border-color,color,box-shadow,transform] duration-300 ease-out sm:w-auto sm:px-3 ${
                isActive ? "bg-white/[0.12] text-white" : "text-zinc-300 hover:bg-white/10 hover:text-white"
              }`
            }
          >
            <Server size={17} className="shrink-0" />
            <AnimatedWidth value={t("nav.server")} className="hidden sm:inline-block">
              <AnimatedText value={t("nav.server")} />
            </AnimatedWidth>
          </NavLink>
          <NavLink
            to="/home"
            onClick={(event) => {
              event.preventDefault();
              handleThemeChange();
            }}
            aria-label={t("nav.changeTheme")}
            title={t("nav.changeTheme")}
            className={() =>
              "inline-flex min-h-10 w-10 items-center justify-center gap-2 whitespace-nowrap rounded-full px-0 text-sm font-semibold text-zinc-300 transition-[width,padding,background-color,border-color,color,box-shadow,transform] duration-300 ease-out hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black sm:w-auto sm:px-3"
            }
          >
            <Palette size={17} className="shrink-0" />
            <AnimatedWidth value={t("nav.changeTheme")} className="hidden sm:inline-block">
              <AnimatedText value={t("nav.changeTheme")} />
            </AnimatedWidth>
          </NavLink>
          <LanguageSwitch />
          {session ? (
            <>
              <div className="hidden min-w-32 items-center gap-2 rounded-full border border-white/10 bg-white/[0.055] px-3 py-2 text-sm font-semibold text-white/[0.82] lg:flex">
                <UserRound size={16} className="shrink-0" />
                <span className="max-w-36 truncate">{session.username}</span>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex min-h-10 w-10 items-center justify-center gap-2 whitespace-nowrap rounded-full px-0 text-sm font-bold text-zinc-200 transition-[width,padding,background-color,border-color,color,box-shadow,transform] duration-300 ease-out hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black sm:w-auto sm:px-3"
              >
                <LogOut size={17} className="shrink-0" />
                <AnimatedWidth value={t("nav.logout")} className="hidden sm:inline-block">
                  <AnimatedText value={t("nav.logout")} />
                </AnimatedWidth>
              </button>
            </>
          ) : null}
        </div>
      </nav>
    </header>
  );
}
