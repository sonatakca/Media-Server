import { useEffect } from "react";

interface KeyboardShortcutOptions {
  enabled?: boolean;
  onTogglePlay: () => void;
  onSeekBy: (seconds: number) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

export function useKeyboardShortcuts({
  enabled = true,
  onTogglePlay,
  onSeekBy,
  onToggleMute,
  onToggleFullscreen,
}: KeyboardShortcutOptions) {
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }

      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        onTogglePlay();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        onSeekBy(-10);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onSeekBy(10);
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        onToggleMute();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        onToggleFullscreen();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onSeekBy, onToggleFullscreen, onToggleMute, onTogglePlay]);
}
