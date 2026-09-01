import { describe, expect, it, vi } from "vitest";
import {
  createRestartController,
  parseRestartConfig,
  type RestartConfig,
} from "./restartController";

function config(overrides: Partial<RestartConfig> = {}): RestartConfig {
  return { mode: "respawn", exitCode: 0, graceMs: 0, ...overrides };
}

/**
 * The controller is driven entirely through injected effects, so a test can
 * watch the order they happen in without ending the process running it.
 */
function build(overrides: Partial<RestartConfig> = {}, hooks = {}) {
  const order: string[] = [];
  const close = vi.fn(async () => {
    order.push("close");
  });
  const spawnReplacement = vi.fn(() => {
    order.push("spawn");
  });
  const exit = vi.fn(() => {
    order.push("exit");
  });
  const logger = { info: vi.fn(), error: vi.fn() };

  const controller = createRestartController({
    config: config(overrides),
    close,
    spawnReplacement,
    exit,
    delay: async () => undefined,
    logger,
    ...hooks,
  });

  return { controller, close, spawnReplacement, exit, logger, order };
}

describe("parseRestartConfig", () => {
  it("respawns by default, which is what a bare `npm run server` needs", () => {
    expect(parseRestartConfig({}).mode).toBe("respawn");
  });

  it("switches to supervisor under systemd rather than double-starting", () => {
    // systemd sets INVOCATION_ID for every unit it starts. Respawning under a
    // unit with a restart policy would leave two servers on one port.
    expect(parseRestartConfig({ INVOCATION_ID: "abc123" }).mode).toBe(
      "supervisor",
    );
  });

  it("switches to supervisor under launchd, which the Mac deployment uses", () => {
    // launchd names the job in XPC_SERVICE_NAME. Respawning under a KeepAlive
    // job is the same double-start systemd would suffer.
    expect(
      parseRestartConfig({ XPC_SERVICE_NAME: "org.seyirlik.server" }).mode,
    ).toBe("supervisor");
  });

  it("does not mistake a login shell for launchd", () => {
    // A shell inherits XPC_SERVICE_NAME=0, which names no job at all; reading
    // it as a supervisor would leave the restart button with nothing to start
    // the replacement.
    expect(parseRestartConfig({ XPC_SERVICE_NAME: "0" }).mode).toBe("respawn");
  });

  it("lets an explicit setting win over the detection", () => {
    expect(
      parseRestartConfig({
        INVOCATION_ID: "abc123",
        SEYIRLIK_RESTART_MODE: "respawn",
      }).mode,
    ).toBe("respawn");
  });

  it("accepts every documented mode, case-insensitively", () => {
    expect(parseRestartConfig({ SEYIRLIK_RESTART_MODE: "disabled" }).mode).toBe(
      "disabled",
    );
    expect(
      parseRestartConfig({ SEYIRLIK_RESTART_MODE: " Supervisor " }).mode,
    ).toBe("supervisor");
  });

  it("treats an empty value as unset", () => {
    expect(parseRestartConfig({ SEYIRLIK_RESTART_MODE: "  " }).mode).toBe(
      "respawn",
    );
  });

  it("rejects a mode it does not know", () => {
    expect(() =>
      parseRestartConfig({ SEYIRLIK_RESTART_MODE: "reboot" }),
    ).toThrow(/SEYIRLIK_RESTART_MODE/);
  });

  it("exits zero, because a requested restart is a clean stop", () => {
    expect(parseRestartConfig({}).exitCode).toBe(0);
  });
});

describe("restart controller", () => {
  it("reports what it can do before anything is asked of it", () => {
    expect(build().controller.status()).toEqual({
      mode: "respawn",
      available: true,
      inProgress: false,
    });
  });

  it("is unavailable and refuses when restarts are disabled", async () => {
    const { controller, close, spawnReplacement, exit } = build({
      mode: "disabled",
    });

    const result = controller.request();
    await controller.settled();

    expect(result).toEqual({
      mode: "disabled",
      available: false,
      accepted: false,
      inProgress: false,
    });
    expect(close).not.toHaveBeenCalled();
    expect(spawnReplacement).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("returns before doing any of the work, so the response can be sent", () => {
    const { controller, close, exit } = build();

    expect(controller.request().accepted).toBe(true);
    // Nothing has happened yet on this tick; the caller still has a live socket.
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  describe("respawn mode", () => {
    it("closes, then starts the replacement, then exits", async () => {
      const { controller, order } = build({ mode: "respawn" });

      controller.request();
      await controller.settled();

      // The order is the whole point: the replacement binds the same port, so
      // spawning before the close would lose the race with EADDRINUSE.
      expect(order).toEqual(["close", "spawn", "exit"]);
    });

    it("exits with the configured status", async () => {
      const { controller, exit } = build({ mode: "respawn", exitCode: 0 });

      controller.request();
      await controller.settled();

      expect(exit).toHaveBeenCalledWith(0);
    });

    it("still exits when the shutdown throws, and says why", async () => {
      const { controller, order, logger, spawnReplacement } = build(
        { mode: "respawn" },
        {
          close: async () => {
            throw new Error("the pool would not close");
          },
        },
      );

      controller.request();
      await controller.settled();

      // A half-closed server that stays running is worse than one that goes.
      expect(spawnReplacement).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["spawn", "exit"]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("the pool would not close"),
      );
    });

    it("logs a replacement that could not be started", async () => {
      const { controller, exit, logger } = build(
        { mode: "respawn" },
        {
          spawnReplacement: () => {
            throw new Error("spawn ENOENT");
          },
        },
      );

      controller.request();
      await controller.settled();

      // Nothing is listening by now, so the log line is the only record.
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("spawn ENOENT"),
      );
      expect(exit).toHaveBeenCalled();
    });
  });

  describe("supervisor mode", () => {
    it("closes and exits without starting anything itself", async () => {
      const { controller, order, spawnReplacement } = build({
        mode: "supervisor",
      });

      controller.request();
      await controller.settled();

      expect(spawnReplacement).not.toHaveBeenCalled();
      expect(order).toEqual(["close", "exit"]);
    });
  });

  describe("a second press", () => {
    it("is accepted without restarting twice", async () => {
      const { controller, close, spawnReplacement, exit } = build();

      const first = controller.request();
      const second = controller.request();
      await controller.settled();

      expect(first.accepted).toBe(true);
      expect(second).toMatchObject({ accepted: true, inProgress: true });
      expect(close).toHaveBeenCalledTimes(1);
      expect(spawnReplacement).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it("shows as in progress once one has been accepted", () => {
      const { controller } = build();

      expect(controller.status().inProgress).toBe(false);
      controller.request();
      expect(controller.status().inProgress).toBe(true);
    });
  });

  it("waits out the grace period before closing anything", async () => {
    const delays: number[] = [];
    const { controller, close } = build(
      { graceMs: 250 },
      {
        delay: async (ms: number) => {
          delays.push(ms);
        },
      },
    );

    controller.request();
    await controller.settled();

    // The 202 has to reach the browser before the socket goes.
    expect(delays).toEqual([250]);
    expect(close).toHaveBeenCalled();
  });
});
