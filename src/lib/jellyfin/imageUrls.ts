import { buildJellyfinUrl } from "./url";

export type JellyfinImageKind = "Primary" | "Logo" | "Backdrop" | "Thumb";

interface BuildJellyfinImageUrlOptions {
  serverUrl: string | null;
  accessToken?: string;
  itemId: string;
  kind: JellyfinImageKind;
  tag?: string;
  maxWidth?: number;
}

const DEFAULT_WIDTH_BY_KIND: Record<JellyfinImageKind, number> = {
  Primary: 500,
  Logo: 900,
  Backdrop: 1600,
  Thumb: 900,
};

export function buildJellyfinImageUrl({
  serverUrl,
  accessToken,
  itemId,
  kind,
  tag,
  maxWidth = DEFAULT_WIDTH_BY_KIND[kind],
}: BuildJellyfinImageUrlOptions): string {
  if (!serverUrl) {
    return "";
  }

  return buildJellyfinUrl(
    serverUrl,
    `/Items/${encodeURIComponent(itemId)}/Images/${kind}`,
    {
      maxWidth,
      quality: kind === "Logo" ? 90 : 82,
      format: "Webp",
      imageIndex: kind === "Backdrop" ? 0 : undefined,
      tag,
      api_key: accessToken,
    },
  );
}
