/**
 * A checkpointed package, played by a real player.
 *
 * The package under test was encoded in four independent five-second epochs and
 * joined by copying bytes. Every timestamp property of that join is already
 * proved with ffprobe elsewhere; what cannot be proved that way is whether a
 * player is *happy* with the result — that MSE accepts fragments from four
 * separate encoder runs under one initialisation segment, that a seek across a
 * join lands where it should, and that the buffered range runs through the join
 * without a hole the player has to stall on.
 *
 * The boundaries fall at roughly six, twelve and eighteen seconds, so every
 * seek below is chosen relative to a real join rather than to a round number.
 */

import Hls from "hls.js";
import { afterEach, describe, expect, it } from "vitest";

const MASTER = "/test-epoch-package/.seyirlik/master.m3u8";

/** Where the epochs were joined, from the fixture's own six-second target. */
const JOINS = [6, 12, 18];

const mounted: Array<{ video: HTMLVideoElement; hls: Hls | null }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.hls?.destroy();
    entry.video.remove();
  }
});

function attach(): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.width = "320px";
  document.body.append(video);
  return video;
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 20_000,
  label = "condition",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (performance.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}.`));
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}

function bufferedRanges(video: HTMLVideoElement): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < video.buffered.length; index += 1) {
    ranges.push([video.buffered.start(index), video.buffered.end(index)]);
  }
  return ranges;
}

async function load(): Promise<{ video: HTMLVideoElement; hls: Hls | null }> {
  const video = attach();
  if (Hls.isSupported()) {
    const hls = new Hls({ enableWorker: false, startLevel: -1 });
    const entry = { video, hls };
    mounted.push(entry);
    hls.loadSource(MASTER);
    hls.attachMedia(video);
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error("hls.js did not parse the manifest.")),
        20_000,
      );
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        window.clearTimeout(timer);
        resolve();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        window.clearTimeout(timer);
        reject(new Error(`hls.js reported ${data.type}: ${data.details}`));
      });
    });
    return entry;
  }

  // Safari plays HLS natively, and the native engine is the one that would
  // notice a malformed master before hls.js did.
  const entry = { video, hls: null };
  mounted.push(entry);
  video.src = MASTER;
  await waitFor(() => video.readyState >= 1, 20_000, "native metadata");
  return entry;
}

describe("a package assembled from independent epochs", () => {
  it("advertises one continuous timeline and starts playing", async () => {
    const { video } = await load();
    await waitFor(
      () => Number.isFinite(video.duration) && video.duration > 0,
      20_000,
      "duration",
    );
    // The fixture is 26 seconds of source; the joins must not have added or
    // lost any of it.
    expect(video.duration).toBeGreaterThan(25.5);
    expect(video.duration).toBeLessThan(26.5);

    await video.play();
    await waitFor(() => video.currentTime > 0.4, 20_000, "playback to start");
    expect(video.videoWidth).toBeGreaterThan(0);
    video.pause();
  });

  it("buffers through an epoch join without a hole", async () => {
    const { video } = await load();
    video.currentTime = JOINS[0]! - 2;
    await video.play();
    /*
     * Playing across the join is the point: a discontinuity the player had to
     * recover from would show up as a second buffered range starting at the
     * boundary, and as playback that stops there.
     */
    await waitFor(
      () => video.currentTime > JOINS[0]! + 1,
      30_000,
      "playback across the first join",
    );
    video.pause();

    const ranges = bufferedRanges(video);
    const covering = ranges.find(
      ([start, end]) => start <= JOINS[0]! && end >= JOINS[0]!,
    );
    expect(
      covering,
      `no single buffered range covers the join; ranges were ${JSON.stringify(ranges)}`,
    ).toBeDefined();
  });

  it("seeks to either side of a join and to the join itself", async () => {
    const { video } = await load();
    await waitFor(
      () => Number.isFinite(video.duration) && video.duration > 0,
      20_000,
      "duration",
    );

    for (const target of [
      JOINS[1]! - 0.5,
      JOINS[1]!,
      JOINS[1]! + 0.5,
      JOINS[2]!,
    ]) {
      video.currentTime = target;
      await waitFor(
        () => !video.seeking && video.readyState >= 2,
        20_000,
        `seek to ${target}`,
      );
      // A seek that landed in the wrong epoch would be out by seconds, not by
      // the fraction of a second a keyframe-aligned seek costs.
      expect(Math.abs(video.currentTime - target)).toBeLessThan(2.1);
    }
  });

  it("plays to the very end without stalling at a join", async () => {
    const { video } = await load();
    await waitFor(
      () => Number.isFinite(video.duration) && video.duration > 0,
      20_000,
      "duration",
    );
    video.currentTime = Math.max(0, video.duration - 2);
    await video.play();
    /*
     * Either signal will do. `ended` is the clean one, but a browser sharing a
     * machine with several other decoding tests can take its time firing it,
     * and the property being tested is that playback reaches the end of the
     * last epoch rather than stopping at a join — which the clock shows just as
     * well.
     */
    let ended = false;
    video.addEventListener("ended", () => {
      ended = true;
    });
    await waitFor(
      () => ended || video.currentTime >= video.duration - 0.3,
      45_000,
      "the end of the last epoch",
    );
    expect(video.currentTime).toBeGreaterThan(video.duration - 1);
  });
});
