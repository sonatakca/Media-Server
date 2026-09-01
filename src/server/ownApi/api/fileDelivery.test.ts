// @vitest-environment node
import { createServer, type RequestListener, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveFile, streamToResponse } from "./fileDelivery";

/**
 * These are the crash tests.
 *
 * Serving bytes is the one thing this server does that a client can interrupt
 * at will, and every interruption used to arrive as a rejected promise from an
 * async request handler nothing awaited — which Node ends the process for. A
 * seek, a closed tab, a phone leaving the network: routine, frequent, and each
 * one a hard stop for everybody else watching. So what is asserted here is not
 * only the body, but that an abort settles quietly.
 */
describe("streaming bytes to a client that leaves", () => {
  let root: string;
  let server: Server | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "seyirlik-delivery-"));
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
    await rm(root, { recursive: true, force: true });
  });

  /** Starts a server on a free port and returns its origin. */
  async function listen(handler: RequestListener): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("Expected a TCP address.");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it("resolves rather than throwing when the client aborts mid-body", async () => {
    const filePath = path.join(root, "film.mp4");
    // Large enough that the client can walk away before the last chunk.
    await writeFile(filePath, Buffer.alloc(8 * 1024 * 1024, 7));

    const outcomes: Array<"resolved" | "rejected"> = [];
    const origin = await listen((request, response) => {
      void serveFile(
        response,
        filePath,
        request.headers.range,
        false,
        "no-store",
      )
        .then(() => outcomes.push("resolved"))
        .catch(() => outcomes.push("rejected"));
    });

    const abort = new AbortController();
    const response = await fetch(`${origin}/`, { signal: abort.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    abort.abort();
    await reader?.cancel().catch(() => undefined);

    // The server notices the closed socket on its next write.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(outcomes).toEqual(["resolved"]);
  });

  it("still reports a genuine read failure", async () => {
    // An abort is routine and resolves; a disk that failed is neither, and the
    // route above it has to hear about it.
    let report!: (outcome: string) => void;
    const reported = new Promise<string>((resolve) => {
      report = resolve;
    });

    const origin = await listen((_request, response) => {
      const failing = new Readable({
        read() {
          this.destroy(new Error("the disk went away"));
        },
      });
      void streamToResponse(failing, response)
        .then(() => "resolved")
        .catch((error: Error) => error.message)
        .then((outcome) => {
          response.destroy();
          report(outcome);
        });
    });

    await fetch(`${origin}/`).catch(() => undefined);
    expect(await reported).toBe("the disk went away");
  });

  it("delivers the requested range in full when nobody interrupts", async () => {
    const filePath = path.join(root, "clip.mp4");
    await writeFile(filePath, "0123456789");

    const origin = await listen((request, response) => {
      void serveFile(
        response,
        filePath,
        request.headers.range,
        false,
        "no-store",
      ).catch(() => response.destroy());
    });

    const response = await fetch(`${origin}/`, {
      headers: { Range: "bytes=2-5" },
    });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("2345");
  });

  it("does not leave the read stream open after an abort", async () => {
    const source = createReadStream(
      await writeFile(path.join(root, "a.bin"), Buffer.alloc(4096)).then(() =>
        path.join(root, "a.bin"),
      ),
    );

    const origin = await listen((_request, response) => {
      void streamToResponse(source, response);
      // Cutting the response is what a vanished client looks like from here.
      setTimeout(() => response.destroy(), 20);
    });

    await fetch(`${origin}/`)
      .then((response) => response.arrayBuffer())
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(source.destroyed).toBe(true);
  });
});
