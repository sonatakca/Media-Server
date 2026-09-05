import { describe, expect, it, vi } from "vitest";
import { toTaskDto, createTaskRoutes } from "./taskRoutes";
import type { JobRecord, JobQueue } from "./jobQueue";
import type { LibraryRepository } from "../libraries/libraryRepository";
const job: JobRecord = {
  id: "job",
  jobType: "library.scan",
  payload: {
    libraryId: "library",
    sourcePath: "/private/source",
    configuration: "secret",
  },
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  progress: 0.42,
  progressMessage: "Analysed 42 of 100 files",
  safeError: "postgres://private/password",
  result: { itemsCreated: 0, path: "/private/source" },
  cancellationRequested: false,
  queuedAt: new Date(),
  startedAt: new Date(),
  finishedAt: null,
};
const libraries = {
  getById: async () => ({ name: "Movies" }),
} as unknown as LibraryRepository;
describe("safe task endpoint presentation", () => {
  it("exposes a resolved name, exact fraction and allowlisted counts only", async () => {
    const dto = await toTaskDto({ ...job, status: "succeeded" }, libraries);
    expect(dto.progress).toBe(0.42);
    expect(dto.presentation.subject?.label).toBe("Movies");
    expect(dto.result).toEqual({ itemsCreated: 0 });
    expect(JSON.stringify(dto)).not.toMatch(
      /private|password|sourcePath|secret/,
    );
    expect(dto.progressMessage).toBeNull();
  });
  it("handles deleted subjects without exposing identifiers", async () => {
    const dto = await toTaskDto(job, {
      getById: async () => null,
    } as unknown as LibraryRepository);
    expect(dto.presentation.subject).toEqual({
      type: "library",
      deleted: true,
    });
  });
  it("resolves media labels rather than trusting payload labels", async () => {
    const dto = await toTaskDto(
      { ...job, payload: { itemId: "secret-id", title: "/private" } },
      libraries,
      async () => ({ kind: "movie", title: "A Film" }),
    );
    expect(dto.presentation.subject?.label).toBe("A Film");
    expect(JSON.stringify(dto)).not.toContain("secret-id");
  });
  it("retains admin access on every task route", () => {
    expect(
      createTaskRoutes({ libraries, queue: {} as JobQueue }).every(
        (route) => route.access === "admin",
      ),
    ).toBe(true);
  });
});

it("enriches only the matching processing attempt with exact encoding time and a safe stage", async () => {
  const processing = {
    jobId: "job",
    itemId: "item",
    state: "running",
    stage: "video",
    encodedSeconds: 42,
    sourceDurationSeconds: 100,
    overallProgress: 0.91,
    stagingDirectory: "/private",
    sourceDamage: null,
  };
  const store = { get: async () => processing } as unknown as NonNullable<
    Parameters<typeof toTaskDto>[3]
  >;
  const current = {
    ...job,
    jobType: "media.process",
    payload: { processingJobId: "processing" },
  };
  const dto = await toTaskDto(
    current,
    libraries,
    async () => ({ kind: "movie", title: "Film" }),
    store,
  );
  expect(dto.presentation).toMatchObject({
    determinate: false,
    stage: "video",
    encoding: { completedSeconds: 42, totalSeconds: 100 },
    subject: { label: "Film" },
  });
  expect(JSON.stringify(dto)).not.toContain("private");
  processing.jobId = "newer-attempt";
  const historical = await toTaskDto(
    current,
    libraries,
    async () => ({ kind: "movie", title: "Film" }),
    store,
  );
  expect(historical.presentation.encoding).toBeUndefined();
});

let sample: Record<string, unknown> | null = null;
let fresh = true;
vi.mock("../processing/liveProgress", () => ({
  readLiveProgress: async () => sample,
  liveProgressIsFresh: () => fresh,
}));

const processingJob = {
  id: "processing",
  jobId: "job",
  itemId: "item",
  state: "running",
  stage: "video",
  encodedSeconds: 1_200,
  sourceDurationSeconds: 3_794,
  sourceDamage: null,
};
const episode = {
  kind: "episode",
  title: "Second of His Name",
  seriesTitle: "House of the Dragon",
  seasonNumber: 1,
  episodeNumber: 3,
};
const store = { get: async () => processingJob } as unknown as NonNullable<
  Parameters<typeof toTaskDto>[3]
>;
const processJob = {
  ...job,
  jobType: "media.process",
  payload: { processingJobId: "processing" },
};

describe("naming a processing job", () => {
  it("names an episode by its show, and says which episode inside it", async () => {
    // Twelve queued episodes of one series are twelve identical cards without
    // the code; the show alone is what makes the card scannable.
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      store,
    );
    expect(dto.presentation.subject).toEqual({
      type: "media",
      label: "House of the Dragon",
      code: "S01E03",
      detail: "Second of His Name",
    });
  });

  it("still identifies a title whose name the allowlist rejects", async () => {
    // A name carrying a path or an identifier is dropped, but the code is ours
    // and always safe — an anonymous card is the failure this prevents.
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => ({ ...episode, title: "s01e03/second", seriesTitle: null }),
      store,
    );
    expect(dto.presentation.subject).toEqual({
      type: "media",
      code: "S01E03",
    });
  });

  it("names a queued attempt that the processing row has moved past", async () => {
    // Which title a processing row is about never changes; only its figures
    // belong to one attempt.
    const dto = await toTaskDto(
      processJob,
      { ...libraries, getById: async () => null } as typeof libraries,
      async () => episode,
      { get: async () => ({ ...processingJob, jobId: "other" }) } as never,
    );
    expect(dto.presentation.subject?.label).toBe("House of the Dragon");
    expect(dto.presentation.encoding).toBeUndefined();
    expect(dto.presentation.remainingSeconds).toBeUndefined();
  });
});

describe("live encode figures", () => {
  it("prefers the live sample and carries the remaining time it measured", async () => {
    sample = {
      encodedSeconds: 1_381,
      sourceDurationSeconds: 3_794,
      etaSeconds: 1_975.4,
    };
    fresh = true;
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      store,
    );
    expect(dto.presentation.encoding).toEqual({
      completedSeconds: 1_381,
      totalSeconds: 3_794,
    });
    expect(dto.presentation.remainingSeconds).toBe(1_975);
  });

  it("withdraws the remaining time when the sample stops arriving", async () => {
    // The figures stay true about the past; a rate that is no longer happening
    // is not a statement anyone should act on.
    sample = {
      encodedSeconds: 1_381,
      sourceDurationSeconds: 3_794,
      etaSeconds: 1_975,
    };
    fresh = false;
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      store,
    );
    expect(dto.presentation.encoding).toEqual({
      completedSeconds: 1_200,
      totalSeconds: 3_794,
    });
    expect(dto.presentation.remainingSeconds).toBeUndefined();
  });

  it("never moves an encode backwards when a sample lags the row", async () => {
    sample = { encodedSeconds: 5, sourceDurationSeconds: 3_794 };
    fresh = true;
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      store,
    );
    expect(dto.presentation.encoding?.completedSeconds).toBe(1_200);
  });
});

it("reads the phase from the sample, not from a row written at checkpoints", async () => {
  // The production shape of this: a row that still says the job is starting
  // while the encoder is most of the way through the picture, and a card that
  // repeated the row.
  sample = {
    stage: "video",
    encodedSeconds: 3_195,
    sourceDurationSeconds: 3_794,
    etaSeconds: 702,
  };
  fresh = true;
  const dto = await toTaskDto(processJob, libraries, async () => episode, {
    get: async () => ({
      ...processingJob,
      stage: "starting",
      encodedSeconds: 0,
      sourceDurationSeconds: null,
    }),
  } as never);
  expect(dto.presentation.stage).toBe("video");
  expect(dto.presentation.encoding).toEqual({
    completedSeconds: 3_195,
    totalSeconds: 3_794,
  });
  expect(dto.presentation.remainingSeconds).toBe(702);
});

describe("a suspended encoder", () => {
  /*
   * Pausing stops the encoder, not the queue attempt: the row this DTO is
   * built from goes on saying `running`. A card that believed it reported a
   * held job as working away with an unmeasurable rate, beside a page showing
   * the same job three quarters encoded and plainly paused.
   */
  const paused = {
    ...processingJob,
    state: "paused",
    pausedReason: "operator",
    encodedSeconds: 3_090,
  };

  it("reports the hold and keeps the position it stopped at", async () => {
    sample = { encodedSeconds: 3_400, sourceDurationSeconds: 3_794 };
    fresh = true;
    const dto = await toTaskDto(processJob, libraries, async () => episode, {
      get: async () => paused,
    } as never);
    expect(dto.status).toBe("running");
    expect(dto.presentation.outcome).toBe("paused");
    expect(dto.presentation.stage).toBe("video");
    // The live sample belongs to a rate that is no longer happening, so it is
    // never read for a job that is not running; the row is.
    expect(dto.presentation.encoding).toEqual({
      completedSeconds: 3_090,
      totalSeconds: 3_794,
    });
    expect(dto.presentation.remainingSeconds).toBeUndefined();
  });

  it("distinguishes an absent drive from a person's hand", async () => {
    const dto = await toTaskDto(processJob, libraries, async () => episode, {
      get: async () => ({ ...paused, pausedReason: "storage-unavailable" }),
    } as never);
    expect(dto.presentation.outcome).toBe("waiting-for-storage");
  });
});

describe("phases that are not the picture", () => {
  /*
   * Assembling, verifying and publishing are the last quarter of every media
   * job, and each measures itself exactly. Reporting only the encode left a
   * card saying "progress not measurable yet" for all of it, beside a page
   * showing the package fully assembled.
   */
  it("carries the phase's own measure once the encode is behind it", async () => {
    sample = {
      stage: "packaging",
      phaseFraction: 0.081,
      encodedSeconds: 3_794,
      sourceDurationSeconds: 3_794,
    };
    fresh = true;
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      store,
    );
    expect(dto.presentation.stage).toBe("packaging");
    expect(dto.presentation.phaseFraction).toBe(0.081);
    // Media seconds describe the picture, and the picture is no longer what
    // this job is doing.
    expect(dto.presentation.encoding).toBeUndefined();
  });

  it("never pairs one source's phase with another source's fraction", async () => {
    // The sample's phase and the row's phase advance independently. Crossing
    // them reports where the phase that just ended got to, under the name of
    // the one that just began.
    sample = { stage: "publishing", phaseFraction: 0.02 };
    fresh = true;
    const crossed = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      {
        get: async () => ({
          ...processingJob,
          stage: "packaging",
          stageProgress: 0.97,
        }),
      } as never,
    );
    expect(crossed.presentation).toMatchObject({
      stage: "publishing",
      phaseFraction: 0.02,
    });

    // With no sample it is the row that names the phase, so it is the row's
    // fraction that goes with it.
    fresh = false;
    const fromRow = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      {
        get: async () => ({
          ...processingJob,
          stage: "validating",
          stageProgress: 0.5,
        }),
      } as never,
    );
    expect(fromRow.presentation).toMatchObject({
      stage: "validating",
      phaseFraction: 0.5,
    });
  });

  it("offers no figure for a job that has not started a phase", async () => {
    fresh = false;
    const dto = await toTaskDto(processJob, libraries, async () => episode, {
      get: async () => ({
        ...processingJob,
        state: "queued",
        stage: "waiting",
        stageProgress: 0,
      }),
    } as never);
    expect(dto.presentation.phaseFraction).toBeUndefined();
  });
});
