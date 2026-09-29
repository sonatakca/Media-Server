import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createGroupState,
  isAdvancing,
  joinParticipant,
  participantKey,
  positionAt,
  removeParticipant,
  reportStatus,
  setStreamOpen,
  SYNCPLAY_TUNING,
  tick,
  waitingFor,
  type GroupState,
  type Transition,
} from "./syncplayState";

const T0 = 1_000_000;
const ITEM = "aaaaaaaa-0000-4000-8000-000000000001";
const NEXT_ITEM = "aaaaaaaa-0000-4000-8000-000000000002";
const AFTER_NEXT = "aaaaaaaa-0000-4000-8000-000000000003";
const tuning = SYNCPLAY_TUNING;

const A = participantKey("user-a", "client-a");
const B = participantKey("user-b", "client-b");
const C = participantKey("user-c", "client-c");

/** Drives a group through transitions and keeps what happened. */
class Group {
  state: GroupState;
  last!: Transition;
  now = T0;
  private sequences = new Map<string, number>();

  constructor(state?: GroupState) {
    this.state =
      state ??
      createGroupState({
        id: "group",
        name: "Party",
        ownerUserId: "user-a",
        itemId: ITEM,
        now: T0,
      });
  }

  private apply(transition: Transition): Transition {
    this.state = transition.state;
    this.last = transition;
    return transition;
  }

  at(ms: number): this {
    this.now = T0 + ms;
    return this;
  }

  /** Joins, opens the stream and reports ready for the current revision. */
  arrive(key: string): this {
    const [userId, clientId] = key.split(":") as [string, string];
    this.apply(
      joinParticipant(
        this.state,
        { userId, clientId, displayName: userId },
        this.now,
      ),
    );
    this.apply(setStreamOpen(this.state, key, true, this.now));
    return this.ready(key);
  }

  ready(key: string, revision = this.state.timeline.revision): this {
    this.apply(
      reportStatus(this.state, key, { status: "ready", revision }, this.now),
    );
    return this;
  }

  report(
    key: string,
    status: "loading" | "ready" | "stalled" | "away",
    revision = this.state.timeline.revision,
  ): this {
    this.apply(reportStatus(this.state, key, { status, revision }, this.now));
    return this;
  }

  command(
    key: string,
    command: Parameters<typeof applyCommand>[3],
    sequence?: number,
  ): Transition {
    const next = sequence ?? (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, Math.max(next, this.sequences.get(key) ?? 0));
    return this.apply(applyCommand(this.state, key, next, command, this.now));
  }

  tick(): Transition {
    return this.apply(tick(this.state, this.now));
  }

  position(): number {
    return positionAt(this.state.timeline, this.now);
  }

  waiting(): string[] {
    return waitingFor(this.state).map((participant) => participant.key);
  }
}

describe("the group timeline", () => {
  it("holds its position while paused", () => {
    const group = new Group().arrive(A);
    expect(group.at(60_000).position()).toBe(0);
  });

  it("advances in real time once playing, from a start scheduled for everyone", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });

    const { anchorMs } = group.state.timeline;
    // The start is scheduled a little ahead so the command reaches everyone
    // before the moment it names.
    expect(anchorMs).toBeGreaterThan(group.now);
    expect(anchorMs - group.now).toBeLessThanOrEqual(tuning.maxStartLeadMs);
    expect(group.position()).toBe(0);
    expect(positionAt(group.state.timeline, anchorMs + 10_000)).toBe(10_000);
  });

  it("schedules the start past the slowest participant's latency", () => {
    const group = new Group().arrive(A).arrive(B);
    group.state = reportStatus(
      group.state,
      B,
      { status: "ready", revision: 0, latencyMs: 400 },
      group.now,
    ).state;

    group.command(A, { type: "play" });
    expect(group.state.timeline.anchorMs - group.now).toBe(
      400 + tuning.startLeadMarginMs,
    );
  });

  it("resumes from where it paused, not from where time has got to", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    const started = group.state.timeline.anchorMs;
    group.now = started + 30_000;
    group.command(B, { type: "pause", positionMs: 30_000 });
    group.ready(A).ready(B);

    group.now += 5 * 60_000;
    group.command(A, { type: "play" });
    const resumed = group.state.timeline.anchorMs;
    expect(positionAt(group.state.timeline, resumed)).toBe(30_000);
    expect(positionAt(group.state.timeline, resumed + 1_000)).toBe(31_000);
  });

  it("treats a repeated play as nothing new", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    const revision = group.state.timeline.revision;

    const repeat = group.command(B, { type: "play" });
    expect(repeat.timelineChanged).toBe(false);
    expect(group.state.timeline.revision).toBe(revision);
  });
});

describe("pausing", () => {
  it("lands where the person who paused saw it", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    group.now = group.state.timeline.anchorMs + 20_000;

    // B's command arrives 150 ms after B pressed pause.
    group.command(B, { type: "pause", positionMs: 19_850 });
    expect(group.state.timeline.positionMs).toBe(19_850);
    expect(group.state.timeline.intent).toBe("paused");
  });

  it("ignores a reported position that is far from the group", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    group.now = group.state.timeline.anchorMs + 20_000;

    group.command(B, { type: "pause", positionMs: 90_000 });
    expect(group.state.timeline.positionMs).toBe(20_000);
  });

  it("cancels a hold, since there is nothing left to wait for", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    group.command(A, { type: "seek", positionMs: 60_000 });
    expect(group.state.timeline.hold).not.toBeNull();

    group.command(B, { type: "pause" });
    expect(group.state.timeline.hold).toBeNull();
    expect(group.state.timeline.positionMs).toBe(60_000);
  });
});

describe("coordinated starts", () => {
  it("holds a seek until everyone can play from the new position", () => {
    const group = new Group().arrive(A).arrive(B).arrive(C);
    group.command(A, { type: "play" });
    group.at(10_000).command(A, { type: "seek", positionMs: 600_000 });

    const seekRevision = group.state.timeline.revision;
    expect(group.state.timeline.hold?.reason).toBe("settling");
    expect(isAdvancing(group.state.timeline)).toBe(false);
    expect(group.waiting().sort()).toEqual([A, B, C].sort());

    // Nobody moves while the group waits.
    group.at(11_000);
    expect(group.position()).toBe(600_000);

    group.ready(A).ready(C);
    expect(group.waiting()).toEqual([B]);
    expect(group.state.timeline.hold).not.toBeNull();

    group.at(11_500).ready(B);
    expect(group.state.timeline.hold).toBeNull();
    expect(group.state.timeline.revision).toBe(seekRevision + 1);
    expect(group.last.events).toContainEqual(
      expect.objectContaining({ type: "hold-released", releasedPast: [] }),
    );
    expect(
      positionAt(group.state.timeline, group.state.timeline.anchorMs),
    ).toBe(600_000);
  });

  it("does not take readiness for an earlier position as readiness for this one", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    const before = group.state.timeline.revision;
    group.command(A, { type: "seek", positionMs: 300_000 });

    // B's report was sent before it had seen the seek.
    group.ready(B, before).ready(A);
    expect(group.waiting()).toEqual([B]);
    expect(group.state.timeline.hold).not.toBeNull();
  });

  it("moves a paused group without holding it", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "seek", positionMs: 120_000 });
    expect(group.state.timeline.hold).toBeNull();
    expect(group.state.timeline.positionMs).toBe(120_000);
  });

  it("waits for a participant that has not caught up with a pause before starting", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    group.at(5_000).command(A, { type: "pause", positionMs: 4_000 });
    group.ready(A);

    group.at(5_100).command(A, { type: "play" });
    expect(group.state.timeline.hold?.reason).toBe("settling");
    expect(group.waiting()).toEqual([B]);

    group.ready(B);
    expect(isAdvancing(group.state.timeline)).toBe(true);
  });

  it("gives up on a participant that cannot get ready, and catches them up later", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    group.at(1_000).command(A, { type: "seek", positionMs: 50_000 });
    group.ready(A);

    group.at(1_000 + tuning.settleTimeoutMs - 1).tick();
    expect(group.state.timeline.hold).not.toBeNull();

    group.at(1_000 + tuning.settleTimeoutMs).tick();
    expect(group.state.timeline.hold).toBeNull();
    expect(group.last.events).toContainEqual(
      expect.objectContaining({ type: "hold-released", releasedPast: [B] }),
    );

    // Released past, B no longer holds anyone up — not even by stalling.
    group.report(B, "stalled");
    expect(group.state.timeline.hold).toBeNull();

    // Once B is ready at the group's current revision it counts again.
    group.ready(B);
    group.report(B, "stalled");
    expect(group.state.timeline.hold?.reason).toBe("buffering");
  });
});

describe("buffering", () => {
  it("freezes the group where it is while someone who stalled catches up", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    const start = group.state.timeline.anchorMs;

    group.now = start + 42_000;
    group.report(B, "stalled");
    expect(group.state.timeline.hold?.reason).toBe("buffering");
    expect(group.position()).toBe(42_000);

    group.now += 3_000;
    expect(group.position()).toBe(42_000);

    // Everyone repositions to the frozen point; the group resumes once all have.
    group.ready(A);
    expect(group.state.timeline.hold).not.toBeNull();
    group.ready(B);
    expect(group.state.timeline.hold).toBeNull();
    expect(
      positionAt(group.state.timeline, group.state.timeline.anchorMs),
    ).toBe(42_000);
  });

  it("does not hold a paused group for a stall", () => {
    const group = new Group().arrive(A).arrive(B);
    group.report(B, "stalled");
    expect(group.state.timeline.hold).toBeNull();
  });

  it("never waits for someone who has said they cannot take part", () => {
    const group = new Group().arrive(A).arrive(B);
    group.report(B, "away");
    group.command(A, { type: "play" });
    expect(isAdvancing(group.state.timeline)).toBe(true);
  });
});

describe("command ordering", () => {
  it("drops a client's own command that was overtaken in flight", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" }, 1);
    group.command(A, { type: "pause", positionMs: 0 }, 3);

    // Sequence 2 (a seek) arrives after 3.
    const late = group.command(A, { type: "seek", positionMs: 90_000 }, 2);
    expect(late.timelineChanged).toBe(false);
    expect(late.events).toContainEqual(
      expect.objectContaining({
        type: "command-ignored",
        reason: "stale-sequence",
      }),
    );
    expect(group.state.timeline.positionMs).toBe(0);
  });

  it("applies different clients' commands in arrival order", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" }, 50);
    // B's own sequence is independent of A's.
    group.command(B, { type: "pause", positionMs: 0 }, 1);
    expect(group.state.timeline.intent).toBe("paused");
  });

  it("ignores commands from someone who is not in the group", () => {
    const group = new Group().arrive(A);
    const result = applyCommand(group.state, B, 1, { type: "play" }, group.now);
    expect(result.timelineChanged).toBe(false);
    expect(result.events).toContainEqual(
      expect.objectContaining({ reason: "unknown-participant" }),
    );
  });
});

describe("changing title", () => {
  it("moves everyone to the start of the new title and waits for them all", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    group.at(20_000).command(A, {
      type: "setItem",
      itemId: NEXT_ITEM,
      fromItemId: ITEM,
    });

    expect(group.state.timeline.itemId).toBe(NEXT_ITEM);
    expect(group.state.timeline.positionMs).toBe(0);
    expect(group.state.timeline.hold?.deadline).toBe(
      group.now + tuning.itemSettleTimeoutMs,
    );
    expect(group.waiting().sort()).toEqual([A, B].sort());
  });

  it("does not skip two titles when two people pick 'next' at once", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "setItem", itemId: NEXT_ITEM, fromItemId: ITEM });

    // B's request was made while B was still on ITEM, asking for what it
    // believed came next.
    const second = group.command(B, {
      type: "setItem",
      itemId: AFTER_NEXT,
      fromItemId: ITEM,
    });
    expect(second.events).toContainEqual(
      expect.objectContaining({ reason: "item-changed" }),
    );
    expect(group.state.timeline.itemId).toBe(NEXT_ITEM);

    // And the same choice twice is simply agreement.
    const same = group.command(B, {
      type: "setItem",
      itemId: NEXT_ITEM,
      fromItemId: ITEM,
    });
    expect(same.timelineChanged).toBe(false);
  });
});

describe("participants", () => {
  it("does not stop the group for someone joining mid-film", () => {
    const group = new Group().arrive(A);
    group.command(A, { type: "play" });
    group.at(30_000);

    const [userId, clientId] = B.split(":") as [string, string];
    group.state = joinParticipant(
      group.state,
      { userId, clientId, displayName: "B" },
      group.now,
    ).state;
    group.state = setStreamOpen(group.state, B, true, group.now).state;
    group.report(B, "loading");
    expect(isAdvancing(group.state.timeline)).toBe(true);
    expect(group.waiting()).toEqual([]);

    // Once caught up, B is waited for like anyone else.
    group.ready(B);
    group.command(A, { type: "seek", positionMs: 0 });
    expect(group.waiting()).toContain(B);
  });

  it("treats two tabs of the same user as two participants", () => {
    const group = new Group().arrive("user-a:tab-1").arrive("user-a:tab-2");
    expect(group.state.participants.map((p) => p.key)).toEqual([
      "user-a:tab-1",
      "user-a:tab-2",
    ]);
  });

  it("keeps a reconnecting participant's place, but never waits for them", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    group.at(1_000).command(A, { type: "seek", positionMs: 10_000 });
    group.ready(A);

    group.state = setStreamOpen(group.state, B, false, group.now).state;
    group.tick();
    expect(group.state.participants.map((p) => p.key)).toContain(B);
    // B's dropped stream releases the hold rather than stalling everyone.
    expect(group.state.timeline.hold).toBeNull();
  });

  it("brings back a refreshed participant as the same person", () => {
    const group = new Group().arrive(A).arrive(B);
    group.state = setStreamOpen(group.state, B, false, group.now).state;

    group.at(5_000);
    const [userId, clientId] = B.split(":") as [string, string];
    const rejoin = joinParticipant(
      group.state,
      { userId, clientId, displayName: "B" },
      group.now,
    );
    expect(rejoin.events).toContainEqual(
      expect.objectContaining({ type: "participant-joined", rejoined: true }),
    );
    expect(rejoin.state.participants).toHaveLength(2);
  });

  it("removes a participant whose stream stays closed past the grace", () => {
    const group = new Group().arrive(A).arrive(B);
    group.state = setStreamOpen(group.state, B, false, group.now).state;

    group.at(tuning.disconnectGraceMs).tick();
    expect(group.state.participants).toHaveLength(2);

    group.at(tuning.disconnectGraceMs + 1).tick();
    expect(group.state.participants.map((p) => p.key)).toEqual([A]);
    expect(group.last.events).toContainEqual(
      expect.objectContaining({
        type: "participant-left",
        participantKey: B,
        reason: "disconnected",
      }),
    );
  });

  it("stops waiting for a participant that goes silent, then removes them", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });

    // A keeps its keepalive going; B's stream is open but B says nothing.
    group.at(tuning.staleAfterMs + 1).ready(A);
    group.command(A, { type: "seek", positionMs: 5_000 });
    group.ready(A);
    expect(group.state.participants.find((p) => p.key === B)?.presence).toBe(
      "unresponsive",
    );
    expect(isAdvancing(group.state.timeline)).toBe(true);

    group.at(tuning.expireAfterMs + 1).ready(A);
    group.tick();
    expect(group.state.participants.map((p) => p.key)).toEqual([A]);
  });

  it("lets the group go on when the person it was waiting for leaves", () => {
    const group = new Group().arrive(A).arrive(B);
    group.command(A, { type: "play" });
    group.command(A, { type: "seek", positionMs: 5_000 });
    group.ready(A);

    const left = removeParticipant(group.state, B, "left", group.now);
    expect(left.state.timeline.hold).toBeNull();
    expect(isAdvancing(left.state.timeline)).toBe(true);
  });
});
