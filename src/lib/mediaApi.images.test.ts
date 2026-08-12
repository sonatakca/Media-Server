import { describe, expect, it } from "vitest";
import { getPrimaryImageUrl } from "./mediaApi";

describe("artwork URLs", () => {
  it("requests the optimized image generation so old full-size cache entries are bypassed", () => {
    const url = new URL(
      getPrimaryImageUrl("book-1", "cover-hash", 440),
      "https://www.seyirlik.org",
    );

    expect(url.pathname).toBe("/ownAPI/v1/items/book-1/images/primary");
    expect(url.searchParams.get("tag")).toBe("cover-hash");
    expect(url.searchParams.get("maxWidth")).toBe("440");
    expect(url.searchParams.get("variant")).toBe("webp-v1");
  });
});
