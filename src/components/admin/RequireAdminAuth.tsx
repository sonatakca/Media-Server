import { useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import { ownApiClient } from "../../api/ownApi/client";
import { setAuthSession } from "../../lib/authStorage";

/**
 * Gate for the developer and administration routes.
 *
 * Administration is a property of the Seyirlik account, so this asks the server
 * who the caller is rather than running a second identity system beside it. The
 * check is re-made on mount instead of trusting the cached session, because the
 * cache is a rendering hint and an administrator can be demoted between visits.
 */
type AdminAuthState =
  | { status: "checking" }
  | { status: "signed-out" }
  | { status: "denied" }
  | { status: "authorized" };

export function RequireAdminAuth() {
  const { t } = useLanguage();
  const location = useLocation();
  const [authState, setAuthState] = useState<AdminAuthState>({
    status: "checking",
  });

  useEffect(() => {
    let isMounted = true;

    void ownApiClient
      .getCurrentUser()
      .then((user) => {
        if (!isMounted) return;

        // Refresh the cached session so the rest of the shell agrees with what
        // the server just said.
        setAuthSession({
          userId: user.id,
          username: user.username,
          displayName: user.displayName,
          isAdministrator: user.isAdministrator,
        });
        setAuthState({
          status: user.isAdministrator ? "authorized" : "denied",
        });
      })
      .catch(() => {
        if (isMounted) setAuthState({ status: "signed-out" });
      });

    return () => {
      isMounted = false;
    };
  }, []);

  if (authState.status === "authorized") {
    return <Outlet />;
  }

  if (authState.status === "signed-out") {
    return <Navigate to="/login" replace />;
  }

  const isChecking = authState.status === "checking";

  return (
    <main className="flex min-h-[calc(100dvh-8rem)] items-center justify-center px-4 py-12 text-white">
      <section className="w-full max-w-lg rounded-3xl border border-white/10 bg-black/55 p-6 text-center shadow-floating-panel backdrop-blur-2xl sm:p-8">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.08] text-[var(--accent)]">
          {isChecking ? (
            <Loader2 className="animate-spin" size={28} />
          ) : (
            <ShieldCheck size={30} />
          )}
        </span>

        <h1 className="mt-5 text-2xl font-black">{t("adminAuth.title")}</h1>
        <p className="mt-3 text-sm leading-6 text-white/65">
          {isChecking ? t("adminAuth.checking") : t("adminAuth.denied")}
        </p>

        <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.055] px-4 py-3 text-xs font-bold text-white/65">
          <p className="truncate text-white/35">{location.pathname}</p>
        </div>
      </section>
    </main>
  );
}
