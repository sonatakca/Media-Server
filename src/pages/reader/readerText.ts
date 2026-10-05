import type { useLanguage } from "../../i18n/LanguageContext";

export type Translate = ReturnType<typeof useLanguage>["t"];

export function formatDuration(minutes: number, t: Translate): string {
  if (minutes < 60) {
    return t("reader.minutes").replace("{m}", String(Math.max(1, minutes)));
  }

  return t("reader.hoursMinutes")
    .replace("{h}", String(Math.floor(minutes / 60)))
    .replace("{m}", String(minutes % 60));
}

export function formatPercent(fraction: number, language: string): string {
  return new Intl.NumberFormat(language, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(fraction);
}

const LEADING_NUMBER = /^\s*(\d{1,3}|[IVXLC]{1,6})\s*(?:[-–—.:·)]\s*|\s+)(.+)$/;

export function splitNumber(label: string): { number: string; title: string } {
  const match = LEADING_NUMBER.exec(label.trim());

  return match
    ? { number: match[1], title: match[2] }
    : { number: "", title: label.trim() };
}

