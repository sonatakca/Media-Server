/**
 * Reading an EPUB's archive: the zip directory, single entries, and the
 * package document every reader starts from.
 *
 * Shared by the upload check, which only needs the package's metadata, and the
 * search index, which reads every section of the book. Both refuse the same
 * books for the same reasons.
 */

import { inflateRawSync } from "node:zlib";

/** Generous: a comic-style EPUB can hold thousands of page images. */
const MAX_ENTRIES = 50_000;

/**
 * The two algorithms `encryption.xml` uses for font obfuscation, which every
 * reader undoes. Anything else listed there is DRM, and the book cannot be read.
 */
const FONT_OBFUSCATION = new Set([
  "http://www.idpf.org/2008/embedding",
  "http://ns.adobe.com/pdf/enc#RC",
]);

export class BookRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BookRejectedError";
  }
}

interface ZipEntry {
  flags: number;
  method: number;
  compressed: number;
  size: number;
  dataStart: number;
}

export type ZipDirectory = Map<string, ZipEntry>;

/**
 * The archive's directory, with every entry's bytes checked to be present.
 *
 * Nothing is inflated here. Checking each local header and its data range is
 * what catches an upload cut short in transit, which is the failure a person
 * would otherwise only meet later as a reader that will not open.
 */
function readZipDirectory(bytes: Buffer): ZipDirectory {
  const isZip =
    bytes.length >= 22 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04;
  if (!isZip) throw new BookRejectedError("This is not an EPUB file.");

  let end = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 65_557);
    i--
  ) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0)
    throw new BookRejectedError("The EPUB is incomplete or damaged.");

  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff)
    throw new BookRejectedError("This EPUB is too large to be read here.");
  if (count > MAX_ENTRIES)
    throw new BookRejectedError("The EPUB holds too many files.");

  const entries: ZipDirectory = new Map();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new BookRejectedError("The EPUB is incomplete or damaged.");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString(flags & 0x800 ? "utf8" : "latin1");
    offset += 46 + nameLength + extraLength + commentLength;

    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50)
      throw new BookRejectedError("The EPUB is incomplete or damaged.");
    const dataStart =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    if (dataStart + compressed > bytes.length)
      throw new BookRejectedError("The EPUB is incomplete or damaged.");

    entries.set(name, { flags, method, compressed, size, dataStart });
  }
  return entries;
}

/**
 * One entry's text, or null when the archive has no such entry. `maxBytes` is
 * the most the entry may inflate to; `tooLarge` is what to say when it does not.
 */
export function readEntryText(
  bytes: Buffer,
  entries: ZipDirectory,
  name: string,
  maxBytes: number,
  tooLarge: string,
): string | null {
  const entry = entries.get(name);
  if (!entry) return null;
  if (entry.flags & 0x1)
    throw new BookRejectedError("This EPUB is encrypted and cannot be read.");
  if (entry.size > maxBytes) throw new BookRejectedError(tooLarge);
  const data = bytes.subarray(
    entry.dataStart,
    entry.dataStart + entry.compressed,
  );
  let content: Buffer;
  if (entry.method === 0) content = data;
  else if (entry.method === 8) {
    try {
      content = inflateRawSync(data, { maxOutputLength: maxBytes });
    } catch {
      throw new BookRejectedError("The EPUB is incomplete or damaged.");
    }
  } else
    throw new BookRejectedError("The EPUB uses an unsupported compression.");
  return content.toString("utf8").replace(/^\uFEFF/, "");
}

export function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** container.xml and the package document are small; this is a ceiling, not a guess. */
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const METADATA_TOO_LARGE = "The EPUB's description is too large.";

export interface OpenedEpub {
  entries: ZipDirectory;
  /** The package document's name inside the archive. */
  packageName: string;
  /** The package document (OPF) itself. */
  packageDocument: string;
}

/**
 * Checks the archive is an EPUB a browser reader can open, and finds its
 * package document.
 */
export function openEpub(bytes: Buffer): OpenedEpub {
  const entries = readZipDirectory(bytes);
  const readSmall = (name: string) =>
    readEntryText(bytes, entries, name, MAX_METADATA_BYTES, METADATA_TOO_LARGE);

  const mimetype = readSmall("mimetype");
  if (mimetype !== null && mimetype.trim() !== "application/epub+zip")
    throw new BookRejectedError("This is not an EPUB file.");

  const container = readSmall("META-INF/container.xml");
  const packagePath = container
    ? /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(container)?.[1]
    : undefined;
  if (!packagePath)
    throw new BookRejectedError("This EPUB has no table of contents to open.");

  if (entries.has("META-INF/rights.xml"))
    throw new BookRejectedError(
      "This EPUB is copy-protected (DRM) and cannot be read here.",
    );
  const encryption = readSmall("META-INF/encryption.xml");
  if (encryption) {
    const algorithms = [
      ...encryption.matchAll(
        /<(?:[\w-]+:)?EncryptionMethod\b[^>]*\bAlgorithm\s*=\s*["']([^"']+)["']/gi,
      ),
    ].map((match) => match[1]!);
    if (algorithms.some((algorithm) => !FONT_OBFUSCATION.has(algorithm)))
      throw new BookRejectedError(
        "This EPUB is copy-protected (DRM) and cannot be read here.",
      );
  }

  const packageName = entryName(entries, decodeXmlText(packagePath));
  const packageDocument = readSmall(packageName);
  if (packageDocument === null)
    throw new BookRejectedError("This EPUB has no table of contents to open.");
  return { entries, packageName, packageDocument };
}

/**
 * An archive path as a book names it. Book paths are URL paths, so a space may
 * arrive as %20; the name is decoded only when that is what finds the entry.
 */
export function entryName(entries: ZipDirectory, name: string): string {
  if (entries.has(name)) return name;
  try {
    return decodeURIComponent(name);
  } catch {
    // Not percent-encoded after all; the caller's lookup reports it missing.
    return name;
  }
}
