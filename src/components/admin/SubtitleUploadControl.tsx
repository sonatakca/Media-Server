import { useRef } from "react";
import { Upload } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { MAX_SUBTITLE_UPLOAD_BYTES } from "../../lib/libraryAdminApi";
import { actionButton } from "./libraryStyle";
import { Tooltip } from "../ui/Tooltip";

/** What the picker offers, and what the server will actually install. */
const ACCEPT = ".srt,.vtt,text/plain,application/x-subrip,text/vtt";

export interface SubtitleUploadPolicy {
  language: "tur" | "eng";
  forced: boolean;
  replace: boolean;
}

/**
 * The two things a subtitle file cannot say about itself, plus one permission.
 *
 * Held apart from the button because a show is uploaded to one episode at a
 * time: the policy is chosen once for the season being worked through, and each
 * episode's row only needs somewhere to drop a file. A film composes the two
 * together and sees no difference.
 */
export function SubtitleUploadPolicyFields({
  policy,
  onChange,
  disabled,
}: {
  policy: SubtitleUploadPolicy;
  onChange: (policy: SubtitleUploadPolicy) => void;
  disabled: boolean;
}) {
  const { t } = useLanguage();
  return (
    <>
      <label className="sr-only" htmlFor="subtitle-upload-language">
        {t("library.subtitleLanguage")}
      </label>
      <select
        id="subtitle-upload-language"
        value={policy.language}
        disabled={disabled}
        onChange={(event) =>
          onChange({
            ...policy,
            language: event.target.value === "eng" ? "eng" : "tur",
          })
        }
        className="min-h-9 rounded-lg border border-white/10 bg-black/40 px-2 text-xs font-bold text-white/80 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <option value="tur">Türkçe</option>
        <option value="eng">English</option>
      </select>

      <label className="inline-flex items-center gap-1.5 text-xs font-bold text-white/60">
        <input
          type="checkbox"
          checked={policy.forced}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...policy, forced: event.target.checked })
          }
          className="accent-sky-300"
        />
        {t("library.subtitleForced")}
      </label>

      <label className="inline-flex items-center gap-1.5 text-xs font-bold text-white/60">
        <input
          type="checkbox"
          checked={policy.replace}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...policy, replace: event.target.checked })
          }
          className="accent-sky-300"
        />
        {t("library.subtitleReplace")}
      </label>
    </>
  );
}

/**
 * Somewhere to drop one subtitle file.
 *
 * The file's own name is neither sent nor shown: where it lands and what it is
 * called are decided on the server from the video it belongs to, and that is
 * the whole point of the control — `[YTS] dune.2021.tr.srt` arrives beside the
 * film as `Dune (2021).tur.srt`.
 */
export function SubtitleUploadButton({
  disabled,
  onPick,
  label,
  iconOnly = false,
}: {
  disabled: boolean;
  onPick: (file: File) => void | Promise<void>;
  /** Names the target, so a screen reader hears which episode this is. */
  label: string;
  iconOnly?: boolean;
}) {
  const { t } = useLanguage();
  const input = useRef<HTMLInputElement>(null);
  const button = (
    <button
      type="button"
      className={actionButton}
      disabled={disabled}
      aria-label={label}
      onClick={() => input.current?.click()}
    >
      <Upload size={13} aria-hidden="true" />
      {iconOnly ? null : t("library.uploadSubtitle")}
    </button>
  );

  return (
    <>
      {iconOnly ? <Tooltip content={label}>{button}</Tooltip> : button}
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Cleared at once, so choosing the same file again still fires.
          event.currentTarget.value = "";
          if (!file || file.size > MAX_SUBTITLE_UPLOAD_BYTES) return;
          void onPick(file);
        }}
      />
    </>
  );
}
