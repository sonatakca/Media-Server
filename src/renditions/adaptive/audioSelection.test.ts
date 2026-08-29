import { describe, expect, it } from "vitest";
import { planAudioRenditions } from "./packager";
import type { RenditionMediaProbe } from "../probe";

function probe(
  audioTracks: RenditionMediaProbe["audioTracks"],
): RenditionMediaProbe {
  return {
    durationSeconds: 60,
    video: {
      streamIndex: 0,
      codec: "h264",
      width: 1920,
      height: 1080,
      rotation: 0,
      isHdr: false,
    },
    audioTracks,
    subtitleTracks: [],
    chapters: [],
  };
}

const track = (
  streamIndex: number,
  overrides: Partial<RenditionMediaProbe["audioTracks"][number]> = {},
): RenditionMediaProbe["audioTracks"][number] => ({
  streamIndex,
  codec: "aac",
  channels: 2,
  isDefault: false,
  isCommentary: false,
  isVisualImpaired: false,
  isOriginal: false,
  ...overrides,
});

describe("planAudioRenditions", () => {
  it("packages only the source default when nothing else is asked for", () => {
    const plan = planAudioRenditions(
      probe([track(1, { isDefault: true }), track(2)]),
    );

    expect(plan.outputs.map((output) => output.sourceStreamIndex)).toEqual([1]);
    expect(plan.deferred).toEqual([2]);
  });

  /**
   * The retention policy, not the packager, decides which languages survive.
   * The packager's job is to carry that decision out exactly.
   */
  it("packages exactly the streams the policy chose", () => {
    const plan = planAudioRenditions(
      probe([track(1, { isDefault: true }), track(2), track(3)]),
      { streamIndexes: [1, 3] },
    );

    expect(plan.outputs.map((output) => output.sourceStreamIndex)).toEqual([
      1, 3,
    ]);
    expect(plan.deferred).toEqual([2]);
  });

  it("makes the policy's first choice the default rendition", () => {
    const plan = planAudioRenditions(
      probe([track(1, { isDefault: true }), track(2, { language: "tur" })]),
      { streamIndexes: [2, 1] },
    );

    expect(plan.outputs[0]!.sourceStreamIndex).toBe(2);
    expect(plan.outputs[0]!.isDefault).toBe(true);
    expect(plan.outputs[1]!.isDefault).toBe(false);
  });

  it("takes precedence over the all-tracks flag", () => {
    const plan = planAudioRenditions(
      probe([track(1, { isDefault: true }), track(2), track(3)]),
      { allTracks: true, streamIndexes: [2] },
    );

    expect(plan.outputs.map((output) => output.sourceStreamIndex)).toEqual([2]);
  });

  /**
   * A stale selection must not silently produce a package with no audio at
   * all; falling back to the source default keeps the title playable.
   */
  it("falls back to the source default when the selection matches nothing", () => {
    const plan = planAudioRenditions(
      probe([track(1, { isDefault: true }), track(2)]),
      { streamIndexes: [99] },
    );

    expect(plan.outputs.map((output) => output.sourceStreamIndex)).toEqual([1]);
  });

  it("downmixes every selected track to the shared stereo ladder", () => {
    const plan = planAudioRenditions(
      probe([
        track(1, { isDefault: true, channels: 8 }),
        track(2, { channels: 6, codec: "eac3" }),
      ]),
      { streamIndexes: [1, 2] },
    );

    expect(plan.outputs.map((output) => output.channels)).toEqual([2, 2]);
  });
});
