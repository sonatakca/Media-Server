import { describe, expect, it } from "vitest";
import {
  ARR_ENDPOINTS,
  ARR_METADATA_FIELDS,
  nativeExportOwnsLibrary,
  redactArrSecrets,
} from "./arrClient";

describe("arr integration boundary", () => {
  it("names the v3 endpoints an adapter would use", () => {
    expect(ARR_ENDPOINTS.metadataSchema).toBe("/api/v3/metadata/schema");
    expect(ARR_ENDPOINTS.metadata).toBe("/api/v3/metadata");
    expect(ARR_ENDPOINTS.command).toBe("/api/v3/command");
    expect(ARR_ENDPOINTS.commandById(42)).toBe("/api/v3/command/42");
  });

  it("keeps each program's metadata fields separate", () => {
    expect(ARR_METADATA_FIELDS.radarr).toEqual([
      "movieMetadata",
      "useMovieNfo",
    ]);
    expect(ARR_METADATA_FIELDS.sonarr).toEqual([
      "seriesMetadata",
      "episodeMetadata",
    ]);
  });

  describe("secret redaction", () => {
    it("removes a key from a header line", () => {
      expect(
        redactArrSecrets("X-Api-Key: 0123456789abcdef0123456789abcdef"),
      ).not.toContain("0123456789abcdef");
    });

    it("removes a key from a query string", () => {
      expect(
        redactArrSecrets(
          "GET /api/v3/movie?apikey=0123456789abcdef0123456789abcdef&page=1",
        ),
      ).toBe("GET /api/v3/movie?apikey=[redacted]&page=1");
    });

    it("removes a bare 32-character key wherever it appears", () => {
      expect(
        redactArrSecrets("failed for 0123456789ABCDEF0123456789abcdef"),
      ).toBe("failed for [redacted]");
    });

    it("leaves ordinary text alone", () => {
      expect(redactArrSecrets("Radarr returned 404 for movie 12345")).toBe(
        "Radarr returned 404 for movie 12345",
      );
    });
  });

  describe("single-writer rule", () => {
    it("lets the native exporter manage a library no Arr instance owns", () => {
      expect(nativeExportOwnsLibrary("movies", new Set())).toBe(true);
      expect(nativeExportOwnsLibrary("movies", new Set(["shows"]))).toBe(true);
    });

    it("hands ownership over when a library is listed", () => {
      expect(nativeExportOwnsLibrary("movies", new Set(["movies"]))).toBe(
        false,
      );
    });

    it("compares slugs case-insensitively, as the config parser stores them", () => {
      expect(nativeExportOwnsLibrary("Movies", new Set(["movies"]))).toBe(
        false,
      );
    });
  });
});
