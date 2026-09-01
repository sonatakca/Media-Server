// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createStaticHandler,
  listenWithRetry,
  parseRunWorker,
} from "./mediaServer";

/**
 * Static serving is what lets this process be the whole origin — app and API
 * together — so a deployment needs no separate frontend host and no
 * cross-origin exception for the session cookie.
 */
describe("static frontend serving", () => {
  let staticRoot: string;

  beforeEach(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "seyirlik-static-"));
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html>app");
    await mkdir(path.join(staticRoot, "assets"), { recursive: true });
    await writeFile(path.join(staticRoot, "assets", "main-abc123.js"), "//js");
  });

  afterEach(async () => {
    await rm(staticRoot, { recursive: true, force: true });
  });

  async function serve(pathname: string, method = "GET") {
    const chunks: Buffer[] = [];
    const headers: Record<string, string> = {};
    let statusCode = 0;

    // The handler pipes into the response; a writable stand-in collects it.
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    Object.assign(writable, {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      get statusCode() {
        return statusCode;
      },
      set statusCode(value: number) {
        statusCode = value;
      },
    });

    const handled = await createStaticHandler(staticRoot)(
      Object.assign(Readable.from([]), {
        method,
        headers: {},
      }) as unknown as IncomingMessage,
      writable as unknown as ServerResponse,
      pathname,
    );

    return {
      handled,
      statusCode,
      headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
  }

  it("serves a real file with its content type", async () => {
    const result = await serve("/assets/main-abc123.js");

    expect(result.handled).toBe(true);
    expect(result.body).toBe("//js");
    expect(result.headers["Content-Type"]).toContain("text/javascript");
  });

  it("caches hashed assets immutably and revalidates the shell", async () => {
    expect(
      (await serve("/assets/main-abc123.js")).headers["Cache-Control"],
    ).toBe("public, max-age=31536000, immutable");
    expect((await serve("/home")).headers["Cache-Control"]).toBe("no-cache");
  });

  it("falls back to the app shell for a client route", async () => {
    const result = await serve("/series/some-id");

    expect(result.handled).toBe(true);
    expect(result.body).toContain("app");
    expect(result.headers["Content-Type"]).toContain("text/html");
  });

  it("does not escape the build directory", async () => {
    const result = await serve("/../../../etc/passwd");

    // Traversal falls through to the shell rather than reading outside root.
    expect(result.body).toContain("app");
    expect(result.body).not.toContain("root:");
  });

  it("answers HEAD without a body", async () => {
    const result = await serve("/assets/main-abc123.js", "HEAD");

    expect(result.handled).toBe(true);
    expect(result.body).toBe("");
    expect(result.headers["Content-Length"]).toBe("4");
  });

  it("ignores unsafe methods so they reach the API's own 404", async () => {
    expect((await serve("/home", "POST")).handled).toBe(false);
  });
});

/**
 * Binding the port.
 *
 * A supervisor relaunching into a port the previous process has not let go of
 * was the longest outage this server has had: `EADDRINUSE` is emitted on the
 * server object, an unhandled `error` event ends the process, and the
 * supervisor starts another one ten seconds later, for as long as the port
 * stays busy. Waiting is what turns that into a pause.
 */
describe("binding a busy port", () => {
  let incumbent: Server | undefined;
  let replacement: Server | undefined;

  afterEach(async () => {
    for (const server of [incumbent, replacement]) {
      if (server?.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    incumbent = undefined;
    replacement = undefined;
  });

  it("waits for the previous process to let go instead of exiting", async () => {
    incumbent = createServer();
    await new Promise<void>((resolve) => {
      incumbent?.listen(0, "127.0.0.1", resolve);
    });
    const address = incumbent.address();
    if (typeof address === "string" || address === null) {
      throw new Error("Expected a TCP address.");
    }

    replacement = createServer();
    const bound = listenWithRetry(replacement, address.port, "127.0.0.1", 10);

    // Still held: nothing has bound, and nothing has thrown either.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replacement.listening).toBe(false);

    await new Promise<void>((resolve) => incumbent?.close(() => resolve()));
    await bound;
    expect(replacement.listening).toBe(true);
  });

  it("raises a listen error that waiting cannot fix", async () => {
    replacement = createServer();
    await expect(
      // A port no unprivileged process may bind is not a race with a
      // predecessor; retrying it would be an infinite loop.
      listenWithRetry(replacement, 1, "127.0.0.1", 10),
    ).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("splitting background work out of the API process", () => {
  it("keeps the worker in-process unless told otherwise", () => {
    expect(parseRunWorker(undefined)).toBe(true);
    expect(parseRunWorker("  ")).toBe(true);
  });

  it("hands background work to a separate process when asked", () => {
    expect(parseRunWorker("false")).toBe(false);
    expect(parseRunWorker("0")).toBe(false);
    expect(parseRunWorker("No")).toBe(false);
  });

  it("refuses a value it cannot read rather than guessing", () => {
    // Guessing here would silently run two workers, or none.
    expect(() => parseRunWorker("maybe")).toThrow(/SEYIRLIK_RUN_WORKER/);
  });
});
