// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  dispositionFor,
  IMPORT_STATES,
  IMPORT_STRATEGIES,
  ImportTransitionError,
  IMPORTED_ROLES,
  isImported,
  isTerminal,
  MAX_IMPORT_ATTEMPTS,
  mayHaveDestination,
  mustPreserveSource,
  needsReconciliation,
  planImportRetry,
  retainsSourceBytes,
  TERMINAL_IMPORT_STATES,
  type ImportFailureClass,
  type ImportFileRole,
  type ImportState,
} from "./importState";

describe("the shape of an import", () => {
  it("runs a normal import to completion", () => {
    const path: ImportState[] = [
      "planned",
      "validating",
      "staging",
      "committing",
      "committed",
      "cleaning",
      "complete",
    ];
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index]!, path[index + 1]!)).toBe(true);
    }
  });

  it("lets a commit finish without any cleanup to do", () => {
    // Nothing to remove — a hardlink policy that retains the source — is not a
    // skipped step, it is the whole of cleanup for that strategy.
    expect(canTransition("committed", "complete")).toBe(true);
  });

  it("treats re-observing the same state as legal", () => {
    for (const state of IMPORT_STATES) {
      expect(canTransition(state, state)).toBe(true);
    }
  });

  it.each(TERMINAL_IMPORT_STATES)("lets nothing leave %s", (state) => {
    for (const other of IMPORT_STATES) {
      if (other === state) continue;
      expect(canTransition(state, other)).toBe(false);
    }
    expect(isTerminal(state)).toBe(true);
  });

  it("has no state that can reach nothing and is not terminal", () => {
    for (const state of IMPORT_STATES) {
      if (isTerminal(state)) continue;
      const reachable = IMPORT_STATES.filter(
        (other) => other !== state && canTransition(state, other),
      );
      expect(reachable.length).toBeGreaterThan(0);
    }
  });

  it("names both states when a transition is illegal", () => {
    expect(() => assertTransition("complete", "staging")).toThrow(
      ImportTransitionError,
    );
    expect(() => assertTransition("complete", "staging")).toThrow(
      /complete to staging/,
    );
    expect(() => assertTransition("planned", "validating")).not.toThrow();
  });
});

describe("what may be claimed about a filesystem that was not looked at", () => {
  it("never lets an in-flight commit be called failed", () => {
    /*
     * The invariant the whole vocabulary exists for. An activation that
     * reported an error may still have happened, so declaring it failed would
     * be a claim — source untouched, no destination — that nobody checked.
     */
    expect(canTransition("committing", "failed")).toBe(false);
  });

  it("only lets a commit be resolved by looking", () => {
    expect(canTransition("committing", "committed")).toBe(true);
    expect(canTransition("committing", "uncertain")).toBe(true);
    expect(canTransition("committing", "needs_attention")).toBe(true);
    // Not by giving up, and not by starting over on top of it.
    expect(canTransition("committing", "cancelled")).toBe(false);
    expect(canTransition("committing", "staging")).toBe(false);
    expect(canTransition("committing", "planned")).toBe(false);
  });

  it("lets reconciliation reach whatever the filesystem actually says", () => {
    for (const outcome of [
      "committed",
      "failed",
      "needs_attention",
      "staging",
    ] as const) {
      expect(canTransition("uncertain", outcome)).toBe(true);
    }
  });

  it("knows which states require looking before touching anything", () => {
    expect(needsReconciliation("committing")).toBe(true);
    expect(needsReconciliation("uncertain")).toBe(true);
    expect(needsReconciliation("failed")).toBe(false);
    expect(needsReconciliation("staging")).toBe(false);
  });

  it("knows every state in which a destination may exist", () => {
    // Anything that got as far as activating may have left one behind, and
    // reconciliation must not conclude an import never happened without
    // considering all of them.
    for (const state of [
      "committing",
      "committed",
      "cleaning",
      "complete",
      "uncertain",
    ] as const) {
      expect(mayHaveDestination(state)).toBe(true);
    }
    for (const state of [
      "planned",
      "validating",
      "staging",
      "failed",
    ] as const) {
      expect(mayHaveDestination(state)).toBe(false);
    }
  });

  it("lets a known failure be retried, because it is a claim that was checked", () => {
    expect(canTransition("failed", "planned")).toBe(true);
    expect(isTerminal("failed")).toBe(false);
  });
});

describe("the source is the only other copy of the bytes", () => {
  it("preserves the source everywhere except while cleaning up after a commit", () => {
    for (const state of IMPORT_STATES) {
      const preserved = mustPreserveSource(state);
      if (state === "cleaning" || state === "complete") {
        expect(preserved).toBe(false);
      } else {
        expect(preserved).toBe(true);
      }
    }
  });

  it("preserves the source through every unresolved outcome", () => {
    // The ones most tempting to clean up after, and the ones where the
    // destination is least proven.
    for (const state of [
      "failed",
      "uncertain",
      "committing",
      "needs_attention",
      "cancelled",
    ] as const) {
      expect(mustPreserveSource(state)).toBe(true);
    }
  });

  it("knows which strategies leave the source bytes behind", () => {
    expect(retainsSourceBytes("hardlink")).toBe(true);
    expect(retainsSourceBytes("copy")).toBe(true);
    // A move has already surrendered them; there is nothing left to retain.
    expect(retainsSourceBytes("move")).toBe(false);
    expect(IMPORT_STRATEGIES).toHaveLength(3);
  });
});

describe("what a failure means", () => {
  it.each([
    ["source-unstable", "retry"],
    ["source-locked", "retry"],
    ["destination-locked", "retry"],
    ["disk-full", "retry"],
    ["commit-ambiguous", "reconcile"],
    ["destination-occupied", "attention"],
    ["source-missing", "attention"],
    ["no-media-found", "attention"],
    ["name-unrepresentable", "attention"],
    ["permission-denied", "attention"],
    ["hardlink-unsupported", "terminal"],
    ["cross-volume", "terminal"],
    ["source-not-regular", "terminal"],
    ["path-escape", "terminal"],
    ["unknown", "terminal"],
  ] as const)("treats %s as %s", (failure, disposition) => {
    expect(dispositionFor(failure)).toBe(disposition);
  });

  it("never resolves an ambiguous commit by retrying it", () => {
    /*
     * A second activation on top of an unknown first one is exactly how one
     * import becomes two library objects.
     */
    const plan = planImportRetry("commit-ambiguous", 1);
    expect(plan.action).toBe("reconcile");
    expect(plan.delayMs).toBe(0);
  });

  it("does not ration reconciliation by attempt count", () => {
    // Reading reality is not an attempt; a row that needs looking at still
    // needs looking at on the tenth restart.
    for (const attempt of [1, 5, 50]) {
      expect(planImportRetry("commit-ambiguous", attempt).action).toBe(
        "reconcile",
      );
    }
  });

  it("retries a transient obstruction with a growing gap", () => {
    const first = planImportRetry("destination-locked", 1, 1_000);
    const second = planImportRetry("destination-locked", 2, 1_000);
    expect(first.action).toBe("retry");
    expect(second.delayMs).toBeGreaterThan(first.delayMs);
  });

  it("asks a person once the attempts are spent", () => {
    const spent = planImportRetry("source-locked", MAX_IMPORT_ATTEMPTS, 1_000);
    expect(spent.action).toBe("attention");
    expect(spent.detail).toContain(String(MAX_IMPORT_ATTEMPTS));
  });

  it("never asks to overwrite an occupied destination by trying harder", () => {
    // A file we did not import is not an obstacle to retry past.
    expect(planImportRetry("destination-occupied", 1).action).toBe("attention");
  });

  it("cannot loop, whatever the failure or the attempt count", () => {
    const classes: ImportFailureClass[] = [
      "source-missing",
      "source-unstable",
      "source-locked",
      "source-not-regular",
      "path-escape",
      "no-media-found",
      "destination-occupied",
      "destination-locked",
      "hardlink-unsupported",
      "cross-volume",
      "permission-denied",
      "disk-full",
      "name-unrepresentable",
      "commit-ambiguous",
      "unknown",
    ];
    for (const failure of classes) {
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        const plan = planImportRetry(failure, attempt);
        expect(["retry", "reconcile", "attention", "terminal"]).toContain(
          plan.action,
        );
        if (attempt >= MAX_IMPORT_ATTEMPTS) {
          expect(plan.action).not.toBe("retry");
        }
      }
    }
  });
});

describe("which files an import claims", () => {
  it.each([
    ["media", true],
    ["subtitle", true],
    ["metadata", true],
    ["artwork", false],
    ["sample", false],
    ["trailer", false],
    ["extra", false],
    ["ignored", false],
    ["unclaimed", false],
  ] as Array<[ImportFileRole, boolean]>)(
    "%s imported: %s",
    (role, imported) => {
      expect(isImported(role)).toBe(imported);
    },
  );

  it("keeps every role it does not import out of the imported set", () => {
    /*
     * `ignored` and `unclaimed` are both left alone but mean different things
     * — a file the policy recognises and declines, versus one it does not
     * recognise at all — and only the second is worth telling an operator
     * about. Neither is ever moved.
     */
    const roles: ImportFileRole[] = [
      "media",
      "subtitle",
      "metadata",
      "artwork",
      "sample",
      "trailer",
      "extra",
      "ignored",
      "unclaimed",
    ];
    expect(roles.filter(isImported)).toEqual(["media", "subtitle", "metadata"]);
    expect(IMPORTED_ROLES).toHaveLength(3);
  });
});
