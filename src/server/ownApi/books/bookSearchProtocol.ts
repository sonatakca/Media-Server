/** What the server and the book search's process say to each other. */

import type { BookPassage } from "./bookText";

/**
 * The embedding model. 8-bit weights index a novel 2.6x faster than full
 * precision and, measured on a Turkish novel, found the same best passage for
 * five questions in six (the sixth swapped two passages of the same scene).
 * An index records the model it was built with; a different one is rebuilt.
 */
export const EMBEDDING_MODEL = {
  id: "Xenova/bge-m3",
  dtype: "q8",
  pooling: "cls",
  dimensions: 1024,
} as const;

/**
 * What an index was built with: the model, and the rules that cut a book into
 * passages (bookText.ts). Raise the passage rules' number whenever they would
 * cut or count a book differently; every index then reads its book again.
 */
export const INDEX_KEY = `${EMBEDDING_MODEL.id}@${EMBEDDING_MODEL.dtype}/passages-1`;

export type BookSearchRequest =
  | { id: number; kind: "index"; filePath: string }
  | { id: number; kind: "query"; text: string };

export type BookSearchReply =
  | { id: number; kind: "progress"; done: number; total: number }
  | {
      id: number;
      kind: "indexed";
      passages: BookPassage[];
      vectors: Float32Array;
    }
  | { id: number; kind: "embedded"; vector: Float32Array }
  /** `rejected`: the book itself cannot be read, so trying again will not help. */
  | { id: number; kind: "error"; message: string; rejected: boolean };
