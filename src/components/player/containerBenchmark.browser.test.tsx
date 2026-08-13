/**
 * Progressive MP4 versus fragmented MP4, measured rather than argued.
 *
 * The two files are the same encode: one source, remuxed twice with `-c copy`,
 * so codec, bitrate, resolution, duration, frame rate and GOP are identical and
 * the only variable is the container layout. Both are served over the same
 * range-capable origin, so transport is identical too.
 *
 * This exists to answer one question with numbers: how much of a rendition
 * switch's preparation cost is the progressive `moov`, and would fragmenting it
 * remove that cost without breaking native playback. It asserts only the
 * properties that must hold for the format to be usable at all — the timings it
 * prints are the point.
 */

import { afterEach, describe, expect, it } from "vitest";

const SOURCES = {
  progressive: "/test-media/bench-progressive.mp4",
  fragmented: "/test-media/bench-fragmented.mp4",
  fragmentedIndexed: "/test-media/bench-fragmented-sidx.mp4",
} as const;

/** Matches the generated pair; see the report for how they were produced. */
const EXPECTED_DURATION_SECONDS = 9326;

interface Measurement {
  layout: string;
  loadedMetadataMs: number;
  firstFrameMs: number;
  seekToMiddleMs: number;
  seekNearEndMs: number;
  durationSeconds: number;
  videoWidth: number;
  videoHeight: number;
  metadataBytes: number;
}

const mounted: HTMLVideoElement[] = [];

function createDeck(): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  // Full size and on-screen: a hidden or zero-sized element is not required to
  // decode, and measuring one would not describe what the player does.
  Object.assign(video.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "320px",
    height: "134px",
    opacity: "0.01",
  });
  document.body.appendChild(video);
  mounted.push(video);
  return video;
}

function once(video: HTMLVideoElement, event: string, timeoutMs = 120_000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${event}`)),
      timeoutMs,
    );
    video.addEventListener(
      event,
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function nextPresentedFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => resolve());
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Bytes before the first media payload: `ftyp` + `moov` for both layouts. */
async function readMetadataBytes(url: string): Promise<number> {
  const response = await fetch(url, { headers: { Range: "bytes=0-4095" } });
  const view = new DataView(await response.arrayBuffer());
  let offset = 0;
  let bytes = 0;

  while (offset + 8 <= view.byteLength) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );
    if (size < 8) break;
    if (type === "mdat" || type === "moof") break;
    bytes += size;
    offset += size;
    if (offset > view.byteLength - 8) break;
  }

  return bytes;
}

async function measure(layout: keyof typeof SOURCES): Promise<Measurement> {
  const url = SOURCES[layout];
  const metadataBytes = await readMetadataBytes(url);
  const video = createDeck();

  const startedAt = performance.now();
  video.src = url;
  video.load();
  await once(video, "loadedmetadata");
  const loadedMetadataMs = performance.now() - startedAt;

  const beforeFrame = performance.now();
  await video.play().catch(() => undefined);
  await nextPresentedFrame(video);
  video.pause();
  const firstFrameMs = performance.now() - beforeFrame;

  const middle = video.duration / 2;
  const beforeMiddle = performance.now();
  video.currentTime = middle;
  await once(video, "seeked");
  const seekToMiddleMs = performance.now() - beforeMiddle;

  const nearEnd = Math.max(0, video.duration - 30);
  const beforeEnd = performance.now();
  video.currentTime = nearEnd;
  await once(video, "seeked");
  const seekNearEndMs = performance.now() - beforeEnd;

  return {
    layout,
    loadedMetadataMs: Math.round(loadedMetadataMs),
    firstFrameMs: Math.round(firstFrameMs),
    seekToMiddleMs: Math.round(seekToMiddleMs),
    seekNearEndMs: Math.round(seekNearEndMs),
    durationSeconds: Math.round(video.duration),
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    metadataBytes,
  };
}

afterEach(() => {
  mounted.splice(0).forEach((video) => {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
  });
});

/**
 * The benchmark pair is ~2.5 GB and is generated on demand, not committed.
 * Build it with `npm run bench:containers` before running this file; without it
 * the comparison is skipped rather than failing a suite that has nothing to do
 * with the container question.
 */
async function fixturesPresent(): Promise<boolean> {
  const checks = await Promise.all(
    Object.values(SOURCES).map(async (url) => {
      try {
        const response = await fetch(url, { headers: { Range: "bytes=0-1" } });
        return response.ok || response.status === 206;
      } catch {
        return false;
      }
    }),
  );
  return checks.every(Boolean);
}

describe("progressive versus fragmented MP4", () => {
  it("measures both layouts of the same encode", async (context) => {
    if (!(await fixturesPresent())) {
      context.skip();
      return;
    }

    const progressive = await measure("progressive");
    const fragmented = await measure("fragmented");
    const fragmentedIndexed = await measure("fragmentedIndexed");

    console.info(
      "[container-benchmark]",
      JSON.stringify(
        {
          progressive,
          fragmented,
          fragmentedIndexed,
          metadataBytesRatio: Math.round(
            progressive.metadataBytes / Math.max(1, fragmented.metadataBytes),
          ),
          loadedMetadataSpeedup: +(
            progressive.loadedMetadataMs /
            Math.max(1, fragmented.loadedMetadataMs)
          ).toFixed(1),
        },
        null,
        1,
      ),
    );

    // Both layouts must remain natively playable and seekable, or the format is
    // not a candidate however fast its metadata is.
    for (const result of [progressive, fragmented, fragmentedIndexed]) {
      expect(
        Math.abs(result.durationSeconds - EXPECTED_DURATION_SECONDS),
      ).toBeLessThanOrEqual(2);
      expect(result.videoWidth).toBe(640);
      expect(result.videoHeight).toBe(268);
      expect(result.firstFrameMs).toBeGreaterThanOrEqual(0);
    }

    // The claim under test: the fragmented layout front-loads far less metadata.
    expect(fragmented.metadataBytes).toBeLessThan(
      progressive.metadataBytes / 100,
    );
  });
});
