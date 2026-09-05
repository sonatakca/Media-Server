/**
 * Whether a scan is allowed to tidy the media volume, parsed once at startup.
 *
 * Moving somebody's files is not a thing to enable by inference, so the default
 * is to do nothing at all. `plan` exists because the useful middle step is
 * seeing the exact list of moves a scan *would* make against the real library —
 * that list appears in the scan's result and in `npm run media:organize:plan` —
 * before anything is moved.
 */

type Environment = Record<string, string | undefined>;

/**
 * - `off`   — the media volume is never written to by a scan. The default.
 * - `plan`  — the moves are computed and reported; nothing is moved.
 * - `apply` — the moves are carried out, then the scan reads the result.
 */
export type OrganizeMode = "off" | "plan" | "apply";

const MODES: OrganizeMode[] = ["off", "plan", "apply"];

export const ORGANIZE_DEFAULT_MODE: OrganizeMode = "off";

export function parseOrganizeMode(
  environment: Environment = process.env,
): OrganizeMode {
  const raw = environment.SEYIRLIK_MEDIA_ORGANIZE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return ORGANIZE_DEFAULT_MODE;
  const match = MODES.find((mode) => mode === raw);
  if (!match) {
    throw new Error(
      `SEYIRLIK_MEDIA_ORGANIZE must be one of ${MODES.join(", ")}.`,
    );
  }
  return match;
}

/** Whether this mode moves a single byte on the media volume. */
export function movesFiles(mode: OrganizeMode): boolean {
  return mode === "apply";
}
