import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  SEARCH_OVERLAY_OPEN_EVENT,
  isSearchShortcut,
} from "../../lib/searchModel";

// The overlay is only ever needed after a deliberate action, so it stays out
// of the initial bundle.
const SearchOverlay = lazy(async () => ({
  default: (await import("./SearchOverlay")).SearchOverlay,
}));

export function SearchOverlayHost() {
  const [isOpen, setIsOpen] = useState(false);

  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    const handleOpenRequest = () => setIsOpen(true);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) {
        return;
      }

      // Cmd/Ctrl+K is claimed here on purpose: it is the app's own shortcut and
      // it must work while the user is typing anywhere on the page.
      event.preventDefault();
      setIsOpen((current) => !current);
    };

    window.addEventListener(SEARCH_OVERLAY_OPEN_EVENT, handleOpenRequest);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener(SEARCH_OVERLAY_OPEN_EVENT, handleOpenRequest);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  if (!isOpen) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <SearchOverlay isOpen={isOpen} onClose={close} />
    </Suspense>
  );
}
