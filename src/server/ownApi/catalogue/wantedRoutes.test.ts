// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import type { TmdbClient } from "../metadata/tmdbClient";
import { TmdbError } from "../metadata/tmdbClient";
import type { RouteContext, RouteDefinition } from "../api/router";
import { createWantedRoutes } from "./wantedRoutes";

export async function invokeWanted(
  route: RouteDefinition,
  body?: unknown,
  query = "",
  params = {},
) {
  let payload: unknown;
  const context = {
    request: {},
    response: {
      setHeader() {},
      writeHead() {},
      end(value: string) {
        payload = JSON.parse(value);
      },
    },
    requestId: "test",
    url: new URL(`http://localhost${route.path}${query}`),
    params,
    requirePrincipal: () => ({ userId: "admin", isAdministrator: true }),
    readJson: async () => body,
  } as unknown as RouteContext;
  await route.handle(context);
  return payload;
}
const pool = { query: vi.fn(), connect: vi.fn() } as unknown as DatabasePool;
describe("wanted API boundaries", () => {
  it("requires admin access on every route", () => {
    expect(
      createWantedRoutes(pool, undefined).every(
        (route) => route.access === "admin",
      ),
    ).toBe(true);
  });
  it("rejects malformed kind and page before contacting TMDB", async () => {
    const catalogue = vi.fn();
    const client = { catalogue } as unknown as TmdbClient;
    const route = createWantedRoutes(pool, client)[0]!;
    await expect(
      invokeWanted(route, undefined, "?kind=person"),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      invokeWanted(route, undefined, "?page=501"),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(catalogue).not.toHaveBeenCalled();
  });
  it("searches TV separately and returns TMDB artwork", async () => {
    const catalogue = vi.fn().mockResolvedValue({
      items: [
        {
          title: "Arcane",
          kind: "series",
          providerId: "94605",
          posterUrl: "https://image.tmdb.org/t/p/w185/a.jpg",
        },
      ],
      page: 2,
      totalPages: 3,
    });
    const result = await invokeWanted(
      createWantedRoutes(pool, { catalogue } as unknown as TmdbClient)[0]!,
      undefined,
      "?kind=tv&query=Arcane&page=2",
    );
    expect(catalogue).toHaveBeenCalledWith("tv", "Arcane", 2);
    expect(result).toMatchObject({
      data: { items: [{ title: "Arcane", kind: "series" }] },
    });
  });
  it("never sends a provider error URL to the browser", async () => {
    const catalogue = vi
      .fn()
      .mockRejectedValue(
        new TmdbError("unavailable", "https://provider/?api_key=secret"),
      );
    await expect(
      invokeWanted(
        createWantedRoutes(pool, { catalogue } as unknown as TmdbClient)[0]!,
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: "TMDB could not answer. Try again shortly.",
    });
  });
});
