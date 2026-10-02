// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createBlocklistRepository } from "./blocklistRepository";
import { createPolicyRepository } from "./policyRepository";
import { createAcquisitionRepository } from "../acquisition/acquisitionRepository";

/*
 * What migration 032 adds, against PostgreSQL: the blocklist's matching, and
 * the size limit every existing profile takes by default.
 *
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("the release blocklist and size limit in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const blocklist = createBlocklistRepository(pool);
  const policies = createPolicyRepository(pool);
  const acquisitions = createAcquisitionRepository(pool);

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("matches by indexer and guid, and by title on any indexer", async () => {
    await blocklist.add({
      indexerId: "nzbgeek",
      releaseGuid: "bad-guid",
      releaseTitle: "Mad.Max.Fury.Road.2015.2160p.UHD.BluRay-BAD",
    });
    // Twice is the same as once.
    await blocklist.add({
      indexerId: "nzbgeek",
      releaseGuid: "bad-guid",
      releaseTitle: "Mad.Max.Fury.Road.2015.2160p.UHD.BluRay-BAD",
    });
    expect(await blocklist.list()).toHaveLength(1);

    const candidates = [
      { indexerId: "nzbgeek", guid: "bad-guid", title: "Renamed" },
      {
        indexerId: "other",
        guid: "x",
        title: "mad.max.fury.road.2015.2160p.uhd.bluray-bad",
      },
      { indexerId: "other", guid: "bad-guid", title: "Different" },
      { indexerId: "nzbgeek", guid: "good", title: "Mad.Max.2015.1080p-OK" },
    ];
    const isBlocked = await blocklist.matcherFor(candidates);
    expect(candidates.map(isBlocked)).toEqual([true, true, false, false]);
  });

  it("removes an entry", async () => {
    const [entry] = await blocklist.list();
    expect(await blocklist.remove(entry!.id)).toBe(true);
    expect(await blocklist.remove(entry!.id)).toBe(false);
    expect(await blocklist.list()).toHaveLength(0);
  });

  it("gives a profile a 30 GB limit by default, which can be changed", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO quality_profiles (id, name, items, cutoff_quality_id)
       VALUES ($1, 'HD', '[["webdl-1080p"]]', 'webdl-1080p')`,
      [id],
    );
    expect((await policies.load(id))!.profile.maxSizeBytes).toBe(30e9);
    expect(await policies.listProfiles()).toEqual([
      { id, name: "HD", maxSizeBytes: 30e9 },
    ]);

    expect(await policies.setMaxSize(id, 50e9)).toBe(true);
    expect((await policies.load(id))!.profile.maxSizeBytes).toBe(50e9);
    expect(await policies.setMaxSize(id, null)).toBe(true);
    expect((await policies.load(id))!.profile.maxSizeBytes).toBeUndefined();
    expect(await policies.setMaxSize(randomUUID(), 1)).toBe(false);
  });

  it("recalls what an acquisition was for, to search for it again", async () => {
    const profileId = randomUUID();
    const created = await acquisitions.create({
      target: { kind: "season", title: "Ezel", season: 2 },
      indexerId: "nzbgeek",
      releaseGuid: "g",
      releaseTitle: "Ezel.S02.1080p-GRP",
      origin: "manual",
      evidence: {
        profileId,
        profileName: "HD",
        policySnapshot: {},
        releaseFacts: {},
        score: 0,
        reasons: [],
        rejected: [],
      },
    });
    expect(await acquisitions.searchContext(created.id)).toEqual({
      target: { kind: "season", title: "Ezel", season: 2 },
      profileId,
    });
    expect(await acquisitions.searchContext(randomUUID())).toBeNull();
  });

  it("retires earlier failures for the same title, and only those", async () => {
    const evidence = {
      profileName: "HD",
      policySnapshot: {},
      releaseFacts: {},
      score: 0,
      reasons: [],
      rejected: [],
    };
    const make = async (
      title: string,
      year: number | undefined,
      state: "failed" | "downloading" | "planned",
    ) => {
      const row = await acquisitions.create({
        target: {
          kind: "movie",
          title,
          ...(year === undefined ? {} : { year }),
        },
        indexerId: "nzbgeek",
        releaseGuid: randomUUID(),
        releaseTitle: `${title}.release`,
        origin: "manual",
        evidence,
      });
      if (state !== "planned") {
        await pool.query("UPDATE acquisitions SET state = $2 WHERE id = $1", [
          row.id,
          state,
        ]);
      }
      return row.id;
    };

    const failedSameYear = await make("Mad Max: Fury Road", 2015, "failed");
    const failedNoYear = await make("mad max: fury road", undefined, "failed");
    const failedOtherYear = await make("Mad Max: Fury Road", 1979, "failed");
    const stillRunning = await make("Mad Max: Fury Road", 2015, "downloading");
    const otherFilm = await make("Mad Max", 1979, "failed");
    const newer = await make("Mad Max: Fury Road", 2015, "planned");

    expect(await acquisitions.supersedeFailedFor(newer)).toBe(2);
    const states = await pool.query<{ id: string; state: string }>(
      "SELECT id, state FROM acquisitions WHERE id = ANY($1::uuid[])",
      [
        [
          failedSameYear,
          failedNoYear,
          failedOtherYear,
          stillRunning,
          otherFilm,
          newer,
        ],
      ],
    );
    const stateOf = new Map(states.rows.map((row) => [row.id, row.state]));
    expect(stateOf.get(failedSameYear)).toBe("superseded");
    expect(stateOf.get(failedNoYear)).toBe("superseded");
    expect(stateOf.get(failedOtherYear)).toBe("failed");
    expect(stateOf.get(stillRunning)).toBe("downloading");
    expect(stateOf.get(otherFilm)).toBe("failed");
    expect(stateOf.get(newer)).toBe("planned");

    const detail = await acquisitions.detail(failedSameYear);
    expect(detail!.events.at(-1)).toMatchObject({
      fromState: "failed",
      toState: "superseded",
    });
  });
});
