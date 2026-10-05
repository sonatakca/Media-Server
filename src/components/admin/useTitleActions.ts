import { useState } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  generateTrickplay,
  requestTitleSubtitles,
  uploadTitleSubtitle,
} from "../../lib/libraryAdminApi";
import { setWanted } from "../../lib/wantedApi";
import { describeErrorDetail } from "../../lib/userFacingError";

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
      const status = (error as { status?: number }).status;
      setNotice({
        tone: "error",
        text:
          status === 404 && key.startsWith("subtitles:")
            ? t("library.subtitlesUnconfigured")
            : status === 404 && key.startsWith("subtitle-upload:")
              ? t("library.subtitlesUnconfigured")
              : /*
                 * A refused upload carries the only sentence that says what to
                 * do about it — which file is in the way, or what the bytes
                 * turned out to be — so it is shown rather than flattened into
                 * "the action failed".
                 */
                (key.startsWith("subtitle-upload:") &&
                  describeErrorDetail(error, t)) ||
                t("library.actionFailed"),
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
    /**
     * A subtitle the operator already has.
     *
     * Reports the name the file was given rather than the one it arrived
     * under: renaming it into the library's convention is the whole point, and
     * seeing the new name is how somebody knows it worked.
     */
    uploadSubtitle: (
      itemId: string,
      file: File,
      policy: { language: "tur" | "eng"; forced?: boolean; replace?: boolean },
    ) =>
      run(`subtitle-upload:${itemId}`, async () => {
        const report = await uploadTitleSubtitle(itemId, file, policy);
        return report.outcome === "duplicate"
          ? `${t("library.subtitleAlreadyThere")} ${report.fileName}`
          : `${t("library.subtitleUploaded")} ${report.fileName}`;
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
