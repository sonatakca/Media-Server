import { useEffect, useRef, useState } from "react";
import { LogOut, Palette, ShieldCheck, UserRound } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useLanguage } from "../i18n/LanguageContext";
import { clearAuthSession, getCachedSession } from "../lib/authStorage";
import { ROUTE_COLOR_TRANSITION_FORCE_EVENT } from "./RouteColorTransition";

const ITEM =
  "flex w-full items-center gap-3 rounded-full px-3 py-2 text-left text-sm font-bold text-white/72 transition-[background-color,color] duration-150 ease-out hover:bg-white/[0.09] hover:text-white focus-visible:bg-white/[0.09] focus-visible:text-white focus-visible:outline-none";

interface AccountMenuProps {
  variant?: "desktop" | "mobile";
  /** Called on every press of the trigger, before the menu toggles. */
  onTriggerClick?: () => void;
}

/**
 * Theme, administration and logout behind the account name. They were three
 * unlabelled icons in the bar, and logout was one stray tap from any page.
 */
export function AccountMenu({
  variant = "desktop",
  onTriggerClick,
}: AccountMenuProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const session = getCachedSession();
  const { t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // The page the menu was opened on; navigating anywhere else closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  // Forget it as soon as the page changes. Merely not matching hid the menu
  // without closing it, so coming back to that page reopened it unasked.
  if (openOn !== null && openOn !== location.pathname) {
    setOpenOn(null);
  }
  const isOpen = openOn === location.pathname;
  const setIsOpen = (open: boolean) =>
    setOpenOn(open ? location.pathname : null);
  const isDesktop = variant === "desktop";

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus({ preventScroll: true });

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setOpenOn(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenOn(null);
        triggerRef.current?.focus();
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }

      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
          [],
      );
      const index = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : -1;

      event.preventDefault();
      items[(index + step + items.length) % items.length]?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  if (!session) {
    return null;
  }

  const handleThemeChange = () => {
    setIsOpen(false);
    window.dispatchEvent(new Event(ROUTE_COLOR_TRANSITION_FORCE_EVENT));
  };

  const handleLogout = () => {
    clearAuthSession();
    navigate("/login", { replace: true });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`${t("nav.account")}: ${session.username}`}
        onClick={() => {
          onTriggerClick?.();
          setIsOpen(!isOpen);
        }}
        className={
          isDesktop
            ? "inline-flex min-h-9 max-w-40 items-center justify-center gap-2 rounded-full px-2.5 text-sm font-semibold text-white/72 transition-[background-color,color] duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-black sm:min-h-10 lg:px-3 [-webkit-tap-highlight-color:transparent]"
            : "inline-flex h-9 w-9 items-center justify-center rounded-full text-white/72 transition hover:bg-white/10 hover:text-white"
        }
      >
        <UserRound size={isDesktop ? 17 : 18} className="shrink-0" />
        {isDesktop ? (
          <span className="hidden min-w-0 truncate lg:inline">
            {session.username}
          </span>
        ) : null}
      </button>

      <AnimatePresence>
        {isOpen ? (
          // Unfolds from the corner it hangs off, like the season picker.
          <motion.div
            ref={menuRef}
            key="account-menu"
            initial={
              shouldReduceMotion
                ? { opacity: 0 }
                : { opacity: 0, y: -6, scale: 0.94 }
            }
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
              transition: { type: "spring", bounce: 0, duration: 0.32 },
            }}
            exit={{
              opacity: 0,
              y: shouldReduceMotion ? 0 : -4,
              scale: shouldReduceMotion ? 1 : 0.97,
              transition: { duration: 0.12, ease: [0.4, 0, 1, 1] },
            }}
            style={{ transformOrigin: "100% 0%" }}
            role="menu"
            aria-label={t("nav.account")}
            className="absolute right-0 top-full z-[70] mt-2 w-max min-w-[12rem] rounded-2xl border border-white/10 bg-[#171719]/95 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.055),inset_0_-1px_0_rgba(0,0,0,0.28),0_10px_35px_rgba(0,0,0,0.28)] backdrop-blur-2xl"
          >
            <p className="truncate px-3 pb-2 pt-1.5 text-xs font-semibold text-white/50">
              {session.username}
            </p>
            <button
              type="button"
              role="menuitem"
              onClick={handleThemeChange}
              className={ITEM}
            >
              <Palette size={16} className="shrink-0" />
              {t("nav.changeTheme")}
            </button>
            {session.isAdministrator ? (
              <Link to="/admin" role="menuitem" className={ITEM}>
                <ShieldCheck size={16} className="shrink-0" />
                {t("admin.entry")}
              </Link>
            ) : null}
            <div aria-hidden="true" className="mx-3 my-1 h-px bg-white/10" />
            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
              className={ITEM}
            >
              <LogOut size={16} className="shrink-0" />
              {t("nav.logout")}
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
