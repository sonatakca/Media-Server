/**
 * Deciding whether what a provider sent is a subtitle.
 *
 * This is the trust boundary of the whole subsystem. Everything upstream is a
 * remote server's word; everything downstream writes a file next to somebody's
 * media. So nothing the provider *said* is believed here — not the format it
 * declared, not the filename it suggested, not the content type. The bytes are
 * read, and either they parse as a subtitle or they do not.
 *
 * The commonest hostile payload is not malicious, it is an HTML error page: a
 * provider that has rate-limited you, or expired your session, frequently
 * answers 200 with a login form. Installed unchecked, that becomes a `.srt`
 * full of markup sitting beside a film, and the only symptom is a viewer
 * seeing nothing.
 */

import type { SubtitlePayload } from "./subtitleProvider";
import type { SubtitleFailureClass, SubtitleFormat } from "./subtitleState";

/**
 * Four megabytes.
 *
 * A three-hour film's subtitles are perhaps 150 KB. This is far above anything
 * legitimate and far below anything that threatens the process, which is the
 * right place for a ceiling whose job is to stop a provider handing over a
 * video file or a decompression bomb.
 */
export const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;

/**
 * The formats this system will actually write beside media.
 *
 * Narrower than `DOWNLOADABLE_SUBTITLE_FORMATS` on purpose, and the difference
 * is meaningful: a provider may legitimately offer ASS, and Seyirlik may
 * legitimately fetch one to look at, but installing it means owning its styling
 * blocks, its embedded fonts and its script directives. Until that is built, an
 * ASS payload is refused as *unsupported* rather than as *invalid* — which lets
 * the pipeline move to the next candidate instead of failing the want.
 */
export const INSTALLABLE_SUBTITLE_FORMATS: readonly SubtitleFormat[] = [
  "srt",
  "vtt",
];

/**
 * Why a payload was refused.
 *
 * Two classes rather than one, because they mean different things to the
 * caller: `payload-unsupported-format` says this candidate is no good, and
 * `payload-invalid` says the provider is not sending subtitles at all — which,
 * repeated across candidates, is how a dead session announces itself.
 */
export class InvalidSubtitleError extends Error {
  readonly failure: SubtitleFailureClass;
  /** Safe for a log and an operator. Never any of the payload's own text. */
  readonly reason: string;
  constructor(failure: SubtitleFailureClass, reason: string) {
    super(reason);
    this.name = "InvalidSubtitleError";
    this.failure = failure;
    this.reason = reason;
  }
}

function invalid(reason: string): never {
  throw new InvalidSubtitleError("payload-invalid", reason);
}

function unsupported(reason: string): never {
  throw new InvalidSubtitleError("payload-unsupported-format", reason);
}

/**
 * Markup that means this is a web page rather than a subtitle.
 *
 * Tested against the decoded text rather than the raw bytes, so a byte-order
 * mark or leading whitespace cannot hide it.
 */
const LOOKS_LIKE_MARKUP =
  /<!doctype\b|<\/?(?:html|head|body|script|iframe|form|title)\b/i;

/** Control characters a text subtitle never contains. Tab and newline are fine. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

const BYTE_ORDER_MARK = /^\uFEFF/;

const SRT_TIMING = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/;
const VTT_TIMING = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;

export interface ValidatedSubtitle {
  readonly bytes: Uint8Array;
  readonly format: "srt" | "vtt";
  /** Cues found, so a caller can report "installed, 842 cues". */
  readonly cueCount: number;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    /*
     * Deliberately strict. Subtitles in the wild are frequently CP1254 or
     * latin-1, and guessing an encoding here would write mojibake beside the
     * media under this system's own name. A provider that cannot send UTF-8 is
     * a provider whose candidate is skipped, which is recoverable; a silently
     * mis-decoded file is not.
     */
    return invalid("The payload is not valid UTF-8.");
  }
}

function timestampSeconds(value: string, format: "srt" | "vtt"): number {
  const pattern = format === "srt" ? SRT_TIMING : VTT_TIMING;
  const found = pattern.exec(value.trim());
  if (!found) invalid("A cue timestamp is not in the expected form.");
  const [, hours, minutes, seconds, millis] = found as RegExpExecArray;
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(millis) / 1000
  );
}

/**
 * Which format the *bytes* are, ignoring what was claimed.
 *
 * A `WEBVTT` signature and an ASS `[Script Info]` header are both definitive.
 * Everything else that parses at all is treated as SubRip, which is what the
 * overwhelming majority of subtitle downloads are.
 *
 * ASS is recognised even though it cannot be installed, so that refusing one
 * says *unsupported* rather than *invalid*. The difference decides whether the
 * pipeline tries the next candidate or concludes the provider is broken.
 */
function sniffFormat(text: string): SubtitleFormat {
  if (/^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/.test(text)) return "vtt";
  if (/^\s*\[Script Info\]/i.test(text)) return "ass";
  return "srt";
}

/**
 * The payload, or a refusal.
 *
 * Returns the bytes it was given rather than the text it parsed. Reserialising
 * would silently rewrite somebody's subtitle, and the only thing that needed
 * establishing is that the bytes are what they claim to be.
 */
export function validateSubtitle(payload: SubtitlePayload): ValidatedSubtitle {
  if (payload.bytes.length === 0) invalid("The payload is empty.");
  if (payload.bytes.length > MAX_SUBTITLE_BYTES) {
    invalid(
      `The payload is larger than the ${MAX_SUBTITLE_BYTES}-byte ceiling.`,
    );
  }

  const decoded = decodeUtf8(payload.bytes);
  const text = decoded
    .replace(BYTE_ORDER_MARK, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (text === "") invalid("The payload holds no text.");
  if (LOOKS_LIKE_MARKUP.test(text)) {
    // Overwhelmingly a login form or an error page answered with a 200.
    invalid("The payload is a web page, not a subtitle.");
  }
  if (FORBIDDEN_CONTROL.test(text)) {
    invalid("The payload contains control characters a subtitle never has.");
  }

  const sniffed = sniffFormat(text);

  /*
   * The declared format is not trusted to *select* the parser, but a
   * disagreement is still worth refusing outright: a provider that says one
   * format and sends another is one whose metadata cannot be relied on for
   * anything else either, including the language — and the language is what
   * decides the filename this ends up under.
   */
  if (payload.declaredFormat !== null && payload.declaredFormat !== sniffed) {
    invalid("The payload is not the format the provider declared.");
  }

  if (!INSTALLABLE_SUBTITLE_FORMATS.includes(sniffed)) {
    unsupported(`Subtitles in ${sniffed} are not installed yet.`);
  }
  const format: "srt" | "vtt" = sniffed === "vtt" ? "vtt" : "srt";

  const body =
    format === "vtt" ? text.slice(text.indexOf("\n") + 1).trimStart() : text;

  const blocks = body.split(/\n{2,}/).filter((block) => block.trim() !== "");
  if (blocks.length === 0) invalid("The payload contains no cues.");

  let cueCount = 0;
  for (const block of blocks) {
    const lines = block.split("\n");
    /*
     * SubRip numbers its cues and WebVTT may name them; either way the line
     * before the timing is an identifier, and only the timing line matters.
     */
    if (lines[0] !== undefined && !lines[0].includes("-->")) lines.shift();

    const timing = lines.shift();
    if (timing === undefined || !timing.includes("-->")) {
      invalid("A cue has no timing line.");
    }
    const [from, to] = (timing as string).split("-->");
    if (from === undefined || to === undefined) {
      invalid("A cue timing line is malformed.");
    }
    /*
     * WebVTT allows cue settings after the end timestamp — `line:90%`,
     * `align:start`. They are not this system's business, but they must not
     * make the timestamp unparseable.
     */
    const end =
      format === "vtt"
        ? ((to as string).trim().split(/\s+/)[0] ?? "")
        : (to as string);
    if (
      timestampSeconds(end, format) <= timestampSeconds(from as string, format)
    ) {
      invalid("A cue ends no later than it starts.");
    }
    if (lines.join("\n").trim() === "") invalid("A cue has no text.");
    cueCount += 1;
  }

  return { bytes: new Uint8Array(payload.bytes), format, cueCount };
}
