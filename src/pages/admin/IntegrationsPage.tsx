import { useEffect, useState } from "react";
import { Check, Minus } from "lucide-react";
import { setPageTitle } from "../../lib/pageTitle";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  fetchIntegrations,
  fetchSchemaStatus,
  type IntegrationStatus,
  type SchemaStatus,
} from "../../lib/configurationApi";
import { SubtitleProvidersPanel } from "../../components/admin/SubtitleProvidersPanel";

/**
 * What the server is connected to, and what its database is carrying.
 *
 * Deliberately read-only. Configuration lives in environment files that only
 * the service accounts can read, and an endpoint that could rewrite them would
 * be a way to point the server somewhere new while keeping its credentials. So
 * this page says what is set up and what is not, and changing it is editing a
 * protected file and restarting — which is also why no secret is ever shown:
 * an operator replaces a key, they never need to read one back.
 *
 * The one thing written from here is a subtitle provider's browser session.
 * It points the server nowhere new — the provider is fixed in configuration —
 * and it is write-only: sealed on arrival and never sent back.
 */
export function IntegrationsPage() {
  const { t } = useLanguage();
  const [integrations, setIntegrations] = useState<IntegrationStatus[] | null>(
    null,
  );
  const [schema, setSchema] = useState<SchemaStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setPageTitle(`${t("admin.integrations.title")} · Seyirlik`, {
      canonicalPath: "/admin/integrations",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let isCancelled = false;

    void (async () => {
      try {
        const [rows, schemaState] = await Promise.all([
          fetchIntegrations(),
          fetchSchemaStatus(),
        ]);
        if (isCancelled) return;
        setIntegrations(rows);
        setSchema(schemaState);
      } catch {
        if (!isCancelled) setFailure("admin.integrations.loadFailed");
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, []);

  return (
    <div className="w-full space-y-6">
      <header>
        <h1 className="text-3xl font-black text-white">
          {t("admin.integrations.title")}
        </h1>

        <p className="mt-1 text-sm font-semibold text-white/50">
          {t("admin.integrations.description")}
        </p>
      </header>

      {failure ? (
        <p
          role="alert"
          className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm font-bold text-red-200"
        >
          {t(failure as "admin.integrations.loadFailed")}
        </p>
      ) : null}

      <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-5">
        <h2 className="text-lg font-black text-white">
          {t("admin.integrations.connected")}
        </h2>

        <ul className="mt-3 space-y-2">
          {(integrations ?? []).map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-2xl border border-white/10 bg-black/25 px-4 py-3"
            >
              <span className="text-sm font-bold text-white/80">
                {t(
                  `admin.integrations.name.${entry.id}` as "admin.integrations.name.indexers",
                )}
              </span>

              <span
                className={`inline-flex items-center gap-1.5 text-sm font-black ${
                  entry.configured ? "text-emerald-300" : "text-white/35"
                }`}
              >
                {entry.configured ? <Check size={14} /> : <Minus size={14} />}
                {entry.configured
                  ? t("admin.integrations.configured")
                  : t("admin.integrations.notConfigured")}
              </span>

              {entry.detail ? (
                <p className="w-full break-all text-xs font-medium text-white/40">
                  {entry.detail}
                </p>
              ) : null}
            </li>
          ))}
        </ul>

        <p className="mt-4 text-xs font-medium text-white/40">
          {t("admin.integrations.readOnly")}
        </p>
      </section>

      <SubtitleProvidersPanel />

      <section className="rounded-3xl border border-white/10 bg-white/[0.05] p-5">
        <h2 className="text-lg font-black text-white">
          {t("admin.integrations.schema")}
        </h2>

        {schema ? (
          <>
            <p className="mt-2 text-sm font-semibold text-white/70">
              {schema.latest ?? t("admin.integrations.schemaNone")} ·{" "}
              {schema.applied} {t("admin.integrations.schemaApplied")}
            </p>

            {schema.current ? (
              <p className="mt-1 text-sm font-bold text-emerald-300">
                {t("admin.integrations.schemaCurrent")}
              </p>
            ) : (
              /*
               * The direction that matters: code shipped ahead of its schema is
               * what stops a service starting, so the missing migrations are
               * named rather than merely counted.
               */
              <div className="mt-2 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3">
                <p className="text-sm font-bold text-amber-200">
                  {t("admin.integrations.schemaBehind")}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {schema.pending.map((version) => (
                    <li
                      key={version}
                      className="text-xs font-medium text-amber-100/70"
                    >
                      {version}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}
