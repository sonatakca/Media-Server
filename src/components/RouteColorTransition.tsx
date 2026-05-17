import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { animate } from "animejs";
import { useLocation } from "react-router-dom";
import {
  ACCENT_THEMES,
  applyStoredAccentTheme,
  getStoredAccentTheme,
  saveAndApplyAccentTheme,
  type AccentTheme,
} from "../lib/accentTheme";
import AppIcon from "../assets/AppIcon.png";

export const ROUTE_COLOR_TRANSITION_FORCE_EVENT =
  "seyirlik:force-theme-transition";

const ROUTE_COLOR_TRANSITION_LAST_SEEN_KEY =
  "seyirlik.routeColorTransition.lastSeen";
const ROUTE_COLOR_TRANSITION_USED_THEMES_KEY =
  "seyirlik.routeColorTransition.usedThemes";
const ROUTE_COLOR_TRANSITION_USED_ANIMS_KEY =
  "seyirlik.routeColorTransition.usedAnims";

const ROUTE_COLOR_TRANSITION_COOLDOWN_MS = 1000 * 1;
const ROUTE_COLOR_TRANSITION_REPEAT_CHANCE = 0.5;

const INITIAL_BLACK_HOLD_MS = 200;
const STEP_MS = 120;
const NON_SELECTED_BLACK_DELAY_MS = 120;
const SELECTED_CENTER_SLIDE_MS = 420;
const LOGO_APPEAR_AFTER_CENTER_START_MS = 180;
const SELECTED_HOLD_MS = 420;
const SELECTED_EXIT_MS = 120;
const FINAL_BLACK_HOLD_MS = 60;
const OVERLAY_FADE_OUT_MS = 420;

const ANIMATION_TYPES = [
  "left-down",
  "right-down",
  "center-down",
  "left-up",
  "right-up",
  "center-up",
] as const;

type AnimationType = (typeof ANIMATION_TYPES)[number];

type ColourBarState = {
  theme: AccentTheme;
  isVisible: boolean;
  isBlack: boolean;
  isSelectedExiting: boolean;
  isSelectedCentering: boolean;
};

function getNextAccentThemeWithoutRepeatingCycle(): AccentTheme {
  const storedUsedThemes = localStorage.getItem(
    ROUTE_COLOR_TRANSITION_USED_THEMES_KEY,
  );
  let usedThemeNames: string[] = [];

  try {
    const parsedUsedThemes = storedUsedThemes
      ? JSON.parse(storedUsedThemes)
      : [];
    if (Array.isArray(parsedUsedThemes)) {
      usedThemeNames = parsedUsedThemes.filter(
        (themeName) => typeof themeName === "string",
      );
    }
  } catch {
    usedThemeNames = [];
  }

  const storedTheme = getStoredAccentTheme();
  const currentThemeName =
    document.documentElement.dataset.accentTheme || storedTheme?.name;

  const availableThemes = ACCENT_THEMES.filter(
    (theme) =>
      !usedThemeNames.includes(theme.name) && theme.name !== currentThemeName,
  );

  const fallbackThemePool = ACCENT_THEMES.filter(
    (theme) => theme.name !== currentThemeName,
  );

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

  localStorage.setItem(
    ROUTE_COLOR_TRANSITION_USED_THEMES_KEY,
    JSON.stringify(nextUsedThemeNames),
  );

  return selectedTheme;
}

function getNextAnimationTypeWithoutRepeatingCycle(): AnimationType {
  const storedUsedAnims = localStorage.getItem(
    ROUTE_COLOR_TRANSITION_USED_ANIMS_KEY,
  );
  let usedAnimNames: string[] = [];

  try {
    const parsedUsedAnims = storedUsedAnims ? JSON.parse(storedUsedAnims) : [];
    if (Array.isArray(parsedUsedAnims)) {
      usedAnimNames = parsedUsedAnims.filter(
        (animName) => typeof animName === "string",
      );
    }
  } catch {
    usedAnimNames = [];
  }

  let availableAnims = ANIMATION_TYPES.filter(
    (anim) => !usedAnimNames.includes(anim),
  );

  if (availableAnims.length === 0) {
    availableAnims = [...ANIMATION_TYPES];
    usedAnimNames = [];
  }

  const selectedAnim =
    availableAnims[Math.floor(Math.random() * availableAnims.length)];
  const nextUsedAnimNames = [...usedAnimNames, selectedAnim];

  localStorage.setItem(
    ROUTE_COLOR_TRANSITION_USED_ANIMS_KEY,
    JSON.stringify(nextUsedAnimNames),
  );

  return selectedAnim;
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
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const logoRef = useRef<HTMLDivElement | null>(null);
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);

  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [isLogoVisible, setIsLogoVisible] = useState(false);
  const [animType, setAnimType] = useState<AnimationType>("left-down");
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

  const setBarRef = useCallback(
    (element: HTMLDivElement | null, index: number) => {
      barRefs.current[index] = element;
    },
    [],
  );

  const applyNextThemeSilently = useCallback(() => {
    clearTransitionTimers();

    const finalTheme = getNextAccentThemeWithoutRepeatingCycle();

    selectedThemeRef.current = finalTheme;
    saveAndApplyAccentTheme(finalTheme);

    setIsVisible(false);
    setIsLeaving(false);
    setIsLogoVisible(false);
    setBars(getInitialBars());
  }, [clearTransitionTimers]);

  const playTransition = useCallback(
    (force = false) => {
      const now = Date.now();
      const lastSeen = Number(
        localStorage.getItem(ROUTE_COLOR_TRANSITION_LAST_SEEN_KEY) ?? "0",
      );
      const hasSeenBefore = lastSeen > 0;
      const isPastCooldown =
        now - lastSeen >= ROUTE_COLOR_TRANSITION_COOLDOWN_MS;
      const passedRandomChance =
        Math.random() < ROUTE_COLOR_TRANSITION_REPEAT_CHANCE;

      const shouldSkipAnimation =
        !force && hasSeenBefore && (!isPastCooldown || !passedRandomChance);

      if (shouldSkipAnimation) {
        applyStoredThemeIfAvailable();
        return;
      }

      localStorage.setItem(ROUTE_COLOR_TRANSITION_LAST_SEEN_KEY, String(now));
      clearTransitionTimers();

      const finalTheme = getNextAccentThemeWithoutRepeatingCycle();
      const nextAnim = getNextAnimationTypeWithoutRepeatingCycle();

      selectedThemeRef.current = finalTheme;
      setAnimType(nextAnim);

      const selectedIndex = ACCENT_THEMES.findIndex(
        (theme) => theme.name === finalTheme.name,
      );
      const safeSelectedIndex =
        selectedIndex >= 0 ? selectedIndex : ACCENT_THEMES.length - 1;

      saveAndApplyAccentTheme(finalTheme);

      setIsVisible(true);
      setIsLeaving(false);
      setIsLogoVisible(false);
      setBars(getInitialBars());

      const isUp = nextAnim.endsWith("-up");

      ACCENT_THEMES.forEach((_theme, index) => {
        const delayIndex = isUp ? ACCENT_THEMES.length - 1 - index : index;

        const timeoutId = window.setTimeout(
          () => {
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
          },
          INITIAL_BLACK_HOLD_MS + delayIndex * STEP_MS,
        );

        timeoutsRef.current.push(timeoutId);
      });

      const colourFillFinishDelay =
        INITIAL_BLACK_HOLD_MS +
        ACCENT_THEMES.length * STEP_MS +
        NON_SELECTED_BLACK_DELAY_MS;

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

      const selectedExitTimeoutId = window.setTimeout(
        () => {
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
        },
        colourFillFinishDelay + SELECTED_CENTER_SLIDE_MS + SELECTED_HOLD_MS,
      );

      const leaveTimeoutId = window.setTimeout(
        () => {
          setIsLeaving(true);
        },
        colourFillFinishDelay +
          SELECTED_CENTER_SLIDE_MS +
          SELECTED_HOLD_MS +
          SELECTED_EXIT_MS +
          FINAL_BLACK_HOLD_MS,
      );

      const hideTimeoutId = window.setTimeout(
        () => {
          setIsVisible(false);
          setIsLeaving(false);
          setIsLogoVisible(false);
        },
        colourFillFinishDelay +
          SELECTED_CENTER_SLIDE_MS +
          SELECTED_HOLD_MS +
          SELECTED_EXIT_MS +
          FINAL_BLACK_HOLD_MS +
          OVERLAY_FADE_OUT_MS,
      );

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
    applyNextThemeSilently();
  }, [applyNextThemeSilently]);

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

    // Route changed:
    // Pick and apply a new colour, but do NOT play the overlay animation.
    const finalTheme = getNextAccentThemeWithoutRepeatingCycle();
    selectedThemeRef.current = finalTheme;
    saveAndApplyAccentTheme(finalTheme);

    return () => {
      clearTransitionTimers();
    };
  }, [location.pathname, clearTransitionTimers, applyStoredThemeIfAvailable]);

  useEffect(() => {
    const handleForcedThemeChange = () => {
      playTransition(true);
    };

    window.addEventListener(
      ROUTE_COLOR_TRANSITION_FORCE_EVENT,
      handleForcedThemeChange,
    );

    return () => {
      window.removeEventListener(
        ROUTE_COLOR_TRANSITION_FORCE_EVENT,
        handleForcedThemeChange,
      );
    };
  }, [playTransition]);

  useEffect(() => {
    const overlay = overlayRef.current;

    if (!overlay) {
      return;
    }

    animate(overlay, {
      opacity: isLeaving ? 0 : 1,
      duration: isLeaving ? OVERLAY_FADE_OUT_MS : 160,
      ease: isLeaving ? "inOut(2)" : "out(2)",
    });
  }, [isLeaving, isVisible]);

  useEffect(() => {
    const logo = logoRef.current;

    if (!logo) {
      return;
    }

    animate(logo, {
      opacity: isLogoVisible ? 1 : 0,
      scale: isLogoVisible ? 1 : 0.88,
      duration: isLogoVisible ? 650 : 180,
      ease: isLogoVisible ? "out(4)" : "in(2)",
    });
  }, [isLogoVisible]);

  useEffect(() => {
    const sizePct = 100 / ACCENT_THEMES.length;
    const selectedSize = 32;

    bars.forEach((bar, index) => {
      const element = barRefs.current[index];

      if (!element) {
        return;
      }

      const normalPos = index * sizePct;
      const selectedPos = 50 - selectedSize / 2;
      const isSelected = bar.isSelectedCentering || bar.isSelectedExiting;

      animate(element, {
        top: `${isSelected ? selectedPos : normalPos}%`,
        height: `${isSelected ? selectedSize : sizePct}%`,
        scaleX: bar.isVisible ? 1 : 0,
        backgroundColor:
          bar.isVisible && !bar.isBlack ? bar.theme.accent : "#000000",
        duration: isSelected ? SELECTED_CENTER_SLIDE_MS : STEP_MS + 160,
        ease: isSelected ? "out(4)" : "out(3)",
      });
    });
  }, [bars]);

  if (!isVisible) {
    return null;
  }

  const sizePct = 100 / ACCENT_THEMES.length;

  const transformOrigin = animType.startsWith("left")
    ? "left center"
    : animType.startsWith("right")
      ? "right center"
      : "center center";

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] overflow-hidden bg-black opacity-0"
      style={{ pointerEvents: isLeaving ? "none" : "auto" }}
      aria-hidden="true"
    >
      {bars.map((bar, index) => {
        const normalPos = index * sizePct;

        return (
          <div
            key={bar.theme.name}
            ref={(element) => setBarRef(element, index)}
            className="absolute"
            style={{
              top: `${normalPos}%`,
              height: `${sizePct}%`,
              left: "0%",
              width: "100%",
              backgroundColor: "#000000",
              transformOrigin,
              transform: "scaleX(0)",
              borderRadius: "10px",
              overflow: "hidden",
              zIndex: bar.isSelectedCentering || bar.isSelectedExiting ? 5 : 1,
            }}
          />
        );
      })}

      <div
        ref={logoRef}
        className="absolute inset-0 z-10 flex items-center justify-center opacity-0"
        style={{ transform: "scale(0.88)" }}
      >
        <div className="relative flex h-32 w-32 items-center justify-center md:h-64 md:w-64">
          <div className="absolute inset-0 rounded-[2rem] bg-black/40 blur-2xl" />

          <div className="absolute inset-5 rounded-[2rem] bg-black/50" />

          <img
            src={AppIcon}
            alt=""
            className="relative z-10 h-24 w-24 rounded-[1.5rem] object-cover shadow-2xl md:h-48 md:w-48"
          />
        </div>
      </div>
    </div>
  );
}
