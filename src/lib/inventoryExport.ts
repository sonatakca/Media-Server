/**
 * The library as a file: every title with what it holds, for a spreadsheet or
 * for handing to another tool. Built from the same rows the library page shows,
 * so the export and the screen never disagree.
 */
import type { LibraryTitle } from "./libraryAdminApi";

const COLUMNS: Array<keyof LibraryTitle> = [
  "id",
  "kind",
  "title",
  "year",
  "status",
  "hasMedia",
  "desired",
  "downloading",
  "importing",
  "processing",
  "sizeBytes",
  "resolution",
  "audioLanguages",
  "subtitleLanguages",
  "pendingSubtitles",
  "files",
  "trickplayFiles",
  "episodeCount",
  "availableEpisodeCount",
  "tmdbId",
  "imdbId",
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("|") : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function inventoryCsv(titles: readonly LibraryTitle[]): string {
  return [
    COLUMNS.join(","),
    ...titles.map((title) =>
      COLUMNS.map((column) => csvCell(title[column])).join(","),
    ),
  ].join("\n");
}

export function inventoryJson(titles: readonly LibraryTitle[]): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      source: "Seyirlik library",
      count: titles.length,
      titles,
    },
    null,
    2,
  );
}

export function downloadInventory(
  titles: readonly LibraryTitle[],
  format: "csv" | "json",
): void {
  const content =
    format === "csv" ? inventoryCsv(titles) : inventoryJson(titles);
  const blob = new Blob([content], {
    type: format === "csv" ? "text/csv" : "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `seyirlik-library-${new Date().toISOString().slice(0, 10)}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
