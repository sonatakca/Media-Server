/**
 * The administration surface, as one list rather than several.
 *
 * Before this there were two descriptions of what administration contains: a
 * grid of cards on one page, and the route table. Adding a section meant
 * editing both, and forgetting either produced a link to nothing or a page
 * nobody could reach. This module is the description; the page renders it and
 * a test holds the route table to it.
 *
 * The translation keys are typed rather than left as strings, so a section
 * naming a key that does not exist fails to compile instead of rendering the
 * key to an operator.
 *
 * It is also grouped, which is the point of the exercise. Thirteen equally
 * prominent cards were already hard to scan, and the subsystems built since —
 * acquisitions, imports, subtitles — would have made nineteen. Grouping asks
 * the reader to choose between four kinds of task instead of nineteen tasks.
 */

import type { TranslationKey } from "../i18n/translations";

/** What a section is for, which is what decides where it is listed. */
export type AdminGroupId =
  /** Running the pipeline: what it is doing, and what needs a person. */
  | "operations"
  /** The library's own contents: processing, tidying, artwork, ordering. */
  | "library"
  /** What the server is connected to, and how it behaves. */
  | "configuration"
  /** Looking inside the machine. Genuinely developer-facing. */
  | "diagnostics";

export interface AdminSection {
  /** Stable identity, independent of the route or the title. */
  readonly id: string;
  readonly group: AdminGroupId;
  /** The route this section lives at. */
  readonly path: string;
  /** Translation keys; the registry holds no display text of its own. */
  readonly titleKey: TranslationKey;
  readonly descriptionKey: TranslationKey;
  readonly tagKey: TranslationKey;
  /** Named rather than imported, so this module pulls in no icon set. */
  readonly icon: AdminIconName;
  /**
   * Only shown in a development build.
   *
   * The one section that is genuinely not for an operator; kept in the
   * registry rather than special-cased at the page, so the list of what exists
   * stays in one place.
   */
  readonly devOnly?: boolean;
}

/** Icons the administration page knows how to draw. */
export type AdminIconName =
  | "activity"
  | "bug"
  | "database"
  | "databaseZap"
  | "download"
  | "fileVideo"
  | "hardDrive"
  | "heartPulse"
  | "images"
  | "languages"
  | "lightbulb"
  | "listOrdered"
  | "panelsTopLeft"
  | "plug"
  | "save"
  | "serverCog"
  | "shieldAlert"
  | "subtitles"
  | "target"
  | "users";

export interface AdminGroup {
  readonly id: AdminGroupId;
  readonly titleKey: TranslationKey;
  readonly descriptionKey: TranslationKey;
}

export const ADMIN_GROUPS: readonly AdminGroup[] = [
  {
    id: "operations",
    titleKey: "admin.group.operations.title",
    descriptionKey: "admin.group.operations.description",
  },
  {
    id: "library",
    titleKey: "admin.group.library.title",
    descriptionKey: "admin.group.library.description",
  },
  {
    id: "configuration",
    titleKey: "admin.group.configuration.title",
    descriptionKey: "admin.group.configuration.description",
  },
  {
    id: "diagnostics",
    titleKey: "admin.group.diagnostics.title",
    descriptionKey: "admin.group.diagnostics.description",
  },
];

/*
 * Existing sections keep the routes they already had. Renaming `/dev/...` to
 * `/admin/...` would break every bookmark and every link back from a dozen
 * pages, for a gain that is entirely cosmetic — the grouping and the naming on
 * the page are what make this an operations surface rather than a toolbox.
 */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  // ---- operations
  {
    id: "health",
    group: "operations",
    path: "/admin/health",
    titleKey: "admin.health.title",
    descriptionKey: "admin.health.description",
    tagKey: "admin.health.tag",
    icon: "heartPulse",
  },
  {
    id: "acquisitions",
    group: "operations",
    path: "/admin/acquisitions",
    titleKey: "admin.acquisitions.title",
    descriptionKey: "admin.acquisitions.description",
    tagKey: "admin.acquisitions.tag",
    icon: "download",
  },
  {
    id: "decisions",
    group: "operations",
    path: "/admin/decisions",
    titleKey: "admin.decisions.title",
    descriptionKey: "admin.decisions.description",
    tagKey: "admin.decisions.tag",
    icon: "target",
  },
  {
    id: "subtitles",
    group: "operations",
    path: "/admin/subtitles",
    titleKey: "admin.subtitles.title",
    descriptionKey: "admin.subtitles.description",
    tagKey: "admin.subtitles.tag",
    icon: "subtitles",
  },
  {
    id: "media-processing",
    group: "operations",
    path: "/dev/media-processing",
    titleKey: "devtools.card.mediaProcessing.title",
    descriptionKey: "devtools.card.mediaProcessing.description",
    tagKey: "devtools.card.mediaProcessing.tag",
    icon: "fileVideo",
  },
  {
    id: "library-maintenance",
    group: "operations",
    path: "/dev/library-maintenance",
    titleKey: "devtools.card.libraryMaintenance.title",
    descriptionKey: "devtools.card.libraryMaintenance.description",
    tagKey: "devtools.card.libraryMaintenance.tag",
    icon: "databaseZap",
  },

  // ---- library
  {
    id: "curation",
    group: "library",
    path: "/dev/curation",
    titleKey: "devtools.card.curation.title",
    descriptionKey: "devtools.card.curation.description",
    tagKey: "devtools.card.curation.tag",
    icon: "listOrdered",
  },
  {
    id: "tmdb-artwork",
    group: "library",
    path: "/dev/tmdb-artwork",
    titleKey: "devtools.card.tmdbArtwork.title",
    descriptionKey: "devtools.card.tmdbArtwork.description",
    tagKey: "devtools.card.tmdbArtwork.tag",
    icon: "images",
  },
  {
    id: "content-explorer",
    group: "library",
    path: "/dev/content",
    titleKey: "devtools.card.contentExplorer.title",
    descriptionKey: "devtools.card.contentExplorer.description",
    tagKey: "devtools.card.contentExplorer.tag",
    icon: "database",
  },

  // ---- configuration
  {
    id: "playback-defaults",
    group: "configuration",
    path: "/dev/playback-defaults",
    titleKey: "devtools.card.playbackDefaults.title",
    descriptionKey: "devtools.card.playbackDefaults.description",
    tagKey: "devtools.card.playbackDefaults.tag",
    icon: "languages",
  },
  {
    id: "users",
    group: "configuration",
    path: "/dev/users",
    titleKey: "devtools.card.userManagement.title",
    descriptionKey: "devtools.card.userManagement.description",
    tagKey: "devtools.card.userManagement.tag",
    icon: "users",
  },

  // ---- diagnostics
  {
    id: "server-control",
    group: "diagnostics",
    path: "/dev/server-control",
    titleKey: "devtools.card.serverControl.title",
    descriptionKey: "devtools.card.serverControl.description",
    tagKey: "devtools.card.serverControl.tag",
    icon: "serverCog",
  },
  {
    id: "playback-health",
    group: "diagnostics",
    path: "/dev/playback-health",
    titleKey: "devtools.card.playbackHealth.title",
    descriptionKey: "devtools.card.playbackHealth.description",
    tagKey: "devtools.card.playbackHealth.tag",
    icon: "shieldAlert",
  },
  {
    id: "playback-audit",
    group: "diagnostics",
    path: "/dev/playback-audit",
    titleKey: "devtools.card.playbackAudit.title",
    descriptionKey: "devtools.card.playbackAudit.description",
    tagKey: "devtools.card.playbackAudit.tag",
    icon: "activity",
  },
  {
    id: "known-bugs",
    group: "diagnostics",
    path: "/dev/known-bugs",
    titleKey: "devtools.card.knownBugs.title",
    descriptionKey: "devtools.card.knownBugs.description",
    tagKey: "devtools.card.knownBugs.tag",
    icon: "bug",
  },
  {
    id: "wanted-features",
    group: "diagnostics",
    path: "/dev/wanted-features",
    titleKey: "devtools.card.wantedFeatures.title",
    descriptionKey: "devtools.card.wantedFeatures.description",
    tagKey: "devtools.card.wantedFeatures.tag",
    icon: "lightbulb",
  },
  {
    id: "skeleton-lab",
    group: "diagnostics",
    path: "/dev/skeleton-lab",
    titleKey: "devtools.card.skeletonLab.title",
    descriptionKey: "devtools.card.skeletonLab.description",
    tagKey: "devtools.card.skeletonLab.tag",
    icon: "panelsTopLeft",
    devOnly: true,
  },
];

/** The sections of one group, in registry order. */
export function sectionsInGroup(
  group: AdminGroupId,
  { includeDevOnly }: { includeDevOnly: boolean },
): AdminSection[] {
  return ADMIN_SECTIONS.filter(
    (section) =>
      section.group === group && (includeDevOnly || section.devOnly !== true),
  );
}

/** Groups that have something to show, so an empty heading is never drawn. */
export function visibleGroups({
  includeDevOnly,
}: {
  includeDevOnly: boolean;
}): Array<{ group: AdminGroup; sections: AdminSection[] }> {
  return ADMIN_GROUPS.map((group) => ({
    group,
    sections: sectionsInGroup(group.id, { includeDevOnly }),
  })).filter((entry) => entry.sections.length > 0);
}
