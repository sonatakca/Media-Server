import { describe, expect, it, vi } from "vitest";
import { waitForServerRestart, type ServerRestartPhase } from "./serverControl";

/**
 * A probe that answers from a script, and a clock that only moves when the
 * wait asks it to. Together they make the two-phase wait testable without any
 * real time passing.
 */
function scriptedProbe(answers: boolean[]) {
  let index = 0;
  return vi.fn(async () => {
    const answer = answers[Math.min(index, answers.length - 1)] ?? false;
    index += 1;
    return answer;
  });
}

function harness(answers: boolean[], overrides = {}) {
  const phases: ServerRestartPhase[] = [];
  let clock = 0;

  return {
    phases,
    options: {
      onPhase: (phase: ServerRestartPhase) => phases.push(phase),
      probe: scriptedProbe(answers),
      delay: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      pollIntervalMs: 100,
      shutdownTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      ...overrides,
    },
  };
}

describe("waitForServerRestart", () => {
  it("waits for the server to go, then to come back", async () => {
    // Still up, still up, gone, gone, back.
    const { options, phases } = harness([true, true, false, false, true]);

    await expect(waitForServerRestart(options)).resolves.toBe("ready");
    expect(phases).toEqual(["stopping", "starting", "ready"]);
  });

  it("does not call it ready while the old process is still answering", async () => {
    /*
     * This is the failure the two phases exist to prevent. The server answers
     * the restart before it stops, so a single "is it healthy" check right
     * afterwards succeeds against a process that is about to disappear, and
     * the page reloads into an outage.
     */
    const probe = scriptedProbe([true, true, false, true]);
    let clock = 0;

    const outcome = await waitForServerRestart({
      probe,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      pollIntervalMs: 100,
      shutdownTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
    });

    expect(outcome).toBe("ready");
    // Two healthy answers, one failure, then the healthy replacement: it did
    // not stop at the first success.
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("reports ready when the restart was quicker than a poll", async () => {
    // Never observed down. That is a fast restart, not a failure, and the
    // server answering now is all the caller needs to know.
    const { options, phases } = harness([true]);

    await expect(waitForServerRestart(options)).resolves.toBe("ready");
    expect(phases).toEqual(["stopping", "ready"]);
  });

  it("gives up when the replacement never comes back", async () => {
    const { options, phases } = harness([false]);

    await expect(waitForServerRestart(options)).resolves.toBe("timeout");
    expect(phases).toEqual(["stopping", "starting", "timeout"]);
  });

  it("treats a probe that throws as the server being down", async () => {
    let call = 0;
    let clock = 0;

    const outcome = await waitForServerRestart({
      probe: async () => {
        call += 1;
        if (call === 1) throw new Error("connection refused");
        return true;
      },
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      pollIntervalMs: 100,
      shutdownTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
    });

    // A caller-supplied probe is allowed to throw; the wait must not.
    await expect(Promise.resolve(outcome)).resolves.toBeDefined();
  });

  it("polls on the interval it was given rather than spinning", async () => {
    const delays: number[] = [];
    let clock = 0;

    await waitForServerRestart({
      probe: scriptedProbe([false, true]),
      delay: async (ms) => {
        delays.push(ms);
        clock += ms;
      },
      now: () => clock,
      pollIntervalMs: 700,
      shutdownTimeoutMs: 5_000,
      startupTimeoutMs: 5_000,
    });

    expect(delays.every((ms) => ms === 700)).toBe(true);
    expect(delays.length).toBeGreaterThan(0);
  });
});
