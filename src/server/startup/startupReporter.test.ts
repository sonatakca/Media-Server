// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createStartupReporter,
  formatElapsed,
  type StartupReporterStream,
} from "./startupReporter";
import type { StartupPhaseSnapshot, StartupSnapshot } from "./startupState";

const CLEAR_LINE = "\r\u001B[2K";

function collector(options: { isTTY?: boolean; columns?: number } = {}) {
  const chunks: string[] = [];
  const stream: StartupReporterStream = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    ...(options.isTTY === undefined ? {} : { isTTY: options.isTTY }),
    ...(options.columns === undefined ? {} : { columns: options.columns }),
  };
  return { stream, chunks, text: () => chunks.join("") };
}

function phase(
  overrides: Partial<StartupPhaseSnapshot> = {},
): StartupPhaseSnapshot {
  return {
    id: "media-storage",
    label: "Media storage",
    state: "running",
    startedAtMs: 1_000,
    elapsedMs: 2_100,
    operation: "stat",
    resource: "/Volumes/Expansion/media",
    ...overrides,
  };
}

function snapshot(overrides: Partial<StartupSnapshot> = {}): StartupSnapshot {
  return {
    live: true,
    ready: true,
    state: "ready",
    phase: null,
    startedAtMs: 1_000,
    elapsedMs: 1_234,
    phases: [],
    ...overrides,
  };
}

describe("the launchd log", () => {
  it("is line-oriented, timestamped, and free of cursor control", () => {
    const { stream, chunks, text } = collector({ isTTY: false });
    const reporter = createStartupReporter({
      stream,
      now: () => 1_700_000_000_000,
    });

    reporter.processStarting({ pid: 4242, moduleLoadMs: 1_400 });
    reporter.began?.(phase());
    reporter.slow?.(phase({ elapsedMs: 5_000 }));
    reporter.settled?.(phase({ state: "ready", elapsedMs: 41_200 }));
    reporter.dispose();

    const output = text();
    // Nothing a `less` session or a `grep` would have to interpret.
    expect(output).not.toContain("\u001B");
    expect(output).not.toContain("\r");
    for (const chunk of chunks) {
      expect(chunk.endsWith("\n")).toBe(true);
    }
    expect(output).toContain(
      "[Seyirlik startup] process starting pid=4242 moduleLoadMs=1400",
    );
    expect(output).toContain(
      'media-storage started operation=stat resource="/Volumes/Expansion/media"',
    );
    expect(output).toContain("media-storage slow operation=stat");
    expect(output).toContain("elapsedMs=5000");
    expect(output).toContain("media-storage ready");
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[Seyirlik startup]/m);
  });

  it("names the phase and the error when startup fails", () => {
    const { stream, text } = collector({ isTTY: false });
    const reporter = createStartupReporter({ stream });

    reporter.finished?.(
      snapshot({
        ready: false,
        state: "failed",
        phases: [
          phase({
            id: "database",
            label: "Database",
            state: "failed",
            error: "The database schema is not current.",
          }),
        ],
      }),
    );

    const output = text();
    expect(output).toContain("failed");
    expect(output).toContain("phase=database");
    expect(output).toContain('error="The database schema is not current."');
  });

  it("reports real progress and never invents any", () => {
    const { stream, text } = collector({ isTTY: false });
    const reporter = createStartupReporter({ stream });

    reporter.waiting?.(
      phase({
        id: "processing",
        label: "Processing state",
        progress: { completed: 1_842, total: 2_413 },
      }),
    );
    reporter.waiting?.(phase());

    const output = text();
    expect(output).toContain("completed=1842 total=2413");
    // A `stat` has no denominator, so no figure is offered for one.
    expect(output).not.toMatch(/\d+%/);
  });
});

describe("the interactive terminal", () => {
  it("says something immediately, before any phase has been awaited", () => {
    const { stream, text } = collector({ isTTY: true, columns: 200 });
    const reporter = createStartupReporter({ stream, companionStreams: [] });

    reporter.processStarting({ pid: 1, moduleLoadMs: 1_400 });
    reporter.began?.(phase());
    reporter.dispose();

    const output = text();
    expect(output).toContain("Seyirlik — starting");
    expect(output).toContain("modules loaded in 1.4 s");
    // The phase is named on the way in, not on the way out.
    expect(output).toContain("Media storage");
    expect(output).toContain("stat");
    expect(output).toContain("/Volumes/Expansion/media");
  });

  it("keeps the live line out of the way of other output", () => {
    const { stream, text } = collector({ isTTY: true, columns: 200 });
    const reporter = createStartupReporter({ stream, companionStreams: [] });

    reporter.began?.(phase());
    /*
     * Something else in the process logs — the artwork migration, a warning
     * from the storage guard. Without the wrapper this lands on the spinner and
     * the next frame erases it.
     */
    stream.write("[Seyirlik] Could not read the storage incident record.\n");
    reporter.dispose();

    const output = text();
    const foreign = output.indexOf("[Seyirlik] Could not read");
    expect(foreign).toBeGreaterThan(-1);
    expect(output.slice(0, foreign).endsWith(CLEAR_LINE)).toBe(true);
    expect(output.trimEnd().endsWith("record.")).toBe(true);
  });

  it("restores the stream when startup ends", () => {
    const { stream } = collector({ isTTY: true });
    const original = stream.write;
    const reporter = createStartupReporter({ stream, companionStreams: [] });

    expect(stream.write).not.toBe(original);
    reporter.dispose();
    expect(stream.write).toBe(original);
  });

  it("is safe to dispose twice", () => {
    const { stream } = collector({ isTTY: true });
    const original = stream.write;
    const reporter = createStartupReporter({ stream, companionStreams: [] });

    reporter.dispose();
    reporter.dispose();
    expect(stream.write).toBe(original);
  });

  it("marks a degraded phase as live but not ready", () => {
    const { stream, text } = collector({ isTTY: true, columns: 200 });
    const reporter = createStartupReporter({ stream, companionStreams: [] });

    reporter.degraded?.(phase({ state: "degraded", elapsedMs: 60_000 }));
    reporter.dispose();

    const output = text();
    expect(output).toContain("Media storage unavailable or delayed");
    expect(output).toContain("the server is live but not ready.");
    expect(output).toContain("operation: stat");
    expect(output).toContain("resource:  /Volumes/Expansion/media");
  });

  it("clips a line to the terminal width rather than wrapping it", () => {
    const { stream, text } = collector({ isTTY: true, columns: 40 });
    const reporter = createStartupReporter({ stream, companionStreams: [] });

    reporter.began?.(
      phase({ resource: "/Volumes/A-Very-Long-Volume-Name/media" }),
    );
    reporter.dispose();

    for (const line of text().split("\n")) {
      const visible = line.split(CLEAR_LINE).at(-1) ?? line;
      expect(visible.length).toBeLessThanOrEqual(40);
    }
  });

  it("stops the frame timer when the phase settles", () => {
    const scheduled: Array<() => void> = [];
    let cleared = 0;
    const { stream } = collector({ isTTY: true, columns: 200 });
    const reporter = createStartupReporter({
      stream,
      companionStreams: [],
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      unschedule: () => {
        cleared += 1;
      },
    });

    reporter.began?.(phase());
    expect(scheduled).toHaveLength(1);
    reporter.settled?.(phase({ state: "ready" }));
    expect(cleared).toBe(1);
    reporter.dispose();
  });
});

describe("formatting a duration", () => {
  it("uses the unit a person reads it in", () => {
    expect(formatElapsed(12)).toBe("12 ms");
    expect(formatElapsed(2_100)).toBe("2.1 s");
    expect(formatElapsed(64_000)).toBe("1m 04s");
  });
});
