import type { JellyfinItem } from "./types";

const ROMAN_VALUES: Record<string, number> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

export function isCollectionItem(item: JellyfinItem): boolean {
  return item.Type === "BoxSet" || item.CollectionType === "boxsets";
}

function parseDateTime(value?: string): number | null {
  if (!value) {
    return null;
  }

  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function getReleaseYear(item: JellyfinItem): number | null {
  if (typeof item.ProductionYear === "number") {
    return item.ProductionYear;
  }

  const premiereTime = parseDateTime(item.PremiereDate);

  if (premiereTime === null) {
    return null;
  }

  return new Date(premiereTime).getUTCFullYear();
}

function romanToNumber(value: string): number | null {
  const normalized = value.toLowerCase();
  let total = 0;
  let previous = 0;

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const current = ROMAN_VALUES[normalized[index]];

    if (!current) {
      return null;
    }

    total += current < previous ? -current : current;
    previous = current;
  }

  return total > 0 ? total : null;
}

function parseOrderToken(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    return number > 0 && number < 100 ? number : null;
  }

  return romanToNumber(value);
}

function extractTitleOrderNumber(title?: string): number | null {
  if (!title) {
    return null;
  }

  const normalizedTitle = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const episodeMatch = normalizedTitle.match(
    /\b(?:episode|ep\.?)\s+([ivxlcdm]+|\d{1,2})\b/i,
  );

  if (episodeMatch?.[1]) {
    const episodeNumber = parseOrderToken(episodeMatch[1]);

    if (episodeNumber !== null) {
      return episodeNumber;
    }
  }

  const trailingMatch = normalizedTitle.match(
    /(?:^|[\s:._-])([ivxlcdm]+|\d{1,2})(?:\s*(?:$|['’`´-]))/i,
  );

  if (trailingMatch?.[1]) {
    const trailingNumber = parseOrderToken(trailingMatch[1]);

    if (trailingNumber !== null) {
      return trailingNumber;
    }
  }

  const numberMatch = normalizedTitle.match(/(?:^|[\s:._-])(\d{1,2})(?=\b)/);

  if (numberMatch?.[1]) {
    return parseOrderToken(numberMatch[1]);
  }

  return null;
}

function getSequelOrderNumber(item: JellyfinItem): number | null {
  return (
    extractTitleOrderNumber(item.OriginalTitle) ??
    extractTitleOrderNumber(item.SortName) ??
    extractTitleOrderNumber(item.Name)
  );
}

function compareText(left: JellyfinItem, right: JellyfinItem): number {
  return (left.SortName ?? left.Name).localeCompare(
    right.SortName ?? right.Name,
    undefined,
    { numeric: true, sensitivity: "base" },
  );
}

function compareMaybeNumber(
  leftValue: number | null,
  rightValue: number | null,
): number {
  if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
    return leftValue - rightValue;
  }

  if (leftValue !== null && rightValue === null) {
    return -1;
  }

  if (leftValue === null && rightValue !== null) {
    return 1;
  }

  return 0;
}

function compareSequelOrder(left: JellyfinItem, right: JellyfinItem): number {
  const leftOrder = getSequelOrderNumber(left);
  const rightOrder = getSequelOrderNumber(right);

  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  if (leftOrder === null && rightOrder !== null) {
    return rightOrder <= 1 ? 0 : -1;
  }

  if (leftOrder !== null && rightOrder === null) {
    return leftOrder <= 1 ? 0 : 1;
  }

  return 0;
}

function compareCollectionItems(left: JellyfinItem, right: JellyfinItem) {
  const leftPremiereTime = parseDateTime(left.PremiereDate);
  const rightPremiereTime = parseDateTime(right.PremiereDate);

  if (
    leftPremiereTime !== null &&
    rightPremiereTime !== null &&
    leftPremiereTime !== rightPremiereTime
  ) {
    return leftPremiereTime - rightPremiereTime;
  }

  const leftYear = getReleaseYear(left);
  const rightYear = getReleaseYear(right);

  if (leftYear !== null && rightYear !== null) {
    return leftYear !== rightYear ? leftYear - rightYear : 0;
  }

  const yearCompare = compareMaybeNumber(leftYear, rightYear);

  if (yearCompare !== 0) {
    return yearCompare;
  }

  const sequelCompare = compareSequelOrder(left, right);

  if (sequelCompare !== 0) {
    return sequelCompare;
  }

  return compareText(left, right);
}

export function sortCollectionItemsForWatching(
  items: JellyfinItem[],
): JellyfinItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const compare = compareCollectionItems(left.item, right.item);
      return compare !== 0 ? compare : left.index - right.index;
    })
    .map(({ item }) => item);
}
