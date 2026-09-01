/**
 * The integration boundary for Radarr and Sonarr, defined but not wired.
 *
 * Nothing in the runtime constructs one of these. It exists so that a future
 * adapter has a shape to fill in and, more importantly, so the rule that makes
 * such an adapter safe is written down next to it: exactly one writer may own
 * an .nfo path. Radarr rewriting what Seyirlik just wrote, and Seyirlik
 * rewriting that, is not a conflict either side can detect — both files look
 * valid, and the library simply churns.
 *
 * The native exporter enforces its half of that rule through
 * `SEYIRLIK_NFO_ARR_MANAGED_LIBRARIES`: a library named there is skipped
 * entirely, whatever the export mode says.
 */

/** v3 endpoints an adapter would use. Listed so the surface stays small. */
export const ARR_ENDPOINTS = {
  metadataSchema: "/api/v3/metadata/schema",
  metadata: "/api/v3/metadata",
  command: "/api/v3/command",
  /** `GET /api/v3/command/{id}` — polled until the command leaves `queued`. */
  commandById: (commandId: number | string) => `/api/v3/command/${commandId}`,
} as const;

/**
 * The metadata-consumer fields each program exposes.
 *
 * Radarr's movie metadata and Sonarr's series/episode metadata are separate
 * toggles on separate consumers; an adapter sets only the ones belonging to the
 * program it is talking to.
 */
export const ARR_METADATA_FIELDS = {
  radarr: ["movieMetadata", "useMovieNfo"],
  sonarr: ["seriesMetadata", "episodeMetadata"],
} as const;

export type ArrFlavour = keyof typeof ARR_METADATA_FIELDS;

export interface ArrMetadataConsumer {
  id: number;
  name: string;
  implementation: string;
  enable: boolean;
  fields: Array<{ name: string; value: unknown }>;
}

export interface ArrCommand {
  id: number;
  name: string;
  status: "queued" | "started" | "completed" | "failed" | "aborted";
}

export interface ArrClientOptions {
  baseUrl: string;
  /**
   * Stays in this process. It is sent as `X-Api-Key` and must never appear in a
   * log line, an error message, or an API response — `redactArrSecrets` is the
   * only sanctioned way to put an Arr response anywhere a person can read it.
   */
  apiKey: string;
  flavour: ArrFlavour;
  timeoutMs?: number;
}

export interface ArrClient {
  readonly flavour: ArrFlavour;
  /** `GET /api/v3/metadata/schema`. */
  getMetadataSchema(): Promise<ArrMetadataConsumer[]>;
  /** `GET /api/v3/metadata`. */
  listMetadataConsumers(): Promise<ArrMetadataConsumer[]>;
  /** `POST /api/v3/metadata`. */
  createMetadataConsumer(
    consumer: Omit<ArrMetadataConsumer, "id">,
  ): Promise<ArrMetadataConsumer>;
  /** `PUT /api/v3/metadata`. */
  updateMetadataConsumer(
    consumer: ArrMetadataConsumer,
  ): Promise<ArrMetadataConsumer>;
  /** `POST /api/v3/command`. */
  runCommand(
    name: string,
    payload?: Record<string, unknown>,
  ): Promise<ArrCommand>;
  /** `GET /api/v3/command/{id}`, polled by the caller. */
  getCommand(commandId: number): Promise<ArrCommand>;
}

/**
 * Strips anything that looks like an Arr credential out of text bound for a
 * log or an API response.
 *
 * Deliberately blunt: an over-redacted log line costs nothing, and a key that
 * reaches a log file has to be rotated.
 */
export function redactArrSecrets(text: string): string {
  return text
    .replace(/(x-api-key\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/([?&]apikey=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b[0-9a-f]{32}\b/gi, "[redacted]");
}

/**
 * Whether the native exporter is allowed to manage this library's .nfo files.
 *
 * The single check both the service and any future adapter must go through, so
 * "who owns this path" has one answer rather than two implementations that
 * agree until they do not.
 */
export function nativeExportOwnsLibrary(
  librarySlug: string,
  arrManagedLibrarySlugs: ReadonlySet<string>,
): boolean {
  return !arrManagedLibrarySlugs.has(librarySlug.toLowerCase());
}
