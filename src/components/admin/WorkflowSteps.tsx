import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";

/**
 * The four stops between wanting a film and having it.
 *
 * Wanting, decisions, acquisitions and imports are four backend subsystems
 * and one human errand, and until now the UI only ever showed one of them at a
 * time with no indication that the others existed — which is what made "from
 * where do I download a wanted movie?" a question the interface could not
 * answer. Shown on each of the four, it doubles as a place marker and as the
 * route to the next step.
 *
 * It navigates and nothing more. Each page still owns its own actions; this
 * only stops them from looking like four unrelated tools.
 */
const STEPS: ReadonlyArray<{ path: string; labelKey: TranslationKey }> = [
  { path: "/admin/library", labelKey: "admin.workflow.wanted" },
  { path: "/admin/decisions", labelKey: "admin.workflow.releases" },
  { path: "/admin/acquisitions", labelKey: "admin.workflow.downloads" },
  { path: "/admin/imports", labelKey: "admin.workflow.imports" },
];

export function WorkflowSteps({ current }: { current: string }) {
  const { t } = useLanguage();

  return (
    <ol
      aria-label={t("admin.overview.workflow.heading")}
      className="flex flex-wrap items-center gap-1.5"
    >
      {STEPS.map((step, index) => {
        const active = step.path === current;

        return (
          <li key={step.path} className="flex items-center gap-1.5">
            {index > 0 ? (
              <ChevronRight size={14} className="shrink-0 text-white/25" />
            ) : null}

            {active ? (
              <span
                aria-current="step"
                className="rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/12 px-3 py-1.5 text-sm font-black text-[var(--accent)]"
              >
                {t(step.labelKey)}
              </span>
            ) : (
              <Link
                to={step.path}
                className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-sm font-bold text-white/60 transition hover:border-[var(--accent)]/35 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {t(step.labelKey)}
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}
