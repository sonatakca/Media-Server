import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationHost } from "./NotificationHost";
import {
  notify,
  resetNotificationsForTests,
} from "../../lib/notifications/notificationStore";
import { translations, type TranslationKey } from "../../i18n/translations";
let language: "en" | "tr" = "en";
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    language,
    t: (key: TranslationKey) => translations[language][key],
  }),
}));
afterEach(() => {
  cleanup();
  resetNotificationsForTests();
});
/** A card is a line until it is asked; every detail below lives behind this. */
function openCard() {
  act(() => {
    document.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
  });
}
it.each(["en", "tr"] as const)(
  "renders localized stage, verified counts, zero results and percentage in %s",
  (lang) => {
    language = lang;
    notify({
      title: "Probe",
      tone: "progress",
      progress: 42,
      task: {
        determinate: true,
        status: "running",
        stage: "analysing",
        counts: { completed: 42, total: 100, unit: "files" },
        metrics: [{ metric: "probed", value: 0 }],
        attempts: 1,
        maxAttempts: 3,
        startedAt: null,
        finishedAt: null,
      },
    });
    render(<NotificationHost />);
    openCard();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
    expect(screen.getByText(lang === "en" ? "42%" : "%42")).toBeInTheDocument();
    expect(
      screen.getByText(
        lang === "en"
          ? "42 of 100 files inspected"
          : "100 dosyanın 42 tanesi incelendi",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  },
);
it("announces meaningful changes but does not repeat the card at each poll", () => {
  language = "en";
  render(<NotificationHost />);
  const input = {
    key: "task:a",
    title: "Probe",
    tone: "progress" as const,
    task: {
      determinate: true,
      status: "running" as const,
      stage: "analysing" as const,
      attempts: 1,
      maxAttempts: 3,
      startedAt: null,
      finishedAt: null,
    },
  };
  act(() => {
    notify({ ...input, progress: 42 });
  });
  const first = screen.getByRole("status").textContent;
  act(() => {
    notify({ ...input, progress: 43 });
  });
  expect(screen.getByRole("status").textContent).toBe(first);
  act(() => {
    notify({ ...input, progress: 51 });
  });
  expect(screen.getByRole("status").textContent).not.toBe(first);
  act(() => {
    notify({
      ...input,
      tone: "success",
      task: { ...input.task, status: "succeeded" },
    });
  });
  expect(screen.getByRole("status").textContent).toContain("Completed");
  expect(screen.queryByRole("progressbar")).toBeNull();
});
it("floors a percentage rather than rounding it up to a finished-looking number", () => {
  // 99.7% is not done. A card that reads 100% next to a job that is still
  // running is the one reading somebody would act on.
  language = "en";
  notify({
    title: "Encode",
    tone: "progress",
    progress: 99.7,
    task: {
      determinate: true,
      status: "running",
      attempts: 1,
      maxAttempts: 3,
      startedAt: null,
      finishedAt: null,
    },
  });
  render(<NotificationHost />);
  expect(screen.getByText("99%")).toBeInTheDocument();
  openCard();
  expect(screen.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "99",
  );
});
it("marks unmeasurable progress explicitly and keeps it out of a progress bar", () => {
  language = "en";
  notify({
    title: "Scan",
    progress: 65,
    task: {
      determinate: false,
      status: "running",
      attempts: 1,
      maxAttempts: 3,
      startedAt: null,
      finishedAt: null,
    },
  });
  render(<NotificationHost />);
  openCard();
  expect(screen.getByText("Progress not measurable yet")).toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("names the title a card is about, in the card and in the announcement", () => {
  // "Media processing · Queued" is true of twelve cards at once. Which episode
  // it is about is the part that makes it worth reading.
  language = "en";
  render(<NotificationHost />);
  act(() => {
    notify({
      key: "task:a",
      title: "Media processing",
      tone: "progress",
      progress: 36.42,
      task: {
        determinate: true,
        status: "running",
        stage: "video",
        titleKey: "tasks.mediaProcess",
        subject: {
          type: "media",
          label: "House of the Dragon",
          code: "S01E03",
          detail: "Second of His Name",
        },
        encoding: { completedSeconds: 1_381, totalSeconds: 3_794 },
        remainingSeconds: 1_975,
        queuedCount: 9,
        attempts: 1,
        maxAttempts: 3,
        startedAt: null,
        finishedAt: null,
      },
    });
  });

  // The line itself carries the show, the episode and the figure.
  expect(
    screen.getByRole("button", { name: /House of the Dragon/ }),
  ).toHaveTextContent("S01E03");
  // Name, then this title's own figure, then the line behind it. The count
  // read as part of neither while it sat between the two.
  expect(
    screen.getByRole("button", { name: /House of the Dragon/ }).textContent,
  ).toMatch(/House of the Dragon.*S01E03.*36\.4%.*\+9/);
  expect(screen.getByRole("status").textContent).toContain(
    "House of the Dragon",
  );
  expect(screen.getByRole("status").textContent).toContain("S01E03");

  openCard();
  expect(screen.getByText("S01E03 · Second of His Name")).toBeInTheDocument();
  expect(screen.getByText("About 32 min 55 sec left")).toBeInTheDocument();
  // The waiting line is the badge on the card's line, and only that.
  expect(screen.getByText("+9")).toBeInTheDocument();
  expect(screen.queryByText(/more waiting/)).toBeNull();
  // A phase that already says the job is running does not say it twice.
  expect(screen.getByText("Encoding video")).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "36.4",
  );
});

it("shows how far along a job is without being opened", () => {
  // The bar used to live inside the body, so the one thing worth knowing at a
  // glance was the one thing a closed card would not say.
  language = "en";
  notify({
    title: "Media processing",
    tone: "progress",
    progress: 76.2,
    task: {
      determinate: true,
      status: "running",
      stage: "video",
      encoding: { completedSeconds: 3_090, totalSeconds: 4_052 },
      attempts: 1,
      maxAttempts: 3,
      startedAt: null,
      finishedAt: null,
    },
  });
  render(<NotificationHost />);
  const bar = screen.getByRole("progressbar");
  expect(bar).toHaveAttribute("aria-valuenow", "76.2");
  expect(bar.querySelector("div")).toHaveStyle({ width: "76.2%" });
  // Still one bar, not a second one, once the card is opened.
  openCard();
  expect(screen.getAllByRole("progressbar")).toHaveLength(1);
});

it("states the encode position on the source timeline as a clock", () => {
  // Media seconds were a figure nobody could picture, and the page beside this
  // card has always shown the pair of clocks a player shows.
  language = "en";
  notify({
    title: "Media processing",
    tone: "progress",
    progress: 76.2,
    task: {
      determinate: true,
      status: "running",
      stage: "video",
      encoding: { completedSeconds: 3_092.7, totalSeconds: 4_052.352 },
      attempts: 1,
      maxAttempts: 3,
      startedAt: null,
      finishedAt: null,
    },
  });
  render(<NotificationHost />);
  openCard();
  expect(screen.getByText("00:51:32 / 01:07:32")).toBeInTheDocument();
});

it.each(["en", "tr"] as const)(
  "says a held job is held, and keeps where it stopped, in %s",
  (lang) => {
    language = lang;
    notify({
      title: "Media processing",
      tone: "warning",
      progress: 76.2,
      task: {
        determinate: true,
        status: "paused",
        stage: "video",
        titleKey: "tasks.mediaProcess",
        subject: {
          type: "media",
          label: "House of the Dragon",
          code: "S01E08",
        },
        encoding: { completedSeconds: 3_092.7, totalSeconds: 4_052.352 },
        attempts: 1,
        maxAttempts: 3,
        startedAt: "2026-09-05T04:42:21Z",
        finishedAt: null,
      },
    });
    render(<NotificationHost />);
    // The position is still shown; the rate — and the claim that it cannot be
    // measured — are not.
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "76.2",
    );
    openCard();
    expect(
      screen.getByText(
        lang === "en"
          ? "Paused · Encoding video"
          : "Duraklatıldı · Video kodlanıyor",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("00:51:32 / 01:07:32")).toBeInTheDocument();
    expect(screen.queryByText(/not measurable|ölçülemiyor/)).toBeNull();
    expect(screen.queryByText(/left$|kaldı/)).toBeNull();
  },
);

it("never spends the line on the word a spinner has already said", () => {
  // With no figure to show, the trailing slot printed "Running" beside a
  // turning spinner and took the room the title needed.
  language = "en";
  notify({
    title: "Media processing",
    tone: "progress",
    task: {
      determinate: false,
      status: "running",
      stage: "packaging",
      titleKey: "tasks.mediaProcess",
      subject: { type: "media", label: "House of the Dragon", code: "S01E08" },
      attempts: 1,
      maxAttempts: 3,
      startedAt: null,
      finishedAt: null,
    },
  });
  render(<NotificationHost />);
  const line = screen.getByRole("button", { name: /House of the Dragon/ });
  expect(line.textContent).toContain("S01E08");
  expect(line.textContent).not.toContain("Running");
  // Every other state still earns its word: nothing else on the card says it.
  cleanup();
  resetNotificationsForTests();
  notify({
    title: "Media processing",
    tone: "warning",
    task: {
      determinate: false,
      status: "paused",
      attempts: 1,
      maxAttempts: 3,
      startedAt: null,
      finishedAt: null,
    },
  });
  render(<NotificationHost />);
  expect(screen.getAllByText("Paused").length).toBeGreaterThan(0);
});

it("shows a figure for the phases that come after the picture", () => {
  language = "en";
  notify({
    title: "Media processing",
    tone: "progress",
    progress: 8.1,
    task: {
      determinate: true,
      status: "running",
      stage: "packaging",
      phaseFraction: 0.081,
      attempts: 1,
      maxAttempts: 3,
      startedAt: null,
      finishedAt: null,
    },
  });
  render(<NotificationHost />);
  // Whole per cent: bytes assembled are not measured as finely as film is.
  expect(screen.getByText("8%")).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "8");
  openCard();
  expect(screen.getByText("Packaging media")).toBeInTheDocument();
  expect(screen.queryByText("Progress not measurable yet")).toBeNull();
});
