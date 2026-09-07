import { expect, it, vi } from "vitest";
import { signalTasksChanged, subscribeTasksChanged } from "./tasksChanged";
it("invalidates multiple subscribers without retaining task state", () => {
  const a = vi.fn();
  const b = vi.fn();
  const offA = subscribeTasksChanged(a);
  const offB = subscribeTasksChanged(b);
  signalTasksChanged();
  expect(a).toHaveBeenCalledExactlyOnceWith();
  expect(b).toHaveBeenCalledExactlyOnceWith();
  offA();
  offA();
  signalTasksChanged();
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(2);
  offB();
});
