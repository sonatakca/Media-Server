import { useState } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  generateTrickplay,
  requestTitleSubtitles,
} from "../../lib/libraryAdminApi";
import { setWanted } from "../../lib/wantedApi";

export type Notice = { tone: "ok" | "error"; text: string } | null;

/**
 * The per-title actions, and what each one said.
 *
 * One hook for the list and the workspace, so "find subtitles" and "generate
 * trickplay" mean the same request and report the same way wherever pressed.
 */
export function useTitleActions(onChanged: () => void | Promise<void>) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function run(key: string, work: () => Promise<string>) {
    setBusy(key);
    setNotice(null);
    try {
      setNotice({ tone: "ok", text: await work() });
      await onChanged();
    } catch (error) {
      setNotice({
        tone: "error",
        text:
          (error as { status?: number }).status === 404 &&
          key.startsWith("subtitles:")
            ? t("library.subtitlesUnconfigured")
            : t("library.actionFailed"),
      });
    } finally {
      setBusy(null);
    }
  }

  return {
    busy,
    notice,
    setNotice,
    findSubtitles: (itemId: string) =>
      run(`subtitles:${itemId}`, async () => {
        const result = await requestTitleSubtitles(itemId, "tur");
        return result.files === 0
          ? t("library.subtitlesNoFiles")
          : `${t("library.subtitlesQueued")} ${result.queued}/${result.files}`;
      }),
    trickplay: (itemId: string, force = false) =>
      run(`trickplay:${itemId}`, async () => {
        const result = await generateTrickplay(itemId, force);
        return result.queued === 0
          ? result.alreadyGenerated > 0
            ? t("library.trickplayUpToDate")
            : t("library.trickplayNothing")
          : `${t("library.trickplayQueued")} ${result.queued}`;
      }),
    toggleWanted: (itemId: string, desired: boolean) =>
      run(`wanted:${itemId}`, async () => {
        await setWanted(itemId, !desired);
        return t(desired ? "library.unwanted" : "library.nowWanted");
      }),
  };
}
