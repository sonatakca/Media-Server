import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import {
  createSubtitleRuntime,
  disabledSubtitleJobTypes,
  unattendedSessionManager,
} from "./subtitleRuntime";
import { SUBTITLE_JOB_TYPES } from "./subtitleJobs";
import type { SubtitleConfig } from "./subtitleConfig";
import type { SubtitleProvider } from "./subtitleProvider";

/**
 * The safety property this whole checkpoint rests on: with nothing declared,
 * the subsystem does not exist.
 *
 * Not "does nothing" — is not constructed. No repository, no service, no
 * handlers, no routes, and no query against the database on the way to finding
 * that out. A subsystem that builds itself and then declines to act is one
 * accident away from acting.
 */

const root = process.platform === "win32" ? "C:\\library" : "/library";

const config = (over: Partial<SubtitleConfig> = {}): SubtitleConfig => ({
  libraryRoot: root,
  providerIds: [],
  timeoutMs: 30_000,
  ...over,
});

const provider = (id: string): SubtitleProvider => ({
  id,
  label: id,
  requiresSession: false,
  rank: 1,
  languages: null,
  search: async () => ({ outcome: "empty" }),
  download: async () => ({ outcome: "empty" }),
});

/** A pool that fails the test if anything touches it. */
function watchfulPool() {
  const query = vi.fn(async () => {
    throw new Error("The subsystem queried the database while unconfigured.");
  });
  return { pool: { query } as unknown as DatabasePool, query };
}

describe("when nothing is declared", () => {
  it("builds no subsystem at all", () => {
    const { pool } = watchfulPool();
    expect(createSubtitleRuntime({ pool })).toBeUndefined();
  });

  it("does not go near the database on the way to that answer", () => {
    const { pool, query } = watchfulPool();
    createSubtitleRuntime({ pool });
    expect(query).not.toHaveBeenCalled();
  });

  /*
   * The worker is told to exclude the job types as well. Otherwise a row left
   * in the queue by an earlier, configured deployment would be picked up by a
   * deployment that has since been switched off, and there would be no handler
   * to run it.
   */
  it("keeps the queue from leasing subtitle work", () => {
    expect(disabledSubtitleJobTypes(undefined)).toEqual(
      Object.values(SUBTITLE_JOB_TYPES),
    );
    expect(disabledSubtitleJobTypes(undefined)).toHaveLength(3);
  });
});

describe("when it is declared", () => {
  it("builds a repository, a service and the handlers", () => {
    const { pool } = watchfulPool();
    const runtime = createSubtitleRuntime({ pool, config: config() });
    expect(runtime).toBeDefined();
    expect(Object.keys(runtime?.handlers ?? {}).sort()).toEqual(
      Object.values(SUBTITLE_JOB_TYPES).sort(),
    );
  });

  it("lets the queue lease subtitle work", () => {
    expect(disabledSubtitleJobTypes(config())).toEqual([]);
  });

  /*
   * A declaration naming a provider nobody registered is a deployment mistake,
   * and it fails at construction rather than at the first search. Discovering
   * it when a person is waiting for a subtitle is discovering it too late.
   */
  it("refuses to start naming a provider that is not registered", () => {
    const { pool } = watchfulPool();
    expect(() =>
      createSubtitleRuntime({
        pool,
        config: config({ providerIds: ["turkcealtyazilar"] }),
        providers: [provider("somebody-else")],
      }),
    ).toThrow(/not registered/);
  });

  it("accepts a provider that is registered", () => {
    const { pool } = watchfulPool();
    expect(() =>
      createSubtitleRuntime({
        pool,
        config: config({ providerIds: ["turkcealtyazilar"] }),
        providers: [provider("turkcealtyazilar")],
      }),
    ).not.toThrow();
  });

  /*
   * With no interactive session host wired in, the honest answer to "may I have
   * a session" is that a person is needed — not a throw, and not a pretence
   * that one exists. That keeps a provider needing authentication in the
   * resumable state rather than turning it into a failure.
   */
  it("answers needs-authentication when no session host is wired in", async () => {
    const lookup = await unattendedSessionManager().acquire("turkcealtyazilar");
    expect(lookup).toEqual({
      outcome: "needs-authentication",
      providerId: "turkcealtyazilar",
      reason: "Interactive authentication is not configured.",
      authenticateAt: null,
    });
  });

  it("carries no session material in that answer", async () => {
    const lookup = await unattendedSessionManager().acquire("p");
    expect(JSON.stringify(lookup)).not.toMatch(/cookie|session=|clearance/i);
  });

  it("accepts an invalidation it has nothing to invalidate", async () => {
    await expect(
      unattendedSessionManager().invalidate("p", "rejected"),
    ).resolves.toBeUndefined();
  });
});
