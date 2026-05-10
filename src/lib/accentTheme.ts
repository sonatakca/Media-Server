export type AccentTheme = {
  name: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentStrong: string;
};

export const ACCENT_THEME_STORAGE_KEY = "seyirlik.routeColorTransition.selectedTheme";

export const ACCENT_THEMES: AccentTheme[] = [
  {
    name: "Warm Red",
    accent: "#bd3f28",
    accentHover: "#fa9b1d",
    accentSoft: "rgba(189, 63, 40, 0.18)",
    accentStrong: "rgba(189, 63, 40, 0.36)",
  },
  {
    name: "Amber",
    accent: "#fa9b1d",
    accentHover: "#d3ca22",
    accentSoft: "rgba(250, 155, 29, 0.18)",
    accentStrong: "rgba(250, 155, 29, 0.36)",
  },
  {
    name: "Gold",
    accent: "#d3ca22",
    accentHover: "#bacb7d",
    accentSoft: "rgba(211, 202, 34, 0.18)",
    accentStrong: "rgba(211, 202, 34, 0.34)",
  },
  {
    name: "Olive",
    accent: "#bacb7d",
    accentHover: "#67a478",
    accentSoft: "rgba(186, 203, 125, 0.18)",
    accentStrong: "rgba(186, 203, 125, 0.34)",
  },
  {
    name: "Green",
    accent: "#67a478",
    accentHover: "#337b6c",
    accentSoft: "rgba(103, 164, 120, 0.18)",
    accentStrong: "rgba(103, 164, 120, 0.36)",
  },
  {
    name: "Teal",
    accent: "#337b6c",
    accentHover: "#67a478",
    accentSoft: "rgba(51, 123, 108, 0.18)",
    accentStrong: "rgba(51, 123, 108, 0.36)",
  },
];

export function getRandomAccentTheme(): AccentTheme {
  return ACCENT_THEMES[Math.floor(Math.random() * ACCENT_THEMES.length)];
}

export function applyAccentTheme(theme: AccentTheme): void {
  const root = document.documentElement;

  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-hover", theme.accentHover);
  root.style.setProperty("--accent-soft", theme.accentSoft);
  root.style.setProperty("--accent-strong", theme.accentStrong);
  root.dataset.accentTheme = theme.name;
}

export function getStoredAccentTheme(): AccentTheme | null {
  const storedThemeName = localStorage.getItem(ACCENT_THEME_STORAGE_KEY);

  if (!storedThemeName) {
    return null;
  }

  return ACCENT_THEMES.find((theme) => theme.name === storedThemeName) ?? null;
}

export function saveAccentTheme(theme: AccentTheme): void {
  localStorage.setItem(ACCENT_THEME_STORAGE_KEY, theme.name);
}

export function saveAndApplyAccentTheme(theme: AccentTheme): void {
  saveAccentTheme(theme);
  applyAccentTheme(theme);
}

export function applyStoredAccentTheme(): void {
  const storedTheme = getStoredAccentTheme();

  if (!storedTheme) {
    return;
  }

  applyAccentTheme(storedTheme);
}
