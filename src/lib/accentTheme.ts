type AccentTheme = {
  name: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
};

const ACCENT_THEMES: AccentTheme[] = [
  {
    name: "Warm Red",
    accent: "#ae4832",
    accentHover: "#ed9f40",
    accentSoft: "rgba(174, 72, 50, 0.18)",
  },
  {
    name: "Amber",
    accent: "#ed9f40",
    accentHover: "#d1ca4a",
    accentSoft: "rgba(237, 159, 64, 0.18)",
  },
  {
    name: "Gold",
    accent: "#d1ca4a",
    accentHover: "#bdca86",
    accentSoft: "rgba(209, 202, 74, 0.18)",
  },
  {
    name: "Olive",
    accent: "#bdca86",
    accentHover: "#75a27b",
    accentSoft: "rgba(189, 202, 134, 0.18)",
  },
  {
    name: "Green",
    accent: "#75a27b",
    accentHover: "#467a6c",
    accentSoft: "rgba(117, 162, 123, 0.18)",
  },
  {
    name: "Teal",
    accent: "#467a6c",
    accentHover: "#75a27b",
    accentSoft: "rgba(70, 122, 108, 0.18)",
  },
];

function getRandomTheme(): AccentTheme {
  return ACCENT_THEMES[Math.floor(Math.random() * ACCENT_THEMES.length)];
}

export function applyRandomAccentTheme(): void {
  const theme = getRandomTheme();
  const root = document.documentElement;

  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-hover", theme.accentHover);
  root.style.setProperty("--accent-soft", theme.accentSoft);
  root.dataset.accentTheme = theme.name;
}