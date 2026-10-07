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

import { safeSegment } from "../imports/importDestination";
import { isPathInsideRoot } from "../../pathSecurity";
import { BookRejectedError, decodeXmlText, openEpub } from "./epubArchive";

export { BookRejectedError };

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

export interface EpubMetadata {
  title: string | null;
  author: string | null;
  year: number | null;
  /** The publisher's blurb, as plain text; what a shared link shows. */
  description: string | null;
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
  const opf = openEpub(bytes).packageDocument;
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
  const text = decodeXmlText(
    value.replace(/<\/(p|div|br)\s*>|<br\s*\/?>/gi, " "),
  );
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
