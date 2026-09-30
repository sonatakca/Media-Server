import { useEffect, useState } from "react";
import { getOfflineTitle, type OfflineTitle } from "./offlineLibrary";

/** The stored record for one title, kept current as downloads change. */
export function useOfflineTitle(itemId: string): OfflineTitle | null {
  const [title, setTitle] = useState<OfflineTitle | null>(null);
  useEffect(() => {
    let current = true;
    const load = () => {
      void getOfflineTitle(itemId)
        .then((stored) => {
          if (current) setTitle(stored);
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener("seyirlik:offline-changed", load);
    return () => {
      current = false;
      window.removeEventListener("seyirlik:offline-changed", load);
    };
  }, [itemId]);
  return title;
}
