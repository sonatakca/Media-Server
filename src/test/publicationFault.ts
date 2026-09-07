import { rename } from "node:fs/promises";
import path from "node:path";

/** A real filesystem whose final publication rename deterministically fails. */
export async function rejectPublicationCommit(titleRoot: string) {
  let rejected = 0;
  let enabled = true;
  const commit: typeof rename = async (source, destination) => {
    if (
      enabled &&
      (path.dirname(String(destination)) === titleRoot ||
        String(destination) ===
          path.join(titleRoot, ".seyirlik", "current.json")) &&
      String(source).includes(`${path.sep}.seyirlik-incoming${path.sep}`)
    ) {
      rejected += 1;
      throw Object.assign(new Error("Injected publication rename failure"), {
        code: "EACCES",
        syscall: "rename",
      });
    }
    return rename(source, destination);
  };
  return {
    fileSystem: { rename: commit },
    rejected: () => rejected,
    restore: () => {
      enabled = false;
    },
  };
}
