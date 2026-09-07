/** Invalidation only: canonical GET responses remain the sole task state. */
const listeners = new Set<() => void>();

export function signalTasksChanged(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeTasksChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
