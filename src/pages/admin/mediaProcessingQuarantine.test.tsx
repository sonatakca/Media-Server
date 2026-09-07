/**
 * What a held job says about itself, rendered through the real page.
 *
 * The defect this suite exists for was silent by construction: a job the guard
 * quarantined after a hard I/O failure rendered with the same "Paused" chip an
 * operator's own pause uses, offered no button, and explained nothing. The
 * queue simply stopped, and the page's account of why was a word that said the
 * opposite of what had happened.
 *
 * So the claims here are the ones an operator reads off the screen: a
 * quarantine is named as a quarantine, the guard's own sentence about the fault
 * is shown, and when the hold and the incident record disagree — the case that
 * leaves nothing to press anywhere on the page — the row says so instead of
 * looking stuck for no reason.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type {
  ProcessingJob,
  ProcessingOverview,
  ProcessingStorageHealth,
} from "../../lib/processingApi";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));

vi.mock("../../lib/mediaApi", () => ({
  getUserViews: async () => [],
  getVideoItemsForLibrary: async () => [],
  getPrimaryImageUrl: () => "",
}));

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
    state: "paused",
    stage: "waiting",
    stageProgress: 0,
    overallProgress: 0.64,
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
    attempts: 2,
    cancellationRequested: false,
    pauseRequested: true,
    pausedReason: null,
    epochCount: 14,
    epochIndex: 11,
    completedEpochs: 11,
    protectedSeconds: 3300,
    encodedSeconds: 3571,
    sourceDurationSeconds: 4101,
    epochStartSeconds: 3300,
    epochEndSeconds: 3600,
    checkpointBytes: 0,
    freeBytes: null,
    queuePriority: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: "2026-09-01T00:10:00.000Z",
    finishedAt: null,
    updatedAt: "2026-09-01T01:00:00.000Z",
    ...overrides,
  } as ProcessingJob;
}

function storage(
  overrides: Partial<ProcessingStorageHealth>,
): ProcessingStorageHealth {
  return {
    root: "/media",
    state: "healthy",
    summary: "",
    reason: "",
    faultCount: 0,
    missingRoots: [],
    firstFaultAt: null,
    lastFaultAt: null,
    changedAt: "2026-09-01T01:00:00.000Z",
    verifiedAt: null,
    mayStartWork: true,
    automaticResumeBlocked: false,
    awaitingVerification: false,
    awaitingResume: false,
    ...overrides,
  };
}

function overviewWith(
  jobs: ProcessingJob[],
  health: ProcessingStorageHealth,
): ProcessingOverview {
  return {
    counts: {
      pending: 0,
      queued: 0,
      running: 0,
      paused: jobs.length,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    },
    hardware: {
      platform: "darwin",
      probedAt: "2026-09-01T00:00:00.000Z",
      adapters: [],
      selected: { h264: "", hevc: "", hevcTenBit: "" },
      selectedAdapter: { h264: "", hevc: "", hevcTenBit: "" },
    },
    jobs,
    stages: [],
    profile: "cmaf-hls-aligned-v2",
    storage: health,
    movies: [],
    series: [],
    jobTitles: jobs.map((entry) => ({
      jobId: entry.id,
      kind: "movie" as const,
      title: entry.id,
    })),
  } as ProcessingOverview;
}

async function renderProcesses() {
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

/** The row for a job, found by the title the server sent with it. */
function rowFor(id: string): HTMLElement {
  const row = screen
    .getAllByRole("listitem")
    .find((candidate) => within(candidate).queryByText(id));
  if (!row) throw new Error(`no row rendered for ${id}`);
  return row;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a job the storage guard is holding", () => {
  it("names a quarantine rather than calling it a pause", async () => {
    overview = overviewWith(
      [job({ id: "quarantined", pausedReason: "storage-quarantined" })],
      storage({
        state: "quarantined",
        mayStartWork: false,
        automaticResumeBlocked: true,
        reason:
          "The storage reported a hard I/O failure. FFmpeg produced no media for 29s and was stopped at 271.188s.",
        faultCount: 1,
      }),
    );
    await renderProcesses();

    const row = rowFor("quarantined");
    expect(within(row).getByText("processing.pausedByQuarantine")).toBeTruthy();
    // The word it used to show, and the whole of the defect.
    expect(within(row).queryByText("processing.pausedByOperator")).toBeNull();
  });

  /**
   * The cause, not just the category. The guard writes one sentence naming the
   * fault and where the encoder stopped, and that sentence is the only place
   * an operator can read *why* without opening the log.
   */
  it("prints the guard's own account of the fault", async () => {
    const reason =
      "The storage reported a hard I/O failure. FFmpeg produced no media for 29s and was stopped at 271.188s.";
    overview = overviewWith(
      [job({ id: "quarantined", pausedReason: "storage-quarantined" })],
      storage({
        state: "quarantined",
        mayStartWork: false,
        automaticResumeBlocked: true,
        reason,
        faultCount: 1,
      }),
    );
    await renderProcesses();

    const row = rowFor("quarantined");
    expect(within(row).getByText(reason)).toBeTruthy();
    expect(
      within(row).getByText("processing.storage.held.quarantined"),
    ).toBeTruthy();
    expect(within(row).getByText("processing.storage.heldAction")).toBeTruthy();
  });

  /**
   * The case that produced a page with nothing to press anywhere on it: the
   * worker holds the job in memory but the incident write failed, so the panel
   * reads healthy and offers no resume while the row offers no continue. The
   * row has to name the disagreement, because it is the only thing on screen
   * that knows about it.
   */
  it("says so when the hold and the incident record disagree", async () => {
    overview = overviewWith(
      [job({ id: "orphaned", pausedReason: "storage-quarantined" })],
      storage({ state: "healthy", mayStartWork: true, reason: "" }),
    );
    await renderProcesses();

    const row = rowFor("orphaned");
    expect(
      within(row).getByText("processing.storage.heldButHealthy"),
    ).toBeTruthy();
  });

  it("distinguishes a check that is pending from a fault that was recorded", async () => {
    overview = overviewWith(
      [job({ id: "pending-check", pausedReason: "recovery-pending" })],
      storage({
        state: "recovery-pending",
        mayStartWork: false,
        automaticResumeBlocked: true,
        awaitingResume: true,
        reason: "Work was interrupted by an unclean shutdown.",
      }),
    );
    await renderProcesses();

    const row = rowFor("pending-check");
    expect(within(row).getByText("processing.pausedByRecovery")).toBeTruthy();
    expect(
      within(row).getByText("processing.storage.held.recoveryPending"),
    ).toBeTruthy();
    expect(
      within(row).queryByText("processing.storage.held.quarantined"),
    ).toBeNull();
  });

  /**
   * The reason that still resumes on its own keeps its quiet wording and its
   * "nothing to do here" panel — the new alarm must not leak onto it.
   */
  it("leaves a volume that is merely absent reading as before", async () => {
    overview = overviewWith(
      [job({ id: "waiting", pausedReason: "storage-unavailable" })],
      storage({ state: "unavailable", mayStartWork: false }),
    );
    await renderProcesses();

    const row = rowFor("waiting");
    expect(within(row).getByText("processing.pausedByStorage")).toBeTruthy();
    expect(within(row).getByText("processing.storage.noAction")).toBeTruthy();
    expect(within(row).queryByText("processing.storage.heldAction")).toBeNull();
  });
});
