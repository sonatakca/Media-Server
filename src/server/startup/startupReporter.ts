/**
 * What startup looks like from a terminal, and from a logfile a week later.
 *
 * These are different audiences and the same facts. A person watching
 * `npm run server` wants to know something is happening *now* — which phase,
 * how long, against what — and gets a line that ticks. An operator reading
 * `~/Library/Logs/Seyirlik/server.log` after the fact wants a record that
 * `grep` and `less` can read, which rules out cursor control entirely.
 *
 * So there are two renderers and one event stream. Nothing in the startup path
 * knows which is attached.
 *
 * ## Why the stream is wrapped
 *
 * The ticking line is the only cursor trick here, and it is only safe while
 * this reporter is the last thing that wrote. It is not: `createNativeRuntime`
 * logs artwork migrations, the storage guard warns about incident records, and
 * a Node deprecation notice can arrive at any moment. Each would land on top of
 * the live line, and the next frame would erase it.
 *
 * Wrapping `write` is how the live line finds out. A write that did not come
 * from here clears the line first and lets the output through; the frame after
 * it draws the line again, below. The wrapper is removed when startup ends, so
 * the running server writes to an untouched stdout.
 */

import type { StartupPhaseSnapshot } from "./startupState";
import type { StartupObserver } from "./startupCoordinator";

export interface StartupReporterStream {
  write(chunk: string): boolean;
  isTTY?: boolean;
  columns?: number;
}

export interface StartupReporter extends StartupObserver {
  /** The first thing the process says. Emitted before any phase begins. */
  processStarting(detail: { pid: number; moduleLoadMs?: number }): void;
  /** Restores the stream and stops the frame timer. Always call it. */
  dispose(): void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\u001B[2K";

/** Real durations, in the units a person reads them in. */
export function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Real progress only.
 *
 * There is no percentage for a `stat`, and inventing one — database is 20%,
 * storage 40% — would make the display less truthful than the blank it
 * replaced. A phase gets a figure here when it counted something.
 */
function formatProgress(phase: StartupPhaseSnapshot): string | null {
  const progress = phase.progress;
  if (!progress || progress.total <= 0) return null;
  const percentage = ((progress.completed / progress.total) * 100).toFixed(1);
  return `${progress.completed.toLocaleString("en-GB")} / ${progress.total.toLocaleString("en-GB")} · ${percentage}%`;
}

function quote(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function fields(phase: StartupPhaseSnapshot): string {
  const parts: string[] = [];
  if (phase.operation) parts.push(`operation=${phase.operation}`);
  if (phase.resource) parts.push(`resource=${quote(phase.resource)}`);
  if (phase.elapsedMs !== null) parts.push(`elapsedMs=${phase.elapsedMs}`);
  if (phase.attempt !== undefined) parts.push(`attempt=${phase.attempt}`);
  if (phase.progress) {
    parts.push(
      `completed=${phase.progress.completed}`,
      `total=${phase.progress.total}`,
    );
  }
  if (phase.detail) parts.push(`detail=${quote(phase.detail)}`);
  if (phase.error) parts.push(`error=${quote(phase.error)}`);
  return parts.join(" ");
}

export interface StartupReporterOptions {
  stream?: StartupReporterStream;
  /** Extra TTY streams to keep out of the live line. Defaults to stderr. */
  companionStreams?: StartupReporterStream[];
  /** Overrides the stream's own answer; tests set it explicitly. */
  tty?: boolean;
  now?: () => number;
  /** Redraw cadence for the live line. Never a log cadence. */
  frameIntervalMs?: number;
  /** Injected so a test need not run a real interval. */
  schedule?: (callback: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
}

export function createStartupReporter({
  stream = process.stdout as unknown as StartupReporterStream,
  companionStreams,
  tty,
  now = Date.now,
  frameIntervalMs = 120,
  schedule = (callback, ms) => {
    const handle = setInterval(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  unschedule = (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
}: StartupReporterOptions = {}): StartupReporter {
  const interactive = tty ?? stream.isTTY === true;
  const companions =
    companionStreams ??
    (stream === (process.stdout as unknown as StartupReporterStream) &&
    process.stderr.isTTY
      ? [process.stderr as unknown as StartupReporterStream]
      : []);

  let writingSelf = false;
  let liveLine: string | null = null;
  let livePhase: StartupPhaseSnapshot | null = null;
  let frame = 0;
  let frameTimer: unknown;
  let disposed = false;

  const raw = (text: string): void => {
    writingSelf = true;
    try {
      stream.write(text);
    } finally {
      writingSelf = false;
    }
  };

  const eraseLive = (): void => {
    if (liveLine === null) return;
    raw(CLEAR_LINE);
    liveLine = null;
  };

  /*
   * Every stream that shares the terminal is wrapped, not just ours. A
   * `console.warn` goes to stderr, which is the same glass, and an unwrapped
   * stderr write is exactly the case that leaves half a spinner on screen.
   */
  const restores: Array<() => void> = [];
  const guard = (target: StartupReporterStream): void => {
    const original = target.write;
    target.write = (chunk: string) => {
      if (!writingSelf) eraseLive();
      return original.call(target, chunk);
    };
    // The exact function that was there, so a second reporter — or a test —
    // finds the stream it started with rather than a wrapper of a wrapper.
    restores.push(() => {
      target.write = original;
    });
  };

  if (interactive) {
    guard(stream);
    for (const companion of companions) guard(companion);
  }

  const renderLive = (): void => {
    if (!interactive || livePhase === null || disposed) return;
    const elapsed =
      livePhase.startedAtMs === null ? 0 : now() - livePhase.startedAtMs;
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "◌";
    frame += 1;
    const progress = formatProgress(livePhase);
    const detail = [
      livePhase.operation ?? null,
      livePhase.resource ?? null,
      progress ?? formatElapsed(elapsed),
    ]
      .filter(Boolean)
      .join("  ");
    const text = `  ${spinner} ${livePhase.label}${detail ? `   ${detail}` : ""}`;
    const columns = stream.columns ?? 0;
    const clipped =
      columns > 2 && text.length > columns - 1
        ? `${text.slice(0, columns - 2)}…`
        : text;
    raw(liveLine === null ? clipped : `${CLEAR_LINE}${clipped}`);
    liveLine = clipped;
  };

  const startFrames = (): void => {
    if (!interactive || frameTimer !== undefined) return;
    frameTimer = schedule(renderLive, frameIntervalMs);
  };

  const stopFrames = (): void => {
    if (frameTimer === undefined) return;
    unschedule(frameTimer);
    frameTimer = undefined;
  };

  /** Commits the live line so the next output starts on a fresh one. */
  const commit = (): void => {
    if (liveLine === null) return;
    raw("\n");
    liveLine = null;
  };

  const line = (text: string): void => {
    eraseLive();
    raw(`${text}\n`);
  };

  const structured = (
    event: string,
    phase: StartupPhaseSnapshot | null,
    extra = "",
  ): void => {
    const timestamp = new Date(now()).toISOString();
    const body = [
      phase ? `${phase.id} ${event}` : event,
      phase ? fields(phase) : "",
      extra,
    ]
      .filter(Boolean)
      .join(" ");
    raw(`${timestamp} [Seyirlik startup] ${body}\n`);
  };

  const symbolFor = (phase: StartupPhaseSnapshot): string => {
    switch (phase.state) {
      case "ready":
        return "✓";
      case "failed":
        return "✗";
      case "cancelled":
        return "·";
      case "degraded":
        return "⚠";
      default:
        return "◌";
    }
  };

  const prettySettled = (phase: StartupPhaseSnapshot): void => {
    const elapsed =
      phase.elapsedMs === null ? "" : formatElapsed(phase.elapsedMs);
    const tail = phase.error
      ? `   ${phase.error}`
      : elapsed
        ? `   ${elapsed}`
        : "";
    line(`  ${symbolFor(phase)} ${phase.label}${tail}`);
  };

  const prettyWaiting = (
    phase: StartupPhaseSnapshot,
    headline: string,
  ): void => {
    const elapsed =
      phase.elapsedMs === null ? "" : ` — ${formatElapsed(phase.elapsedMs)}`;
    line(`  ⚠ ${headline}${elapsed}`);
    if (phase.operation) line(`      operation: ${phase.operation}`);
    if (phase.resource) line(`      resource:  ${phase.resource}`);
  };

  return {
    processStarting({ pid, moduleLoadMs }) {
      if (interactive) {
        line("");
        line("Seyirlik — starting");
        if (moduleLoadMs !== undefined) {
          line(`  · modules loaded in ${formatElapsed(moduleLoadMs)}`);
        }
        line("");
        return;
      }
      structured(
        "process starting",
        null,
        [
          `pid=${pid}`,
          moduleLoadMs === undefined
            ? ""
            : `moduleLoadMs=${Math.round(moduleLoadMs)}`,
        ]
          .filter(Boolean)
          .join(" "),
      );
    },

    began(phase) {
      if (!interactive) {
        structured("started", phase);
        return;
      }
      commit();
      livePhase = phase;
      frame = 0;
      renderLive();
      startFrames();
    },

    slow(phase) {
      if (!interactive) {
        structured("slow", phase);
        return;
      }
      livePhase = phase;
      prettyWaiting(phase, `${phase.label} is unusually slow`);
    },

    waiting(phase) {
      if (!interactive) {
        structured("waiting", phase);
        return;
      }
      livePhase = phase;
      prettyWaiting(phase, `Still waiting for ${phase.label.toLowerCase()}`);
    },

    degraded(phase) {
      if (!interactive) {
        structured("degraded", phase);
        return;
      }
      livePhase = phase;
      prettyWaiting(phase, `${phase.label} unavailable or delayed`);
      line("      the server is live but not ready.");
    },

    settled(phase) {
      if (!interactive) {
        structured(phase.state, phase);
        return;
      }
      if (livePhase?.id === phase.id) {
        livePhase = null;
        stopFrames();
      }
      prettySettled(phase);
    },

    live(snapshot) {
      const listener = snapshot.phases.find((phase) => phase.id === "listener");
      if (!interactive) {
        structured(
          "live",
          null,
          listener?.resource ? `resource=${quote(listener.resource)}` : "",
        );
        return;
      }
      line("  · the HTTP listener is answering; startup continues.");
    },

    finished(snapshot) {
      const blocking = snapshot.phases.find(
        (phase) => phase.state === "failed" || phase.state === "degraded",
      );
      if (!interactive) {
        structured(
          snapshot.state,
          null,
          [
            `elapsedMs=${snapshot.elapsedMs}`,
            `ready=${snapshot.ready}`,
            blocking ? `phase=${blocking.id}` : "",
            blocking?.error ? `error=${quote(blocking.error)}` : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
        return;
      }
      livePhase = null;
      stopFrames();
      commit();
      line("");
      if (snapshot.ready) {
        line(`  ✓ Seyirlik is ready — ${formatElapsed(snapshot.elapsedMs)}`);
      } else if (snapshot.state === "failed") {
        line(
          `  ✗ Seyirlik startup failed${blocking ? ` at ${blocking.label.toLowerCase()}` : ""}.`,
        );
        if (blocking?.error) line(`      ${blocking.error}`);
      } else if (snapshot.state === "stopping") {
        line("  · Seyirlik stopped before startup finished.");
      } else {
        line(
          `  ⚠ Seyirlik is live but not ready${blocking ? ` — ${blocking.label.toLowerCase()}` : ""}.`,
        );
      }
      line("");
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopFrames();
      commit();
      while (restores.length > 0) restores.pop()?.();
    },
  };
}
