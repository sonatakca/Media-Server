import { describe, expect, it } from "vitest";
import { parseNfoConfig, writesFiles } from "./nfoConfig";

describe("nfo config", () => {
  it("writes safe sidecars during scans by default", () => {
    const config = parseNfoConfig({});

    expect(config.mode).toBe("sidecar");
    expect(config.overwritePolicy).toBe("managed-only");
    expect(config.arrManagedLibrarySlugs.size).toBe(0);
  });

  it("treats an empty variable as unset", () => {
    expect(parseNfoConfig({ SEYIRLIK_NFO_EXPORT: "  " }).mode).toBe("sidecar");
  });

  it("accepts the documented modes", () => {
    expect(parseNfoConfig({ SEYIRLIK_NFO_EXPORT: "preview" }).mode).toBe(
      "preview",
    );
    expect(parseNfoConfig({ SEYIRLIK_NFO_EXPORT: "generated" }).mode).toBe(
      "generated",
    );
  });

  it("rejects a mode it does not know", () => {
    expect(() => parseNfoConfig({ SEYIRLIK_NFO_EXPORT: "yes" })).toThrow(
      /SEYIRLIK_NFO_EXPORT/,
    );
  });

  describe("scan behaviour", () => {
    it("allows sidecars to be explicitly disabled", () => {
      expect(parseNfoConfig({ SEYIRLIK_NFO_EXPORT: "disabled" }).mode).toBe(
        "disabled",
      );
    });

    it("accepts sidecar mode without a second acknowledgement flag", () => {
      expect(parseNfoConfig({ SEYIRLIK_NFO_EXPORT: "sidecar" }).mode).toBe(
        "sidecar",
      );
    });
  });

  describe("overwrite policy", () => {
    it("reads force when it is asked for explicitly", () => {
      expect(
        parseNfoConfig({ SEYIRLIK_NFO_OVERWRITE: "force" }).overwritePolicy,
      ).toBe("force");
    });

    it("rejects anything else", () => {
      expect(() => parseNfoConfig({ SEYIRLIK_NFO_OVERWRITE: "yes" })).toThrow(
        /SEYIRLIK_NFO_OVERWRITE/,
      );
    });
  });

  it("reads the libraries an Arr instance owns, normalised and de-blanked", () => {
    const config = parseNfoConfig({
      SEYIRLIK_NFO_ARR_MANAGED_LIBRARIES: " Movies , ,shows ",
    });

    expect([...config.arrManagedLibrarySlugs].sort()).toEqual([
      "movies",
      "shows",
    ]);
  });

  it("knows which modes put bytes on a disk", () => {
    expect(writesFiles("disabled")).toBe(false);
    expect(writesFiles("preview")).toBe(false);
    expect(writesFiles("generated")).toBe(true);
    expect(writesFiles("sidecar")).toBe(true);
  });
});
