import { ownApiClient } from "../api/ownApi/client";

/** A passage that means what the search asked, and where it starts. */
export interface BookSearchHit {
  /** The spine position, as epub.js numbers sections. */
  section: number;
  /** The block it starts in, as `getEpubBlocks` numbers them. */
  block: number;
  /** The start of the passage's text in that block, to check the block by. */
  anchor: string;
  text: string;
  score: number;
}

export type BookSearchOutcome =
  | { state: "ready"; hits: BookSearchHit[] }
  /** The book is being read for the first time; ask again shortly. */
  | { state: "preparing"; progress: number | null }
  | { state: "unavailable"; reason: string };

/**
 * Searches a book by meaning. An empty query only asks the server to prepare
 * the book, which it does once, in the background, in a few minutes.
 */
export function searchBook(
  itemId: string,
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<BookSearchOutcome> {
  return ownApiClient.request<BookSearchOutcome>(
    `/books/${encodeURIComponent(itemId)}/search`,
    {
      method: "POST",
      background: true,
      signal: options.signal,
      body: { query },
    },
  );
}
