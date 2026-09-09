import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { ChevronRight, PanelLeft, X } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { useIsMobileView } from "../../hooks/useIsMobileView";
import { groupForSection, sectionForPath } from "../../lib/adminSections";
import { DevToolsNav } from "./DevToolsNav";

/**
 * One shell around every administrative tool.
 *
 * Before this each tool was its own page: its own maximum width, its own back
 * link, its own idea of where the title goes. Opening two of them in a row felt
 * like opening two applications, and the only route between them was back to
 * the index. The shell supplies the frame — where you are, what else there is,
 * and how wide the content runs — so a tool only has to supply its own work.
 *
 * A layout route rather than a wrapper each page imports: the pages keep their
 * routes, their lazy chunks and their tests, and none of them has to remember
 * to opt in.
 *
 * The shell deliberately stops short of the title. Every tool already renders
 * its own `h1`, and a second one here would put two page headings on every
 * page — the duplicate headers this was meant to remove. The breadcrumb names
 * the group and the tool, which is what the heading would have said.
 */
export function DevToolsLayout() {
  const { t } = useLanguage();
  const location = useLocation();
  const isMobile = useIsMobileView();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const section = sectionForPath(location.pathname);
  const group = section ? groupForSection(section) : undefined;

  /*
   * A drawer left open across a navigation would cover the page it opened.
   * Adjusted during render rather than in an effect: the close has to happen
   * before the new page paints, and an effect would show the drawer over it
   * for a frame first.
   */
  const [drawerPath, setDrawerPath] = useState(location.pathname);
  if (drawerPath !== location.pathname) {
    setDrawerPath(location.pathname);
    setDrawerOpen(false);
  }

  const breadcrumb = (
    <nav
      aria-label={t("admin.shell.breadcrumb")}
      className="flex min-w-0 flex-wrap items-center gap-1 text-sm font-bold"
    >
      <Link
        to="/admin"
        className="rounded text-white/45 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        {t("admin.shell.root")}
      </Link>

      {group && section ? (
        <>
          <ChevronRight size={14} className="shrink-0 text-white/25" />
          <span className="text-white/45">{t(group.titleKey)}</span>
          <ChevronRight size={14} className="shrink-0 text-white/25" />
          <span className="truncate text-white">{t(section.titleKey)}</span>
        </>
      ) : null}
    </nav>
  );

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <div className="lg:flex lg:items-start lg:gap-8">
        {isMobile ? null : (
          <aside className="sticky top-24 hidden w-60 shrink-0 lg:block">
            <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto rounded-3xl border border-white/10 bg-black/30 p-3 shadow-2xl backdrop-blur-xl">
              <DevToolsNav />
            </div>
          </aside>
        )}

        <div className="min-w-0 flex-1 space-y-5">
          <div className="flex items-center gap-3">
            {isMobile ? (
              <button
                type="button"
                onClick={() => setDrawerOpen((open) => !open)}
                aria-expanded={drawerOpen}
                aria-controls="devtools-mobile-nav"
                className="inline-flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-2 text-sm font-bold text-white/70 transition hover:border-[var(--accent)]/35 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {drawerOpen ? <X size={16} /> : <PanelLeft size={16} />}
                {t(drawerOpen ? "admin.nav.close" : "admin.nav.open")}
              </button>
            ) : null}

            {breadcrumb}
          </div>

          {isMobile && drawerOpen ? (
            <div
              id="devtools-mobile-nav"
              className="rounded-3xl border border-white/10 bg-black/40 p-3 shadow-2xl backdrop-blur-xl"
            >
              <DevToolsNav
                idPrefix="devtools-mobile-nav"
                onNavigate={() => setDrawerOpen(false)}
              />
            </div>
          ) : null}

          <Outlet />
        </div>
      </div>
    </div>
  );
}
