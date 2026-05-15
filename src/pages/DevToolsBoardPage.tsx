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

interface BoardConfig {
  type: BoardType;
  title: string;
  eyebrow: string;
  description: string;
  storageKey: string;
  icon: typeof Bug;
  emptyTitle: string;
  emptyDescription: string;
  defaultItems: BoardItem[];
}

const nowIso = () => new Date().toISOString();

const BUGS_STORAGE_KEY = "seyirlik-devtools-known-bugs";
const FEATURES_STORAGE_KEY = "seyirlik-devtools-wanted-features";

const defaultKnownBugs: BoardItem[] = [
  {
    id: "bug-library-missing-movies",
    title: "Library is not getting every movie",
    description:
      "Some movies do not appear in the library view even though they exist in Jellyfin. Need to check whether paging, item type filters, parent IDs, or Jellyfin API query limits are causing missing results.",
    status: "open",
    priority: "high",
    createdAt: nowIso(),
  },
  {
    id: "bug-seven-no-english-audio",
    title: "Se7en opens with no audio by default",
    description:
      "The movie Se7en does not have built-in English audio available in the expected way. By default it opens with no audio. Selecting another audio track causes transcoding.",
    status: "open",
    priority: "high",
    createdAt: nowIso(),
  },
  {
    id: "bug-transcode-pixelated",
    title: "Transcoded video is pixelated",
    description:
      "Transcoded video looks pixelated even when transcoding speed is fast. The player should try the highest reasonable transcode quality first to preserve quality, then fall back lower only if the server is too slow.",
    status: "open",
    priority: "high",
    createdAt: nowIso(),
  },
];

const defaultWantedFeatures: BoardItem[] = [
  {
    id: "feature-rotating-hero-template",
    title: "Hero template should change over time",
    description:
      "The hero section should not stay stable/static. It should rotate featured items or change its presentation over time to make the home page feel more alive.",
    status: "open",
    priority: "medium",
    createdAt: nowIso(),
  },
];

const boardConfigs: Record<BoardType, BoardConfig> = {
  bugs: {
    type: "bugs",
    title: "Known Bugs",
    eyebrow: "Debug Tracker",
    description:
      "Track broken behaviour, playback problems, library issues, and anything that needs investigation.",
    storageKey: BUGS_STORAGE_KEY,
    icon: Bug,
    emptyTitle: "No bugs tracked",
    emptyDescription: "Add the first known bug using the editor on this page.",
    defaultItems: defaultKnownBugs,
  },
  features: {
    type: "features",
    title: "Wanted Features",
    eyebrow: "Product Ideas",
    description:
      "Collect future ideas, UX improvements, and features you want to build into Seyirlik.",
    storageKey: FEATURES_STORAGE_KEY,
    icon: Lightbulb,
    emptyTitle: "No wanted features yet",
    emptyDescription:
      "Add the first feature idea using the editor on this page.",
    defaultItems: defaultWantedFeatures,
  },
};

function readItems(config: BoardConfig): BoardItem[] {
  try {
    const stored = localStorage.getItem(config.storageKey);

    if (!stored) {
      localStorage.setItem(
        config.storageKey,
        JSON.stringify(config.defaultItems),
      );
      return config.defaultItems;
    }

    const parsed = JSON.parse(stored);

    if (!Array.isArray(parsed)) {
      return config.defaultItems;
    }

    return parsed;
  } catch {
    return config.defaultItems;
  }
}

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function getStatusLabel(status: BoardStatus) {
  if (status === "in-progress") return "In progress";
  if (status === "done") return "Done";
  return "Open";
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

function getPriorityLabel(priority: BoardItem["priority"]) {
  if (priority === "high") return "High";
  if (priority === "medium") return "Medium";
  return "Low";
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
  const config = boardConfigs[type];
  const Icon = config.icon;

  const [items, setItems] = useState<BoardItem[]>(() => readItems(config));
  const [draft, setDraft] = useState(createEmptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    setPageTitle(`${config.title} · Devtools · Seyirlik`);
  }, [config.title]);

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
      `${config.title}: ${item.title}`,
      "",
      `Status: ${getStatusLabel(item.status)}`,
      `Priority: ${getPriorityLabel(item.priority)}`,
      `Created: ${formatDate(item.createdAt)}`,
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
    setItems(config.defaultItems);
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
            Back to Devtools
          </Link>

          <div className="relative mt-6 grid gap-5 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
                {config.eyebrow}
              </p>

              <div className="mt-3 flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[var(--accent)]/10 text-[var(--accent)]">
                  <Icon size={23} />
                </div>

                <div>
                  <h1 className="text-3xl font-black text-white sm:text-4xl">
                    {config.title}
                  </h1>
                  <p className="mt-1 max-w-2xl text-sm font-semibold leading-6 text-white/52">
                    {config.description}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 rounded-3xl border border-white/10 bg-black/25 p-2">
              <div className="rounded-2xl bg-white/[0.06] px-3 py-2 text-center">
                <p className="text-lg font-black text-white">{stats.total}</p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-white/42">
                  Total
                </p>
              </div>

              <div className="rounded-2xl bg-amber-400/10 px-3 py-2 text-center">
                <p className="text-lg font-black text-amber-100">
                  {stats.open}
                </p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-amber-100/52">
                  Open
                </p>
              </div>

              <div className="rounded-2xl bg-sky-400/10 px-3 py-2 text-center">
                <p className="text-lg font-black text-sky-100">
                  {stats.inProgress}
                </p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-sky-100/52">
                  Doing
                </p>
              </div>

              <div className="rounded-2xl bg-emerald-400/10 px-3 py-2 text-center">
                <p className="text-lg font-black text-emerald-100">
                  {stats.done}
                </p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-emerald-100/52">
                  Done
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
                {editingItem ? "Edit item" : "Create item"}
              </p>

              <h2 className="mt-2 text-xl font-black text-white">
                {editingItem ? editingItem.title : "Add new entry"}
              </h2>
            </div>

            {editingItem ? (
              <button
                type="button"
                onClick={resetForm}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/58 transition hover:bg-white/10 hover:text-white"
                aria-label="Cancel editing"
              >
                <X size={18} />
              </button>
            ) : null}
          </div>

          <label className="mt-5 block">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
              Title
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
                  ? "Example: Audio selection causes transcode"
                  : "Example: Add animated hero variants"
              }
              className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
            />
          </label>

          <label className="mt-4 block">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
              Description
            </span>
            <textarea
              value={draft.description}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              placeholder="Write what is happening, why it matters, and what should be checked."
              rows={7}
              className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
            />
          </label>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                Status
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
                <option value="open">Open</option>
                <option value="in-progress">In progress</option>
                <option value="done">Done</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                Priority
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
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="submit"
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-black text-black shadow-[0_16px_40px_var(--accent-soft)] transition hover:bg-[var(--accent-hover)]"
            >
              {editingItem ? <Save size={17} /> : <Plus size={17} />}
              {editingItem ? "Save changes" : "Add item"}
            </button>

            <button
              type="button"
              onClick={handleResetDefaults}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-black text-white/72 transition hover:bg-white/10 hover:text-white"
            >
              <Sparkles size={17} />
              Reset defaults
            </button>
          </div>
        </form>

        <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                <ClipboardList size={15} />
                Current list
              </p>
              <h2 className="mt-2 text-xl font-black text-white">
                {visibleItems.length} visible item
                {visibleItems.length === 1 ? "" : "s"}
              </h2>
            </div>

            <label className="w-full sm:max-w-xs">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                Search
              </span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search title, text, status..."
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
                          {getStatusLabel(item.status)}
                        </span>

                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${getPriorityClasses(
                            item.priority,
                          )}`}
                        >
                          {getPriorityLabel(item.priority)} priority
                        </span>

                        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-bold text-white/42">
                          <CalendarDays size={13} />
                          {formatDate(item.createdAt)}
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
                        aria-label={`Copy ${item.title}`}
                        title={copiedId === item.id ? "Copied" : "Copy"}
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
                        aria-label={`Edit ${item.title}`}
                        title="Edit"
                      >
                        <Pencil size={17} />
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDelete(item.id)}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/58 transition hover:border-red-400/35 hover:bg-red-400/10 hover:text-red-200"
                        aria-label={`Delete ${item.title}`}
                        title="Delete"
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
                {config.emptyTitle}
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm font-medium leading-6 text-white/48">
                {search.trim()
                  ? "No item matched your search."
                  : config.emptyDescription}
              </p>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}
