import {
  applyOperatorAction,
  applyStorageObservation,
  describeStorageHealth,
  demandsStop,
  initialStorageHealth,
  mayStartWork,
  observationForFailure,
  resumesAutomatically,
  type StorageHealthRecord,
  type StorageObservation,
} from "../../../renditions/processing/storageHealth";
import type { ProcessingFailureKind } from "../../../renditions/adaptive/epochs/failure";
import type { StorageWatchdog } from "../../../renditions/processing/storageWatchdog";
import { looksExternallyBacked } from "./recoveryPolicy";
import {
  satisfiesRecovery,
  type StorageIdentityProbe,
  type VolumeIdentity,
} from "../../../renditions/processing/storageIdentity";
import {
  healthFromIncident,
  type StorageIncidentRecord,
  type StorageIncidentStore,
} from "./storageIncidentStore";

/**
 * The one place that answers "may work start against this storage".
 *
 * It exists because the answer used to be computed in three places from two
 * different facts. The queue asked whether the media root was listable; the
 * encoder asked the watchdog at the moment something failed; and the startup
 * reconciler asked neither and simply requeued. On a drive whose USB bridge was
 * returning `EIO` while its directory metadata stayed perfectly cached, all
 * three said yes.
 *
 * So the question is asked once, of something that remembers. The guard holds
 * the state machine's verdict, keeps it in the database so a reboot cannot
 * clear it, and is consulted before anything spawns a process, starts a job,
 * scans a library or requeues an interrupted encode.
 *
 * What it deliberately does not do is look at the disk any harder than the
 * watchdog already does. A health checker that reads the volume to decide
 * whether the volume is healthy is a health checker that keeps a dying drive in
 * the kernel's retry path — the safety system has to *reduce* I/O, which is why
 * every method here is either memory, a database row, or the single `stat` and
 * `readdir` the watchdog was already doing.
 */

export type StorageGuardEvent =
  | "storage.available"
  | "storage.unavailable"
  | "storage.suspect"
  | "storage.quarantined"
  | "storage.recovery_pending"
  | "storage.recovered"
  /** An operator declared replacement storage authoritative. Never automatic. */
  | "storage.identity_adopted";

export interface StorageGuardLogger {
  /** Called once per transition. Never per poll and never per failed check. */
  transition(event: StorageGuardEvent, detail: string): void;
}

export interface StorageGuard {
  /** The current record. Memory; costs nothing. */
  readonly health: StorageHealthRecord;
  /** Whether new work may start. The gate every caller checks. */
  mayStartWork(): boolean;
  /** Whether whatever is running must be stopped. */
  demandsStop(): boolean;
  /** Whether the same volume returning is enough, with no operator involved. */
  resumesAutomatically(): boolean;
  /** One sentence, safe to show, matching what the page says. */
  describe(): string;
  /**
   * Folds the watchdog's latest availability into the health.
   *
   * Called from the watchdog's own poll rather than on a clock of its own, so
   * there is exactly one thing in the process touching the volume.
   */
  observeAvailability(available: boolean): Promise<StorageHealthRecord>;
  /** Folds a classified processing failure in. */
  reportFailure(input: {
    kind: ProcessingFailureKind;
    detail: string;
    processingJobId?: string;
  }): Promise<StorageHealthRecord>;
  /**
   * Records that work was found interrupted by a shutdown nobody observed.
   *
   * Parks rather than condemns: an unclean restart is evidence that the last
   * attempt's ending was not watched, which is a reason to ask before starting
   * a 4K encode against an external drive, not a reason to call the drive bad.
   */
  reportUncleanRestart(input: {
    detail: string;
    processingJobId?: string;
  }): Promise<StorageHealthRecord>;
  /**
   * The operator's cheap, non-destructive check.
   *
   * Reads directory metadata and the device identity. Nothing else — no media
   * is read, no checksum is taken, no benchmark is run. Verifying a suspect
   * drive by exercising it is how a verification becomes the next outage.
   */
  verify(acknowledgedBy?: string): Promise<{
    ok: boolean;
    detail: string;
    /**
     * How the pass was reached, so a page can never present a replacement as a
     * confirmed recovery of the original hardware.
     */
    outcome: "same-identity-verified" | "identity-unconfirmed" | "unavailable";
    health: StorageHealthRecord;
  }>;
  /** The operator's second, explicit press. Only ever follows a passing verify. */
  resume(acknowledgedBy?: string): Promise<StorageHealthRecord>;
  /**
   * Learns the volume's identity, if it is healthy and nothing is cached yet.
   *
   * Called before heavy work begins, so that a later fault has something to
   * record without anyone having to ask the failed device. A no-op in every
   * other state, which is what guarantees no probe ever follows a fault.
   */
  ensureIdentity(): Promise<VolumeIdentity | null>;
  /** What is on the incident row, and what was learned while healthy. */
  readonly identity: {
    recorded: VolumeIdentity | null;
    cached: VolumeIdentity | null;
  };
  /**
   * Adopts the volume currently present as the new authoritative identity.
   *
   * The deliberate, operator-only path for replacement hardware and for
   * incidents that never captured an identity. It is not "ignore identity": it
   * requires a *successful* probe of a volume that reports an authoritative
   * UUID, and it writes that UUID down as the thing future recoveries are
   * checked against. Without a UUID there is nothing to adopt and it refuses.
   */
  adopt(acknowledgedBy?: string): Promise<{
    ok: boolean;
    detail: string;
    adopted: VolumeIdentity | null;
    health: StorageHealthRecord;
  }>;
  /**
   * Whether policy allows heavy work to begin, on identity grounds.
   *
   * Separate from `mayStartWork`, which asks about the storage's *health*. This
   * asks whether enough is known about the volume to be able to quarantine it
   * usefully later — because an encode started against an unidentified external
   * disk is one whose eventual fault cannot be recorded against anything, and
   * whose recovery would then need the adoption flow for want of a UUID nobody
   * captured while it was easy.
   */
  identityPermitsWork(): { ok: true } | { ok: false; reason: string };
  /** Re-reads the persisted incident. Called at startup and after a DB outage. */
  reload(): Promise<StorageHealthRecord>;
  /** The open incident row, for the page. */
  incident(): Promise<StorageIncidentRecord | null>;
}

const EVENT_FOR_STATE: Readonly<
  Record<StorageHealthRecord["state"], StorageGuardEvent>
> = {
  healthy: "storage.available",
  unavailable: "storage.unavailable",
  suspect: "storage.suspect",
  quarantined: "storage.quarantined",
  "recovery-pending": "storage.recovery_pending",
};

export interface CreateStorageGuardOptions {
  /** The root this guard speaks for. The media root, in every deployment so far. */
  root: string;
  watchdog: Pick<StorageWatchdog, "poll" | "missingRoots">;
  incidents: StorageIncidentStore;
  /**
   * Asks the OS which volume is at the root. Metadata only; never reads media.
   *
   * Optional because a deployment without an implementation must still work —
   * it simply has no identity, and every identity-dependent decision then fails
   * closed rather than guessing.
   */
  identityProbe?: StorageIdentityProbe;
  logger?: StorageGuardLogger;
  now?: () => number;
}

export function createStorageGuard({
  root,
  watchdog,
  incidents,
  identityProbe,
  logger,
  now = Date.now,
}: CreateStorageGuardOptions): StorageGuard {
  let health = initialStorageHealth(root, now());
  /*
   * The state the row was last written with. Persisting only on change is what
   * keeps an idle healthy machine from writing a row every poll, and — more
   * importantly — keeps a five-minute outage from writing three hundred.
   */
  let persistedState: StorageHealthRecord["state"] | null = null;
  let persistedReason: string | null = null;
  /**
   * The volume the open incident was recorded against.
   *
   * Loaded from the row on `reload`, captured at the moment an incident opens,
   * and never replaced while the incident stands — replacing it would mean the
   * quarantine quietly starts describing whatever is mounted now.
   */
  let recordedIdentity: VolumeIdentity | null = null;
  /**
   * What this volume was, learned while it was still healthy.
   *
   * The distinction between this and `recordedIdentity` is the whole of the
   * second safety point. An earlier version captured identity "at the instant
   * health first leaves healthy", which sounded careful and was the opposite: a
   * hard `EIO` would launch `diskutil` at the device that had just returned it,
   * putting another process into the same kernel path the encoder was being
   * pulled out of. On the drive this exists for, that is how one bad region
   * became minutes of retries.
   *
   * So identity is learned in advance, while the volume is answering normally
   * and a probe costs nothing, and the cached value is what a quarantine is
   * recorded with. After a fault nothing asks the device anything.
   */
  let cachedHealthyIdentity: VolumeIdentity | null = null;

  /** Never throws: an identity that cannot be read is `null`, which fails closed. */
  const probeIdentity = async (): Promise<VolumeIdentity | null> => {
    if (!identityProbe) return null;
    try {
      return await identityProbe(root);
    } catch {
      return null;
    }
  };

  /**
   * Learns the volume's identity, but only while it is healthy.
   *
   * Idempotent and cheap: once cached it never probes again, so the ordinary
   * poll loop does not spawn a process. Refusing to run in any other state is
   * what guarantees no probe follows a fault.
   */
  const captureIdentityWhileHealthy =
    async (): Promise<VolumeIdentity | null> => {
      if (health.state !== "healthy") return cachedHealthyIdentity;
      if (cachedHealthyIdentity) return cachedHealthyIdentity;
      const identity = await probeIdentity();
      if (identity) cachedHealthyIdentity = identity;
      return cachedHealthyIdentity;
    };

  const announce = (previous: StorageHealthRecord["state"]): void => {
    if (previous === health.state) return;
    const event =
      health.state === "healthy" && previous !== "healthy"
        ? "storage.recovered"
        : EVENT_FOR_STATE[health.state];
    logger?.transition(event, `${root}: ${health.reason}`);
  };

  const persist = async (context?: {
    failureClass?: string | null;
    processingJobId?: string | null;
    acknowledgedBy?: string | null;
    identity?: VolumeIdentity | null;
    adoption?: { adoptedAtMs: number; supersededVolumeUuid: string | null };
  }): Promise<void> => {
    if (
      health.state === persistedState &&
      health.reason === persistedReason &&
      context?.acknowledgedBy === undefined &&
      context?.adoption === undefined
    ) {
      return;
    }
    try {
      await incidents.save(health, context ?? {});
      persistedState = health.state;
      persistedReason = health.reason;
    } catch (error) {
      /*
       * A database that cannot record the quarantine must not be allowed to
       * undo it. The in-memory verdict stands for this process either way, and
       * `persistedState` is left alone so the next transition tries again.
       *
       * This is the deliberately unsafe corner of the design and it is worth
       * naming: if the database is down *and* the process dies before it comes
       * back, the quarantine is lost. The mitigation is elsewhere — a worker
       * whose database is unavailable does not start encodes at all.
       */
      logger?.transition(
        EVENT_FOR_STATE[health.state],
        `${root}: could not record the storage incident (${
          error instanceof Error ? error.message : String(error)
        }). The block stands for this process.`,
      );
    }
  };

  const fold = async (
    observation: StorageObservation,
    context?: { failureClass?: string; processingJobId?: string },
  ): Promise<StorageHealthRecord> => {
    const previous = health.state;
    health = applyStorageObservation(health, observation, now());
    announce(previous);
    /*
     * The identity written with a new incident is the one already cached from
     * when the volume was healthy. Nothing is asked of the device here — this
     * path runs immediately after an `EIO`, and the correct amount of further
     * I/O to send a drive that has just failed a transfer is none.
     *
     * A fault with nothing cached records no identity at all, which is honest
     * and fails closed: recovery then needs the explicit adoption flow rather
     * than a guess.
     */
    let captured: VolumeIdentity | null = null;
    if (previous === "healthy" && health.state !== "healthy") {
      captured = cachedHealthyIdentity;
      if (captured) recordedIdentity = captured;
    }
    await persist({
      failureClass: context?.failureClass ?? null,
      processingJobId: context?.processingJobId ?? null,
      ...(captured ? { identity: captured } : {}),
    });
    return health;
  };

  return {
    get health() {
      return health;
    },

    mayStartWork: () => mayStartWork(health.state),
    demandsStop: () => demandsStop(health.state),
    resumesAutomatically: () => resumesAutomatically(health.state),
    describe: () => describeStorageHealth(health),

    async observeAvailability(available) {
      const record = await fold(
        available
          ? { kind: "ok" }
          : { kind: "absent", roots: [...watchdog.missingRoots] },
      );
      /*
       * Learned here, on a healthy poll, which is the only safe moment to ask.
       * Once cached this costs nothing, so the ordinary poll loop does not
       * spawn a process; and by the time anything fails the answer is already
       * known and the device is left alone.
       */
      if (available) await captureIdentityWhileHealthy();
      return record;
    },

    ensureIdentity: captureIdentityWhileHealthy,

    identityPermitsWork() {
      /*
       * A deployment with no probe at all cannot satisfy this rule and must not
       * be held hostage by it. macOS supplies one; a Linux host has no
       * `diskutil`, and blocking every encode there would be enforcing a policy
       * by disabling the product.
       */
      if (!identityProbe) return { ok: true as const };

      const identity = cachedHealthyIdentity;
      /*
       * The rule is scoped to physical external media, deliberately and
       * narrowly. That is the storage that can fail the way this system exists
       * to survive; a disk image is a file, and holding the E2E suite for want
       * of a UUID on a synthetic volume would be enforcing the rule where it
       * buys nothing.
       */
      if (identity && identity.medium !== "physical-external") {
        return { ok: true as const };
      }
      if (identity?.volumeUuid) return { ok: true as const };

      if (identity) {
        return {
          ok: false as const,
          reason:
            "This external volume did not report a durable identity, so a fault here could not be recorded against it. Processing is held until it can be identified.",
        };
      }

      /*
       * The probe found nothing at all, so the medium is unknown. The path is
       * the only remaining evidence, and it is used in the cautious direction
       * only — note that the synthetic images the tests mount live under a
       * temporary directory rather than `/Volumes`, so they are unaffected.
       */
      if (looksExternallyBacked(root)) {
        return {
          ok: false as const,
          reason:
            "The identity of this external volume could not be established, so processing is held rather than started against storage that cannot be identified.",
        };
      }
      return { ok: true as const };
    },

    get identity() {
      return { recorded: recordedIdentity, cached: cachedHealthyIdentity };
    },

    reportFailure: ({ kind, detail, processingJobId }) =>
      fold(observationForFailure(kind, detail), {
        failureClass: kind,
        ...(processingJobId ? { processingJobId } : {}),
      }),

    reportUncleanRestart: ({ detail, processingJobId }) =>
      fold(
        { kind: "unclean-restart", detail },
        {
          failureClass: "unclean-restart",
          ...(processingJobId ? { processingJobId } : {}),
        },
      ),

    async verify(acknowledgedBy) {
      /*
       * Two questions, and the second one is the one that used to be missing.
       *
       * "Does something answer at this path" is the watchdog's poll, and it was
       * once all this asked — which meant attaching *any* volume at the
       * quarantined path passed verification. A disk image named `Expansion`
       * did exactly that during testing.
       *
       * "Is it the same volume" is the identity check, and for a hard
       * quarantine it is required. This is also the one moment a probe is
       * appropriate: the operator has repaired or reconnected the hardware and
       * is asking about it, so the device is no longer one that just failed a
       * transfer under an encoder.
       *
       * There is deliberately no flag here that means "ignore identity". A
       * volume that cannot be matched is not verified, and the way forward is
       * the explicit `adopt` operation, which records a new authoritative UUID
       * rather than waving the question away.
       */
      const available = await watchdog.poll();
      const previous = health.state;
      const needsIdentity =
        previous === "quarantined" || previous === "suspect";

      if (!available) {
        const detail = `${watchdog.missingRoots.join(", ") || "The volume"} did not answer.`;
        health = applyOperatorAction(
          health,
          { kind: "verify-failed", detail },
          now(),
        );
        announce(previous);
        await persist({
          acknowledgedBy: acknowledgedBy ?? null,
          failureClass: "verification-failed",
        });
        return { ok: false, detail, outcome: "unavailable" as const, health };
      }

      if (!needsIdentity) {
        /*
         * `recovery-pending` from an unclean restart has no fault on record and
         * no recorded identity to match, so the metadata check is the whole of
         * it. Requiring identity here would trap a deployment with no probe on
         * a hold that never implied anything was wrong with the disk.
         */
        const detail = "The volume answered a metadata check.";
        health = applyOperatorAction(
          health,
          { kind: "verify-passed", detail },
          now(),
        );
        announce(previous);
        await persist({ acknowledgedBy: acknowledgedBy ?? null });
        return {
          ok: true,
          detail,
          outcome: "same-identity-verified" as const,
          health,
        };
      }

      const current = await probeIdentity();
      const verdict = satisfiesRecovery(recordedIdentity, current);
      const detail = verdict.ok
        ? `The volume answered a metadata check and is the same volume that was quarantined${
            current?.deviceNode ? ` (currently ${current.deviceNode})` : ""
          }.`
        : verdict.reason;

      health = applyOperatorAction(
        health,
        verdict.ok
          ? { kind: "verify-passed", detail }
          : { kind: "verify-failed", detail },
        now(),
      );
      announce(previous);
      await persist({
        acknowledgedBy: acknowledgedBy ?? null,
        failureClass: verdict.ok ? null : "verification-failed",
      });
      return {
        ok: verdict.ok,
        detail,
        outcome: verdict.ok
          ? ("same-identity-verified" as const)
          : ("identity-unconfirmed" as const),
        health,
      };
    },

    async adopt(acknowledgedBy) {
      /*
       * Adoption is what replaces the old "accept unverified identity" flag, and
       * the difference is not cosmetic. That flag meant "the probe failed, carry
       * on regardless", which is a way of switching fail-closed off. This means
       * "there is a volume here, it has told me what it is, and an operator says
       * this is now the storage" — so the system ends up knowing *more* than
       * before, not less, and every later check is an ordinary strict one
       * against the newly recorded UUID.
       *
       * It is therefore refused, not softened, when the current volume cannot
       * identify itself. There is nothing to adopt.
       */
      const available = await watchdog.poll();
      if (!available) {
        return {
          ok: false,
          detail: `${watchdog.missingRoots.join(", ") || "The volume"} did not answer, so there is nothing to adopt.`,
          adopted: null,
          health,
        };
      }

      const current = await probeIdentity();
      if (!current || current.volumeUuid === null) {
        return {
          ok: false,
          detail:
            "The volume present did not report an identity, so it cannot be adopted. Recovery stays closed.",
          adopted: null,
          health,
        };
      }

      const previousIdentity = recordedIdentity;
      const previous = health.state;
      recordedIdentity = current;
      /*
       * The cache is replaced too. This is now the storage, so a later fault
       * must record *this* volume rather than the one that was taken away.
       */
      cachedHealthyIdentity = current;

      const detail = previousIdentity?.volumeUuid
        ? `An operator adopted replacement storage. The previous volume was not recovered.`
        : `An operator adopted this storage as the recovery identity for a quarantine that had none recorded.`;

      health = applyOperatorAction(
        health,
        { kind: "verify-passed", detail },
        now(),
      );
      announce(previous);
      /*
       * Recorded as adoption rather than verification, and the superseded UUID
       * is kept. "This drive was replaced on the 3rd" is exactly what somebody
       * reading the history a year later needs, and it is the one fact a
       * successful recovery would otherwise erase.
       */
      await persist({
        acknowledgedBy: acknowledgedBy ?? null,
        identity: current,
        adoption: {
          adoptedAtMs: now(),
          supersededVolumeUuid: previousIdentity?.volumeUuid ?? null,
        },
      });
      logger?.transition(
        "storage.identity_adopted",
        `${root}: ${detail} Now ${current.volumeUuid}.`,
      );
      return { ok: true, detail, adopted: current, health };
    },

    async resume(acknowledgedBy) {
      const previous = health.state;
      health = applyOperatorAction(
        health,
        { kind: "resume", detail: "The operator confirmed the storage." },
        now(),
      );
      announce(previous);
      await persist({ acknowledgedBy: acknowledgedBy ?? null });
      return health;
    },

    async reload() {
      /*
       * Fails closed, and this is the one place in the file where that choice is
       * load-bearing.
       *
       * A guard is constructed `healthy` — it has to be, or every process would
       * announce an outage on startup — and `reload` is what replaces that
       * assumption with the recorded truth. If the read throws and the failure
       * is swallowed, the assumption *stands*, and a process comes up believing
       * a quarantined volume is fine. That is the original defect wearing a
       * different hat: concluding storage is healthy from the absence of
       * evidence rather than from evidence.
       *
       * So a read that fails blocks instead. The cost is bounded and small: the
       * worker retries every five seconds while it is held, so a transient
       * database blip costs a few seconds of not starting new work, and never
       * costs a wrong answer in the dangerous direction.
       */
      let incident: Awaited<ReturnType<typeof incidents.findOpen>>;
      try {
        incident = await incidents.findOpen(root);
      } catch (error) {
        health = {
          ...health,
          state: "recovery-pending",
          reason: `The storage incident record could not be read, so work is held until it can. ${
            error instanceof Error ? error.message : String(error)
          }`,
          changedAtMs: now(),
          verifiedAtMs: null,
        };
        logger?.transition(
          "storage.recovery_pending",
          `${root}: ${health.reason}`,
        );
        return health;
      }
      health = healthFromIncident(root, incident, now());
      recordedIdentity = incident?.identity ?? null;
      persistedState = incident ? health.state : null;
      persistedReason = incident ? health.reason : null;
      if (!mayStartWork(health.state)) {
        logger?.transition(
          EVENT_FOR_STATE[health.state],
          `${root}: ${health.reason} (restored from the incident record)`,
        );
      }
      return health;
    },

    incident: () => incidents.findOpen(root),
  };
}

/**
 * A guard that permits everything, for the paths that have no storage to guard.
 *
 * Tests and the offline CLI construct runners without a runtime around them,
 * and an optional guard threaded through every call site would be an `if` at
 * each one — which is precisely the shape that let three call sites disagree.
 */
export function createPermissiveStorageGuard(root = "/"): StorageGuard {
  const health = initialStorageHealth(root, Date.now());
  return {
    get health() {
      return health;
    },
    mayStartWork: () => true,
    demandsStop: () => false,
    resumesAutomatically: () => true,
    describe: () => describeStorageHealth(health),
    observeAvailability: async () => health,
    reportFailure: async () => health,
    reportUncleanRestart: async () => health,
    verify: async () => ({
      ok: true,
      detail: "Not guarded.",
      outcome: "same-identity-verified" as const,
      health,
    }),
    ensureIdentity: async () => null,
    identityPermitsWork: () => ({ ok: true as const }),
    get identity() {
      return { recorded: null, cached: null };
    },
    adopt: async () => ({
      ok: false,
      detail: "Not guarded.",
      adopted: null,
      health,
    }),
    resume: async () => health,
    reload: async () => health,
    incident: async () => null,
  };
}
