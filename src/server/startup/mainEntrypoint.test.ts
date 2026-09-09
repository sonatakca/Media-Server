import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMainEntrypoint } from "./mainEntrypoint";

describe("isMainEntrypoint", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "seyirlik-entrypoint-"));
    await mkdir(path.join(root, "releases", "one", "src"), { recursive: true });
    await writeFile(path.join(root, "releases", "one", "src", "server.ts"), "");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("recognises the entrypoint when it is named directly", () => {
    const file = path.join(root, "releases", "one", "src", "server.ts");
    expect(isMainEntrypoint(pathToFileURL(file).href, file)).toBe(true);
  });

  /*
   * The production case. The services are pointed at `app/current`, a link to
   * the active release, so the command line names a path under the link while
   * Node has already resolved the module to the release it points at.
   */
  it("recognises the entrypoint reached through a link to the release", async () => {
    await symlink(
      path.join(root, "releases", "one"),
      path.join(root, "current"),
      "junction",
    );

    const viaLink = path.join(root, "current", "src", "server.ts");
    const real = path.join(root, "releases", "one", "src", "server.ts");

    expect(isMainEntrypoint(pathToFileURL(real).href, viaLink)).toBe(true);
  });

  it("still says no to a different file in the same directory", () => {
    const file = path.join(root, "releases", "one", "src", "server.ts");
    const other = path.join(root, "releases", "one", "src", "worker.ts");
    expect(isMainEntrypoint(pathToFileURL(file).href, other)).toBe(false);
  });

  it("says no when nothing was named on the command line", () => {
    const file = path.join(root, "releases", "one", "src", "server.ts");
    expect(isMainEntrypoint(pathToFileURL(file).href, undefined)).toBe(false);
  });

  /*
   * A path that does not exist cannot be canonicalised, and the answer still
   * has to be an answer: importing a module must not fail because a stale
   * argument could not be resolved.
   */
  it("falls back to plain resolution when the path cannot be resolved", () => {
    const missing = path.join(root, "gone", "server.ts");
    expect(isMainEntrypoint(pathToFileURL(missing).href, missing)).toBe(true);
  });
});
