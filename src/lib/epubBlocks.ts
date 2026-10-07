/**
 * The block-level pieces of a book's section, in reading order.
 *
 * A saved place and a search result both name a block by its index in this
 * list, so the reader and the server must count the same blocks. This is the
 * one definition both use: the reader on the document epub.js renders, the
 * server on the same markup parsed by jsdom. It touches no browser global, so
 * it runs in either.
 */

const PRIMARY_BLOCKS = [
  "figure",
  "picture",
  "img",
  "table",
  "blockquote",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
].join(",");

/** What fades in, what the light falls on, and what a place counts in. */
export function getEpubBlocks(document: Document): HTMLElement[] {
  const primary = Array.from(
    document.querySelectorAll<HTMLElement>(PRIMARY_BLOCKS),
  );
  const fallback = Array.from(
    document.querySelectorAll<HTMLElement>(
      "body div, body section, body article",
    ),
  ).filter((element) => {
    const directText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent?.trim() ?? "")
      .join("");

    return Boolean(directText) && !element.querySelector(PRIMARY_BLOCKS);
  });
  const candidates = [...primary, ...fallback];
  const candidateSet = new Set(candidates);

  return candidates
    .filter((element) => {
      let parent = element.parentElement;

      while (parent && parent !== document.body) {
        if (candidateSet.has(parent)) {
          return false;
        }

        parent = parent.parentElement;
      }

      return Boolean(
        element.textContent?.trim() || element.matches("img,picture,figure"),
      );
    })
    .sort((a, b) =>
      a.compareDocumentPosition(b) & a.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
}

/**
 * A block's words as a search compares them: soft hyphens (which the reader
 * inserts to hyphenate) gone, whitespace collapsed.
 */
export function epubBlockText(text: string): string {
  return text.replace(/­/g, "").replace(/\s+/g, " ").trim();
}
