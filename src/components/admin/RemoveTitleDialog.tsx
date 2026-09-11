import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  formatBytes,
  removeLibraryTitle,
  type LibraryTitle,
  type TitleRemovalReport,
} from "../../lib/libraryAdminApi";

/**
 * The one irreversible action on the Wanted page.
 *
 * The title has to be typed, not clicked: a mis-aimed click can land on any
 * button, but it cannot spell a film's name. The server checks the same thing,
 * so this dialog is a courtesy and not the control.
 */
export function RemoveTitleDialog({
  title,
  onClose,
  onRemoved,
}: {
  title: LibraryTitle;
  onClose: () => void;
  onRemoved: (report: TitleRemovalReport) => void;
}) {
  const { t } = useLanguage();
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const matches = typed.trim() === title.title.trim();

  useEffect(() => {
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, working]);

  async function remove() {
    setWorking(true);
    setFailure(null);
    try {
      onRemoved(await removeLibraryTitle(title.id, typed));
    } catch (error) {
      const code = (error as { code?: string }).code;
      setFailure(
        t(
          code === "REMOVAL_BUSY"
            ? "library.removeBusy"
            : code === "REMOVAL_CONFIRMATION"
              ? "library.removeMismatch"
              : code === "REMOVAL_UNSAFE"
                ? "library.removeUnsafe"
                : "library.removeFailed",
        ),
      );
      setWorking(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget && !working) onClose();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-title-heading"
        aria-describedby="remove-title-description"
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0a0b0e] p-6 shadow-2xl"
      >
        <h2 id="remove-title-heading" className="text-lg font-black text-white">
          {t("library.removeHeading")} {title.title}
        </h2>
        <div
          id="remove-title-description"
          className="mt-3 space-y-2 text-sm text-white/70"
        >
          <p>{t("library.removeExplanation")}</p>
          {title.sizeBytes > 0 ? (
            <p className="font-bold text-rose-200">
              {t("library.removeSize")} {formatBytes(title.sizeBytes)}
            </p>
          ) : null}
          <p className="font-bold text-white/85">
            {t("library.removeIrreversible")}
          </p>
        </div>
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (matches && !working) void remove();
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-bold text-white/60">
            {t("library.removeType")}{" "}
            <span className="select-all font-black text-white">
              {title.title}
            </span>
            <input
              ref={input}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 min-h-10 rounded-lg border border-white/15 bg-black/40 px-3 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
            />
          </label>
          {failure ? (
            <p role="alert" className="text-sm text-red-200">
              {failure}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={working}
              className="min-h-10 rounded-lg px-4 text-sm font-bold text-white/75 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {t("library.cancel")}
            </button>
            <button
              type="submit"
              disabled={!matches || working}
              className="min-h-10 rounded-lg bg-rose-500/90 px-4 text-sm font-black text-white hover:bg-rose-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200"
            >
              {working ? t("library.removing") : t("library.removeConfirm")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
