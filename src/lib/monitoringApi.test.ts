import { afterEach, expect, it, vi } from "vitest";
import { ownApiClient } from "../api/ownApi/client";
import { listSeries } from "./monitoringApi";
afterEach(() => vi.restoreAllMocks());
it("adapts native catalogue names and follows every page", async () => {
  const request = vi
    .spyOn(ownApiClient, "requestCollection")
    .mockResolvedValueOnce({
      data: [{ id: "arcane", title: "Arcane", productionYear: 2021 }],
      pagination: { limit: 200, nextCursor: "next" },
      requestId: "1",
    })
    .mockResolvedValueOnce({
      data: [{ id: "andor", title: "Andor" }],
      pagination: { limit: 200, nextCursor: null },
      requestId: "2",
    });
  expect(await listSeries()).toEqual([
    { Id: "arcane", Name: "Arcane", ProductionYear: 2021 },
    { Id: "andor", Name: "Andor", ProductionYear: undefined },
  ]);
  expect(request).toHaveBeenLastCalledWith("/series?limit=200&cursor=next");
});
