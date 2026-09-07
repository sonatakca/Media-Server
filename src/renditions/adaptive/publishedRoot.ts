import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const PUBLICATION_GENERATIONS = ".seyirlik-generations";
export const PUBLICATION_POINTER = ".seyirlik/current.json";

/** Resolve once per reader so a later activation cannot mix its generations. */
export async function resolvePublishedTitleRoot(
  titleRoot: string,
): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path.join(titleRoot, PUBLICATION_POINTER), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return titleRoot;
    throw error;
  }
  const pointer = JSON.parse(raw) as {
    schemaVersion?: unknown;
    generation?: unknown;
  };
  if (
    pointer.schemaVersion !== 1 ||
    typeof pointer.generation !== "string" ||
    !/^[a-f0-9]{64}$/.test(pointer.generation)
  ) {
    throw new Error("The publication pointer is invalid.");
  }
  const [root, target] = await Promise.all([
    realpath(titleRoot),
    realpath(path.join(titleRoot, PUBLICATION_GENERATIONS, pointer.generation)),
  ]);
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("The publication generation escaped its title root.");
  }
  return target;
}
