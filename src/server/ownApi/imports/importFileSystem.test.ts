// @vitest-environment node
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createNodeReadFileSystem,
  createRootResolver,
  PathEscapeError,
} from "./importFileSystem";

/*
 * Real directories, real links. Path containment cannot be proven against a
 * fake filesystem: the whole question is what the operating system does with a
 * name, and a double would only confirm what this module already believes.
 */
let workspace: string;
let root: string;
let outside: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-import-fs-"));
  // Deliberately named so that a naive prefix comparison would let `library2`
  // pass as being inside `library`.
  root = path.join(workspace, "library");
  outside = path.join(workspace, "library2");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.mkv"), "not yours");
  await mkdir(path.join(root, "Dune (2021)", "src"), { recursive: true });
  await writeFile(path.join(root, "Dune (2021)", "src", "Dune.mkv"), "bytes");
  await writeFile(path.join(root, "Dune (2021)", "Dune.nfo"), "<nfo/>");
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("resolving a name against the root it was authorised against", () => {
  it("resolves an ordinary relative path", () => {
    const resolver = createRootResolver(root);
    expect(resolver.resolve("Dune (2021)/src/Dune.mkv")).toBe(
      path.join(root, "Dune (2021)", "src", "Dune.mkv"),
    );
  });

  it("resolves a path that does not exist yet", () => {
    // A destination is not there until it is written; containment still has to
    // be decidable about it.
    const resolver = createRootResolver(root);
    expect(resolver.resolve("New Film (2026)/src/New Film.mkv")).toContain(
      root,
    );
  });

  it.each([
    ["a parent segment", "../library2/secret.mkv"],
    ["a deeper escape", "Dune (2021)/../../library2/secret.mkv"],
    ["a bare parent", ".."],
    ["a backslash escape", "..\\library2\\secret.mkv"],
    ["a mixed separator escape", "Dune (2021)\\..\\..\\library2\\x.mkv"],
    ["a NUL byte", "Dune\0.mkv"],
  ])("refuses %s", (_name, attempted) => {
    const resolver = createRootResolver(root);
    expect(() => resolver.resolve(attempted)).toThrow(PathEscapeError);
  });

  it("refuses a sibling root whose name merely starts the same way", () => {
    /*
     * `library2` is not inside `library`, however similar the two strings
     * look. A prefix comparison would have said otherwise.
     */
    const resolver = createRootResolver(root);
    expect(() => resolver.resolve("../library2")).toThrow(PathEscapeError);
  });

  it("reports nothing rather than throwing for a path that is simply absent", async () => {
    const resolver = createRootResolver(root);
    expect(await resolver.resolveReal("nowhere/at/all")).toBeNull();
  });
});

describe("what a link can and cannot do", () => {
  it("refuses a link that leads outside the root", async () => {
    /*
     * The lexical check cannot catch this one: the name is well behaved and
     * only the resolved location gives it away. This is the case a crafted
     * download would use.
     */
    const linkPath = path.join(root, "escape");
    await symlink(outside, linkPath, "junction").catch(async () => {
      await symlink(outside, linkPath);
    });
    const resolver = createRootResolver(root);
    await expect(resolver.resolveReal("escape")).rejects.toBeInstanceOf(
      PathEscapeError,
    );
    await expect(resolver.resolveReal("escape/secret.mkv")).rejects.toThrow(
      PathEscapeError,
    );
    await rm(linkPath, { recursive: true, force: true });
  });

  it("shows a link as a link rather than following it", async () => {
    // The inspector can only refuse a junction if it is told there is one.
    const linkPath = path.join(root, "Dune (2021)", "elsewhere.mkv");
    await symlink(path.join(outside, "secret.mkv"), linkPath);
    const fileSystem = createNodeReadFileSystem(root);
    const entries = await fileSystem.list("Dune (2021)");
    const link = entries.find((entry) => entry.name === "elsewhere.mkv");
    expect(link?.isSymbolicLink).toBe(true);
    expect(link?.isDirectory).toBe(false);
    await rm(linkPath, { force: true });
  });

  it("allows a link that stays inside the root to be seen, still as a link", async () => {
    // Containment is satisfied, but it is still not a regular file, and the
    // inspector refuses it on that ground rather than on this one.
    const linkPath = path.join(root, "inside-link.mkv");
    await symlink(path.join(root, "Dune (2021)", "src", "Dune.mkv"), linkPath);
    const fileSystem = createNodeReadFileSystem(root);
    const entry = await fileSystem.stat("inside-link.mkv");
    expect(entry?.isSymbolicLink).toBe(true);
    await rm(linkPath, { force: true });
  });
});

describe("reading a tree", () => {
  it("lists entries with the facts stability is judged on", async () => {
    const fileSystem = createNodeReadFileSystem(root);
    const entries = await fileSystem.list("Dune (2021)");
    const nfo = entries.find((entry) => entry.name === "Dune.nfo");
    expect(nfo).toMatchObject({ isDirectory: false, isSymbolicLink: false });
    expect(nfo!.sizeBytes).toBeGreaterThan(0);
    expect(nfo!.mtimeMs).toBeGreaterThan(0);
    expect(entries.find((entry) => entry.name === "src")?.isDirectory).toBe(
      true,
    );
  });

  it("returns nothing for a directory that is not there", async () => {
    const fileSystem = createNodeReadFileSystem(root);
    expect(await fileSystem.list("no-such-release")).toEqual([]);
  });

  it("returns null for a file that is not there", async () => {
    const fileSystem = createNodeReadFileSystem(root);
    expect(await fileSystem.stat("no-such-file.mkv")).toBeNull();
  });

  it("refuses to list its way out of the root", async () => {
    const fileSystem = createNodeReadFileSystem(root);
    await expect(fileSystem.list("../library2")).rejects.toBeInstanceOf(
      PathEscapeError,
    );
  });
});
