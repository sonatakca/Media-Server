import { describe, expect, it } from "vitest";
import { describeErrorSafely } from "./safeErrorText";

const FALLBACK = "The step did not complete.";

describe("error text that may reach a browser", () => {
  it("strips a quoted path, which is how Node writes them", () => {
    // The exact shape that leaked the media root before this was one function.
    const text = describeErrorSafely(
      new Error(
        "ENOENT: no such file or directory, stat '/Volumes/Expansion/media'",
      ),
      FALLBACK,
    );

    expect(text).not.toContain("/Volumes");
    expect(text).toContain("ENOENT");
    expect(text).toContain("stat");
  });

  it("strips an unquoted path", () => {
    expect(
      describeErrorSafely(
        new Error("cannot read /Volumes/Expansion/media/film.mkv"),
        FALLBACK,
      ),
    ).not.toContain("Expansion");
  });

  it("strips a connection URL along with its credentials", () => {
    const text = describeErrorSafely(
      new Error(
        "connect ECONNREFUSED postgres://seyirlik:hunter2@db.local/app",
      ),
      FALLBACK,
    );

    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("db.local");
    expect(text).toContain("ECONNREFUSED");
  });

  it("keeps only the first line", () => {
    expect(
      describeErrorSafely(new Error("headline\n  at somewhere:1:2"), FALLBACK),
    ).toBe("headline");
  });

  it("bounds the length", () => {
    expect(
      describeErrorSafely(new Error("x".repeat(500)), FALLBACK).length,
    ).toBe(240);
  });

  it("falls back rather than returning nothing", () => {
    expect(describeErrorSafely(new Error("/tmp/only-a-path"), FALLBACK)).toBe(
      FALLBACK,
    );
  });

  it("leaves ordinary prose alone", () => {
    const message = "SEYIRLIK_MEDIA_ROOT must point to an existing directory.";
    expect(describeErrorSafely(new Error(message), FALLBACK)).toBe(message);
    // A slash inside a word is not a path.
    expect(describeErrorSafely(new Error("read/write denied"), FALLBACK)).toBe(
      "read/write denied",
    );
  });
});
