/**
 * Writing a subtitle beside somebody's media.
 *
 * The most dangerous operation in the subsystem, because it is the only one
 * that leaves anything behind. Four properties are enforced here rather than
 * hoped for by the callers:
 *
 *  - **A caller names a catalogue id, never a path.** The destination is
 *    derived from the media file the id resolves to, so no provider, payload or
 *    API client can choose where a byte lands.
 *  - **Everything stays inside one configured root.** Containment is checked
 *    after resolution, and again on the derived destination, because a check
 *    made before resolution is not a check.
 *  - **Ownership is a recorded digest, not a filename.** A subtitle this system
 *    installed can be replaced; one somebody added by hand cannot, whatever it
 *    is called. That is the same rule the NFO writer uses for its managed
 *    marker, expressed for a format with nowhere to put a marker.
 *  - **A new file never clobbers.** New installs go in with a no-clobber link,
 *    so two workers racing produce one file and one loser, not a torn one.
 *
 * **The Phase 6 interlock lives in configuration, not in this file.** Which root
 * is authorised is a deployment decision — a synthetic directory while the media
 * volume is untrusted, the library root once it is not — and hard-coding a
 * validation path here would make the module untestable on the development
 * platform and unusable in production without editing it.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isPathInsideRoot } from "../../pathSecurity";
import { classifyFsError } from "../imports/importOperations";
import { detectSubtitlesOnDisk } from "./subtitleDetection";
import {
  InvalidSubtitleError,
  MAX_SUBTITLE_BYTES,
  validateSubtitle,
} from "./subtitlePayload";
import type { SubtitlePayload } from "./subtitleProvider";
import type {
  SubtitleFailureClass,
  SubtitleFlags,
  SubtitleTrack,
} from "./subtitleState";

/** Containers a subtitle may be installed beside. */
const VIDEO_EXTENSIONS = /[.](?:mkv|mp4|m4v|avi|mov|webm|ts|m2ts)$/i;

/**
 * Segments a path may not contain, whatever the host filesystem tolerates.
 *
 * Windows-safe by construction rather than by platform test: a name that is
 * legal on ext4 and illegal on NTFS would make a library that cannot be moved
 * between the two, and this system has already migrated once.
 */
// Control characters are exactly what this must reject; the rule is about
// accidental ones.
// eslint-disable-next-line no-control-regex
const UNSAFE_SEGMENT = /[\\:<>"|?*]|[\x00-\x1F]/;
const TRAILING_DOT_OR_SPACE = /[. ]$/;

export type SubtitleInstallOutcome =
  | {
      readonly outcome: "installed";
      readonly relativePath: string;
      readonly sha256: string;
      readonly cueCount: number;
    }
  /** Byte-identical to what is already there. Not an error, and not a write. */
  | {
      readonly outcome: "duplicate";
      readonly relativePath: string;
      readonly sha256: string;
    }
  | {
      readonly outcome: "error";
      readonly failure: SubtitleFailureClass;
      readonly reason: string;
    }
  | { readonly outcome: "cancelled" };

export interface SubtitleInstallRequest {
  readonly mediaFileId: string;
  readonly language: string;
  readonly flags: SubtitleFlags;
  readonly payload: SubtitlePayload;
  /**
   * Whether an existing subtitle this system owns may be overwritten.
   *
   * Never allows overwriting one it does not own: `replace` is permission to
   * upgrade Seyirlik's own work, not permission to take somebody else's.
   */
  readonly replace: boolean;
  readonly signal?: AbortSignal;
}

export interface SubtitleStorage {
  /** The external tracks currently beside a media file. */
  inspect(mediaFileId: string): Promise<SubtitleTrack[]>;
  install(request: SubtitleInstallRequest): Promise<SubtitleInstallOutcome>;
  reconcile?(intent: SubtitleWriteIntent): Promise<SubtitleInstallOutcome>;
}

export interface SubtitleWriteIntent {
  readonly mediaFileId: string;
  readonly language: string;
  readonly flags: SubtitleFlags;
  readonly format: "srt" | "vtt";
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly cueCount: number;
  readonly fileIdentity: string;
  readonly operationId: string;
}

export interface SubtitleStorageOptions {
  /** Durable execution owner; supplied only by the server service. */
  readonly operationId?: string;
  readonly prepare?: (intent: SubtitleWriteIntent) => Promise<void>;
  /**
   * The only directory this writer will touch. Absolute, and authorised by the
   * deployment rather than by anything that arrives in a request.
   */
  readonly libraryRoot: string;
  /**
   * A catalogue id to a library-relative POSIX path. A server dependency: it
   * reads the catalogue, never a client's input.
   */
  resolveMedia(mediaFileId: string): Promise<string>;
  /**
   * The digest this system recorded for a subtitle it installed, or `null` if
   * it installed none there. The only thing that establishes ownership.
   */
  managedDigest(
    mediaFileId: string,
    relativePath: string,
  ): Promise<string | null>;
}

export function subtitleDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class StorageFailure extends Error {
  readonly failure: SubtitleFailureClass;
  readonly reason: string;
  constructor(failure: SubtitleFailureClass, reason: string) {
    super(reason);
    this.name = "StorageFailure";
    this.failure = failure;
    this.reason = reason;
  }
}

export function createSubtitleStorage(
  options: SubtitleStorageOptions,
): SubtitleStorage {
  if (!path.isAbsolute(options.libraryRoot)) {
    throw new Error("A subtitle library root must be an absolute path.");
  }
  const configuredRoot = path.resolve(options.libraryRoot);
  /*
   * The root is canonicalised once, lazily, and every check below is made
   * against the canonical form.
   *
   * This matters more than it looks. The walk further down refuses a symbolic
   * link on the way to a file, and an earlier version walked the *whole*
   * absolute path — which on macOS means `/var`, a system symlink to
   * `/private/var`, so every write under a temporary directory was refused as a
   * path escape. Links above the root are the deployment's own arrangement and
   * are none of this module's business; links *below* it are the ones a
   * mistake or an attacker could introduce, and those are what the walk is for.
   */
  let canonicalRoot: string | undefined;
  async function rootPath(): Promise<string> {
    canonicalRoot ??= await realpath(configuredRoot).catch(
      () => configuredRoot,
    );
    return canonicalRoot;
  }

  /**
   * The media file an id names, proven to be a real file inside the root.
   *
   * The walk down the path exists to reject a symlink or junction *before*
   * following it. Checking the final target alone is not enough: a link
   * anywhere along the way redirects everything below it, and the containment
   * check would then be answered about the wrong place.
   */
  async function locateMedia(mediaFileId: string): Promise<string> {
    const root = await rootPath();
    const relative = await options.resolveMedia(mediaFileId);
    const segments = relative.split("/");
    const unsafe =
      relative === "" ||
      segments.some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          UNSAFE_SEGMENT.test(segment) ||
          TRAILING_DOT_OR_SPACE.test(segment),
      );
    if (unsafe) {
      throw new StorageFailure(
        "path-escape",
        "The catalogue path is not a safe library-relative path.",
      );
    }

    const target = path.join(root, ...segments);
    if (!isPathInsideRoot(root, target)) {
      throw new StorageFailure(
        "path-escape",
        "The media path leaves the root.",
      );
    }

    // From the root down, never above it. See `rootPath`.
    let walked = root;
    const chain = path.relative(root, target).split(path.sep);
    for (let index = 0; index < chain.length; index += 1) {
      walked = path.join(walked, chain[index] as string);
      const entry = await lstat(walked).catch(() => null);
      if (entry === null) {
        throw new StorageFailure(
          "media-missing",
          "The media file is not there.",
        );
      }
      if (entry.isSymbolicLink()) {
        throw new StorageFailure(
          "path-escape",
          "A link on the way to the media file was refused.",
        );
      }
      const last = index === chain.length - 1;
      if (last ? !entry.isFile() : !entry.isDirectory()) {
        throw new StorageFailure(
          "media-missing",
          "The media path does not name a file.",
        );
      }
    }
    return target;
  }

  /** What is at the destination now, or `null`. Refuses anything odd. */
  async function existingAt(target: string): Promise<Uint8Array | null> {
    const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (entry === null) return null;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new StorageFailure(
        "destination-occupied",
        "The destination is not a regular file.",
      );
    }
    if (entry.size > MAX_SUBTITLE_BYTES) {
      throw new StorageFailure(
        "destination-occupied",
        "The destination is too large to be a subtitle this system wrote.",
      );
    }
    return readFile(target);
  }

  return {
    async inspect(mediaFileId) {
      const media = await locateMedia(mediaFileId);
      return detectSubtitlesOnDisk(media, await rootPath());
    },

    async install(request) {
      const { mediaFileId, language, flags, payload, replace, signal } =
        request;
      let temporary: string | undefined;
      let lockPath: string | undefined;
      let lock: Awaited<ReturnType<typeof open>> | undefined;

      try {
        const validated = validateSubtitle(payload);
        if (!/^[a-z]{2,3}$/.test(language) || language === "und") {
          throw new StorageFailure(
            "name-unrepresentable",
            "A subtitle needs a known language to be named after.",
          );
        }
        if (signal?.aborted) return { outcome: "cancelled" };

        const source = await locateMedia(mediaFileId);
        const root = await rootPath();
        if (!VIDEO_EXTENSIONS.test(source)) {
          throw new StorageFailure(
            "name-unrepresentable",
            "The catalogue path does not name a video container.",
          );
        }

        /*
         * `<stem>.<lang>[.forced][.sdh].<format>` — the convention the sidecar
         * discovery already reads, so a subtitle installed here is found by the
         * detector, the packager and the player without any of them being told
         * about it.
         */
        const suffix =
          `.${language}` +
          (flags.forced ? ".forced" : "") +
          (flags.hearingImpaired ? ".sdh" : "") +
          `.${validated.format}`;
        const target =
          source.slice(0, source.length - path.extname(source).length) + suffix;
        if (!isPathInsideRoot(root, target)) {
          throw new StorageFailure(
            "path-escape",
            "The derived destination leaves the root.",
          );
        }
        const relativePath = path
          .relative(root, target)
          .split(path.sep)
          .join("/");

        /*
         * One writer per media file. A process killed while holding this leaves
         * a lock nobody clears, which is deliberate: guessing the owner is dead
         * and stealing it is how two workers write the same file. The condition
         * is `commit-ambiguous`, which reconciles rather than retries.
         */
        lockPath = `${source}.seyirlik-subtitle.lock`;
        try {
          lock = await open(lockPath, "wx", 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return {
              outcome: "error",
              failure: "commit-ambiguous",
              reason: "Another writer holds this media file.",
            };
          }
          throw error;
        }

        const previous = await existingAt(target);
        const sha256 = subtitleDigest(validated.bytes);
        if (previous !== null && subtitleDigest(previous) === sha256) {
          // Already exactly this. Not a write, and not a failure.
          return { outcome: "duplicate", relativePath, sha256 };
        }

        if (previous === null) {
          /*
           * Nothing at this exact name, but the want may already be answered
           * under another one — a hand-added `Film.türkçe.srt` satisfies a
           * Turkish want and must not be silently duplicated beside itself.
           */
          const beside = await detectSubtitlesOnDisk(source, root);
          if (
            beside.some(
              (track) =>
                track.language === language && track.forced === flags.forced,
            )
          ) {
            throw new StorageFailure(
              "destination-occupied",
              "That language is already subtitled beside this file.",
            );
          }
        } else {
          const owned = await options.managedDigest(mediaFileId, relativePath);
          if (
            !replace ||
            owned === null ||
            owned !== subtitleDigest(previous)
          ) {
            throw new StorageFailure(
              "destination-occupied",
              "The destination holds a subtitle this system did not install.",
            );
          }
        }

        temporary = `${target}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o644);
        try {
          await handle.writeFile(validated.bytes);
          await handle.sync();
          if (options.prepare && options.operationId) {
            const stat = await handle.stat({ bigint: true });
            await lock.writeFile(options.operationId, "utf8");
            await lock.sync();
            await options.prepare({
              mediaFileId,
              language,
              flags: {
                forced: flags.forced,
                hearingImpaired: flags.hearingImpaired,
              },
              format: validated.format,
              sha256,
              sizeBytes: validated.bytes.length,
              cueCount: validated.cueCount,
              fileIdentity: `${stat.dev}:${stat.ino}`,
              operationId: options.operationId,
            });
          }
        } finally {
          await handle.close();
        }

        if (signal?.aborted) return { outcome: "cancelled" };

        /*
         * The window between deciding and committing is where somebody else's
         * write lands. Re-reading the destination narrows it to the moment of
         * the rename itself, which is as close as this can get without a
         * filesystem transaction.
         */
        const latest = await existingAt(target);
        const unchanged =
          previous === null
            ? latest === null
            : latest !== null &&
              subtitleDigest(latest) === subtitleDigest(previous);
        if (!unchanged) {
          throw new StorageFailure(
            "destination-occupied",
            "The destination changed while this subtitle was being written.",
          );
        }

        if (previous === null) {
          // No-clobber: two workers racing produce one file and one loser.
          await link(temporary, target);
        } else {
          await rename(temporary, target);
        }
        // A cancellation arriving now cannot un-commit what is on the disk.
        return {
          outcome: "installed",
          relativePath,
          sha256,
          cueCount: validated.cueCount,
        };
      } catch (error) {
        if (error instanceof StorageFailure) {
          return {
            outcome: "error",
            failure: error.failure,
            reason: error.reason,
          };
        }
        if (error instanceof InvalidSubtitleError) {
          return {
            outcome: "error",
            failure: error.failure,
            reason: error.reason,
          };
        }
        const classified = classifyFsError(error);
        const carried: readonly SubtitleFailureClass[] = [
          "destination-locked",
          "destination-occupied",
          "disk-full",
          "commit-ambiguous",
        ];
        const failure: SubtitleFailureClass =
          classified.failure === "source-missing"
            ? "media-missing"
            : carried.includes(classified.failure as SubtitleFailureClass)
              ? (classified.failure as SubtitleFailureClass)
              : "unknown";
        return {
          outcome: "error",
          failure,
          reason: "The subtitle could not be written.",
        };
      } finally {
        if (temporary !== undefined) {
          await unlink(temporary).catch(() => undefined);
        }
        if (lock !== undefined) {
          await lock.close();
          if (lockPath !== undefined) {
            await unlink(lockPath).catch(() => undefined);
          }
        }
      }
    },
    async reconcile(intent) {
      try {
        if (
          intent.operationId !== options.operationId ||
          !/^[a-z]{2,3}$/.test(intent.language) ||
          !["srt", "vtt"].includes(intent.format)
        )
          throw new Error("Invalid intent");
        const source = await locateMedia(intent.mediaFileId);
        const root = await rootPath();
        const target =
          source.slice(0, source.length - path.extname(source).length) +
          `.${intent.language}${intent.flags.forced ? ".forced" : ""}${intent.flags.hearingImpaired ? ".sdh" : ""}.${intent.format}`;
        if (!VIDEO_EXTENSIONS.test(source) || !isPathInsideRoot(root, target))
          throw new Error("Invalid target");
        const bytes = await existingAt(target);
        if (!bytes || subtitleDigest(bytes) !== intent.sha256)
          throw new Error("Receipt mismatch");
        const stat = await lstat(target, { bigint: true });
        if (`${stat.dev}:${stat.ino}` !== intent.fileIdentity)
          throw new Error("Identity mismatch");
        const lockPath = `${source}.seyirlik-subtitle.lock`;
        const lockStat = await lstat(lockPath).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (lockStat) {
          if (
            !lockStat.isFile() ||
            lockStat.isSymbolicLink() ||
            lockStat.size > 128 ||
            (await readFile(lockPath, "utf8")) !== intent.operationId
          )
            throw new Error("Different lock owner");
          await unlink(lockPath);
        }
        return {
          outcome: "installed",
          relativePath: path.relative(root, target).split(path.sep).join("/"),
          sha256: intent.sha256,
          cueCount: intent.cueCount,
        };
      } catch {
        return {
          outcome: "error",
          failure: "commit-ambiguous",
          reason: "The pending installation needs operator reconciliation.",
        };
      }
    },
  };
}
