// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createStartupState,
  describeStartupError,
  toPublicStartupSnapshot,
  type StartupPhaseDefinition,
} from "./startupState";

const PHASES: StartupPhaseDefinition[] = [
  { id: "configuration", label: "Runtime configuration" },
  { id: "listener", label: "HTTP listener" },
  { id: "media-storage", label: "Media storage" },
];

function clock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("the startup record", () => {
  it("starts neither live nor ready, with every phase pending", () => {
    const state = createStartupState({ phases: PHASES });
    const snapshot = state.snapshot();

    expect(snapshot).toMatchObject({
      live: false,
      ready: false,
      state: "starting",
      phase: null,
    });
    expect(snapshot.phases.map((phase) => phase.state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("separates liveness from readiness", () => {
    const state = createStartupState({ phases: PHASES });
    state.markLive();

    // The listener answers; nothing else is up. That distinction is the whole
    // reason this file exists.
    expect(state.snapshot()).toMatchObject({ live: true, ready: false });
  });

  it("records when a phase started and what it is waiting on", () => {
    const time = clock();
    const state = createStartupState({ phases: PHASES, now: time.now });

    state.begin("media-storage", {
      operation: "stat",
      resource: "/Volumes/Expansion/media",
    });
    time.advance(2_100);

    expect(state.snapshot().phases[2]).toMatchObject({
      state: "running",
      operation: "stat",
      resource: "/Volumes/Expansion/media",
      elapsedMs: 2_100,
    });
    expect(state.snapshot().phase).toBe("media-storage");
  });

  it("freezes the duration when the phase completes", () => {
    const time = clock();
    const state = createStartupState({ phases: PHASES, now: time.now });

    state.begin("configuration");
    time.advance(12);
    state.complete("configuration");
    time.advance(5_000);

    expect(state.snapshot().phases[0]).toMatchObject({
      state: "ready",
      elapsedMs: 12,
    });
  });

  it("completes a phase once and only once", () => {
    const state = createStartupState({ phases: PHASES });
    state.begin("configuration");

    expect(state.complete("configuration")).toBe(true);
    expect(state.complete("configuration")).toBe(false);
    // A failure arriving after the completion must not rewrite history either.
    expect(state.fail("configuration", new Error("late"))).toBe(false);
    expect(state.snapshot().phases[0]?.state).toBe("ready");
  });

  it("keeps a degraded phase running, and lets it recover", () => {
    const state = createStartupState({ phases: PHASES });
    state.begin("media-storage", { operation: "stat" });

    expect(state.degrade("media-storage", "No answer yet.")).toBe(true);
    expect(state.snapshot()).toMatchObject({ state: "degraded", ready: false });
    expect(state.snapshot().phases[2]?.state).toBe("degraded");

    /*
     * The volume answered at last. Degrading never cancelled the `stat`, so
     * this is a real outcome rather than a retry, and the phase settles.
     */
    expect(state.complete("media-storage")).toBe(true);
    expect(state.snapshot().phases[2]?.state).toBe("ready");
  });

  it("refuses to degrade a phase that has already settled", () => {
    const state = createStartupState({ phases: PHASES });
    state.begin("configuration");
    state.complete("configuration");

    expect(state.degrade("configuration", "too late")).toBe(false);
    expect(state.snapshot().phases[0]?.state).toBe("ready");
  });

  it("is ready only when every phase is", () => {
    const state = createStartupState({ phases: PHASES });
    for (const phase of PHASES) {
      expect(state.snapshot().ready).toBe(false);
      state.begin(phase.id);
      state.complete(phase.id);
    }

    expect(state.snapshot()).toMatchObject({ ready: true, state: "ready" });
  });

  it("records a failure with a safe message and stops being ready", () => {
    const state = createStartupState({ phases: PHASES });
    state.begin("media-storage");
    state.fail(
      "media-storage",
      new Error(
        "ENOENT: no such file or directory, stat '/Volumes/Expansion/media'",
      ),
    );

    const phase = state.snapshot().phases[2];
    expect(phase?.state).toBe("failed");
    expect(phase?.error).not.toContain("/Volumes");
    expect(state.snapshot().state).toBe("failed");
  });

  it("cancels what was open when shutdown begins, and never becomes ready after", () => {
    const state = createStartupState({ phases: PHASES });
    state.begin("configuration");
    state.complete("configuration");
    state.begin("media-storage");

    state.stop();

    expect(state.stopping).toBe(true);
    expect(state.snapshot().phases[2]?.state).toBe("cancelled");
    // The volume answering after SIGTERM must not make a departing process
    // claim it can serve.
    state.complete("media-storage");
    state.begin("listener");
    state.complete("listener");
    expect(state.snapshot()).toMatchObject({ ready: false, state: "stopping" });
  });
});

describe("what the public health endpoint may see", () => {
  it("drops the resource, which is where the storage path lives", () => {
    const state = createStartupState({ phases: PHASES });
    state.begin("media-storage", {
      operation: "stat",
      resource: "/Volumes/Expansion/media",
      detail: "Checking the configured media root.",
    });

    const published = toPublicStartupSnapshot(state.snapshot());

    expect(JSON.stringify(published)).not.toContain("/Volumes");
    // Everything a browser can act on survives the trip.
    expect(published.phases[2]).toMatchObject({
      id: "media-storage",
      operation: "stat",
      detail: "Checking the configured media root.",
    });
  });
});

describe("describing an error safely", () => {
  it("keeps one line, drops paths and URLs, and bounds the length", () => {
    const described = describeStartupError(
      new Error(
        "connect ECONNREFUSED at postgres://user:pw@db.local/seyirlik\nstack line",
      ),
    );

    expect(described).not.toContain("postgres://");
    expect(described).not.toContain("stack line");
    expect(described.length).toBeLessThanOrEqual(240);
  });

  it("never returns an empty string", () => {
    expect(describeStartupError(new Error("/tmp/only-a-path"))).toBe(
      "The startup step did not complete.",
    );
  });
});
