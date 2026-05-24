export type NavigatorWithStandalone = Navigator & {
  standalone?: boolean;
};

export function isStandaloneWebApp(): boolean {
  if (typeof window === "undefined") return false;

  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    ("standalone" in window.navigator &&
      (window.navigator as NavigatorWithStandalone).standalone === true)
  );
}
