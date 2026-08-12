import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCcw,
  Save,
  Search,
  ShieldCheck,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { getCachedSession, setAuthSession } from "../lib/authStorage";
import {
  createUser,
  getUserById,
  getUsers,
  updateUser,
  updateUserPassword,
  updateUserPolicy,
} from "../lib/mediaApi";
import { setPageTitle } from "../lib/pageTitle";
import type { MediaUser, MediaUserPolicy } from "../lib/types";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";

type ActionStatus = "idle" | "loading" | "success" | "error";

interface ActionState {
  status: ActionStatus;
  message: string;
}

interface UserDraft {
  name: string;
  password: string;
  resetPassword: boolean;
  isAdministrator: boolean;
  isDisabled: boolean;
  isHidden: boolean;
  enableRemoteAccess: boolean;
  enableAllFolders: boolean;
  enableMediaPlayback: boolean;
  enableContentDownloading: boolean;
}

const inputClassName =
  "mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]";

function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}

function createEmptyDraft(): UserDraft {
  return {
    name: "",
    password: "",
    resetPassword: false,
    isAdministrator: false,
    isDisabled: false,
    isHidden: false,
    enableRemoteAccess: true,
    enableAllFolders: true,
    enableMediaPlayback: true,
    enableContentDownloading: true,
  };
}

function createDraftFromUser(user: MediaUser): UserDraft {
  const policy = user.Policy ?? {};

  return {
    name: user.Name,
    password: "",
    resetPassword: false,
    isAdministrator: policy.IsAdministrator === true,
    isDisabled: policy.IsDisabled === true,
    isHidden: policy.IsHidden === true,
    enableRemoteAccess: policy.EnableRemoteAccess !== false,
    enableAllFolders: policy.EnableAllFolders !== false,
    enableMediaPlayback: policy.EnableMediaPlayback !== false,
    enableContentDownloading: policy.EnableContentDownloading !== false,
  };
}

function applyDraftToPolicy(
  policy: MediaUserPolicy,
  draft: UserDraft,
): MediaUserPolicy {
  return {
    ...policy,
    IsAdministrator: draft.isAdministrator,
    IsDisabled: draft.isDisabled,
    IsHidden: draft.isHidden,
    EnableRemoteAccess: draft.enableRemoteAccess,
    EnableAllFolders: draft.enableAllFolders,
    EnableMediaPlayback: draft.enableMediaPlayback,
    EnableContentDownloading: draft.enableContentDownloading,
  };
}

function formatActivityDate(
  value: string | undefined,
  t: (key: TranslationKey) => string,
): string {
  if (!value) return t("userManagement.never");

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("userManagement.never");

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

interface ToggleFieldProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}

function ToggleField({
  checked,
  disabled = false,
  label,
  description,
  onChange,
}: ToggleFieldProps) {
  return (
    <label
      className={`flex gap-3 rounded-2xl border border-white/10 bg-white/[0.045] p-4 ${
        disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
      />
      <span>
        <span className="block text-sm font-black text-white">{label}</span>
        <span className="mt-1 block text-xs font-medium leading-5 text-white/45">
          {description}
        </span>
      </span>
    </label>
  );
}

export function UserManagementPage() {
  const { t } = useLanguage();
  const currentUserId = getCachedSession()?.userId ?? null;
  const [users, setUsers] = useState<MediaUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [draft, setDraft] = useState<UserDraft>(createEmptyDraft);
  const [search, setSearch] = useState("");
  const [loadState, setLoadState] = useState<ActionState>({
    status: "loading",
    message: "",
  });
  const [saveState, setSaveState] = useState<ActionState>({
    status: "idle",
    message: "",
  });

  const selectedUser = useMemo(
    () => users.find((user) => user.Id === selectedUserId) ?? null,
    [selectedUserId, users],
  );
  const isEditing = selectedUser !== null;
  const isEditingCurrentUser = selectedUser?.Id === currentUserId;

  const visibleUsers = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();

    return users
      .filter((user) => {
        if (!query) return true;
        const roles = [
          user.Policy?.IsAdministrator
            ? t("userManagement.administrator")
            : t("userManagement.standardUser"),
          user.Policy?.IsDisabled ? t("userManagement.disabled") : "",
        ];
        return [user.Name, user.Id, ...roles]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query);
      })
      .sort((left, right) =>
        left.Name.localeCompare(right.Name, undefined, {
          sensitivity: "base",
        }),
      );
  }, [search, t, users]);

  useEffect(() => {
    setPageTitle(
      `${t("userManagement.title")} · ${t("devtools.title")} · Seyirlik`,
      {
        canonicalPath: "/dev/users",
        robots: "noindex, nofollow",
      },
    );
  }, [t]);

  const loadUsers = async (preferredUserId?: string | null) => {
    setLoadState({ status: "loading", message: "" });

    try {
      const nextUsers = await getUsers();
      setUsers(nextUsers);

      const nextSelectedId =
        preferredUserId && nextUsers.some((user) => user.Id === preferredUserId)
          ? preferredUserId
          : selectedUserId &&
              nextUsers.some((user) => user.Id === selectedUserId)
            ? selectedUserId
            : null;

      setSelectedUserId(nextSelectedId);
      if (nextSelectedId) {
        const nextSelectedUser = nextUsers.find(
          (user) => user.Id === nextSelectedId,
        );
        setDraft(
          nextSelectedUser
            ? createDraftFromUser(nextSelectedUser)
            : createEmptyDraft(),
        );
      } else {
        setDraft(createEmptyDraft());
      }
      setLoadState({ status: "success", message: "" });
    } catch (error) {
      setLoadState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  useEffect(() => {
    void loadUsers(null);
    // The signed-in server and token are stable for the lifetime of this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginCreating = () => {
    setSelectedUserId(null);
    setDraft(createEmptyDraft());
    setSaveState({ status: "idle", message: "" });
  };

  const beginEditing = (user: MediaUser) => {
    setSelectedUserId(user.Id);
    setDraft(createDraftFromUser(user));
    setSaveState({ status: "idle", message: "" });
  };

  const setDraftValue = <Key extends keyof UserDraft>(
    key: Key,
    value: UserDraft[Key],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const name = draft.name.trim();

    if (!name) {
      setSaveState({
        status: "error",
        message: t("userManagement.nameRequired"),
      });
      return;
    }

    setSaveState({
      status: "loading",
      message: isEditing
        ? t("userManagement.savingUser")
        : t("userManagement.creatingUser"),
    });

    try {
      let savedUserId: string;

      if (selectedUser) {
        const nextDraft = isEditingCurrentUser
          ? {
              ...draft,
              isAdministrator: true,
              isDisabled: false,
            }
          : draft;

        if (!selectedUser.Policy) {
          throw new Error(t("userManagement.policyUnavailable"));
        }

        await updateUser({
          ...selectedUser,
          Name: name,
        });
        await updateUserPolicy(
          selectedUser.Id,
          applyDraftToPolicy(selectedUser.Policy, nextDraft),
        );

        if (nextDraft.resetPassword) {
          await updateUserPassword(selectedUser.Id, {
            newPassword: "",
            resetPassword: true,
          });
        } else if (nextDraft.password) {
          await updateUserPassword(selectedUser.Id, {
            newPassword: nextDraft.password,
          });
        }

        if (isEditingCurrentUser) {
          const currentSession = getCachedSession();
          if (currentSession) {
            setAuthSession({ ...currentSession, username: name });
          }
        }

        savedUserId = selectedUser.Id;
      } else {
        const createdUser = await createUser(name, draft.password);
        const completeUser = createdUser.Policy
          ? createdUser
          : await getUserById(createdUser.Id);

        if (!completeUser.Policy) {
          throw new Error(t("userManagement.policyUnavailable"));
        }

        await updateUserPolicy(
          completeUser.Id,
          applyDraftToPolicy(completeUser.Policy, draft),
        );
        savedUserId = completeUser.Id;
      }

      await loadUsers(savedUserId);
      setSaveState({
        status: "success",
        message: formatTemplate(
          isEditing
            ? t("userManagement.userUpdated")
            : t("userManagement.userCreated"),
          { name },
        ),
      });
    } catch (error) {
      setSaveState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const statusClasses =
    saveState.status === "error"
      ? "border-red-400/20 bg-red-400/10 text-red-100"
      : saveState.status === "success"
        ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"
        : "border-white/10 bg-white/[0.06] text-white/62";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link
        to="/dev"
        className="inline-flex items-center gap-2 text-sm font-bold text-white/55 transition hover:text-white"
      >
        <ChevronLeft size={17} />
        {t("devtools.backToDevtools")}
      </Link>

      <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] p-6 shadow-2xl backdrop-blur-xl">
        <div className="pointer-events-none absolute -right-20 -top-24 h-60 w-60 rounded-full bg-[var(--accent)]/20 blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
              <ShieldCheck size={16} />
              {t("userManagement.eyebrow")}
            </p>
            <h1 className="mt-3 text-3xl font-black text-white sm:text-4xl">
              {t("userManagement.title")}
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-white/52">
              {t("userManagement.description")}
            </p>
          </div>

          <button
            type="button"
            onClick={beginCreating}
            className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-5 text-sm font-black text-zinc-950 transition hover:bg-[var(--accent-hover)]"
          >
            <Plus size={18} />
            {t("userManagement.addUser")}
          </button>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[0.88fr_1.25fr]">
        <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                <Users size={16} />
                {t("userManagement.users")}
              </p>
              <h2 className="mt-2 text-xl font-black text-white">
                {formatTemplate(t("userManagement.userCount"), {
                  count: users.length,
                })}
              </h2>
            </div>
            <button
              type="button"
              onClick={() => void loadUsers(selectedUserId)}
              disabled={loadState.status === "loading"}
              aria-label={t("userManagement.refreshUsers")}
              className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] text-white/65 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
            >
              <RefreshCcw
                size={17}
                className={
                  loadState.status === "loading" ? "animate-spin" : undefined
                }
              />
            </button>
          </div>

          <label className="relative mt-5 block">
            <Search
              size={16}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("userManagement.searchPlaceholder")}
              className="w-full rounded-2xl border border-white/10 bg-white/[0.06] py-3 pl-10 pr-4 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50"
            />
          </label>

          {loadState.status === "error" ? (
            <div className="mt-4 rounded-2xl border border-red-400/20 bg-red-400/10 p-4 text-sm font-semibold text-red-100">
              <p className="flex items-center gap-2 font-black">
                <CircleAlert size={17} />
                {t("userManagement.loadFailed")}
              </p>
              <p className="mt-2 text-red-100/75">{loadState.message}</p>
            </div>
          ) : null}

          <div className="mt-4 max-h-[44rem] space-y-2 overflow-y-auto pr-1">
            {loadState.status === "loading" && users.length === 0 ? (
              <div className="flex min-h-40 items-center justify-center">
                <Loader2 size={30} className="animate-spin text-white/55" />
              </div>
            ) : null}

            {visibleUsers.map((user) => {
              const isSelected = user.Id === selectedUserId;
              const isCurrent = user.Id === currentUserId;

              return (
                <button
                  key={user.Id}
                  type="button"
                  onClick={() => beginEditing(user)}
                  className={`w-full rounded-3xl border p-4 text-left transition ${
                    isSelected
                      ? "border-[var(--accent)]/45 bg-[var(--accent)]/12"
                      : "border-white/10 bg-white/[0.045] hover:border-[var(--accent)]/30 hover:bg-white/[0.07]"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
                        user.Policy?.IsDisabled
                          ? "bg-red-400/10 text-red-200"
                          : "bg-white/[0.08] text-white/72"
                      }`}
                    >
                      <UserRound size={20} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-base font-black text-white">
                          {user.Name}
                        </span>
                        {isCurrent ? (
                          <span className="rounded-full border border-[var(--accent)]/25 bg-[var(--accent)]/10 px-2 py-0.5 text-[0.65rem] font-black uppercase tracking-wider text-[var(--accent)]">
                            {t("userManagement.you")}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 block text-xs font-semibold text-white/38">
                        {user.Policy?.IsAdministrator
                          ? t("userManagement.administrator")
                          : t("userManagement.standardUser")}
                        {user.Policy?.IsDisabled
                          ? ` · ${t("userManagement.disabled")}`
                          : ""}
                      </span>
                      <span className="mt-1 block truncate text-xs font-medium text-white/28">
                        {formatTemplate(t("userManagement.lastActive"), {
                          date: formatActivityDate(user.LastActivityDate, t),
                        })}
                      </span>
                    </span>
                    <Pencil size={16} className="mt-2 shrink-0 text-white/28" />
                  </div>
                </button>
              );
            })}

            {loadState.status !== "loading" && visibleUsers.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-sm font-semibold text-white/38">
                {t("userManagement.noUsersFound")}
              </p>
            ) : null}
          </div>
        </section>

        <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                {isEditing ? <Pencil size={16} /> : <Plus size={16} />}
                {isEditing
                  ? t("userManagement.editUser")
                  : t("userManagement.createUser")}
              </p>
              <h2 className="mt-2 text-xl font-black text-white">
                {isEditing ? selectedUser.Name : t("userManagement.newUser")}
              </h2>
            </div>
            {isEditing ? (
              <button
                type="button"
                onClick={beginCreating}
                aria-label={t("userManagement.cancelEditing")}
                className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] text-white/55 transition hover:text-white"
              >
                <X size={17} />
              </button>
            ) : null}
          </div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                  {t("userManagement.username")}
                </span>
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraftValue("name", event.target.value)
                  }
                  autoComplete="off"
                  placeholder={t("userManagement.usernamePlaceholder")}
                  className={inputClassName}
                />
              </label>

              <label className="block">
                <span className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-white/42">
                  <KeyRound size={14} />
                  {isEditing
                    ? t("userManagement.newPassword")
                    : t("userManagement.password")}
                </span>
                <input
                  type="password"
                  value={draft.password}
                  disabled={draft.resetPassword}
                  onChange={(event) =>
                    setDraftValue("password", event.target.value)
                  }
                  autoComplete="new-password"
                  placeholder={
                    isEditing
                      ? t("userManagement.passwordUnchanged")
                      : t("userManagement.passwordOptional")
                  }
                  className={`${inputClassName} disabled:cursor-not-allowed disabled:opacity-45`}
                />
              </label>
            </div>

            {isEditing ? (
              <ToggleField
                checked={draft.resetPassword}
                label={t("userManagement.resetPassword")}
                description={t("userManagement.resetPasswordDescription")}
                onChange={(checked) => {
                  setDraft((current) => ({
                    ...current,
                    resetPassword: checked,
                    password: checked ? "" : current.password,
                  }));
                }}
              />
            ) : null}

            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                {t("userManagement.permissions")}
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <ToggleField
                  checked={isEditingCurrentUser ? true : draft.isAdministrator}
                  disabled={isEditingCurrentUser}
                  label={t("userManagement.administrator")}
                  description={
                    isEditingCurrentUser
                      ? t("userManagement.currentAdminProtected")
                      : t("userManagement.administratorDescription")
                  }
                  onChange={(checked) =>
                    setDraftValue("isAdministrator", checked)
                  }
                />
                <ToggleField
                  checked={isEditingCurrentUser ? false : draft.isDisabled}
                  disabled={isEditingCurrentUser}
                  label={t("userManagement.disableUser")}
                  description={
                    isEditingCurrentUser
                      ? t("userManagement.currentUserProtected")
                      : t("userManagement.disableUserDescription")
                  }
                  onChange={(checked) => setDraftValue("isDisabled", checked)}
                />
                <ToggleField
                  checked={draft.isHidden}
                  label={t("userManagement.hideUser")}
                  description={t("userManagement.hideUserDescription")}
                  onChange={(checked) => setDraftValue("isHidden", checked)}
                />
                <ToggleField
                  checked={draft.enableRemoteAccess}
                  label={t("userManagement.remoteAccess")}
                  description={t("userManagement.remoteAccessDescription")}
                  onChange={(checked) =>
                    setDraftValue("enableRemoteAccess", checked)
                  }
                />
                <ToggleField
                  checked={draft.enableAllFolders}
                  label={t("userManagement.allLibraries")}
                  description={t("userManagement.allLibrariesDescription")}
                  onChange={(checked) =>
                    setDraftValue("enableAllFolders", checked)
                  }
                />
                <ToggleField
                  checked={draft.enableMediaPlayback}
                  label={t("userManagement.mediaPlayback")}
                  description={t("userManagement.mediaPlaybackDescription")}
                  onChange={(checked) =>
                    setDraftValue("enableMediaPlayback", checked)
                  }
                />
                <ToggleField
                  checked={draft.enableContentDownloading}
                  label={t("userManagement.downloads")}
                  description={t("userManagement.downloadsDescription")}
                  onChange={(checked) =>
                    setDraftValue("enableContentDownloading", checked)
                  }
                />
              </div>
            </div>

            {saveState.message ? (
              <p
                className={`flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-bold ${statusClasses}`}
              >
                {saveState.status === "success" ? (
                  <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
                ) : saveState.status === "error" ? (
                  <CircleAlert size={17} className="mt-0.5 shrink-0" />
                ) : (
                  <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin" />
                )}
                {saveState.message}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={saveState.status === "loading"}
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-5 text-sm font-black text-zinc-950 transition hover:bg-[var(--accent-hover)] disabled:cursor-wait disabled:opacity-60"
            >
              {saveState.status === "loading" ? (
                <Loader2 size={18} className="animate-spin" />
              ) : isEditing ? (
                <Save size={18} />
              ) : (
                <Plus size={18} />
              )}
              {isEditing
                ? t("userManagement.saveChanges")
                : t("userManagement.createUser")}
            </button>
          </form>
        </section>
      </section>
    </div>
  );
}
