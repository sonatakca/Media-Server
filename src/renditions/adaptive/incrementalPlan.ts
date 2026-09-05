import {
  audioRenditionId,
  subtitleRenditionId,
  videoRenditionId,
} from "./profile";

/**
 * Deciding how much of a package actually has to be built.
 *
 * The packager used to answer this as a single yes or no: a title whose
 * package matched its source and profile and carried every rung of today's
 * ladder was skipped, and anything else was rebuilt from scratch. That is
 * correct only at the two extremes. The moment the ladder gained a rung, a
 * title holding seven perfectly good renditions was put through an eight-rung
 * encode — a `split=8` filter graph, eight VideoToolbox encoders and a fresh
 * audio transcode — to obtain the one rendition it lacked. The planner and the
 * UI knew only 1440p was missing; the encoder was simply never told.
 *
 * The work is therefore decided per rendition, here, in one pure function that
 * both the packager and its tests can call. What the encoder receives is the
 * answer this returns, so the two cannot drift apart again.
 */

/** A rung of the ladder the current policy asks for. */
export interface LadderRequirement {
  qualityHeight: number;
}

/** The published renditions a title already holds, as the manifest lists them. */
export interface ExistingPackageShape {
  sourceFingerprint: string;
  profileVersion: string;
  video: readonly { id: string; qualityHeight: number }[];
  audio: readonly { id: string }[];
  subtitle: readonly { id: string }[];
}

/**
 * Which published renditions were found intact on disk.
 *
 * Presence is supplied rather than probed here so this stays pure, and so the
 * caller can decide how thorough the check is — a manifest entry whose media
 * file is missing or zero-length must not be treated as reusable.
 */
export interface RenditionPresence {
  video: ReadonlySet<string>;
  audio: ReadonlySet<string>;
  subtitle: ReadonlySet<string>;
}

export type PackageWorkMode = "full" | "incremental" | "none";

export interface PackageWorkPlan {
  mode: PackageWorkMode;
  /** Exactly the rungs the encoder should produce, ascending by height. */
  videoQualityHeights: number[];
  /** Audio stream indexes to encode; empty means reuse what is published. */
  audioStreamIndexes: number[];
  /** Subtitle stream indexes to extract; empty means reuse what is published. */
  subtitleStreamIndexes: number[];
  /** Why this shape of work was chosen, for logs and job metadata. */
  reason: string;
}

export interface PlanPackageWorkInput {
  requirements: readonly LadderRequirement[];
  /** The published package, or null when the title has never been packaged. */
  existing: ExistingPackageShape | null;
  presence: RenditionPresence;
  sourceFingerprint: string;
  profileVersion: string;
  /** Source audio stream indexes the retention policy chose. */
  requiredAudioStreamIndexes: readonly number[];
  /** Source subtitle stream indexes the retention policy chose. */
  requiredSubtitleStreamIndexes: readonly number[];
}

function fullPlan(
  input: PlanPackageWorkInput,
  reason: string,
): PackageWorkPlan {
  return {
    mode: "full",
    videoQualityHeights: [...input.requirements]
      .map((requirement) => requirement.qualityHeight)
      .sort((left, right) => left - right),
    audioStreamIndexes: [...input.requiredAudioStreamIndexes],
    subtitleStreamIndexes: [...input.requiredSubtitleStreamIndexes],
    reason,
  };
}

/**
 * The renditions that actually need encoding, and nothing else.
 *
 * A published rendition is reusable only when the package as a whole was built
 * from these source bytes under this profile *and* that particular rendition's
 * files are still intact. The first two conditions are what make reuse safe
 * after an encoding-profile change: a new profile version invalidates
 * everything at once, which is the existing mechanism and the right one. The
 * per-rendition file check is what stops a truncated or missing output being
 * mistaken for finished work.
 *
 * Adding a rung to the ladder deliberately does *not* invalidate the rungs
 * already on disk — their encoding configuration did not change — so it yields
 * one missing rendition rather than a stale package.
 */
export function planPackageWork(input: PlanPackageWorkInput): PackageWorkPlan {
  const { existing, presence } = input;

  if (!existing) {
    return fullPlan(input, "No package exists for this title yet.");
  }
  if (existing.sourceFingerprint !== input.sourceFingerprint) {
    return fullPlan(
      input,
      "The source file changed since the package was built.",
    );
  }
  if (existing.profileVersion !== input.profileVersion) {
    return fullPlan(
      input,
      "The package was built by an older encoding profile.",
    );
  }

  /*
   * Only a rendition that is both listed and intact counts. A manifest entry
   * whose media file has gone missing is not evidence of work already done.
   */
  const usableVideoHeights = new Set(
    existing.video
      .filter((rendition) => presence.video.has(rendition.id))
      .map((rendition) => rendition.qualityHeight),
  );
  const videoQualityHeights = input.requirements
    .map((requirement) => requirement.qualityHeight)
    .filter((height) => !usableVideoHeights.has(height))
    .sort((left, right) => left - right);

  const usableAudioIds = new Set(
    existing.audio
      .filter((rendition) => presence.audio.has(rendition.id))
      .map((rendition) => rendition.id),
  );
  const audioStreamIndexes = input.requiredAudioStreamIndexes.filter(
    (streamIndex) => !usableAudioIds.has(audioRenditionId(streamIndex)),
  );

  const usableSubtitleIds = new Set(
    existing.subtitle
      .filter((rendition) => presence.subtitle.has(rendition.id))
      .map((rendition) => rendition.id),
  );
  const subtitleStreamIndexes = input.requiredSubtitleStreamIndexes.filter(
    (streamIndex) => !usableSubtitleIds.has(subtitleRenditionId(streamIndex)),
  );

  /*
   * A package can be short of audio without being short of video, and the
   * reverse. Each is asked for separately so adding a rung never re-encodes
   * sound that is already correct, and a missing audio track never rebuilds
   * seven video renditions.
   */
  if (
    videoQualityHeights.length === 0 &&
    audioStreamIndexes.length === 0 &&
    subtitleStreamIndexes.length === 0
  ) {
    return {
      mode: "none",
      videoQualityHeights: [],
      audioStreamIndexes: [],
      subtitleStreamIndexes: [],
      reason: "Every required rendition is already published and intact.",
    };
  }

  return {
    mode: "incremental",
    videoQualityHeights,
    audioStreamIndexes,
    subtitleStreamIndexes,
    reason: describeIncrementalWork(
      videoQualityHeights,
      audioStreamIndexes,
      subtitleStreamIndexes,
    ),
  };
}

/** A short human description of incremental work, for job metadata and logs. */
export function describeIncrementalWork(
  videoQualityHeights: readonly number[],
  audioStreamIndexes: readonly number[],
  subtitleStreamIndexes: readonly number[],
): string {
  const parts: string[] = [];
  if (videoQualityHeights.length > 0) {
    parts.push(
      [...videoQualityHeights]
        .sort((left, right) => right - left)
        .map((height) => videoRenditionId(height))
        .join(", "),
    );
  }
  if (audioStreamIndexes.length > 0) {
    parts.push(`${audioStreamIndexes.length} audio track(s)`);
  }
  if (subtitleStreamIndexes.length > 0) {
    parts.push(`${subtitleStreamIndexes.length} subtitle track(s)`);
  }
  return parts.length === 0
    ? "Nothing to build."
    : `Adding ${parts.join(" + ")}.`;
}
