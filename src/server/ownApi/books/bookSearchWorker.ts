/**
 * The book search's own process: reads books into passages and turns text into
 * meaning vectors with a multilingual embedding model (bge-m3).
 *
 * It is forked by bookSearchProcess.ts at below-normal priority and never runs
 * as anything else, so it needs no main-module guard. Everything heavy the
 * search does happens here, off the server's event loop: jsdom, and a model
 * that holds about 1.1 GB while loaded.
 *
 * Messages in:  { id, kind: "index", filePath } | { id, kind: "query", text }
 * Messages out: { id, kind: "progress", done, total }
 *               { id, kind: "indexed", passages, vectors }
 *               { id, kind: "embedded", vector }
 *               { id, kind: "error", message, rejected }
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

import { BookRejectedError } from "./epubArchive";
import { readBookPassages } from "./bookText";
import {
  EMBEDDING_MODEL,
  type BookSearchRequest,
  type BookSearchReply,
} from "./bookSearchProtocol";

/**
 * Two threads: a novel indexes in about eight minutes on the Windows host's
 * i5-9500T, and the rest of the machine (the encoder, everyone's playback)
 * keeps its other four cores.
 */
const THREADS = 2;
/**
 * One passage per model call, with ONNX Runtime's memory arena off. Measured
 * on the Windows host, batches of four padded every passage to the longest
 * and the arena kept the high-water mark: 1.6 GB at 971 ms a passage, against
 * 1.1 GB at 864 ms this way.
 */
const BATCH = 1;
/** Long enough for a just-finished download's file to be closed. */
const DOWNLOAD_SETTLE_MS = 3_000;

const cacheDir = process.env.SEYIRLIK_BOOK_SEARCH_MODEL_DIR;
if (cacheDir) env.cacheDir = cacheDir;
// Only from the cache or the hub; never a path a book could name.
env.allowLocalModels = false;

let extractor: Promise<FeatureExtractionPipeline> | null = null;

const createExtractor = () =>
  pipeline("feature-extraction", EMBEDDING_MODEL.id, {
    dtype: EMBEDDING_MODEL.dtype,
    session_options: {
      intraOpNumThreads: THREADS,
      interOpNumThreads: 1,
      enableCpuMemArena: false,
    },
  });

/**
 * The model, downloaded on first use.
 *
 * transformers.js does not wait for a downloaded file to close before ONNX
 * Runtime opens it, and on Windows the open then fails (system error 13), so
 * a first failure is tried once more when the file has settled. A model that
 * still will not load was cut short, by a crash mid-download, and would fail
 * the same way forever: it is deleted, to be downloaded again next time.
 */
async function loadExtractor(): Promise<FeatureExtractionPipeline> {
  try {
    return await createExtractor();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_SETTLE_MS));
    try {
      return await createExtractor();
    } catch (error) {
      await rm(path.join(env.cacheDir!, ...EMBEDDING_MODEL.id.split("/")), {
        recursive: true,
        force: true,
      });
      throw error;
    }
  }
}

function model(): Promise<FeatureExtractionPipeline> {
  extractor ??= loadExtractor().catch((error: unknown) => {
    // Worth trying again next time: the network may be back.
    extractor = null;
    throw error;
  });
  return extractor;
}

/** Unit-length vectors, one per text, laid end to end. */
async function embed(texts: string[]): Promise<Float32Array> {
  const output = await (
    await model()
  )(texts, { pooling: EMBEDDING_MODEL.pooling, normalize: true });
  return Float32Array.from(output.data as Float32Array);
}

function send(reply: BookSearchReply): void {
  process.send?.(reply);
}

async function handle(request: BookSearchRequest): Promise<void> {
  try {
    if (request.kind === "query") {
      send({
        id: request.id,
        kind: "embedded",
        vector: await embed([request.text]),
      });
      return;
    }

    const passages = readBookPassages(await readFile(request.filePath));
    // The model first, so a slow download shows as no progress rather than as
    // a stall at the first batch.
    await model();
    const vectors = new Float32Array(
      passages.length * EMBEDDING_MODEL.dimensions,
    );
    for (let start = 0; start < passages.length; start += BATCH) {
      send({
        id: request.id,
        kind: "progress",
        done: start,
        total: passages.length,
      });
      const batch = passages.slice(start, start + BATCH).map((p) => p.text);
      vectors.set(await embed(batch), start * EMBEDDING_MODEL.dimensions);
    }
    send({ id: request.id, kind: "indexed", passages, vectors });
  } catch (error) {
    send({
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      rejected: error instanceof BookRejectedError,
    });
  }
}

process.on("message", (request: BookSearchRequest) => {
  void handle(request);
});
// The server going away takes this process with it.
process.on("disconnect", () => process.exit(0));
