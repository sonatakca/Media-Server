import { describe, expect, it } from "vitest";
import {
  buildJellyfinImageUrl,
  type JellyfinImageKind,
} from "./jellyfin/imageUrls";
import { buildJellyfinUrl } from "./jellyfin/url";

describe("Jellyfin URL builders", () => {
  it("normalizes server paths and omits empty query values", () => {
    expect(
      buildJellyfinUrl("https://media.example.test///", "/Items/a b", {
        ids: [1, 2],
        empty: "",
        missing: undefined,
        enabled: true,
      }),
    ).toBe("https://media.example.test/Items/a%20b?ids=1%2C2&enabled=true");
  });

  it.each<[JellyfinImageKind, number, string]>([
    ["Primary", 500, "quality=82&format=Webp"],
    ["Logo", 900, "quality=90&format=Webp"],
    ["Backdrop", 1600, "quality=82&format=Webp&imageIndex=0"],
    ["Thumb", 900, "quality=82&format=Webp"],
  ])("preserves %s image URL defaults", (kind, width, expectedQuery) => {
    const url = buildJellyfinImageUrl({
      serverUrl: "https://media.example.test",
      accessToken: "token",
      itemId: "item/id",
      kind,
      tag: "tag",
    });
    expect(url).toContain(`/Items/item%2Fid/Images/${kind}?maxWidth=${width}&`);
    expect(url).toContain(expectedQuery);
    expect(url).toContain("tag=tag&api_key=token");
  });

  it("returns an empty image URL when no server is configured", () => {
    expect(
      buildJellyfinImageUrl({ serverUrl: "", itemId: "item", kind: "Primary" }),
    ).toBe("");
  });
});
