import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Bug,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Copy,
  Check,
  ClipboardList,
  Lightbulb,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { setPageTitle } from "../lib/pageTitle";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";

type BoardType = "bugs" | "features";

type BoardStatus = "open" | "in-progress" | "done";

interface BoardItem {
  id: string;
  title: string;
  description: string;
  status: BoardStatus;
  priority: "low" | "medium" | "high";
  createdAt: string;
}

interface DefaultBoardItem {
  id: string;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  status: BoardStatus;
  priority: "low" | "medium" | "high";
  createdAt: string;
}

interface BoardConfig {
  type: BoardType;
  titleKey: TranslationKey;
  eyebrowKey: TranslationKey;
  descriptionKey: TranslationKey;
  storageKey: string;
  icon: typeof Bug;
  emptyTitleKey: TranslationKey;
  emptyDescriptionKey: TranslationKey;
  defaultItems: DefaultBoardItem[];
}

const nowIso = () => new Date().toISOString();

const BUGS_STORAGE_KEY = "seyirlik-devtools-known-bugs";
const FEATURES_STORAGE_KEY = "seyirlik-devtools-wanted-features";

const defaultKnownBugs: DefaultBoardItem[] = [
  {
    id: "bug-library-missing-movies",
    titleKey: "devtools.defaultBug.libraryMissingMovies.title",
    descriptionKey: "devtools.defaultBug.libraryMissingMovies.description",
    status: "open",
    priority: "high",
    createdAt: nowIso(),
  },
  {
    id: "bug-seven-no-english-audio",
    titleKey: "devtools.defaultBug.sevenNoEnglishAudio.title",
    descriptionKey: "devtools.defaultBug.sevenNoEnglishAudio.description",
    status: "open",
    priority: "high",
    createdAt: nowIso(),
  },
  {
    id: "bug-transcode-pixelated",
    titleKey: "devtools.defaultBug.transcodePixelated.title",
    descriptionKey: "devtools.defaultBug.transcodePixelated.description",
    status: "open",
    priority: "high",
    createdAt: nowIso(),
  },
];

const defaultWantedFeatures: DefaultBoardItem[] = [
  {
    id: "feature-rotating-hero-template",
    titleKey: "devtools.defaultFeature.rotatingHero.title",
    descriptionKey: "devtools.defaultFeature.rotatingHero.description",
    status: "open",
    priority: "medium",
    createdAt: nowIso(),
  },
];

const boardConfigs: Record<BoardType, BoardConfig> = {
  bugs: {
    type: "bugs",
    titleKey: "devtools.bugs.title",
    eyebrowKey: "devtools.bugs.eyebrow",
    descriptionKey: "devtools.bugs.description",
    storageKey: BUGS_STORAGE_KEY,
    icon: Bug,
    emptyTitleKey: "devtools.bugs.emptyTitle",
    emptyDescriptionKey: "devtools.bugs.emptyDescription",
    defaultItems: defaultKnownBugs,
  },
  features: {
    type: "features",
    titleKey: "devtools.features.title",
    eyebrowKey: "devtools.features.eyebrow",
    descriptionKey: "devtools.features.description",
    storageKey: FEATURES_STORAGE_KEY,
    icon: Lightbulb,
    emptyTitleKey: "devtools.features.emptyTitle",
    emptyDescriptionKey: "devtools.features.emptyDescription",
    defaultItems: defaultWantedFeatures,
  },
};

function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}

function materializeDefaultItems(
  items: DefaultBoardItem[],
  t: (key: TranslationKey) => string,
): BoardItem[] {
  return items.map((item) => ({
    id: item.id,
    title: t(item.titleKey),
    description: t(item.descriptionKey),
    status: item.status,
    priority: item.priority,
    createdAt: item.createdAt,
  }));
}

function readItems(config: BoardConfig, defaultItems: BoardItem[]): BoardItem[] {
  try {
    const stored = localStorage.getItem(config.storageKey);

    if (!stored) {
      localStorage.setItem(config.storageKey, JSON.stringify(defaultItems));
      return defaultItems;
    }

    const parsed = JSON.parse(stored);

    if (!Array.isArray(parsed)) {
      return defaultItems;
    }

    return parsed;
  } catch {
    return defaultItems;
  }
}

function formatDate(value: string, t: (key: TranslationKey) => string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return t("devtools.unknownDate");
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function getStatusLabel(
  status: BoardStatus,
  t: (key: TranslationKey) => string,
) {
  if (status === "in-progress") return t("devtools.status.inProgress");
  if (status === "done") return t("devtools.status.done");
  return t("devtools.status.open");
}

function getStatusClasses(status: BoardStatus) {
  if (status === "done") {
    return "border-emerald-400/20 bg-emerald-400/10 text-emerald-200";
  }

  if (status === "in-progress") {
    return "border-sky-400/20 bg-sky-400/10 text-sky-200";
  }

  return "border-amber-400/20 bg-amber-400/10 text-amber-200";
}

function getPriorityClasses(priority: BoardItem["priority"]) {
  if (priority === "high") {
    return "border-red-400/20 bg-red-400/10 text-red-200";
  }

  if (priority === "medium") {
    return "border-yellow-400/20 bg-yellow-400/10 text-yellow-100";
  }

  return "border-white/10 bg-white/[0.06] text-white/62";
}

function getPriorityLabel(
  priority: BoardItem["priority"],
  t: (key: TranslationKey) => string,
) {
  if (priority === "high") return t("devtools.priority.high");
  if (priority === "medium") return t("devtools.priority.medium");
  return t("devtools.priority.low");
}

function createEmptyDraft(): Omit<BoardItem, "id" | "createdAt"> {
  return {
    title: "",
    description: "",
    status: "open",
    priority: "medium",
  };
}

interface DevToolsBoardPageProps {
  type: BoardType;
}

export function DevToolsBoardPage({ type }: DevToolsBoardPageProps) {
  const { t } = useLanguage();
  const config = boardConfigs[type];
  const Icon = config.icon;
  const defaultItems = useMemo(
    () => materializeDefaultItems(config.defaultItems, t),
    [config.defaultItems, t],
  );
  const configTitle = t(config.titleKey);
  const configEyebrow = t(config.eyebrowKey);
  const configDescription = t(config.descriptionKey);
  const configEmptyTitle = t(config.emptyTitleKey);
  const configEmptyDescription = t(config.emptyDescriptionKey);

  const [items, setItems] = useState<BoardItem[]>(() =>
    readItems(config, defaultItems),
  );
  const [draft, setDraft] = useState(createEmptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    setPageTitle(`${configTitle} · ${t("devtools.title")} · Seyirlik`, {
      canonicalPath:
        type === "bugs" ? "/dev/known-bugs" : "/dev/wanted-features",
      robots: "noindex, nofollow",
    });
  }, [configTitle, t, type]);

  useEffect(() => {
    localStorage.setItem(config.storageKey, JSON.stringify(items));
  }, [config.storageKey, items]);

  const editingItem = useMemo(() => {
    return editingId
      ? (items.find((item) => item.id === editingId) ?? null)
      : null;
  }, [editingId, items]);

  const visibleItems = useMemo(() => {
    const trimmedSearch = search.trim().toLowerCase();

    return items
      .filter((item) => {
        if (!trimmedSearch) return true;

        return (
          item.title.toLowerCase().includes(trimmedSearch) ||
          item.description.toLowerCase().includes(trimmedSearch) ||
          item.status.toLowerCase().includes(trimmedSearch) ||
          item.priority.toLowerCase().includes(trimmedSearch)
        );
      })
      .sort((a, b) => {
        const priorityScore = { high: 3, medium: 2, low: 1 };
        const statusScore = { open: 3, "in-progress": 2, done: 1 };

        const priorityDifference =
          priorityScore[b.priority] - priorityScore[a.priority];
        if (priorityDifference !== 0) return priorityDifference;

        const statusDifference = statusScore[b.status] - statusScore[a.status];
        if (statusDifference !== 0) return statusDifference;

        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      });
  }, [items, search]);

  const stats = useMemo(() => {
    return {
      total: items.length,
      open: items.filter((item) => item.status === "open").length,
      inProgress: items.filter((item) => item.status === "in-progress").length,
      done: items.filter((item) => item.status === "done").length,
    };
  }, [items]);

  const resetForm = () => {
    setDraft(createEmptyDraft());
    setEditingId(null);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    const title = draft.title.trim();
    const description = draft.description.trim();

    if (!title || !description) {
      return;
    }

    if (editingId) {
      setItems((currentItems) =>
        currentItems.map((item) =>
          item.id === editingId
            ? {
                ...item,
                title,
                description,
                status: draft.status,
                priority: draft.priority,
              }
            : item,
        ),
      );

      resetForm();
      return;
    }

    const newItem: BoardItem = {
      id: `${config.type}-${Date.now()}`,
      title,
      description,
      status: draft.status,
      priority: draft.priority,
      createdAt: nowIso(),
    };

    setItems((currentItems) => [newItem, ...currentItems]);
    resetForm();
  };

  const handleEdit = (item: BoardItem) => {
    setEditingId(item.id);
    setDraft({
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleDelete = (id: string) => {
    setItems((currentItems) => currentItems.filter((item) => item.id !== id));

    if (editingId === id) {
      resetForm();
    }
  };

  const handleCopy = async (item: BoardItem) => {
    const copiedText = [
      `${configTitle}: ${item.title}`,
      "",
      `${t("devtools.clipboard.status")}: ${getStatusLabel(item.status, t)}`,
      `${t("devtools.clipboard.priority")}: ${getPriorityLabel(
        item.priority,
        t,
      )}`,
      `${t("devtools.clipboard.created")}: ${formatDate(item.createdAt, t)}`,
      "",
      item.description,
    ].join("\n");

    const markAsCopied = () => {
      setCopiedId(item.id);

      window.setTimeout(() => {
        setCopiedId((currentId) => (currentId === item.id ? null : currentId));
      }, 1400);
    };

    try {
      await navigator.clipboard.writeText(copiedText);
      markAsCopied();
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = copiedText;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      markAsCopied();
    }
  };

  const handleResetDefaults = () => {
    setItems(defaultItems);
    resetForm();
  };

  return (
    <div className="relative mx-auto max-w-6xl space-y-6">
      <section className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] shadow-2xl backdrop-blur-xl">
        <div className="relative p-6 sm:p-7">
          <div className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-[var(--accent)]/20 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 left-10 h-56 w-56 rounded-full bg-white/10 blur-3xl" />

          <Link
            to="/dev"
            className="relative inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-sm font-bold text-white/66 transition hover:border-[var(--accent)]/35 hover:text-white"
          >
            <ArrowLeft size={16} />
            {t("devtools.backToDevtools")}
          </Link>

          <div className="relative mt-6 grid gap-5 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
                {configEyebrow}
              </p>

              <div className="mt-3 flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[var(--accent)]/10 text-[var(--accent)]">
                  <Icon size={23} />
                </div>

                <div>
                  <h1 className="text-3xl font-black text-white sm:text-4xl">
                    {configTitle}
                  </h1>
                  <p className="mt-1 max-w-2xl text-sm font-semibold leading-6 text-white/52">
                    {configDescription}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 rounded-3xl border border-white/10 bg-black/25 p-2">
              <div className="rounded-2xl bg-white/[0.06] px-3 py-2 text-center">
                <p className="text-lg font-black text-white">{stats.total}</p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-white/42">
                  {t("devtools.total")}
                </p>
              </div>

              <div className="rounded-2xl bg-amber-400/10 px-3 py-2 text-center">
                <p className="text-lg font-black text-amber-100">
                  {stats.open}
                </p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-amber-100/52">
                  {t("devtools.open")}
                </p>
              </div>

              <div className="rounded-2xl bg-sky-400/10 px-3 py-2 text-center">
                <p className="text-lg font-black text-sky-100">
                  {stats.inProgress}
                </p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-sky-100/52">
                  {t("devtools.doing")}
                </p>
              </div>

              <div className="rounded-2xl bg-emerald-400/10 px-3 py-2 text-center">
                <p className="text-lg font-black text-emerald-100">
                  {stats.done}
                </p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-emerald-100/52">
                  {t("devtools.done")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[0.92fr_1.25fr]">
        <form
          onSubmit={handleSubmit}
          className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                {editingItem ? <Pencil size={15} /> : <Plus size={15} />}
                {editingItem ? t("devtools.editItem") : t("devtools.createItem")}
              </p>

              <h2 className="mt-2 text-xl font-black text-white">
                {editingItem ? editingItem.title : t("devtools.addNewEntry")}
              </h2>
            </div>

            {editingItem ? (
              <button
                type="button"
                onClick={resetForm}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/58 transition hover:bg-white/10 hover:text-white"
                aria-label={t("devtools.cancelEditing")}
              >
                <X size={18} />
              </button>
            ) : null}
          </div>

          <label className="mt-5 block">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
              {t("common.title")}
            </span>
            <input
              value={draft.title}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
              placeholder={
                type === "bugs"
                  ? t("devtools.titlePlaceholder.bugs")
                  : t("devtools.titlePlaceholder.features")
              }
              className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
            />
          </label>

          <label className="mt-4 block">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
              {t("common.description")}
            </span>
            <textarea
              value={draft.description}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              placeholder={t("devtools.descriptionPlaceholder")}
              rows={7}
              className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
            />
          </label>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                {t("common.status")}
              </span>
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    status: event.target.value as BoardStatus,
                  }))
                }
                className="mt-2 w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm font-bold text-white outline-none transition focus:border-[var(--accent)]/50"
              >
                <option value="open">{t("devtools.status.open")}</option>
                <option value="in-progress">
                  {t("devtools.status.inProgress")}
                </option>
                <option value="done">{t("devtools.status.done")}</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                {t("common.priority")}
              </span>
              <select
                value={draft.priority}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    priority: event.target.value as BoardItem["priority"],
                  }))
                }
                className="mt-2 w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm font-bold text-white outline-none transition focus:border-[var(--accent)]/50"
              >
                <option value="low">{t("devtools.priority.low")}</option>
                <option value="medium">{t("devtools.priority.medium")}</option>
                <option value="high">{t("devtools.priority.high")}</option>
              </select>
            </label>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="submit"
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-black text-black shadow-[0_16px_40px_var(--accent-soft)] transition hover:bg-[var(--accent-hover)]"
            >
              {editingItem ? <Save size={17} /> : <Plus size={17} />}
              {editingItem ? t("devtools.saveChanges") : t("devtools.addItem")}
            </button>

            <button
              type="button"
              onClick={handleResetDefaults}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-black text-white/72 transition hover:bg-white/10 hover:text-white"
            >
              <Sparkles size={17} />
              {t("devtools.resetDefaults")}
            </button>
          </div>
        </form>

        <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                <ClipboardList size={15} />
                {t("devtools.currentList")}
              </p>
              <h2 className="mt-2 text-xl font-black text-white">
                {formatTemplate(
                  t(
                    visibleItems.length === 1
                      ? "devtools.visibleItemSingular"
                      : "devtools.visibleItemPlural",
                  ),
                  { count: visibleItems.length },
                )}
              </h2>
            </div>

            <label className="w-full sm:max-w-xs">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                {t("common.search")}
              </span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("devtools.searchPlaceholder")}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
              />
            </label>
          </div>

          {visibleItems.length > 0 ? (
            <div className="mt-5 grid gap-3">
              {visibleItems.map((item) => (
                <article
                  key={item.id}
                  className="group rounded-3xl border border-white/10 bg-white/[0.045] p-4 transition hover:border-[var(--accent)]/30 hover:bg-white/[0.07]"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-black ${getStatusClasses(
                            item.status,
                          )}`}
                        >
                          {item.status === "done" ? (
                            <CheckCircle2 size={13} />
                          ) : item.status === "in-progress" ? (
                            <CircleAlert size={13} />
                          ) : (
                            <CircleAlert size={13} />
                          )}
                          {getStatusLabel(item.status, t)}
                        </span>

                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${getPriorityClasses(
                            item.priority,
                          )}`}
                        >
                          {formatTemplate(t("devtools.priorityLabel"), {
                            priority: getPriorityLabel(item.priority, t),
                          })}
                        </span>

                        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-bold text-white/42">
                          <CalendarDays size={13} />
                          {formatDate(item.createdAt, t)}
                        </span>
                      </div>

                      <h3 className="mt-3 text-lg font-black text-white transition group-hover:text-[var(--accent)]">
                        {item.title}
                      </h3>

                      <p className="mt-2 text-sm font-medium leading-6 text-white/58">
                        {item.description}
                      </p>
                    </div>

                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => handleCopy(item)}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/58 transition hover:border-emerald-400/35 hover:bg-emerald-400/10 hover:text-emerald-200"
                        aria-label={formatTemplate(t("devtools.copyItem"), {
                          title: item.title,
                        })}
                        title={
                          copiedId === item.id
                            ? t("common.copied")
                            : t("common.copy")
                        }
                      >
                        {copiedId === item.id ? (
                          <Check size={17} />
                        ) : (
                          <Copy size={17} />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleEdit(item)}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/58 transition hover:border-[var(--accent)]/35 hover:text-[var(--accent)]"
                        aria-label={formatTemplate(t("devtools.editItemTitle"), {
                          title: item.title,
                        })}
                        title={t("common.edit")}
                      >
                        <Pencil size={17} />
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDelete(item.id)}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/58 transition hover:border-red-400/35 hover:bg-red-400/10 hover:text-red-200"
                        aria-label={formatTemplate(
                          t("devtools.deleteItemTitle"),
                          { title: item.title },
                        )}
                        title={t("common.delete")}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="mt-5 rounded-3xl border border-dashed border-white/12 bg-white/[0.035] p-8 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] text-white/52">
                <Icon size={22} />
              </div>

              <h3 className="mt-4 text-lg font-black text-white">
                {configEmptyTitle}
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm font-medium leading-6 text-white/48">
                {search.trim()
                  ? t("devtools.noSearchMatch")
                  : configEmptyDescription}
              </p>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}
