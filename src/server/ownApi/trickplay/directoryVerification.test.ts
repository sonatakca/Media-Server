import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  compareSummaries,
  copyDirectoryTree,
  copyOrder,
  summariseDirectory,
} from "./directoryVerification";

/**
 * The AppleDouble ordering rule, which is the one thing about copying that this
 * library's exFAT volume makes non-obvious.
 *
 * It is asserted as an order rather than as a simulated filesystem on purpose.
 * The behaviour only appears on a volume that materialises extended attributes
 * as `._` files, the machine running the suite is on APFS, and a substituted
 * `node:fs/promises` does not reach inside a source module under this test
 * runner — so a test that claimed to reproduce the effect would in fact be
 * asserting nothing. The order is the fix, and the order is what is pinned. The
 * effect itself was confirmed against the real volume before this was written:
 * sidecars first produced a differing `._sprite_0.jpg`, sidecars last produced
 * a byte-identical copy.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

it("writes AppleDouble sidecars after the entries they describe", () => {
  expect(
    copyOrder([
      "._sprite_1.jpg",
      "sprite_1.jpg",
      "._sprite_0.jpg",
      "sprite_0.jpg",
    ]),
  ).toEqual([
    "sprite_0.jpg",
    "sprite_1.jpg",
    "._sprite_0.jpg",
    "._sprite_1.jpg",
  ]);
});

it("treats a directory as payload so its own sidecar is written after it", () => {
  // Creating the directory is what makes `._nested` appear, so the copy of
  // `._nested` has to happen after the directory has been recursed into.
  expect(copyOrder(["._nested", "nested", ".DS_Store"])).toEqual([
    "nested",
    ".DS_Store",
    "._nested",
  ]);
});

it("copies a tree with sidecars and nested directories to a verifiable copy", async () => {
  const source = await temporaryDirectory("trickplay-source-");
  const destination = path.join(
    await temporaryDirectory("trickplay-copy-"),
    "trickplay",
  );

  await writeFile(path.join(source, "sprite_0.jpg"), "first sheet");
  await writeFile(path.join(source, "._sprite_0.jpg"), "first sheet metadata");
  await mkdir(path.join(source, "nested"));
  await writeFile(path.join(source, "._nested"), "directory metadata");
  await writeFile(path.join(source, "nested", "sprite_1.jpg"), "second sheet");

  const before = await summariseDirectory(source);
  await copyDirectoryTree(source, destination);

  expect(
    compareSummaries(before, await summariseDirectory(destination)),
  ).toEqual({ identical: true, differences: [] });
});
