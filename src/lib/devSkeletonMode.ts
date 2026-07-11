import { useSyncExternalStore } from "react";

export const DEV_SKELETON_STORAGE_KEY = "seyirlik-dev-force-skeletons";
export const DEV_SKELETON_CHANGED_EVENT = "seyirlik:dev-skeleton-changed";

export function isDevSkeletonModeAvailable(): boolean {
  return import.meta.env.DEV;
}

export function getDevSkeletonMode(): boolean {
  if (!isDevSkeletonModeAvailable() || typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(DEV_SKELETON_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setDevSkeletonMode(enabled: boolean): void {
  if (!isDevSkeletonModeAvailable() || typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      DEV_SKELETON_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch {
    // The current page still updates through the event when storage is blocked.
  }

  window.dispatchEvent(new Event(DEV_SKELETON_CHANGED_EVENT));
}

function subscribeToDevSkeletonMode(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  const handleStorage = (event: StorageEvent) => {
    if (event.key === DEV_SKELETON_STORAGE_KEY) onStoreChange();
  };

  window.addEventListener(DEV_SKELETON_CHANGED_EVENT, onStoreChange);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(DEV_SKELETON_CHANGED_EVENT, onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useDevSkeletonMode(): boolean {
  return useSyncExternalStore(
    subscribeToDevSkeletonMode,
    getDevSkeletonMode,
    () => false,
  );
}
