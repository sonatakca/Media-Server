import type { TranslationKey } from "../../i18n/translations";

/**
 * What the maintenance actions and the processing pages share.
 *
 * This module used to carry the per-title metadata editor's model as well —
 * drafts, subtitle-preference aggregation, detail formatting. The editor moved
 * into the title workspace, where artwork and metadata are edited through the
 * native API, and those helpers went with it.
 */

export type ActionState = "idle" | "loading" | "success" | "error";

export type Translate = (key: TranslationKey) => string;

export interface ActionResult {
  state: ActionState;
  message: string;
}

export function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}
