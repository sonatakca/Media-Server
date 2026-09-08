// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaybackRefreshBoundary } from "./playbackRefresh";

const change = {
  mediaFileId: "synthetic-media-id",
  kind: "subtitles" as const,
};
afterEach(() => vi.useRealTimers());

describe("optional playback refresh", () => {
  it("truthfully reports unconfigured without any external work", async () => {
    const boundary = createPlaybackRefreshBoundary();
    expect(boundary.configured).toBe(false);
    expect(await boundary.request(change)).toEqual({ outcome: "unconfigured" });
  });
  it("passes only catalogue identity and change type to the adapter", async () => {
    const refresh = vi.fn(async () => {});
    const boundary = createPlaybackRefreshBoundary({ adapter: { refresh } });
    expect(boundary.configured).toBe(true);
    expect(
      await boundary.request({
        ...change,
        untrustedPath: "not forwarded",
      } as typeof change),
    ).toEqual({ outcome: "refreshed" });
    expect(refresh).toHaveBeenCalledWith(change, expect.any(AbortSignal));
  });
  it("contains external exceptions without exposing credentials or error bodies", async () => {
    const boundary = createPlaybackRefreshBoundary({
      adapter: {
        refresh: async () => {
          throw new Error("Authorization: secret; <html>error</html>");
        },
      },
    });
    expect(await boundary.request(change)).toEqual({ outcome: "unavailable" });
  });
  it("bounds an adapter that ignores cancellation and ignores its late failure", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let reject: (error: Error) => void = () => {};
    const boundary = createPlaybackRefreshBoundary({
      timeoutMs: 100,
      adapter: {
        refresh: async (_change, received) => {
          signal = received;
          return new Promise((_, no) => {
            reject = no;
          });
        },
      },
    });
    const result = boundary.request(change);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ outcome: "timeout" });
    expect(signal?.aborted).toBe(true);
    reject(new Error("late sensitive error"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start a refresh for an already cancelled caller", async () => {
    const refresh = vi.fn(async () => {});
    expect(
      await createPlaybackRefreshBoundary({ adapter: { refresh } }).request(
        change,
        AbortSignal.abort(),
      ),
    ).toEqual({ outcome: "cancelled" });
    expect(refresh).not.toHaveBeenCalled();
  });
  it("cancels an in-flight refresh without turning it into core failure", async () => {
    const controller = new AbortController();
    const boundary = createPlaybackRefreshBoundary({
      adapter: {
        refresh: async (_change, signal) => {
          controller.abort();
          expect(signal.aborted).toBe(true);
          return new Promise(() => {});
        },
      },
    });
    expect(await boundary.request(change, controller.signal)).toEqual({
      outcome: "cancelled",
    });
  });
  it.each([0, -1, NaN, Infinity, 1.5, 300001])(
    "rejects invalid timeout %s",
    (timeoutMs) => {
      expect(() => createPlaybackRefreshBoundary({ timeoutMs })).toThrow(
        "timeout",
      );
    },
  );
});
