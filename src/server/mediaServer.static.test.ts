// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaticHandler } from "./mediaServer";

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
