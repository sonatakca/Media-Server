/**
 * The SABnzbd boundary. Every call to it happens here.
 *
 * Only the subset this phase needs: check it is there, read the queue and the
 * history, submit an NZB, and remove a job Seyirlik itself created. SABnzbd
 * exposes a great deal more, and implementing methods nothing calls would be
 * surface to keep working for no one.
 *
 * The API key travels in the query string because SABnzbd offers no other way,
 * which makes this the same problem the indexer client has: the key is added
 * at the moment of the request, and nothing from a transport failure is
 * carried into an error, because a fetch rejection stringifies to a message
 * containing the URL.
 */

export type SabErrorKind =
  | "auth"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "bad-request"
  | "malformed-response"
  | "rejected";

export class SabError extends Error {
  readonly kind: SabErrorKind;

  constructor(kind: SabErrorKind, message: string) {
    super(message);
    this.name = "SabError";
    this.kind = kind;
  }
}

/** What a job is doing, in Seyirlik's words rather than SABnzbd's. */
export type SabJobState =
  | "queued"
  | "downloading"
  | "processing"
  | "completed"
  | "failed"
  | "paused";

export interface SabJob {
  readonly nzoId: string;
  /** The name SABnzbd shows, which is the name it was asked to use. */
  readonly name: string;
  readonly category?: string;
  readonly state: SabJobState;
  /** 0–100 where SABnzbd reports it. */
  readonly percentage?: number;
  readonly sizeBytes?: number;
  /** Where the finished bytes are. Only history entries have one. */
  readonly storagePath?: string;
  /** SABnzbd's own words about a failure. Never a credential. */
  readonly failMessage?: string;
  readonly source: "queue" | "history";
}

export interface SabSubmission {
  readonly bytes: Uint8Array;
  /** Becomes the job name, and is how a lost response is recovered. */
  readonly name: string;
  readonly category: string;
  readonly filename?: string;
}

export interface SabnzbdClient {
  /** Version string, and proof the key works. */
  version(signal?: AbortSignal): Promise<string>;
  listQueue(signal?: AbortSignal): Promise<SabJob[]>;
  listHistory(limit?: number, signal?: AbortSignal): Promise<SabJob[]>;
  /** Returns the job's identifier when SABnzbd reports one. */
  submit(
    submission: SabSubmission,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  /** Searches the queue then the history for a job by its exact name. */
  findByName(name: string, signal?: AbortSignal): Promise<SabJob | undefined>;
  getJob(nzoId: string, signal?: AbortSignal): Promise<SabJob | undefined>;
  /** Removes a job. The caller is responsible for it being Seyirlik's. */
  remove(
    nzoId: string,
    options?: { deleteFiles?: boolean; signal?: AbortSignal },
  ): Promise<void>;
}

export interface SabnzbdClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * SABnzbd's queue statuses, mapped to what Seyirlik does about them.
 *
 * `Grabbing`, `Fetching` and `Verifying` are all "it is working on it"; the
 * distinction matters to SABnzbd's own UI and not to a decision here.
 */
function queueState(status: string): SabJobState {
  const value = status.toLowerCase();
  if (value === "paused") return "paused";
  if (value === "queued" || value === "grabbing") return "queued";
  if (
    value === "verifying" ||
    value === "repairing" ||
    value === "extracting" ||
    value === "running" ||
    value === "moving"
  ) {
    return "processing";
  }
  return "downloading";
}

function historyState(status: string): SabJobState {
  const value = status.toLowerCase();
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  // Queued/Running/Extracting appear in history while post-processing runs.
  return "processing";
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Megabytes as SABnzbd reports them, in bytes. */
function megabytesToBytes(value: unknown): number | undefined {
  const mb = toNumber(value);
  return mb === undefined ? undefined : Math.round(mb * 1024 * 1024);
}

export function createSabnzbdClient({
  baseUrl,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}: SabnzbdClientOptions): SabnzbdClient {
  if (!apiKey.trim()) throw new Error("SABnzbd needs an API key.");
  const endpoint = new URL(
    "api",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );

  async function call(
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    body?: FormData,
  ): Promise<unknown> {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("output", "json");
    url.searchParams.set("apikey", apiKey);

    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        ...(body ? { method: "POST", body } : {}),
      });
      if (response.status === 401 || response.status === 403) {
        throw new SabError("auth", "SABnzbd refused the key.");
      }
      if (!response.ok) {
        throw new SabError(
          response.status >= 500 ? "unavailable" : "bad-request",
          `SABnzbd answered ${response.status}.`,
        );
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new SabError(
          "malformed-response",
          "SABnzbd's response is implausibly large.",
        );
      }
      /*
       * A wrong key is reported with HTTP 200 and a plain-text body, so a
       * status check alone would read it as a successful empty queue.
       */
      if (
        /api key incorrect|api key required|access denied/i.test(
          text.slice(0, 200),
        )
      ) {
        throw new SabError("auth", "SABnzbd refused the key.");
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new SabError(
          "malformed-response",
          "SABnzbd did not answer with JSON.",
        );
      }
    } catch (error) {
      if (error instanceof SabError) throw error;
      if (signal?.aborted) {
        throw new SabError("cancelled", "The request was cancelled.");
      }
      if (timedOut || (error instanceof Error && error.name === "AbortError")) {
        throw new SabError("timeout", "SABnzbd did not answer in time.");
      }
      // Deliberately nothing from the original: it contains the URL, and the
      // URL contains the key.
      throw new SabError("unavailable", "SABnzbd could not be reached.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  function parseQueue(payload: unknown): SabJob[] {
    const slots = (payload as { queue?: { slots?: unknown } })?.queue?.slots;
    if (!Array.isArray(slots)) return [];
    return slots.flatMap((raw): SabJob[] => {
      const slot = raw as Record<string, unknown>;
      const nzoId = typeof slot.nzo_id === "string" ? slot.nzo_id : "";
      if (!nzoId) return [];
      const total = megabytesToBytes(slot.mb);
      return [
        {
          nzoId,
          name: typeof slot.filename === "string" ? slot.filename : "",
          ...(typeof slot.cat === "string" ? { category: slot.cat } : {}),
          state: queueState(typeof slot.status === "string" ? slot.status : ""),
          ...(toNumber(slot.percentage) === undefined
            ? {}
            : { percentage: toNumber(slot.percentage)! }),
          ...(total === undefined ? {} : { sizeBytes: total }),
          source: "queue",
        },
      ];
    });
  }

  function parseHistory(payload: unknown): SabJob[] {
    const slots = (payload as { history?: { slots?: unknown } })?.history
      ?.slots;
    if (!Array.isArray(slots)) return [];
    return slots.flatMap((raw): SabJob[] => {
      const slot = raw as Record<string, unknown>;
      const nzoId = typeof slot.nzo_id === "string" ? slot.nzo_id : "";
      if (!nzoId) return [];
      const failMessage =
        typeof slot.fail_message === "string" && slot.fail_message.trim()
          ? slot.fail_message.trim()
          : undefined;
      return [
        {
          nzoId,
          name: typeof slot.name === "string" ? slot.name : "",
          ...(typeof slot.category === "string"
            ? { category: slot.category }
            : {}),
          state: historyState(
            typeof slot.status === "string" ? slot.status : "",
          ),
          ...(toNumber(slot.bytes) === undefined
            ? {}
            : { sizeBytes: toNumber(slot.bytes)! }),
          ...(typeof slot.storage === "string" && slot.storage
            ? { storagePath: slot.storage }
            : {}),
          ...(failMessage === undefined ? {} : { failMessage }),
          source: "history",
        },
      ];
    });
  }

  return {
    async version(signal) {
      const payload = await call({ mode: "version" }, signal);
      const version = (payload as { version?: unknown })?.version;
      if (typeof version !== "string") {
        throw new SabError("malformed-response", "SABnzbd gave no version.");
      }
      return version;
    },

    async listQueue(signal) {
      return parseQueue(await call({ mode: "queue", limit: "500" }, signal));
    },

    async listHistory(limit = 200, signal) {
      return parseHistory(
        await call({ mode: "history", limit: String(limit) }, signal),
      );
    },

    async submit(submission, signal) {
      const form = new FormData();
      form.set(
        "nzbfile",
        new Blob([submission.bytes as BlobPart], { type: "application/x-nzb" }),
        submission.filename ?? `${submission.name}.nzb`,
      );
      const payload = await call(
        {
          mode: "addfile",
          // The name is the recovery handle: a response lost after SABnzbd
          // accepted the file leaves a job findable only by this.
          nzbname: submission.name,
          cat: submission.category,
        },
        signal,
        form,
      );
      const result = payload as {
        status?: unknown;
        nzo_ids?: unknown;
        error?: unknown;
      };
      if (result.status === false) {
        const detail =
          typeof result.error === "string"
            ? result.error
            : "SABnzbd refused the NZB.";
        throw new SabError("rejected", detail);
      }
      const ids = Array.isArray(result.nzo_ids) ? result.nzo_ids : [];
      const first = ids.find(
        (value): value is string => typeof value === "string",
      );
      // Undefined is not a failure: SABnzbd accepted it, and the caller
      // recovers the identifier by looking for the name.
      return first;
    },

    async findByName(name, signal) {
      const queued = (await this.listQueue(signal)).find(
        (job) => job.name === name,
      );
      if (queued) return queued;
      return (await this.listHistory(200, signal)).find(
        (job) => job.name === name,
      );
    },

    async getJob(nzoId, signal) {
      const queued = (await this.listQueue(signal)).find(
        (job) => job.nzoId === nzoId,
      );
      if (queued) return queued;
      return (await this.listHistory(200, signal)).find(
        (job) => job.nzoId === nzoId,
      );
    },

    async remove(nzoId, options = {}) {
      if (!nzoId) throw new SabError("bad-request", "No job was named.");
      // Both lists: a job may have moved to history between the decision to
      // remove it and this call.
      await call(
        {
          mode: "queue",
          name: "delete",
          value: nzoId,
          del_files: options.deleteFiles ? "1" : "0",
        },
        options.signal,
      ).catch((error: unknown) => {
        if (error instanceof SabError && error.kind === "bad-request") return;
        throw error;
      });
      await call(
        {
          mode: "history",
          name: "delete",
          value: nzoId,
          del_files: options.deleteFiles ? "1" : "0",
        },
        options.signal,
      ).catch((error: unknown) => {
        if (error instanceof SabError && error.kind === "bad-request") return;
        throw error;
      });
    },
  };
}

/**
 * What SABnzbd's failure message amounts to.
 *
 * Its wording is not a stable API, so this is a best effort that falls back to
 * "unknown" rather than guessing — and "unknown" is terminal, so a
 * misclassification stops rather than looping.
 */
export function classifySabFailure(
  message: string | undefined,
):
  | "missing-articles"
  | "repair-failed"
  | "unpack-failed"
  | "password-required"
  | "disk-full"
  | "unknown" {
  const value = (message ?? "").toLowerCase();
  if (!value) return "unknown";
  if (value.includes("password")) return "password-required";
  if (value.includes("out of disk") || value.includes("no space"))
    return "disk-full";
  if (value.includes("unpack") || value.includes("extraction"))
    return "unpack-failed";
  if (value.includes("repair") || value.includes("par2"))
    return "repair-failed";
  if (
    value.includes("missing article") ||
    value.includes("not enough") ||
    value.includes("aborted")
  ) {
    return "missing-articles";
  }
  return "unknown";
}
