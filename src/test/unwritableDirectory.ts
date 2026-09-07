import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A directory that refuses to be written into, on any host.
 *
 * The tests that need this are about what the packager and the trickplay
 * migration do when the destination fails *after* the expensive work has
 * succeeded — the case where hours of encoding are at their most exposed. They
 * forced it with `chmod(titleRoot, 0o500)`, which is a POSIX way of asking.
 * Windows honours the read-only attribute on files and effectively ignores it on
 * directories: the chmod succeeded, everything was written anyway, and four
 * tests failed asserting that work which had in fact completed had not.
 *
 * A file standing where a directory has to go is not the answer either. Both
 * publishers rename a live directory aside before putting the new one in place,
 * so the blocking file was simply renamed out of the way and the publication
 * carried on — a block that looks like one and is not.
 *
 * So Windows is asked in its own language: an explicit deny ACE on write-data
 * and append-data for the current user, which is what actually stops a
 * directory from gaining entries there. A deny ACE outranks any allow the user
 * has, including one from being an administrator.
 */
export async function denyWritesInto(
  directory: string,
): Promise<() => Promise<void>> {
  if (process.platform !== "win32") {
    await chmod(directory, 0o500);
    return async () => {
      await chmod(directory, 0o700);
    };
  }

  /*
   * The bare account name. `USERDOMAIN` is `WORKGROUP` on a machine that is not
   * joined to one, and `WORKGROUP\\sonat` resolves to nothing — icacls exits
   * 1332, "No mapping between account names and security IDs", and the deny is
   * never applied at all.
   */
  const who = process.env.USERNAME ?? "";
  /*
   * `(OI)(CI)` so the deny is inherited by everything created underneath, and
   * `(W)` for the whole write set. Measured on Windows 11 as an elevated
   * administrator: a file directly inside is refused, and so is a file inside a
   * subdirectory created afterwards. Creating the subdirectory itself is *not*
   * refused — an elevated token walks past a deny for that — which is a limit
   * worth stating rather than discovering: this makes a directory that will not
   * accept content, not one that will not accept structure. Adding `DE` to deny
   * deletion changes nothing either, measured; a publisher that renames the
   * outgoing directory aside is not stopped by an ACL on this host at all.
   */
  await run("icacls", [directory, "/deny", `${who}:(OI)(CI)(W)`]);
  return async () => {
    await run("icacls", [directory, "/remove:d", who]).catch(() => undefined);
  };
}
