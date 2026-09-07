// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PROCESS_STARTED_AT_MS,
  announceProcessStart,
  isSeyirlikProcessEntryPoint,
  moduleLoadElapsedMs,
} from "./processBanner";

describe("the process's opening line", () => {
  it("is emitted only when this really is a Seyirlik process", () => {
    expect(
      isSeyirlikProcessEntryPoint([
        "node",
        "/srv/app/src/server/mediaServer.ts",
      ]),
    ).toBe(true);
    expect(
      isSeyirlikProcessEntryPoint(["node", "/srv/app/dist/mediaWorker.js"]),
    ).toBe(true);
    // Importing these modules under a test runner or a script must stay silent.
    expect(
      isSeyirlikProcessEntryPoint([
        "node",
        "/srv/app/node_modules/.bin/vitest",
      ]),
    ).toBe(false);
    expect(isSeyirlikProcessEntryPoint(["node"])).toBe(false);
  });

  it("names the process, and is structured when it is going to a logfile", () => {
    const lines: string[] = [];
    announceProcessStart(
      { write: (chunk) => lines.push(chunk) },
      Date.parse("2026-09-06T10:00:00.000Z"),
    );

    expect(lines[0]).toContain("[Seyirlik startup] process loading");
    expect(lines[0]).toContain(`pid=${process.pid}`);
    expect(lines[0]?.startsWith("2026-09-06T10:00:00.000Z")).toBe(true);
    expect(lines[0]?.endsWith("\n")).toBe(true);
  });

  it("is plain in a terminal", () => {
    const lines: string[] = [];
    announceProcessStart({ write: (chunk) => lines.push(chunk), isTTY: true });

    expect(lines[0]).toContain("Seyirlik — loading");
    expect(lines[0]).not.toContain("[Seyirlik startup]");
  });

  it("measures how long the rest of the import graph took", () => {
    // Recorded at module evaluation, which is the earliest point reachable
    // from inside the process — the whole reason this module is imported first.
    expect(PROCESS_STARTED_AT_MS).toBeLessThanOrEqual(Date.now());
    expect(moduleLoadElapsedMs()).toBeGreaterThanOrEqual(0);
  });
});
