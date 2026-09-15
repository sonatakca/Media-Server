/**
 * A subtitle document, read so that only its timings can be rewritten.
 *
 * Retiming is the one operation that edits somebody's subtitle rather than
 * replacing it, so the parser here is built around a different promise from the
 * validator's: **everything that is not a timestamp comes back out unchanged.**
 * A `STYLE` block, a `NOTE`, a translator's credit, a cue's positioning
 * settings, the blank line somebody left between two cues — none of it is
 * understood, and none of it is dropped. The document is a list of blocks, each
 * either a cue this module can move or an opaque run of text it will hand back
 * verbatim.
 *
 * That is why this exists beside `subtitlePayload.ts` rather than inside it.
 * The validator answers "are these bytes a subtitle at all", which is a
 * question about a stranger's payload and is allowed to be strict and lossy.
 * This answers "where are the timings in this file somebody already trusts",
 * and being lossy here would mean the sync feature quietly stripped styling out
 * of every file it touched.
 */

/** The two formats this system installs, and therefore the two it can retime. */
export type SubtitleCueFormat = "srt" | "vtt";

export interface TimedCue {
  readonly kind: "cue";
  startSeconds: number;
  endSeconds: number;
  /**
   * The lines before the timing line — a SubRip sequence number, a WebVTT cue
   * identifier — kept together because nothing here needs to tell them apart.
   */
  readonly lead: readonly string[];
  /** Whatever followed the end timestamp on the timing line. WebVTT settings. */
  readonly settings: string;
  readonly text: readonly string[];
}

/** A block this module does not understand and will not touch. */
export interface RawBlock {
  readonly kind: "raw";
  readonly text: string;
}

export type SubtitleBlock = TimedCue | RawBlock;

export interface SubtitleDocument {
  readonly format: SubtitleCueFormat;
  readonly blocks: readonly SubtitleBlock[];
  /** How the file separated its lines, so the rewrite keeps the same shape. */
  readonly newline: "\n" | "\r\n";
}

/**
 * Both timestamp spellings, in one pattern.
 *
 * SubRip writes a comma and WebVTT a full stop, and files in the wild mix them
 * — a `.srt` exported by a tool that thought in WebVTT is extremely common. The
 * parser accepts either in either format and the writer emits the one the
 * format calls for, which quietly repairs such a file as a side effect of
 * touching it.
 */
const TIMESTAMP = /^(?:(\d{1,4}):)?([0-5]\d):([0-5]\d)[.,](\d{1,3})$/;

const TIMING_LINE =
  /^((?:\d{1,4}:)?[0-5]\d:[0-5]\d[.,]\d{1,3})[ \t]*-->[ \t]*((?:\d{1,4}:)?[0-5]\d:[0-5]\d[.,]\d{1,3})(.*)$/;

export function parseCueTimestamp(value: string): number | null {
  const found = TIMESTAMP.exec(value.trim());
  if (!found) return null;
  const [, hours, minutes, seconds, fraction] = found as RegExpExecArray;
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number((fraction as string).padEnd(3, "0")) / 1000
  );
}

/**
 * `HH:MM:SS,mmm` for SubRip and `HH:MM:SS.mmm` for WebVTT.
 *
 * Hours are always written even when zero. WebVTT permits leaving them out and
 * a great many files do, but a document whose cues change length as they pass
 * the hour is harder to diff than one that does not, and every player accepts
 * the long form.
 */
export function formatCueTimestamp(
  seconds: number,
  format: SubtitleCueFormat,
): string {
  const clamped = Math.max(0, seconds);
  // Rounded once, into whole milliseconds, before anything is split off it:
  // splitting first and rounding the remainder is what writes `00:00:09.1000`.
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const whole = (totalMs - ms) / 1000;
  const parts = [
    Math.floor(whole / 3600),
    Math.floor((whole % 3600) / 60),
    whole % 60,
  ].map((part) => String(part).padStart(2, "0"));
  return `${parts.join(":")}${format === "srt" ? "," : "."}${String(
    ms,
  ).padStart(3, "0")}`;
}

/**
 * Which format a document is, from the bytes rather than from a filename.
 *
 * The same rule `subtitlePayload` applies: a `WEBVTT` signature is definitive
 * and everything else that parses at all is SubRip. A file called `.srt` whose
 * first line is `WEBVTT` is a WebVTT file, and writing SubRip timings back into
 * it would produce something neither format's parser accepts.
 */
export function sniffCueFormat(text: string): SubtitleCueFormat {
  return /^\uFEFF?WEBVTT(?:[ \t][^\n]*)?(?:\r?\n|$)/.test(text) ? "vtt" : "srt";
}

/**
 * Reads a document into blocks.
 *
 * Nothing is refused. A run of text with no timing line in it is a raw block,
 * which is how the WebVTT header, `NOTE` and `STYLE` blocks, and any malformed
 * cue all survive a rewrite without this module having to recognise them. A
 * caller that needs to know whether the file is usable asks how many cues came
 * back.
 */
export function parseSubtitleDocument(text: string): SubtitleDocument {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const normalised = text.replace(/\r\n?/g, "\n");
  const blocks: SubtitleBlock[] = [];
  for (const raw of normalised.split(/\n{2,}/)) {
    /*
     * The newlines around a block belong to the separator, not to the block.
     * Leaving the trailing one attached makes the file's last cue carry an
     * empty final line of text, which the writer then renders as an extra blank
     * line — and a document that grows a line every time it is touched is not
     * one anybody can diff.
     */
    const block = raw.replace(/^\n+|\n+$/g, "");
    if (block.trim() === "") continue;
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => TIMING_LINE.test(line));
    const timing =
      timingIndex < 0 ? null : TIMING_LINE.exec(lines[timingIndex] as string);
    const startSeconds = timing ? parseCueTimestamp(timing[1] as string) : null;
    const endSeconds = timing ? parseCueTimestamp(timing[2] as string) : null;
    if (startSeconds === null || endSeconds === null) {
      blocks.push({ kind: "raw", text: block });
      continue;
    }
    blocks.push({
      kind: "cue",
      startSeconds,
      endSeconds,
      lead: lines.slice(0, timingIndex),
      settings: (timing?.[3] ?? "").trim(),
      text: lines.slice(timingIndex + 1),
    });
  }
  return { format: sniffCueFormat(normalised), blocks, newline };
}

export function documentCues(document: SubtitleDocument): TimedCue[] {
  return document.blocks.filter((block): block is TimedCue => isCue(block));
}

function isCue(block: SubtitleBlock): block is TimedCue {
  return block.kind === "cue";
}

/**
 * Writes the document back out.
 *
 * A WebVTT file that somehow lost its signature regains one, because a document
 * without it is not WebVTT and this is the last place that can notice. Nothing
 * else is added, reordered or normalised.
 */
export function serialiseSubtitleDocument(document: SubtitleDocument): string {
  const rendered = document.blocks.map((block) =>
    isCue(block)
      ? [
          ...block.lead,
          `${formatCueTimestamp(block.startSeconds, document.format)} --> ${formatCueTimestamp(
            block.endSeconds,
            document.format,
          )}${block.settings ? ` ${block.settings}` : ""}`,
          ...block.text,
        ].join("\n")
      : block.text,
  );
  const first = rendered[0];
  const needsSignature =
    document.format === "vtt" &&
    (first === undefined || !/^\uFEFF?WEBVTT\b/.test(first));
  const body = (needsSignature ? ["WEBVTT", ...rendered] : rendered).join(
    "\n\n",
  );
  return `${body}\n`.replace(/\n/g, document.newline);
}

/** How a subtitle's timeline is mapped onto the media's: `t · rate + offset`. */
export interface CueTransform {
  /**
   * The multiplier, for a subtitle timed against a differently-paced print.
   *
   * One means the two timelines run at the same speed and only the origin is
   * wrong, which is the overwhelmingly common case. A film transferred between
   * 23.976 and 25 frames per second gives 1.0427, and nothing else in between
   * is a round number.
   */
  readonly rate: number;
  /** Seconds added after scaling. Negative moves the subtitle earlier. */
  readonly offsetSeconds: number;
}

export interface RetimeReport {
  readonly blocks: readonly SubtitleBlock[];
  /** Cues that ended before the media began and could not be kept. */
  readonly dropped: number;
  /** Cues that began before zero and were held at it. */
  readonly clamped: number;
}

/**
 * Moves every cue onto the media's timeline.
 *
 * Two edge cases are decided here rather than left to the writer. A cue pushed
 * entirely before zero is **dropped**: there is no such moment in the media, and
 * a pile of cues stacked on the first frame is worse than their absence. A cue
 * that merely *starts* before zero is held at zero and keeps its end, because
 * it is a real line of dialogue over the opening frames and truncating its lead
 * is the smaller lie.
 */
export function retimeBlocks(
  blocks: readonly SubtitleBlock[],
  transform: CueTransform,
): RetimeReport {
  const kept: SubtitleBlock[] = [];
  let dropped = 0;
  let clamped = 0;
  for (const block of blocks) {
    if (!isCue(block)) {
      kept.push(block);
      continue;
    }
    const start = block.startSeconds * transform.rate + transform.offsetSeconds;
    const end = block.endSeconds * transform.rate + transform.offsetSeconds;
    if (end <= 0) {
      dropped += 1;
      continue;
    }
    if (start < 0) clamped += 1;
    kept.push({
      ...block,
      startSeconds: Math.max(0, start),
      endSeconds: end,
    });
  }
  return { blocks: kept, dropped, clamped };
}

/** The intervals a document's cues occupy, which is all the aligner reads. */
export function cueIntervals(
  cues: readonly TimedCue[],
): { startSeconds: number; endSeconds: number }[] {
  return cues
    .filter((cue) => cue.endSeconds > cue.startSeconds)
    .map((cue) => ({
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
    }))
    .sort((left, right) => left.startSeconds - right.startSeconds);
}
