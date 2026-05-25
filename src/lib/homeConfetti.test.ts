import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOME_CONFETTI_LAST_SHOWN_DATE_KEY,
  LOGIN_CONFETTI_PENDING_KEY,
  consumeLoginConfettiPending,
  getTodayDateKey,
  markDailyHomeConfettiShown,
  markLoginConfettiPending,
  shouldShowDailyHomeConfetti,
} from "./homeConfetti";

describe("home confetti storage", () => {
  let localStorageMock: Storage;

  beforeEach(() => {
    const storage = new Map<string, string>();
    localStorageMock = {
      get length() {
        return storage.size;
      },
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };

    vi.stubGlobal("localStorage", localStorageMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 25, 12));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses a local calendar date key for daily confetti", () => {
    expect(getTodayDateKey(new Date(2026, 0, 2, 23, 30))).toBe("2026-01-02");
    expect(shouldShowDailyHomeConfetti()).toBe(true);

    markDailyHomeConfettiShown();

    expect(window.localStorage.getItem(HOME_CONFETTI_LAST_SHOWN_DATE_KEY)).toBe(
      "2026-05-25",
    );
    expect(shouldShowDailyHomeConfetti()).toBe(false);

    vi.setSystemTime(new Date(2026, 4, 26, 0, 1));

    expect(shouldShowDailyHomeConfetti()).toBe(true);
  });

  it("consumes each successful-login marker only once", () => {
    markLoginConfettiPending();

    expect(window.localStorage.getItem(LOGIN_CONFETTI_PENDING_KEY)).toBe(
      "true",
    );
    expect(consumeLoginConfettiPending()).toBe(true);
    expect(consumeLoginConfettiPending()).toBe(false);
  });

  it("does not throw if local storage is unavailable", () => {
    vi.spyOn(localStorageMock, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(localStorageMock, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(localStorageMock, "removeItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    expect(() => markLoginConfettiPending()).not.toThrow();
    expect(() => markDailyHomeConfettiShown()).not.toThrow();
    expect(consumeLoginConfettiPending()).toBe(false);
    expect(shouldShowDailyHomeConfetti()).toBe(true);
  });
});
