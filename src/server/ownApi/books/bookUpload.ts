/**
 * A book somebody hands over from their own computer.
 *
 * The Books library is read from disk like every other library, so before this
 * existed the only way in was to copy a file onto the server itself. This puts
 * an EPUB where a person on that server would have put it — the configured
 * Books root — and leaves the rest to the same scan that finds a copied one.
 *
 * A caller never names a path. The destination is built from the book's own
 * metadata (`<Author>/<Title> (<Year>).epub`), so a file called
 * `9780141182803_v2-final.epub` still arrives under a name the scanner reads
 * back as its title.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { safeSegment } from "../imports/importDestination";
import { isPathInsideRoot } from "../../pathSecurity";

/**
 * Cloudflare's free plan refuses a request body over 100 MB before it reaches
 * the server, so a larger ceiling here would only move where the refusal comes
 * from. Real EPUBs are a few megabytes; illustrated ones rarely pass 50.
 */
export const MAX_BOOK_UPLOAD_BYTES = 95 * 1024 * 1024;

/** Same budget the importer keeps, for the same reason: Win32 readers. */
const MAX_RELATIVE_LENGTH = 200;
const MAX_TITLE_LENGTH = 120;
const MAX_AUTHOR_LENGTH = 60;
/** Generous: a comic-style EPUB can hold thousands of page images. */
const MAX_ENTRIES = 50_000;
/** container.xml and the package document are small; this is a ceiling, not a guess. */
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

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

export interface EpubMetadata {
  title: string | null;
  author: string | null;
  year: number | null;
  /** The publisher's blurb, as plain text; what a shared link shows. */
  description: string | null;
}

interface ZipEntry {
  flags: number;
  method: number;
  compressed: number;
  size: number;
  dataStart: number;
}

/**
 * The archive's directory, with every entry's bytes checked to be present.
 *
 * Nothing is inflated here. Checking each local header and its data range is
 * what catches an upload cut short in transit, which is the failure a person
 * would otherwise only meet later as a reader that will not open.
 */
function readZipDirectory(bytes: Buffer): Map<string, ZipEntry> {
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

  const entries = new Map<string, ZipEntry>();
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

function readEntryText(
  bytes: Buffer,
  entries: Map<string, ZipEntry>,
  name: string,
): string | null {
  const entry = entries.get(name);
  if (!entry) return null;
  if (entry.flags & 0x1)
    throw new BookRejectedError("This EPUB is encrypted and cannot be read.");
  if (entry.size > MAX_METADATA_BYTES)
    throw new BookRejectedError("The EPUB's description is too large.");
  const data = bytes.subarray(
    entry.dataStart,
    entry.dataStart + entry.compressed,
  );
  let content: Buffer;
  if (entry.method === 0) content = data;
  else if (entry.method === 8) {
    try {
      content = inflateRawSync(data, { maxOutputLength: MAX_METADATA_BYTES });
    } catch {
      throw new BookRejectedError("The EPUB is incomplete or damaged.");
    }
  } else
    throw new BookRejectedError("The EPUB uses an unsupported compression.");
  return content.toString("utf8").replace(/^\uFEFF/, "");
}

function decodeXmlText(value: string): string {
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

/** The first Dublin Core element of that name, whatever prefix it was given. */
function firstElement(metadata: string, element: string): string | null {
  const match = new RegExp(
    `<(?:[\\w-]+:)?${element}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${element}>`,
    "i",
  ).exec(metadata);
  const text = match ? decodeXmlText(match[1]!) : "";
  return text || null;
}

/**
 * Checks the archive is an EPUB a browser reader can open, and reads what the
 * book says about itself.
 */
export function readEpub(bytes: Buffer): EpubMetadata {
  const entries = readZipDirectory(bytes);

  const mimetype = readEntryText(bytes, entries, "mimetype");
  if (mimetype !== null && mimetype.trim() !== "application/epub+zip")
    throw new BookRejectedError("This is not an EPUB file.");

  const container = readEntryText(bytes, entries, "META-INF/container.xml");
  const packagePath = container
    ? /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(container)?.[1]
    : undefined;
  if (!packagePath)
    throw new BookRejectedError("This EPUB has no table of contents to open.");

  if (entries.has("META-INF/rights.xml"))
    throw new BookRejectedError(
      "This EPUB is copy-protected (DRM) and cannot be read here.",
    );
  const encryption = readEntryText(bytes, entries, "META-INF/encryption.xml");
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

  // full-path is a URL path, so a space in it may arrive as %20.
  let opfName = decodeXmlText(packagePath);
  if (!entries.has(opfName)) {
    try {
      opfName = decodeURIComponent(opfName);
    } catch {
      // Not percent-encoded after all; the lookup below reports it missing.
    }
  }
  const opf = readEntryText(bytes, entries, opfName);
  if (opf === null)
    throw new BookRejectedError("This EPUB has no table of contents to open.");
  const metadata =
    /<(?:[\w-]+:)?metadata\b[\s\S]*?<\/(?:[\w-]+:)?metadata>/i.exec(opf)?.[0] ??
    opf;

  const date = firstElement(metadata, "date");
  const year = date ? Number(/^\s*(\d{4})/.exec(date)?.[1]) : NaN;
  return {
    title: firstElement(metadata, "title"),
    author: firstElement(metadata, "creator"),
    // The scanner reads a year back only in this range; Calibre writes 0101 for "unknown".
    year: year >= 1900 && year <= 2199 ? year : null,
    description: plainDescription(firstElement(metadata, "description")),
  };
}

/**
 * Calibre and most publishers write the blurb as escaped HTML, so once the XML
 * is decoded it is markup again; it is stripped a second time to leave text.
 */
function plainDescription(value: string | null): string | null {
  if (!value) return null;
  const text = decodeXmlText(value.replace(/<\/(p|div|br)\s*>|<br\s*\/?>/gi, " "));
  return text || null;
}

function clip(value: string, length: number): string {
  return safeSegment(value.slice(0, length));
}

/** `<Author>/<Title> (<Year>).epub`, relative to the Books root. */
export function bookDestination(
  metadata: Pick<EpubMetadata, "title" | "author" | "year">,
  fallbackName: string,
): string {
  const fallback = fallbackName.replace(/\.epub$/i, "");
  const title =
    clip(metadata.title ?? "", MAX_TITLE_LENGTH) ||
    clip(fallback, MAX_TITLE_LENGTH) ||
    "Untitled";
  const author = clip(metadata.author ?? "", MAX_AUTHOR_LENGTH);
  const stem = metadata.year ? `${title} (${metadata.year})` : title;
  return author ? `${author}/${stem}.epub` : `${stem}.epub`;
}

export interface BookUploadResult {
  outcome: "added" | "duplicate";
  /** Relative to the media root, as the catalogue stores it. */
  relativePath: string;
  title: string | null;
  author: string | null;
}

export interface BookUploader {
  upload(bytes: Buffer, fileName: string): Promise<BookUploadResult>;
}

async function sha256OfFile(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function createBookUploader(options: {
  mediaRoot: string;
  /** The Books library root, relative to the media root. */
  booksRoot: string;
}): BookUploader {
  const mediaRoot = path.resolve(options.mediaRoot);
  const booksRoot = path.resolve(mediaRoot, options.booksRoot);

  return {
    async upload(bytes, fileName) {
      const metadata = readEpub(bytes);
      const destination = bookDestination(metadata, fileName);
      const target = path.resolve(booksRoot, ...destination.split("/"));
      const relativePath = path
        .relative(mediaRoot, target)
        .split(path.sep)
        .join("/");
      if (!isPathInsideRoot(booksRoot, target))
        throw new BookRejectedError("The book's name cannot be filed.");
      if (relativePath.length > MAX_RELATIVE_LENGTH)
        throw new BookRejectedError("The book's title is too long to file.");

      const result = (outcome: BookUploadResult["outcome"]) => ({
        outcome,
        relativePath,
        title: metadata.title,
        author: metadata.author,
      });
      const digest = createHash("sha256").update(bytes).digest("hex");
      const refuseOrDuplicate = async () => {
        if ((await sha256OfFile(target)) === digest) return result("duplicate");
        throw new BookRejectedError(
          `A different book is already filed as "${destination}".`,
        );
      };

      if (await exists(target)) return refuseOrDuplicate();

      await fs.mkdir(path.dirname(target), { recursive: true });
      /*
       * Written beside the destination under a name the scanner does not read,
       * flushed, then renamed. The media volume is exFAT, so there is no
       * hardlink to commit with; a crash leaves a `.part`, never half a book.
       */
      const temporary = path.join(
        path.dirname(target),
        `.seyirlik-upload-${randomUUID()}.part`,
      );
      try {
        const handle = await fs.open(temporary, "wx");
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Another upload of the same book may have landed while this one wrote.
        if (await exists(target)) return await refuseOrDuplicate();
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return result("added");
    },
  };
}
