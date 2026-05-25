export const HOME_CONFETTI_LAST_SHOWN_DATE_KEY =
  "seyirlik.homeConfetti.lastShownDate";
export const LOGIN_CONFETTI_PENDING_KEY = "seyirlik.loginConfetti.pending";

export function getTodayDateKey(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${date.getFullYear()}-${month}-${day}`;
}

export function safeGetLocalStorageItem(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSetLocalStorageItem(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

export function safeRemoveLocalStorageItem(key: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

export function shouldShowDailyHomeConfetti(): boolean {
  return (
    safeGetLocalStorageItem(HOME_CONFETTI_LAST_SHOWN_DATE_KEY) !==
    getTodayDateKey()
  );
}

export function markDailyHomeConfettiShown(): void {
  safeSetLocalStorageItem(HOME_CONFETTI_LAST_SHOWN_DATE_KEY, getTodayDateKey());
}

export function markLoginConfettiPending(): void {
  safeSetLocalStorageItem(LOGIN_CONFETTI_PENDING_KEY, "true");
}

export function consumeLoginConfettiPending(): boolean {
  const hasPendingLoginConfetti =
    safeGetLocalStorageItem(LOGIN_CONFETTI_PENDING_KEY) !== null;

  if (hasPendingLoginConfetti) {
    safeRemoveLocalStorageItem(LOGIN_CONFETTI_PENDING_KEY);
  }

  return hasPendingLoginConfetti;
}
