/**
 * A real filesystem, a faithful in-memory record, and a way to break either.
 *
 * Fault injection happens at the filesystem boundary rather than through
 * permissions, because an elevated Windows token ignores a deny ACE often
 * enough that a test built on one proves nothing. Wrapping the operation is
 * deterministic on every host.
 *
 * The in-memory repository reproduces the two properties the real schema
 * enforces — a conditional state write, and one committed file per destination
 * — so a unit test exercises the same semantics the database does. That the
 * database really enforces them is proven separately, against PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import type {
  CreateImportInput,
  ImportEvent,
  ImportFilePatch,
  ImportFileRecord,
  ImportFileState,
  ImportPatch,
  ImportRecord,
  ImportRepository,
  PlannedImportFile,
} from "./importRepository";
import { DestinationAlreadyCommittedError } from "./importRepository";
import type { ImportOperations } from "./importOperations";
import type { ImportState, ImportStrategy } from "./importState";

export interface MemoryRepository extends ImportRepository {
  /** Every state the import passed through, for asserting on the trail. */
  trail(importId: string): string[];
}

export function createMemoryRepository(): MemoryRepository {
  const imports = new Map<string, ImportRecord & { targetItemId?: string }>();
  const files = new Map<string, ImportFileRecord>();
  const events: Array<ImportEvent & { importId: string }> = [];

  function record(
    importId: string,
    fromState: string,
    toState: string,
    failureClass?: string,
    detail?: string,
  ): void {
    events.push({
      importId,
      fromState,
      toState,
      ...(failureClass ? { failureClass } : {}),
      ...(detail ? { detail } : {}),
      atMs: Date.now(),
    });
  }

  const repository: MemoryRepository = {
    async create(input: CreateImportInput) {
      const id = randomUUID();
      const now = Date.now();
      const created: ImportRecord = {
        id,
        ...(input.acquisitionId ? { acquisitionId: input.acquisitionId } : {}),
        idempotencyKey: `seyirlik-import-${id}`,
        state: "planned",
        targetKind: input.target.kind,
        targetTitle: input.target.title,
        sourceRoot: input.sourceRoot,
        libraryRoot: input.libraryRoot,
        sourceRelative: input.sourceRelative,
        attempt: 0,
        createdAtMs: now,
        updatedAtMs: now,
      };
      imports.set(id, created);
      record(id, "", "planned", undefined, "Import planned.");
      return created;
    },

    async get(id) {
      return imports.get(id) ?? null;
    },

    async update(id, expectedState, patch: ImportPatch, detail) {
      const existing = imports.get(id);
      // The conditional write. A second worker holding the same row sees the
      // state has moved, matches nothing, and stops.
      if (!existing || existing.state !== expectedState) return false;
      const next: ImportRecord = {
        ...existing,
        state: (patch.state ?? existing.state) as ImportState,
        ...(patch.strategy ? { strategy: patch.strategy } : {}),
        attempt: patch.attempt ?? existing.attempt,
        ...(patch.failureClass !== undefined ||
        patch.failureDetail !== undefined
          ? {
              ...(patch.failureClass
                ? { failureClass: patch.failureClass }
                : {}),
              ...(patch.failureDetail
                ? { failureDetail: patch.failureDetail }
                : {}),
            }
          : {}),
        ...(patch.committed ? { committedAtMs: Date.now() } : {}),
        updatedAtMs: Date.now(),
      };
      imports.set(id, next);
      if (patch.state && patch.state !== expectedState) {
        record(
          id,
          expectedState,
          patch.state,
          patch.failureClass ?? undefined,
          detail,
        );
      }
      return true;
    },

    async addFiles(importId, planned: readonly PlannedImportFile[]) {
      const created: ImportFileRecord[] = [];
      for (const file of planned) {
        const row: ImportFileRecord = {
          id: randomUUID(),
          importId,
          role: file.role,
          sourceRelative: file.sourceRelative,
          ...(file.destinationRelative
            ? { destinationRelative: file.destinationRelative }
            : {}),
          ...(file.destinationKey
            ? { destinationKey: file.destinationKey }
            : {}),
          state: "planned",
          ...(file.sizeBytes === undefined
            ? {}
            : { sizeBytes: file.sizeBytes }),
          ...(file.sourceMtimeMs === undefined
            ? {}
            : { sourceMtimeMs: file.sourceMtimeMs }),
        };
        files.set(row.id, row);
        created.push(row);
      }
      return created;
    },

    async listFiles(importId) {
      return [...files.values()]
        .filter((file) => file.importId === importId)
        .sort((a, b) => a.sourceRelative.localeCompare(b.sourceRelative));
    },

    async updateFile(
      fileId,
      expectedState: ImportFileState,
      patch: ImportFilePatch,
      detail,
    ) {
      const existing = files.get(fileId);
      if (!existing || existing.state !== expectedState) return false;
      const next: ImportFileRecord = {
        ...existing,
        state: (patch.state ?? existing.state) as ImportFileState,
        ...(patch.strategy ? { strategy: patch.strategy } : {}),
        ...(patch.destinationIdentity
          ? { destinationIdentity: patch.destinationIdentity }
          : {}),
        ...(patch.failureClass ? { failureClass: patch.failureClass } : {}),
        ...(patch.failureDetail ? { failureDetail: patch.failureDetail } : {}),
      };
      files.set(fileId, next);
      if (patch.state && patch.state !== expectedState) {
        record(
          existing.importId,
          expectedState,
          patch.state,
          patch.failureClass ?? undefined,
          detail,
        );
      }
      return true;
    },

    async commitFile(
      fileId,
      expectedState: ImportFileState,
      identity,
      strategy: ImportStrategy,
    ) {
      const existing = files.get(fileId);
      if (!existing) return false;
      // The unique index, in miniature: one committed file per destination,
      // across every import.
      const clash = [...files.values()].find(
        (file) =>
          file.id !== fileId &&
          file.state === "committed" &&
          file.destinationKey !== undefined &&
          file.destinationKey === existing.destinationKey,
      );
      if (clash) {
        throw new DestinationAlreadyCommittedError(
          existing.destinationKey ?? "(unknown)",
        );
      }
      return repository.updateFile(
        fileId,
        expectedState,
        { state: "committed", destinationIdentity: identity, strategy },
        "Destination activated.",
      );
    },

    async findCommittedDestination(destinationKey) {
      return (
        [...files.values()].find(
          (file) =>
            file.state === "committed" &&
            file.destinationKey === destinationKey,
        ) ?? null
      );
    },

    async list() {
      return [...imports.values()];
    },

    async listActive() {
      return [...imports.values()].filter(
        (row) => !["complete", "cancelled", "failed"].includes(row.state),
      );
    },

    async listUncertain() {
      return [...imports.values()].filter((row) =>
        ["committing", "uncertain"].includes(row.state),
      );
    },

    async detail(id) {
      const row = imports.get(id);
      if (!row) return null;
      return {
        record: row,
        files: await repository.listFiles(id),
        events: events.filter((event) => event.importId === id),
      };
    },

    trail(importId) {
      return events
        .filter((event) => event.importId === importId)
        .map((event) => event.toState);
    },
  };

  return repository;
}

/** Which operation to break, and how. */
export interface Fault {
  readonly operation: keyof ImportOperations;
  /** Which call of that operation, counting from one. */
  readonly onCall?: number;
  readonly code?: string;
  /**
   * Throws *after* the real operation has taken effect.
   *
   * The crash that matters: the filesystem did the work and the process died
   * before it could record that it had.
   */
  readonly afterEffect?: boolean;
}

export class SimulatedCrash extends Error {
  constructor(operation: string) {
    super(`Simulated crash during ${operation}.`);
    this.name = "SimulatedCrash";
  }
}

/**
 * Wraps real operations so one of them can be made to fail on demand.
 *
 * `afterEffect` is the interesting mode. It lets the underlying call happen
 * and then throws, which is the only way to reproduce a process dying between
 * a filesystem change and the record of it.
 */
export function withFault(
  operations: ImportOperations,
  fault: Fault | null,
): ImportOperations {
  const counts = new Map<string, number>();
  const wrapped: Record<string, unknown> = {
    sourceRoot: operations.sourceRoot,
    libraryRoot: operations.libraryRoot,
  };

  for (const name of Object.keys(operations) as Array<keyof ImportOperations>) {
    const original = operations[name];
    if (typeof original !== "function") continue;
    wrapped[name] = async (...args: unknown[]) => {
      const shouldFail = fault !== null && fault.operation === name;
      if (shouldFail) {
        const seen = (counts.get(name) ?? 0) + 1;
        counts.set(name, seen);
        if (seen === (fault.onCall ?? 1)) {
          if (!fault.afterEffect) {
            const error = new SimulatedCrash(name);
            if (fault.code) Object.assign(error, { code: fault.code });
            throw error;
          }
          const result = await (
            original as (...a: unknown[]) => Promise<unknown>
          ).apply(operations, args);
          const error = new SimulatedCrash(name);
          if (fault.code) Object.assign(error, { code: fault.code });
          Object.assign(error, { result });
          throw error;
        }
      }
      return (original as (...a: unknown[]) => Promise<unknown>).apply(
        operations,
        args,
      );
    };
  }

  return wrapped as unknown as ImportOperations;
}
