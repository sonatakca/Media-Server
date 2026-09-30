import { useEffect, useRef } from "react";

/**
 * Closes a panel when a pointer goes down anywhere outside it.
 *
 * `insideSelectors` are the roots that count as inside: the panel itself and
 * any surface that may be used while it is open. The latest `onDismiss` is
 * always the one called, without re-subscribing when it changes identity.
 */
export function useDismissOnOutsidePointer(
  isOpen: boolean,
  insideSelectors: readonly string[],
  onDismiss: () => void,
): void {
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });
  const selectorKey = insideSelectors.join(",");

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const selectors = selectorKey.split(",");
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement | null;

      if (selectors.some((selector) => target?.closest(selector))) {
        return;
      }

      onDismissRef.current();
    };

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isOpen, selectorKey]);
}
