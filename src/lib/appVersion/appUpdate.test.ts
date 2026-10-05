import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RUNNING_BUILD,
  applyAppUpdate,
  checkForAppUpdate,
  getAppUpdateState,
  purgeStaleCaches,
  resetAppUpdateForTests,
} from "./appUpdate";
import { describeBuild, readBuildIdFromHtml } from "./buildInfo";

const NEWER = {
  version: "2026.10.06 · abcdef1",
  buildId: "abcdef1-newer",
  commit: "abcdef1234567",
  builtAt: "2026-10-06T00:00:00.000Z",
};

function shell(buildId: string) {
  return `<!doctype html><html><head><meta name="seyirlik-build" content="${buildId}"></head></html>`;
}

/** A Cache Storage holding whole responses, keyed by cache then URL. */
function fakeCacheStorage(contents: Record<string, Record<string, string>>) {
  const store = new Map(
    Object.entries(contents).map(([name, entries]) => [
      name,
      new Map(Object.entries(entries)),
    ]),
  );
  return {
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
    open: async (name: string) => {
      const entries = store.get(name) ?? new Map<string, string>();
      return {
        keys: async () => [...entries.keys()].map((url) => new Request(url)),
        match: async (request: Request) => {
          const body = entries.get(request.url);
          return body === undefined ? undefined : new Response(body);
        },
      };
    },
    names: () => [...store.keys()],
  };
}

function serveLiveBuild(build: object | null) {
  const fetchMock = vi.fn(async () =>
    build
      ? new Response(JSON.stringify(build), { status: 200 })
      : new Response("", { status: 404 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("build identity", () => {
  it("names the date and commit, and marks a dirty tree", () => {
    const build = describeBuild({
      commit: "2358815aaaaaaaa",
      dirty: true,
      builtAt: new Date("2026-10-05T12:00:00Z"),
    });
    expect(build.version).toBe("2026.10.05 · 2358815+dirty");
    expect(build.buildId).toMatch(/^2358815\+dirty-/);
  });

  it("still names a build made without a repository", () => {
    const build = describeBuild({
      commit: null,
      dirty: false,
      builtAt: new Date("2026-10-05T12:00:00Z"),
    });
    expect(build.version).toBe("2026.10.05");
    expect(build.buildId).toMatch(/^nogit-/);
  });

  it("reads the build back out of index.html", () => {
    expect(readBuildIdFromHtml(shell("abc-1"))).toBe("abc-1");
    expect(readBuildIdFromHtml("<html></html>")).toBeNull();
  });
});

describe("app update", () => {
  const reload = vi.fn();

  beforeEach(() => {
    resetAppUpdateForTests();
    vi.stubGlobal("location", { ...window.location, reload });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    reload.mockReset();
  });

  it("offers nothing while the live build is the running one", async () => {
    serveLiveBuild(RUNNING_BUILD);
    expect(await checkForAppUpdate()).toBeNull();
    expect(getAppUpdateState()).toEqual({ status: "current" });
  });

  it("offers nothing when the live build cannot be learned", async () => {
    serveLiveBuild(null);
    expect(await checkForAppUpdate()).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await checkForAppUpdate()).toBeNull();
    expect(getAppUpdateState()).toEqual({ status: "current" });
  });

  it("offers a newer live build, asked for past every cache", async () => {
    const fetchMock = serveLiveBuild(NEWER);
    expect(await checkForAppUpdate()).toEqual(NEWER);
    expect(getAppUpdateState()).toEqual({ status: "available", latest: NEWER });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/version\.json\?t=\d+$/),
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("keeps downloaded titles and a precache already on the new build", async () => {
    const storage = fakeCacheStorage({
      "seyirlik-offline-v1": { "https://x/ownAPI/v1/a": "film" },
      "workbox-precache-v2-https://x/": {
        "https://x/index.html?__WB_REVISION__=2": shell(NEWER.buildId),
      },
      "workbox-runtime-old": { "https://x/a.js": "old" },
    });
    vi.stubGlobal("caches", storage);

    expect(await purgeStaleCaches(NEWER.buildId)).toEqual([
      "workbox-runtime-old",
    ]);
    expect(storage.names()).toEqual([
      "seyirlik-offline-v1",
      "workbox-precache-v2-https://x/",
    ]);
  });

  it("drops a precache that could still serve the old shell", async () => {
    const storage = fakeCacheStorage({
      "seyirlik-offline-v1": {},
      // A new worker waiting: both revisions side by side.
      "workbox-precache-v2-https://x/": {
        "https://x/index.html?__WB_REVISION__=1": shell("old"),
        "https://x/index.html?__WB_REVISION__=2": shell(NEWER.buildId),
      },
    });
    vi.stubGlobal("caches", storage);

    await purgeStaleCaches(NEWER.buildId);
    expect(storage.names()).toEqual(["seyirlik-offline-v1"]);
  });

  it("brings the new worker in before clearing caches, then reloads", async () => {
    serveLiveBuild(NEWER);
    await checkForAppUpdate();
    const order: string[] = [];
    const storage = fakeCacheStorage({ "workbox-precache-v2-x": {} });
    vi.stubGlobal("caches", {
      ...storage,
      keys: async () => {
        order.push("caches");
        return storage.keys();
      },
    });
    const registration = {
      installing: null,
      waiting: null,
      update: vi.fn(async () => {
        order.push("update");
      }),
    };
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { getRegistration: async () => registration },
    });
    reload.mockImplementation(() => order.push("reload"));

    await applyAppUpdate();

    expect(order).toEqual(["update", "caches", "reload"]);
    expect(storage.names()).toEqual([]);
    expect(getAppUpdateState()).toEqual({ status: "applying", latest: NEWER });
  });

  it("still reloads when the worker cannot be updated", async () => {
    serveLiveBuild(NEWER);
    await checkForAppUpdate();
    vi.stubGlobal("caches", fakeCacheStorage({}));
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: {
        getRegistration: async () => {
          throw new Error("SecurityError");
        },
      },
    });

    await applyAppUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
