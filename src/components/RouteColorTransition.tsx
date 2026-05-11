import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  ACCENT_THEMES,
  applyStoredAccentTheme,
  getStoredAccentTheme,
  saveAndApplyAccentTheme,
  type AccentTheme,
} from "../lib/accentTheme";
import logoOnSide from "../assets/Seyirlik-OnSide-noNeon.png";

export const ROUTE_COLOR_TRANSITION_FORCE_EVENT = "seyirlik:force-theme-transition";

const ROUTE_COLOR_TRANSITION_LAST_SEEN_KEY = "seyirlik.routeColorTransition.lastSeen";
const ROUTE_COLOR_TRANSITION_USED_THEMES_KEY = "seyirlik.routeColorTransition.usedThemes";

// Production:
const ROUTE_COLOR_TRANSITION_COOLDOWN_MS = 1000 * 60 * 30;
const ROUTE_COLOR_TRANSITION_REPEAT_CHANCE = 0.50;

// // Testing:
// const ROUTE_COLOR_TRANSITION_COOLDOWN_MS = 1000 * 10;
// const ROUTE_COLOR_TRANSITION_REPEAT_CHANCE = 1;

const INITIAL_BLACK_HOLD_MS = 200;

const STEP_MS = 120;
const NON_SELECTED_BLACK_DELAY_MS = 120;
const SELECTED_CENTER_SLIDE_MS = 420;
const LOGO_APPEAR_AFTER_CENTER_START_MS = 180;
const SELECTED_HOLD_MS = 420;
const SELECTED_EXIT_MS = 120;
const FINAL_BLACK_HOLD_MS = 60;
const OVERLAY_FADE_OUT_MS = 420;

type ColourBarState = {
  theme: AccentTheme;
  isVisible: boolean;
  isBlack: boolean;
  isSelectedExiting: boolean;
  isSelectedCentering: boolean;
};

function getNextAccentThemeWithoutRepeatingCycle(): AccentTheme {
  const storedUsedThemes = localStorage.getItem(ROUTE_COLOR_TRANSITION_USED_THEMES_KEY);

  let usedThemeNames: string[] = [];

  try {
    const parsedUsedThemes = storedUsedThemes ? JSON.parse(storedUsedThemes) : [];

    if (Array.isArray(parsedUsedThemes)) {
      usedThemeNames = parsedUsedThemes.filter((themeName) => typeof themeName === "string");
    }
  } catch {
    usedThemeNames = [];
  }

  const storedTheme = getStoredAccentTheme();
  const currentThemeName = document.documentElement.dataset.accentTheme || storedTheme?.name;

  const availableThemes = ACCENT_THEMES.filter(
    (theme) => !usedThemeNames.includes(theme.name) && theme.name !== currentThemeName,
  );

  const fallbackThemePool = ACCENT_THEMES.filter((theme) => theme.name !== currentThemeName);

  const themePool =
    availableThemes.length > 0
      ? availableThemes
      : fallbackThemePool.length > 0
        ? fallbackThemePool
        : ACCENT_THEMES;

  const selectedTheme = themePool[Math.floor(Math.random() * themePool.length)];

  const nextUsedThemeNames =
    availableThemes.length > 0
      ? [...usedThemeNames, selectedTheme.name]
      : [selectedTheme.name];

  localStorage.setItem(ROUTE_COLOR_TRANSITION_USED_THEMES_KEY, JSON.stringify(nextUsedThemeNames));

  return selectedTheme;
}

function getInitialBars(): ColourBarState[] {
  return ACCENT_THEMES.map((theme) => ({
    theme,
    isVisible: false,
    isBlack: true,
    isSelectedExiting: false,
    isSelectedCentering: false,
  }));
}

export function RouteColorTransition() {
  const location = useLocation();
  const timeoutsRef = useRef<number[]>([]);
  const selectedThemeRef = useRef<AccentTheme | null>(null);
  const hasMountedRef = useRef(false);
  const previousPathnameRef = useRef(location.pathname);

  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [isLogoVisible, setIsLogoVisible] = useState(false);
  const [bars, setBars] = useState<ColourBarState[]>(getInitialBars);

  const applyStoredThemeIfAvailable = useCallback(() => {
    const storedTheme = getStoredAccentTheme();

    if (storedTheme) {
      selectedThemeRef.current = storedTheme;
      applyStoredAccentTheme();
    }
  }, []);

  const clearTransitionTimers = useCallback(() => {
    timeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    timeoutsRef.current = [];
  }, []);

  const playTransition = useCallback(
    (force = false) => {
      const now = Date.now();
      const lastSeen = Number(localStorage.getItem(ROUTE_COLOR_TRANSITION_LAST_SEEN_KEY) ?? "0");
      const hasSeenBefore = lastSeen > 0;
      const isPastCooldown = now - lastSeen >= ROUTE_COLOR_TRANSITION_COOLDOWN_MS;
      const passedRandomChance = Math.random() < ROUTE_COLOR_TRANSITION_REPEAT_CHANCE;

      const shouldSkipAnimation =
        !force &&
        hasSeenBefore &&
        (!isPastCooldown || !passedRandomChance);

      if (shouldSkipAnimation) {
        applyStoredThemeIfAvailable();
        return;
      }

      localStorage.setItem(ROUTE_COLOR_TRANSITION_LAST_SEEN_KEY, String(now));

      clearTransitionTimers();

      // IMPORTANT:
      // If the animation is playing, always pick a NEW theme.
      // Do not reuse selectedThemeRef.current here.
      const finalTheme = getNextAccentThemeWithoutRepeatingCycle();

      selectedThemeRef.current = finalTheme;

      const selectedIndex = ACCENT_THEMES.findIndex((theme) => theme.name === finalTheme.name);
      const safeSelectedIndex = selectedIndex >= 0 ? selectedIndex : ACCENT_THEMES.length - 1;

      saveAndApplyAccentTheme(finalTheme);

      setIsVisible(true);
      setIsLeaving(false);
      setIsLogoVisible(false);
      setBars(getInitialBars());

      ACCENT_THEMES.forEach((_theme, index) => {
        const timeoutId = window.setTimeout(() => {
          setBars((currentBars) =>
            currentBars.map((bar, barIndex) =>
              barIndex === index
                ? {
                    ...bar,
                    isVisible: true,
                    isBlack: false,
                  }
                : bar,
            ),
          );
        }, INITIAL_BLACK_HOLD_MS + index * STEP_MS);

        timeoutsRef.current.push(timeoutId);
      });

      const colourFillFinishDelay =
        INITIAL_BLACK_HOLD_MS + ACCENT_THEMES.length * STEP_MS + NON_SELECTED_BLACK_DELAY_MS;

      const selectedCenterTimeoutId = window.setTimeout(() => {
        setBars((currentBars) =>
          currentBars.map((bar, index) =>
            index === safeSelectedIndex
              ? {
                  ...bar,
                  isSelectedCentering: true,
                }
              : bar,
          ),
        );
      }, colourFillFinishDelay);

      const logoVisibleTimeoutId = window.setTimeout(() => {
        setIsLogoVisible(true);
      }, colourFillFinishDelay + LOGO_APPEAR_AFTER_CENTER_START_MS);

      const nonSelectedBlackTimeoutId = window.setTimeout(() => {
        setBars((currentBars) =>
          currentBars.map((bar, index) =>
            index !== safeSelectedIndex
              ? {
                  ...bar,
                  isBlack: true,
                }
              : bar,
          ),
        );
      }, colourFillFinishDelay);

      const selectedExitTimeoutId = window.setTimeout(() => {
        setBars((currentBars) =>
          currentBars.map((bar, index) =>
            index === safeSelectedIndex
              ? {
                  ...bar,
                  isBlack: false,
                  isSelectedExiting: true,
                }
              : bar,
          ),
        );
      }, colourFillFinishDelay + SELECTED_CENTER_SLIDE_MS + SELECTED_HOLD_MS);

      const leaveTimeoutId = window.setTimeout(() => {
        setIsLeaving(true);
      }, colourFillFinishDelay + SELECTED_CENTER_SLIDE_MS + SELECTED_HOLD_MS + SELECTED_EXIT_MS + FINAL_BLACK_HOLD_MS);

      const hideTimeoutId = window.setTimeout(() => {
        setIsVisible(false);
        setIsLeaving(false);
        setIsLogoVisible(false);
      }, colourFillFinishDelay + SELECTED_CENTER_SLIDE_MS + SELECTED_HOLD_MS + SELECTED_EXIT_MS + FINAL_BLACK_HOLD_MS + OVERLAY_FADE_OUT_MS);

      timeoutsRef.current.push(
        nonSelectedBlackTimeoutId,
        selectedCenterTimeoutId,
        logoVisibleTimeoutId,
        selectedExitTimeoutId,
        leaveTimeoutId,
        hideTimeoutId,
      );
    },
    [applyStoredThemeIfAvailable, clearTransitionTimers],
  );

  useEffect(() => {
    applyStoredThemeIfAvailable();
  }, [applyStoredThemeIfAvailable]);

  useLayoutEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      previousPathnameRef.current = location.pathname;
      applyStoredThemeIfAvailable();
      return;
    }

    if (previousPathnameRef.current === location.pathname) {
      return;
    }

    previousPathnameRef.current = location.pathname;
    playTransition(false);

    return () => {
      clearTransitionTimers();
    };
  }, [location.pathname, playTransition, clearTransitionTimers, applyStoredThemeIfAvailable]);

  useEffect(() => {
    const handleForcedThemeChange = () => {
      playTransition(true);
    };

    window.addEventListener(ROUTE_COLOR_TRANSITION_FORCE_EVENT, handleForcedThemeChange);

    return () => {
      window.removeEventListener(ROUTE_COLOR_TRANSITION_FORCE_EVENT, handleForcedThemeChange);
    };
  }, [playTransition]);

  if (!isVisible) {
    return null;
  }

  const barHeight = 100 / ACCENT_THEMES.length;
  const selectedHeight = 32;

  return (
    <div
      className={`fixed inset-0 z-[9999] overflow-hidden bg-black transition-opacity duration-[420ms] ${
        isLeaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      aria-hidden="true"
    >
      {bars.map((bar, index) => {
        const normalTop = index * barHeight;
        const selectedTop = 50 - selectedHeight / 2;

        return (
          <div
            key={bar.theme.name}
            className={`absolute left-0 right-0 ${
              bar.isSelectedCentering || bar.isSelectedExiting
                ? "transition-[top,height,background-color] duration-[520ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
                : "transition-none"
            }`}
            style={{
              top: bar.isSelectedCentering ? `${selectedTop}%` : `${normalTop}%`,
              height: bar.isSelectedCentering ? `${selectedHeight}%` : `${barHeight}%`,
              backgroundColor: bar.isVisible && !bar.isBlack ? bar.theme.accent : "#000000",
              transformOrigin: "center center",
              zIndex: bar.isSelectedCentering || bar.isSelectedExiting ? 5 : 1,
            }}
          />
        );
      })}

      <div
        className={`absolute inset-0 z-10 flex items-center justify-center transition-[opacity,transform] duration-[650ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
          isLogoVisible ? "scale-100 opacity-100" : "scale-90 opacity-0"
        }`}
      >
        <img
          src={logoOnSide}
          alt=""
          className="h-auto w-auto max-w-[78vw] md:h-60 md:max-w-none"
        />
      </div>
    </div>
  );
}
