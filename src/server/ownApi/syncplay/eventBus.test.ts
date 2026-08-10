import { describe, expect, it, vi } from "vitest";
import { createSyncplayEventBus, type SyncplayEvent } from "./eventBus";

function event(groupId: string): SyncplayEvent {
  return { type: "state", groupId, data: { isPlaying: true } };
}

describe("syncplay event bus", () => {
  it("delivers an event to every subscriber of that group", () => {
    const bus = createSyncplayEventBus();
    const first = vi.fn();
    const second = vi.fn();

    bus.subscribe("group-1", first);
    bus.subscribe("group-1", second);
    bus.publish(event("group-1"));

    expect(first).toHaveBeenCalledWith(event("group-1"));
    expect(second).toHaveBeenCalledWith(event("group-1"));
  });

  it("does not leak events between groups", () => {
    const bus = createSyncplayEventBus();
    const other = vi.fn();

    bus.subscribe("group-2", other);
    bus.publish(event("group-1"));

    expect(other).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe and forgets the group", () => {
    const bus = createSyncplayEventBus();
    const subscriber = vi.fn();

    const unsubscribe = bus.subscribe("group-1", subscriber);
    unsubscribe();
    bus.publish(event("group-1"));

    expect(subscriber).not.toHaveBeenCalled();
    expect(bus.subscriberCount("group-1")).toBe(0);
  });

  it("keeps delivering to healthy subscribers when one throws", () => {
    const bus = createSyncplayEventBus();
    const healthy = vi.fn();

    bus.subscribe("group-1", () => {
      throw new Error("this stream is already closed");
    });
    bus.subscribe("group-1", healthy);

    expect(() => bus.publish(event("group-1"))).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
  });

  it("tolerates publishing to a group nobody is watching", () => {
    const bus = createSyncplayEventBus();
    expect(() => bus.publish(event("nobody"))).not.toThrow();
  });

  it("unsubscribing one of several leaves the rest connected", () => {
    const bus = createSyncplayEventBus();
    const staying = vi.fn();

    const leave = bus.subscribe("group-1", vi.fn());
    bus.subscribe("group-1", staying);
    leave();

    expect(bus.subscriberCount("group-1")).toBe(1);
    bus.publish(event("group-1"));
    expect(staying).toHaveBeenCalledOnce();
  });
});
