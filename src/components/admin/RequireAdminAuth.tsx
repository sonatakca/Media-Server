import { useEffect, useState } from "react";
import { Loader2, LogOut, ShieldCheck } from "lucide-react";
import { FcGoogle } from "react-icons/fc";
import { Outlet, useLocation } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  getConfiguredAdminEmail,
  getFirebaseAdminConfigurationError,
  isAuthorizedAdminUser,
  observeAdminAuthState,
  signInAdminWithGoogle,
  signOutAdmin,
} from "../../lib/firebaseAdminAuth";
import type { User } from "firebase/auth";

type AdminAuthState =
  | { status: "checking" }
  | { status: "signed-out" }
  | { status: "denied"; user: User }
  | { status: "authorized"; user: User }
  | { status: "configuration-error"; message: string }
  | { status: "error"; message: string };

export function RequireAdminAuth() {
  const { t } = useLanguage();
  const location = useLocation();
  const [authState, setAuthState] = useState<AdminAuthState>(() => {
    const configurationError = getFirebaseAdminConfigurationError();

    return configurationError
      ? { status: "configuration-error", message: configurationError }
      : { status: "checking" };
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (getFirebaseAdminConfigurationError()) {
      return undefined;
    }

    return observeAdminAuthState(
      (user) => {
        setActionError(null);

        if (!user) {
          setAuthState({ status: "signed-out" });
        } else if (!isAuthorizedAdminUser(user)) {
          setAuthState({ status: "denied", user });
        } else {
          setAuthState({ status: "authorized", user });
        }
      },
      (error) => {
        setAuthState({ status: "error", message: error.message });
      },
    );
  }, []);

  if (authState.status === "authorized") {
    return <Outlet />;
  }

  const signIn = async () => {
    setIsSubmitting(true);
    setActionError(null);

    try {
      await signInAdminWithGoogle();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetAccount = async () => {
    setIsSubmitting(true);
    setActionError(null);

    try {
      await signOutAdmin();
      await signInAdminWithGoogle();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const isChecking = authState.status === "checking";
  const isDenied = authState.status === "denied";
  const blockingMessage =
    authState.status === "configuration-error" || authState.status === "error"
      ? authState.message
      : null;

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
          {isDenied
            ? t("adminAuth.denied")
            : isChecking
              ? t("adminAuth.checking")
              : t("adminAuth.description")}
        </p>

        <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.055] px-4 py-3 text-xs font-bold text-white/65">
          <p>{getConfiguredAdminEmail()}</p>
          <p className="mt-1 truncate text-white/35">{location.pathname}</p>
        </div>

        {blockingMessage || actionError ? (
          <p className="mt-4 rounded-xl border border-rose-300/20 bg-rose-300/[0.08] px-4 py-3 text-sm font-semibold text-rose-100">
            {blockingMessage ?? actionError}
          </p>
        ) : null}

        {!isChecking && !blockingMessage ? (
          <button
            type="button"
            onClick={() => void (isDenied ? resetAccount() : signIn())}
            disabled={isSubmitting}
            className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-full bg-white px-5 text-sm font-black text-zinc-950 shadow-button-glow transition hover:bg-white/88 disabled:cursor-wait disabled:opacity-65"
          >
            {isSubmitting ? (
              <Loader2 className="animate-spin" size={20} />
            ) : isDenied ? (
              <LogOut size={20} />
            ) : (
              <FcGoogle size={22} />
            )}
            {isDenied
              ? t("adminAuth.useAnotherAccount")
              : t("adminAuth.signIn")}
          </button>
        ) : null}
      </section>
    </main>
  );
}
