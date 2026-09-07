import {
  createDiskutilIdentityProbe,
  type StorageIdentityProbe,
} from "./storageIdentity";
import {
  createWindowsIdentityProbe,
  type WindowsIdentityFailure,
} from "./windowsStorageIdentity";

/**
 * Which identity probe this host gets.
 *
 * One place, so that "does this platform have identity?" is a question with a
 * single answer that a test can ask directly. The alternative — a
 * `process.platform` ternary inside the runtime's construction function — is
 * how the Windows gap went unnoticed: it was one branch of one expression in a
 * 900-line module, and nothing could assert on it without building a server.
 *
 * Returning `undefined` is a real answer, not an oversight. A platform with no
 * implementation has no identity, and every consumer already treats a missing
 * probe as "cannot establish" and fails closed.
 */
export function createVolumeIdentityProbe(options: {
  platform: NodeJS.Platform;
  run: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string>;
  timeoutMs?: number;
  onWindowsFailure?: (failure: WindowsIdentityFailure, detail: string) => void;
}): StorageIdentityProbe | undefined {
  const { platform, run } = options;
  const timeout =
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };

  if (platform === "darwin") {
    return createDiskutilIdentityProbe({ run, ...timeout });
  }
  if (platform === "win32") {
    return createWindowsIdentityProbe({
      run,
      ...timeout,
      ...(options.onWindowsFailure
        ? { onFailure: options.onWindowsFailure }
        : {}),
    });
  }
  return undefined;
}
