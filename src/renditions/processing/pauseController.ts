/**
 * Suspending an encode without losing it.
 *
 * Cancelling an encode throws away everything it has done; for a two-hour 4K
 * ladder that is hours of work. A pause instead stops the encoder where it
 * stands with SIGSTOP and lets SIGCONT pick it up, so the process keeps its
 * memory, its open files and its position in the source.
 *
 * The limits are worth stating plainly, because they decide what callers may
 * promise:
 *
 * - A paused encoder still holds its file descriptors. That is what makes the
 *   resume seamless, and it is also why a pause cannot rescue an encode whose
 *   storage has been unmounted — those descriptors are already invalid, and no
 *   signal makes them valid again. Storage that disappears costs the in-flight
 *   title its progress no matter what; what pausing buys there is that the
 *   *queue* stops rather than burning through every remaining title against a
 *   drive that is not there.
 * - The process stays resident while paused. It holds its memory and its
 *   temporary files, so a pause is a pause, not a way to free the machine.
 */

export type PauseListener = (paused: boolean) => void;

export interface PauseController {
  readonly paused: boolean;
  /** Suspends. Idempotent: pausing a paused controller does nothing. */
  pause(): void;
  /** Resumes. Idempotent. */
  resume(): void;
  /**
   * Registers a listener and immediately reports the current state, so a
   * process that starts while already paused suspends itself rather than
   * running until the next change.
   */
  subscribe(listener: PauseListener): () => void;
}

export function createPauseController(
  initiallyPaused = false,
): PauseController {
  let paused = initiallyPaused;
  const listeners = new Set<PauseListener>();

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener(paused);
      } catch {
        // One child that has already exited must not stop the others from
        // being signalled.
      }
    }
  };

  return {
    get paused() {
      return paused;
    },
    pause() {
      if (paused) return;
      paused = true;
      emit();
    },
    resume() {
      if (!paused) return;
      paused = false;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(paused);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Keeps a spawned child suspended in step with a controller.
 *
 * Returns an unsubscribe function. Signalling a process that has already exited
 * throws, so every send is guarded: a child that finished between the pause
 * request and its delivery is not an error, it is a race that resolved the
 * better way.
 *
 * **There is no suspend on Windows.** `SIGSTOP` and `SIGCONT` are not among the
 * signals Node will deliver there — `process.kill` rejects them with
 * `ERR_UNKNOWN_SIGNAL` before they reach the process — and Windows exposes no
 * other way to suspend a process tree without native code. Before this, the
 * throw was swallowed by the `catch` above and the controller went on reporting
 * `paused: true` while the encoder ran at full speed: the queue said stopped,
 * the disk said otherwise, and an operator pausing to unplug a drive would have
 * been told it was safe. So the binding now refuses to be installed silently —
 * `onUnsupported` is called once, at bind time, and nothing is ever sent.
 *
 * Callers must treat that as what it is: a pause this host cannot honour. It is
 * a real gap, not a cosmetic one, and the honest options are to keep the
 * encoder running or to cancel it — not to claim it is asleep.
 */
export function bindChildToPauseController(
  child: { pid?: number | undefined; kill(signal: NodeJS.Signals): boolean },
  controller: PauseController,
  options: {
    /** Called once when this platform cannot suspend a process at all. */
    onUnsupported?: (reason: string) => void;
    /** Injected by tests; defaults to this host. */
    platform?: NodeJS.Platform;
  } = {},
): () => void {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    options.onUnsupported?.(
      "This platform has no signal that suspends a process, so the encoder cannot be paused where it stands.",
    );
    return () => {};
  }
  return controller.subscribe((paused) => {
    if (child.pid === undefined) return;
    try {
      child.kill(paused ? "SIGSTOP" : "SIGCONT");
    } catch {
      // Already gone.
    }
  });
}
