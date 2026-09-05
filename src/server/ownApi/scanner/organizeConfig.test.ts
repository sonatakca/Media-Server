import { describe, expect, it } from "vitest";
import { movesFiles, parseOrganizeMode } from "./organizeConfig";

describe("organize mode", () => {
  it("does nothing to the media volume unless asked", () => {
    expect(parseOrganizeMode({})).toBe("off");
    expect(parseOrganizeMode({ SEYIRLIK_MEDIA_ORGANIZE: "" })).toBe("off");
    expect(movesFiles("off")).toBe(false);
    expect(movesFiles("plan")).toBe(false);
    expect(movesFiles("apply")).toBe(true);
  });

  it("accepts the three modes, however they are typed", () => {
    expect(parseOrganizeMode({ SEYIRLIK_MEDIA_ORGANIZE: " Plan " })).toBe(
      "plan",
    );
    expect(parseOrganizeMode({ SEYIRLIK_MEDIA_ORGANIZE: "APPLY" })).toBe(
      "apply",
    );
  });

  /*
   * A typo here would otherwise be discovered from a diff on the media volume.
   */
  it("refuses to start on a value it does not understand", () => {
    expect(() => parseOrganizeMode({ SEYIRLIK_MEDIA_ORGANIZE: "yes" })).toThrow(
      /SEYIRLIK_MEDIA_ORGANIZE/,
    );
  });
});
