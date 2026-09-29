import { randomUUID } from "node:crypto";
import type {
  SyncplayGroupRecord,
  SyncplayRepository,
} from "./syncplayRepository";

/**
 * The repository contract without PostgreSQL, for tests and local harnesses.
 * It enforces the same newer-revision-only rule the SQL does.
 */
export function createMemorySyncplayRepository(): SyncplayRepository & {
  records: Map<string, SyncplayGroupRecord & { closed: boolean }>;
} {
  const records = new Map<string, SyncplayGroupRecord & { closed: boolean }>();

  return {
    records,

    create: async ({ name, ownerUserId, itemId }) => {
      const record = {
        id: randomUUID(),
        name,
        ownerUserId,
        itemId,
        revision: 0,
        isPlaying: false,
        positionMs: 0,
        positionUpdatedAt: Date.now(),
        closed: false,
      };
      records.set(record.id, record);
      return { ...record };
    },

    findOpen: async (groupId) => {
      const record = records.get(groupId);
      return record && !record.closed ? { ...record } : null;
    },

    saveTimeline: async (groupId, timeline) => {
      const record = records.get(groupId);
      if (!record || record.closed || record.revision >= timeline.revision) {
        return;
      }
      record.revision = timeline.revision;
      record.itemId = timeline.itemId;
      record.isPlaying = timeline.isPlaying;
      record.positionMs = Math.max(0, Math.round(timeline.positionMs));
      record.positionUpdatedAt = timeline.anchorMs;
    },

    close: async (groupId) => {
      const record = records.get(groupId);
      if (record) record.closed = true;
    },

    closeOpenExcept: async (keepIds) => {
      const closed: string[] = [];
      for (const record of records.values()) {
        if (!record.closed && !keepIds.includes(record.id)) {
          record.closed = true;
          closed.push(record.id);
        }
      }
      return closed;
    },
  };
}
