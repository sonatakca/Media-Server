import type { SubtitleCue } from "./types";

function decodeCueText(rawText: string): string {
  const textWithLineBreaks = rawText
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(b|i|u|c|lang|ruby|rt)[^>]*>/gi, "")
    .replace(/<\/?v[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");

  const textarea = document.createElement("textarea");
  textarea.innerHTML = textWithLineBreaks;
  return textarea.value.trim();
}

function parseSubtitleTimestamp(rawTimestamp: string): number | null {
  const timestamp = rawTimestamp.trim().replace(",", ".");
  const parts = timestamp.split(":");

  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length > 0 ? Number(parts.pop()) : 0;

  if (![hours, minutes, seconds].every(Number.isFinite)) {
    return null;
  }

  if (minutes < 0 || minutes > 59 || seconds < 0) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

export function parseSubtitleCues(rawText: string): SubtitleCue[] {
  const normalizedText = rawText
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const blocks = normalizedText.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  blocks.forEach((block) => {
    const lines = block
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line, index) => index > 0 || line.trim() !== "WEBVTT");

    const firstLine = lines[0]?.trim().toUpperCase() ?? "";

    if (
      !firstLine ||
      firstLine === "WEBVTT" ||
      firstLine.startsWith("NOTE") ||
      firstLine === "STYLE" ||
      firstLine === "REGION"
    ) {
      return;
    }

    const timingLineIndex = lines.findIndex((line) => line.includes("-->"));
    const timingLine = timingLineIndex >= 0 ? lines[timingLineIndex] : "";
    const timingMatch = timingLine.match(/^(.+?)\s*-->\s*(\S+)/);

    if (!timingMatch) {
      return;
    }

    const start = parseSubtitleTimestamp(timingMatch[1]);
    const end = parseSubtitleTimestamp(timingMatch[2]);
    const text = lines
      .slice(timingLineIndex + 1)
      .join("\n")
      .trim();

    if (start === null || end === null || end <= start || !text) {
      return;
    }

    cues.push({ start, end, text });
  });

  return cues.sort((left, right) => left.start - right.start);
}

export function getActiveSubtitleTextForTime(
  cues: SubtitleCue[],
  currentTime: number,
): string {
  const activeTexts = cues
    .filter((cue) => cue.start <= currentTime && cue.end >= currentTime)
    .map((cue) => decodeCueText(cue.text))
    .filter(Boolean);

  return activeTexts.join("\n");
}

export function disableNativeVideoTextTracks(video: HTMLVideoElement): void {
  for (let index = 0; index < video.textTracks.length; index += 1) {
    const track = video.textTracks[index];
    track.mode = "disabled";
  }
}
