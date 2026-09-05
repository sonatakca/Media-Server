/**
 * The presses that act on more than one job at a time.
 *
 * The queue tab could only ever be operated a row at a time: pause this,
 * resume that, drag the other. A backlog is a season — forty rows — and every
 * one of these exists because doing the same thing forty times is not a thing
 * anybody does. What is asserted here is what reaches the server, because that
 * is the whole of what these buttons are: an arrangement worked out on the
 * page and sent in one call.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type {
  ProcessingJob,
  ProcessingJobTitle,
  ProcessingOverview,
} from "../../lib/processingApi";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));

vi.mock("../../lib/mediaApi", () => ({
  getUserViews: async () => [],
  getVideoItemsForLibrary: async () => [],
  getPrimaryImageUrl: () => "",
}));

const reorderProcessingQueue = vi.fn(async () => ({ reordered: [] }));
const pauseProcessingJob = vi.fn(async () => ({}) as never);
const resumeProcessingJob = vi.fn(async () => ({}) as never);

let overview: ProcessingOverview;

vi.mock("../../lib/processingApi", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/processingApi")
  >("../../lib/processingApi");
  return {
    ...actual,
    getProcessingOverview: async () => overview,
    previewProcessing: async () => {
      throw new Error("no preview in this suite");
    },
    getProcessingJob: async () => null,
    reorderProcessingQueue: (...args: unknown[]) =>
      reorderProcessingQueue(...(args as [])),
    pauseProcessingJob: (...args: unknown[]) =>
      pauseProcessingJob(...(args as [])),
    resumeProcessingJob: (...args: unknown[]) =>
      resumeProcessingJob(...(args as [])),
  };
});

vi.mock("../../lib/notifications/notificationStore", () => ({
  notify: vi.fn(),
}));

// ------------------------------------------------------------- fixtures

function job(overrides: Partial<ProcessingJob> & { id: string }) {
  return {
    itemId: `${overrides.id}-item`,
    mediaFileId: `${overrides.id}-file`,
    profile: "cmaf-hls-aligned-v2",
    state: "queued",
    stage: "waiting",
    stageProgress: 0,
    overallProgress: 0,
    bytesProcessed: 0,
    actualOutputBytes: 0,
    outputBytes: null,
    estimatedOutputBytes: null,
    estimatedStagingBytes: null,
    speed: null,
    fps: null,
    etaSeconds: null,
    hardwareAdapter: null,
    videoEncoder: null,
    decision: null,
    validation: null,
    warnings: [],
    sourceDamage: null,
    errorCode: null,
    errorMessage: null,
    publishedVersion: null,
    attempts: 0,
    cancellationRequested: false,
    pauseRequested: false,
    pausedReason: null,
    epochCount: null,
    epochIndex: null,
    completedEpochs: 0,
    protectedSeconds: 0,
    encodedSeconds: 0,
    sourceDurationSeconds: null,
    epochStartSeconds: null,
    epochEndSeconds: null,
    checkpointBytes: 0,
    freeBytes: null,
    queuePriority: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as ProcessingJob;
}

function baseOverview(
  jobs: ProcessingJob[],
  jobTitles?: ProcessingJobTitle[],
): ProcessingOverview {
  return {
    counts: {
      pending: 0,
      queued: 0,
      running: 0,
      paused: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    },
    hardware: {
      platform: "darwin",
      probedAt: new Date().toISOString(),
      adapters: [],
      selected: { h264: "", hevc: "", hevcTenBit: "" },
      selectedAdapter: { h264: "", hevc: "", hevcTenBit: "" },
    },
    jobs,
    stages: [],
    profile: "cmaf-hls-aligned-v2",
    storage: {
      root: "/media",
      state: "healthy",
      summary: "",
      reason: "",
      faultCount: 0,
      missingRoots: [],
      firstFaultAt: null,
      lastFaultAt: null,
      changedAt: new Date().toISOString(),
      verifiedAt: null,
      mayStartWork: true,
      automaticResumeBlocked: false,
      awaitingVerification: false,
      awaitingResume: false,
    },
    movies: [],
    series: [],
    jobTitles:
      jobTitles ??
      jobs.map((entry) => ({
        jobId: entry.id,
        kind: "movie" as const,
        title: entry.id,
      })),
  } as ProcessingOverview;
}

async function renderQueue() {
  const { MediaProcessingPage } = await import("./MediaProcessingPage");
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <MediaProcessingPage />
    </MemoryRouter>,
  );
  await screen.findByText("processing.title");
  await user.click(await screen.findByRole("tab", { name: /tabs.processes/ }));
  return user;
}

function titleOf(row: HTMLElement): string {
  return within(row).getAllByText(/^[a-z0-9-]+$/i)[0]?.textContent ?? "";
}

/** The waiting rows, in the order the queue is showing them. */
function slotOrder(): string[] {
  return screen
    .getAllByRole("listitem")
    .filter((row) => row.dataset.queueSlot)
    .sort((a, b) => Number(a.dataset.queueSlot) - Number(b.dataset.queueSlot))
    .map(titleOf);
}

function rowFor(title: string): HTMLElement {
  return screen.getAllByRole("listitem").find((row) => titleOf(row) === title)!;
}

/** The order the last reorder sent to the server. */
function lastSavedOrder(): string[] {
  const calls = reorderProcessingQueue.mock.calls;
  return (calls[calls.length - 1] as unknown as [string[]])[0];
}

beforeEach(() => {
  reorderProcessingQueue.mockClear();
  pauseProcessingJob.mockClear();
  resumeProcessingJob.mockClear();
});

// --------------------------------------------------------- whole queue

describe("holding and continuing the whole queue", () => {
  it("continues every pause a person set, and leaves the storage's own alone", async () => {
    overview = baseOverview([
      job({ id: "encoding", state: "running", startedAt: "2026-09-01T01:00Z" }),
      job({
        id: "held-one",
        state: "paused",
        pauseRequested: true,
        pausedReason: "operator",
      }),
      job({
        id: "held-two",
        state: "paused",
        pauseRequested: true,
        pausedReason: "operator",
      }),
      /*
       * This one is waiting for a volume, not for a person. It continues by
       * itself when the drive comes back, and resuming it by hand only wakes
       * it into the same failure — so it is not part of what the button counts.
       */
      job({
        id: "storage-held",
        state: "paused",
        pauseRequested: true,
        pausedReason: "storage-unavailable",
      }),
    ]);
    const user = await renderQueue();

    const button = await screen.findByRole("button", {
      name: /processing.bulk.resumeAll/,
    });
    expect(within(button).getByText("2")).toBeInTheDocument();

    await user.click(button);

    await waitFor(() => expect(resumeProcessingJob).toHaveBeenCalledTimes(2));
    expect(resumeProcessingJob.mock.calls.flat()).toEqual([
      "held-one",
      "held-two",
    ]);
  });

  it("holds everything that has not started, and not the encode that has", async () => {
    overview = baseOverview([
      job({ id: "encoding", state: "running", startedAt: "2026-09-01T01:00Z" }),
      job({ id: "first", queuePriority: 100 }),
      job({ id: "second", queuePriority: 101 }),
      // Already held: pressing again would say nothing the first press did not.
      job({
        id: "held",
        state: "paused",
        pauseRequested: true,
        pausedReason: "operator",
      }),
    ]);
    const user = await renderQueue();

    const button = await screen.findByRole("button", {
      name: /processing.bulk.pauseAll/,
    });
    expect(within(button).getByText("2")).toBeInTheDocument();

    await user.click(button);

    await waitFor(() => expect(pauseProcessingJob).toHaveBeenCalledTimes(2));
    expect(pauseProcessingJob.mock.calls.flat()).toEqual(["first", "second"]);
  });

  it("offers both presses at once when there is something for each", async () => {
    /*
     * They are two independent questions — is anything waiting, and is
     * anything held — and a queue in the middle of being worked through is
     * usually both. Either one appearing must never depend on the other.
     */
    overview = baseOverview([
      job({ id: "encoding", state: "running", startedAt: "2026-09-01T01:00Z" }),
      job({ id: "waiting-one", queuePriority: 100 }),
      job({ id: "waiting-two", queuePriority: 101 }),
      job({
        id: "held",
        state: "paused",
        pauseRequested: true,
        pausedReason: "operator",
      }),
    ]);
    await renderQueue();

    const resume = await screen.findByRole("button", {
      name: /processing.bulk.resumeAll/,
    });
    const pause = await screen.findByRole("button", {
      name: /processing.bulk.pauseAll/,
    });
    expect(within(resume).getByText("1")).toBeInTheDocument();
    expect(within(pause).getByText("2")).toBeInTheDocument();
  });

  it("continues a job that is held while it is still only queued", async () => {
    /*
     * Holding a waiting job does not stop it being queued — no worker has
     * touched it yet, so nothing has written `paused` on it. It is held all
     * the same, and it has to be possible to let it go again without waiting
     * for a worker to pick it up and park it.
     */
    overview = baseOverview([
      job({ id: "held-in-queue", queuePriority: 100, pauseRequested: true }),
      job({ id: "still-waiting", queuePriority: 101 }),
    ]);
    const user = await renderQueue();

    const resume = await screen.findByRole("button", {
      name: /processing.bulk.resumeAll/,
    });
    expect(within(resume).getByText("1")).toBeInTheDocument();

    await user.click(resume);
    await waitFor(() => expect(resumeProcessingJob).toHaveBeenCalledTimes(1));
    expect(resumeProcessingJob.mock.calls.flat()).toEqual(["held-in-queue"]);
  });

  it("offers neither press when there is nothing for it to do", async () => {
    overview = baseOverview([
      job({ id: "encoding", state: "running", startedAt: "2026-09-01T01:00Z" }),
    ]);
    await renderQueue();
    await screen.findByText("processing.outcome.active");

    expect(
      screen.queryByRole("button", { name: /processing.bulk.resumeAll/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /processing.bulk.pauseAll/ }),
    ).toBeNull();
  });
});

// ------------------------------------------------------ show and episode

describe("grouping the queue by show and episode", () => {
  /** The operator's own example, in the order they found it in. */
  const QUEUE = [
    job({ id: "arcane-1", queuePriority: 100 }),
    job({ id: "hod-5", queuePriority: 101 }),
    job({ id: "arcane-3", queuePriority: 102 }),
    job({ id: "arcane-2", queuePriority: 103 }),
    job({ id: "hod-4", queuePriority: 104 }),
  ];

  const TITLES: ProcessingJobTitle[] = [
    {
      jobId: "arcane-1",
      kind: "episode",
      seriesTitle: "arcane",
      code: "S01E01",
      seasonNumber: 1,
      episodeNumber: 1,
      title: "arcane-1",
    },
    {
      jobId: "hod-5",
      kind: "episode",
      seriesTitle: "hod",
      code: "S01E05",
      seasonNumber: 1,
      episodeNumber: 5,
      title: "hod-5",
    },
    {
      jobId: "arcane-3",
      kind: "episode",
      seriesTitle: "arcane",
      code: "S01E03",
      seasonNumber: 1,
      episodeNumber: 3,
      title: "arcane-3",
    },
    {
      jobId: "arcane-2",
      kind: "episode",
      seriesTitle: "arcane",
      code: "S01E02",
      seasonNumber: 1,
      episodeNumber: 2,
      title: "arcane-2",
    },
    {
      jobId: "hod-4",
      kind: "episode",
      seriesTitle: "hod",
      code: "S01E04",
      seasonNumber: 1,
      episodeNumber: 4,
      title: "hod-4",
    },
  ];

  it("gathers each show under the place it already held", async () => {
    overview = baseOverview(QUEUE, TITLES);
    const user = await renderQueue();
    await waitFor(() =>
      expect(slotOrder()).toEqual(["arcane", "hod", "arcane", "arcane", "hod"]),
    );

    await user.click(
      await screen.findByRole("button", {
        name: /processing.queueOrder.groupTitle/,
      }),
    );

    await waitFor(() => expect(reorderProcessingQueue).toHaveBeenCalled());
    expect(lastSavedOrder()).toEqual([
      "arcane-1",
      "arcane-2",
      "arcane-3",
      "hod-4",
      "hod-5",
    ]);
  });

  it("saves nothing when the queue is already grouped", async () => {
    overview = baseOverview(
      [
        job({ id: "arcane-1", queuePriority: 100 }),
        job({ id: "arcane-2", queuePriority: 101 }),
      ],
      TITLES,
    );
    const user = await renderQueue();
    await waitFor(() => expect(slotOrder()).toHaveLength(2));

    await user.click(
      await screen.findByRole("button", {
        name: /processing.queueOrder.groupTitle/,
      }),
    );

    expect(reorderProcessingQueue).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------- ends and groups

describe("sending rows to either end of the queue", () => {
  const QUEUE = [
    job({ id: "encoding", state: "running", startedAt: "2026-09-01T01:00Z" }),
    job({ id: "first", queuePriority: 100 }),
    job({ id: "second", queuePriority: 101 }),
    job({ id: "third", queuePriority: 102 }),
  ];

  beforeEach(() => {
    overview = baseOverview(QUEUE);
  });

  it("takes one row to the front of the waiting list", async () => {
    const user = await renderQueue();
    await waitFor(() =>
      expect(slotOrder()).toEqual(["first", "second", "third"]),
    );

    await user.click(
      within(rowFor("third")).getByRole("button", {
        name: /processing.queueOrder.sendNextLabel/,
      }),
    );

    await waitFor(() => expect(reorderProcessingQueue).toHaveBeenCalled());
    expect(lastSavedOrder()).toEqual(["third", "first", "second"]);
    // The encode that is running is not part of the order: it holds no place
    // in the queue, and sending anything "next" cannot displace it.
    expect(lastSavedOrder()).not.toContain("encoding");
  });

  it("takes one row to the end of the waiting list", async () => {
    const user = await renderQueue();
    await waitFor(() =>
      expect(slotOrder()).toEqual(["first", "second", "third"]),
    );

    await user.click(
      within(rowFor("first")).getByRole("button", {
        name: /processing.queueOrder.sendLastLabel/,
      }),
    );

    await waitFor(() => expect(reorderProcessingQueue).toHaveBeenCalled());
    expect(lastSavedOrder()).toEqual(["second", "third", "first"]);
  });

  it("offers neither end to the row that is already at it", async () => {
    await renderQueue();
    await waitFor(() =>
      expect(slotOrder()).toEqual(["first", "second", "third"]),
    );

    expect(
      within(rowFor("first")).queryByRole("button", {
        name: /processing.queueOrder.sendNextLabel/,
      }),
    ).toBeNull();
    expect(
      within(rowFor("third")).queryByRole("button", {
        name: /processing.queueOrder.sendLastLabel/,
      }),
    ).toBeNull();
  });

  it("moves a whole selection at once, keeping the order it had", async () => {
    const user = await renderQueue();
    await waitFor(() =>
      expect(slotOrder()).toEqual(["first", "second", "third"]),
    );

    // Ticked bottom-up on purpose: what a group move carries is the queue's
    // order, not the order the boxes were ticked in.
    await user.click(
      within(rowFor("third")).getByRole("checkbox", {
        name: /processing.queueOrder.select/,
      }),
    );
    await user.click(
      within(rowFor("second")).getByRole("checkbox", {
        name: /processing.queueOrder.select/,
      }),
    );

    await user.click(
      await screen.findByRole("button", {
        name: /processing.queueOrder.groupToTop/,
      }),
    );

    await waitFor(() => expect(reorderProcessingQueue).toHaveBeenCalled());
    expect(lastSavedOrder()).toEqual(["second", "third", "first"]);
  });

  it("drops a whole selection to the end", async () => {
    const user = await renderQueue();
    await waitFor(() =>
      expect(slotOrder()).toEqual(["first", "second", "third"]),
    );

    await user.click(
      within(rowFor("first")).getByRole("checkbox", {
        name: /processing.queueOrder.select/,
      }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: /processing.queueOrder.groupToBottom/,
      }),
    );

    await waitFor(() => expect(reorderProcessingQueue).toHaveBeenCalled());
    expect(lastSavedOrder()).toEqual(["second", "third", "first"]);
  });

  it("selects the whole waiting list in one press, and clears it in one", async () => {
    const user = await renderQueue();
    await waitFor(() =>
      expect(slotOrder()).toEqual(["first", "second", "third"]),
    );

    await user.click(
      await screen.findByRole("button", {
        name: /processing.queueOrder.selectAll/,
      }),
    );
    expect(
      screen.getAllByRole("checkbox", {
        name: /processing.queueOrder.select/,
      }),
    ).toHaveLength(3);
    for (const box of screen.getAllByRole("checkbox", {
      name: /processing.queueOrder.select/,
    })) {
      expect(box).toBeChecked();
    }

    await user.click(
      await screen.findByRole("button", {
        name: /processing.queueOrder.clearSelection/,
      }),
    );
    for (const box of screen.getAllByRole("checkbox", {
      name: /processing.queueOrder.select/,
    })) {
      expect(box).not.toBeChecked();
    }
  });
});
