import { normalizeServerUrl } from "../authStorage";

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean>;

export type QueryParams = Record<string, QueryValue>;

function appendQueryParams(url: URL, params: QueryParams = {}): void {
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    if (Array.isArray(value)) {
      if (value.length > 0) {
        url.searchParams.set(key, value.join(","));
      }
      return;
    }

    url.searchParams.set(key, String(value));
  });
}

export function buildJellyfinUrl(
  serverUrl: string,
  path: string,
  params: QueryParams = {},
): string {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const normalizedPath = path.replace(/^\/+/, "");
  const url = new URL(`${normalizedServerUrl}/${normalizedPath}`);
  appendQueryParams(url, params);
  return url.toString();
}
