/**
 * Getting subtitle files out of what a provider sends.
 *
 * Providers commonly hand over a ZIP — one subtitle, or a whole season's worth.
 * The reader is deliberately small: stored and deflated entries only, no ZIP64,
 * no encryption, and hard ceilings on entry count and inflated size, checked
 * while inflating rather than trusted from the header, because a header's
 * sizes are the attacker's to write. Anything else — RAR, 7z — is refused as
 * unsupported so the pipeline moves on to the next candidate.
 */
import { inflateRawSync } from "node:zlib";
import { MAX_SUBTITLE_BYTES } from "./subtitlePayload";

export class ArchiveUnsupportedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ArchiveUnsupportedError";
  }
}

export interface ArchiveEntry {
  /** The entry's own file name, without any directory part. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

const MAX_ENTRIES = 500;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SUBTITLE_NAME = /\.(srt|vtt)$/i;

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function isZip(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

/** RAR 4/5 and 7z: recognised so they can be refused by name. */
function archiveKind(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return "RAR";
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
  return null;
}

/** The subtitle entries of a ZIP, or the payload itself when it is not one. */
export function subtitleEntries(
  bytes: Uint8Array,
  fallbackName: string,
): ArchiveEntry[] {
  const other = archiveKind(bytes);
  if (other)
    throw new ArchiveUnsupportedError(`${other} archives are not supported.`);
  if (!isZip(bytes)) return [{ name: fallbackName, bytes }];

  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is within the last 64 KiB + 22 bytes.
  let end = -1;
  for (let i = view.length - 22; i >= Math.max(0, view.length - 65_557); i--) {
    if (view.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ArchiveUnsupportedError("The ZIP has no directory.");
  const count = view.readUInt16LE(end + 10);
  let offset = view.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES)
    throw new ArchiveUnsupportedError("The ZIP holds too many files.");

  const entries: ArchiveEntry[] = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > view.length || view.readUInt32LE(offset) !== 0x02014b50)
      throw new ArchiveUnsupportedError("The ZIP directory is damaged.");
    const flags = view.readUInt16LE(offset + 8);
    const method = view.readUInt16LE(offset + 10);
    const compressed = view.readUInt32LE(offset + 20);
    const size = view.readUInt32LE(offset + 24);
    const nameLength = view.readUInt16LE(offset + 28);
    const extraLength = view.readUInt16LE(offset + 30);
    const commentLength = view.readUInt16LE(offset + 32);
    const local = view.readUInt32LE(offset + 42);
    const rawName = view.subarray(offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    // Names are UTF-8 when bit 11 says so, otherwise CP437 — ASCII covers what matters.
    const fullName = rawName.toString(flags & 0x800 ? "utf8" : "latin1");
    const name = fullName.split(/[\\/]/).pop() ?? "";
    if (!SUBTITLE_NAME.test(name) || fullName.startsWith("__MACOSX")) continue;
    if (flags & 0x1) throw new ArchiveUnsupportedError("The ZIP is encrypted.");
    if (compressed === 0xffffffff || size === 0xffffffff)
      throw new ArchiveUnsupportedError("ZIP64 archives are not supported.");
    if (size > MAX_SUBTITLE_BYTES) continue;

    if (local + 30 > view.length || view.readUInt32LE(local) !== 0x04034b50)
      throw new ArchiveUnsupportedError("The ZIP is damaged.");
    const dataStart =
      local +
      30 +
      view.readUInt16LE(local + 26) +
      view.readUInt16LE(local + 28);
    const data = view.subarray(dataStart, dataStart + compressed);
    if (data.length !== compressed)
      throw new ArchiveUnsupportedError("The ZIP is truncated.");
    let content: Buffer;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) {
      try {
        content = inflateRawSync(data, { maxOutputLength: MAX_SUBTITLE_BYTES });
      } catch {
        continue;
      }
    } else continue;
    if (content.length !== size) continue;
    total += content.length;
    if (total > MAX_TOTAL_BYTES)
      throw new ArchiveUnsupportedError("The ZIP inflates to too much.");
    entries.push({ name, bytes: new Uint8Array(content) });
  }
  return entries;
}

/**
 * Subtitle text as UTF-8.
 *
 * The validator downstream accepts UTF-8 only and must not guess. This is where
 * a guess is not one: a provider's language says which legacy code page its
 * uploads use. Turkish subtitles are overwhelmingly Windows-1254 — `ı`, `ş`,
 * `ğ` exist in no other common single-byte encoding — so a Turkish file that
 * is not UTF-8 is decoded as that and nothing else.
 */
export function toUtf8(bytes: Uint8Array, language: string): Uint8Array {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextEncoder().encode(new TextDecoder("utf-16le").decode(bytes));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextEncoder().encode(new TextDecoder("utf-16be").decode(bytes));
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes;
  } catch {
    const legacy = language === "tur" ? "windows-1254" : "windows-1252";
    return new TextEncoder().encode(new TextDecoder(legacy).decode(bytes));
  }
}
