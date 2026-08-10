/**
 * In-process fan-out for Party Watch state.
 *
 * Deliberately not a broker: a single media server owns its groups, and the
 * durable state lives in PostgreSQL, so the bus only has to reach the sockets
 * this process is holding open. If Seyirlik ever runs more than one API process,
 * this is the seam to replace with PostgreSQL LISTEN/NOTIFY or Redis — the
 * callers do not change.
 */

export interface SyncplayEvent {
  type: "state" | "members" | "closed" | "heartbeat";
  groupId: string;
  data: Record<string, unknown>;
}

export type SyncplaySubscriber = (event: SyncplayEvent) => void;

export interface SyncplayEventBus {
  subscribe(groupId: string, subscriber: SyncplaySubscriber): () => void;
  publish(event: SyncplayEvent): void;
  subscriberCount(groupId: string): number;
}

export function createSyncplayEventBus(): SyncplayEventBus {
  const subscribers = new Map<string, Set<SyncplaySubscriber>>();

  return {
    subscribe: (groupId, subscriber) => {
      const existing = subscribers.get(groupId) ?? new Set();
      existing.add(subscriber);
      subscribers.set(groupId, existing);

      return () => {
        const current = subscribers.get(groupId);
        if (!current) return;
        current.delete(subscriber);
        // Drop the key rather than leaving empty sets behind; groups are
        // created and abandoned freely.
        if (current.size === 0) subscribers.delete(groupId);
      };
    },

    publish: (event) => {
      for (const subscriber of subscribers.get(event.groupId) ?? []) {
        try {
          subscriber(event);
        } catch {
          // A broken client stream must not stop delivery to the others.
        }
      }
    },

    subscriberCount: (groupId) => subscribers.get(groupId)?.size ?? 0,
  };
}
