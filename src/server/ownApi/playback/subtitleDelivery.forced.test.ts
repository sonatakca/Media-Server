// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractSubtitleAsWebVtt } from "./subtitleDelivery";

/**
 * Forced subtitles are the case most easily mistaken for a broken track: a
 * correct forced rendition is blank for almost the whole film and carries only
 * a handful of cues. Judging one by "is anything on screen" reports every
 * healthy forced track as empty, so the cue windows themselves are asserted.
 */

const FORCED_SRT = [
  "1",
  "00:00:05,000 --> 00:00:09,000",
  "Forced English subtitle test.",
  "",
  "2",
  "00:00:21,000 --> 00:00:25,000",
  "Forced-track selection marker.",
  "",
].join("\n");

const TURKISH_SRT = [
  "1",
  "00:00:00,000 --> 00:00:03,879",
  "Fremenler çöl alanlarını geçerler, kum yürüyüşünü kullanarak.",
  "",
  "2",
  "00:00:11,178 --> 00:00:15,474",
  "Arrakis'te var olan kıt bitki yaşamı, Fremenler sayesindedir.",
  "",
].join("\n");

let ffmpegAvailable = true;
let mediaPath = "";

interface Cue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

function toSeconds(stamp: string): number {
  const [minutesPart, secondsPart] = stamp.split(":").slice(-2);
  const hours = stamp.split(":").length > 2 ? Number(stamp.split(":")[0]) : 0;
  return hours * 3600 + Number(minutesPart) * 60 + Number(secondsPart);
}

function parseCues(webVtt: string): Cue[] {
  const cues: Cue[] = [];
  const lines = webVtt.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([\d:.]+)\s+-->\s+([\d:.]+)/.exec(lines[index] ?? "");
    if (!match) continue;
    const text: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      if ((lines[next] ?? "").trim() === "") break;
      text.push(lines[next]!.trim());
    }
    cues.push({
      startSeconds: toSeconds(match[1]!),
      endSeconds: toSeconds(match[2]!),
      text: text.join(" "),
    });
  }
  return cues;
}

/** The cue a player would paint at this instant, or nothing. */
function cueAt(cues: Cue[], seconds: number): string {
  return (
    cues.find((cue) => seconds >= cue.startSeconds && seconds < cue.endSeconds)
      ?.text ?? ""
  );
}

beforeAll(() => {
  const workDir = mkdtempSync(path.join(tmpdir(), "seyirlik-forced-subs-"));
  const forcedPath = path.join(workDir, "forced.srt");
  const turkishPath = path.join(workDir, "turkish.srt");
  mediaPath = path.join(workDir, "fixture.mkv");
  writeFileSync(forcedPath, FORCED_SRT, "utf8");
  writeFileSync(turkishPath, TURKISH_SRT, "utf8");

  try {
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x180:r=24:d=30",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-i",
        forcedPath,
        "-i",
        turkishPath,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-map",
        "2:s",
        "-map",
        "3:s",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-c:s",
        "srt",
        // `-t` rather than `-shortest`: with an endless silent input the
        // shortest-stream rule stops the muxer before the late forced cue is
        // written, and the fixture would then hide the very gap it exists to
        // prove.
        "-t",
        "30",
        "-disposition:s:0",
        "forced",
        "-metadata:s:s:0",
        "language=eng",
        "-metadata:s:s:0",
        "title=English Forced Test",
        "-metadata:s:s:1",
        "language=tur",
        mediaPath,
      ],
      { stdio: "ignore" },
    );
  } catch {
    ffmpegAvailable = false;
  }
});

describe("forced subtitle extraction", () => {
  it("extracts the forced track as WebVTT", async () => {
    if (!ffmpegAvailable) return;
    const webVtt = (await extractSubtitleAsWebVtt(mediaPath, 2)).toString(
      "utf8",
    );

    expect(webVtt.startsWith("WEBVTT")).toBe(true);
    expect(parseCues(webVtt)).toHaveLength(2);
  });

  it("keeps the forced cue inside its own window and blank outside it", async () => {
    if (!ffmpegAvailable) return;
    const cues = parseCues(
      (await extractSubtitleAsWebVtt(mediaPath, 2)).toString("utf8"),
    );

    expect(cueAt(cues, 1)).toBe("");
    expect(cueAt(cues, 4.9)).toBe("");
    expect(cueAt(cues, 5)).toBe("Forced English subtitle test.");
    expect(cueAt(cues, 7)).toBe("Forced English subtitle test.");
    expect(cueAt(cues, 8.9)).toBe("Forced English subtitle test.");
    expect(cueAt(cues, 9)).toBe("");
    expect(cueAt(cues, 12)).toBe("");
    expect(cueAt(cues, 22)).toBe("Forced-track selection marker.");
  });

  it("preserves the exact cue boundaries the source declares", async () => {
    if (!ffmpegAvailable) return;
    const cues = parseCues(
      (await extractSubtitleAsWebVtt(mediaPath, 2)).toString("utf8"),
    );

    expect(cues[0]!.startSeconds).toBeCloseTo(5, 2);
    expect(cues[0]!.endSeconds).toBeCloseTo(9, 2);
    expect(cues[1]!.startSeconds).toBeCloseTo(21, 2);
    expect(cues[1]!.endSeconds).toBeCloseTo(25, 2);
  });

  it("extracts only the requested track, not the whole subtitle set", async () => {
    if (!ffmpegAvailable) return;
    const forced = (await extractSubtitleAsWebVtt(mediaPath, 2)).toString(
      "utf8",
    );
    const turkish = (await extractSubtitleAsWebVtt(mediaPath, 3)).toString(
      "utf8",
    );

    expect(forced).not.toContain("Fremenler");
    expect(turkish).not.toContain("Forced English subtitle test.");
  });

  it("round-trips Turkish characters through the WebVTT conversion", async () => {
    if (!ffmpegAvailable) return;
    const turkish = (await extractSubtitleAsWebVtt(mediaPath, 3)).toString(
      "utf8",
    );

    expect(turkish).toContain("Fremenler çöl alanlarını geçerler");
    expect(turkish).toContain("Arrakis'te var olan kıt bitki yaşamı");
    expect(turkish).not.toContain("�");
  });
});
