import { beforeEach, expect, it, vi } from "vitest";
import { getTaskObservation } from "./mediaApi";
import { getMaintenanceTasks } from "./maintenanceApi";
const request = vi.fn();
vi.mock("../api/ownApi/client", () => ({
  ownApiClient: { request: (...args: unknown[]) => request(...args) },
}));
beforeEach(() => {
  request.mockReset();
});
it("reads a burst across bounded pages using the first page's observation boundary", async () => {
  const since = "2026-09-06T10:00:00.000Z";
  const observedAt = "2026-09-06T10:01:00.000Z";
  const rows = Array.from({ length: 451 }, (_, i) => ({
    id: String(i).padStart(6, "0"),
  }));
  request.mockImplementation(async (path: string) => {
    const query = new URL(path, "http://test").searchParams;
    expect(query.get("since")).toBe(since);
    expect(query.get("limit")).toBe("200");
    const start = query.has("after") ? Number(query.get("after")) + 1 : 0;
    const tasks = rows.slice(start, start + 200);
    return {
      tasks,
      next: tasks.length === 200 ? tasks.at(-1)!.id : null,
      observedAt: start === 0 ? observedAt : "2026-09-06T10:02:00.000Z",
    };
  });
  expect(await getTaskObservation(since)).toEqual({ tasks: rows, observedAt });
  expect(request).toHaveBeenCalledTimes(3);
});
it("rejects a partial observation when a later page fails", async () => {
  request
    .mockResolvedValueOnce({
      tasks: [{ id: "a" }],
      observedAt: "2026-09-06T10:00:00.000Z",
      next: "a",
    })
    .mockRejectedValueOnce(new Error("offline"));
  await expect(getTaskObservation()).rejects.toThrow("offline");
});
it("bounds exact maintenance ID reads and merges canonical responses", async () => {
  const taskIds = Array.from({ length: 201 }, (_, i) => String(i));
  request.mockImplementation(async (path: string) => {
    const ids = new URL(path, "http://test").searchParams
      .get("include")!
      .split(",");
    expect(ids.length).toBeLessThanOrEqual(100);
    return { tasks: ids.map((id) => ({ id })), queue: [] };
  });
  expect((await getMaintenanceTasks({ taskIds })).tasks).toHaveLength(201);
  expect(request).toHaveBeenCalledTimes(3);
});
