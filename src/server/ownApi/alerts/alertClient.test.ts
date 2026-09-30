// @vitest-environment node
import { describe, expect, it } from "vitest";
import { verifyRequest, verifyViewerToken } from "../../../../alerts/src/core";
import {
  createAlertClient,
  parseAlertConfig,
  storageTransitionEvent,
} from "./alertClient";

const SECRET = "s".repeat(40);

describe("parseAlertConfig", () => {
  it("is off when nothing is set, and refuses half a configuration", () => {
    expect(parseAlertConfig({})).toBeNull();
    expect(() =>
      parseAlertConfig({ SEYIRLIK_ALERTS_URL: "https://a" }),
    ).toThrow();
    expect(() =>
      parseAlertConfig({
        SEYIRLIK_ALERTS_URL: "https://a",
        SEYIRLIK_ALERTS_SECRET: "short",
      }),
    ).toThrow(/32/);
    expect(
      parseAlertConfig({
        SEYIRLIK_ALERTS_URL: "https://alerts.seyirlik.org/",
        SEYIRLIK_ALERTS_SECRET: SECRET,
      }),
    ).toEqual({ url: "https://alerts.seyirlik.org", secret: SECRET });
  });
});

describe("storageTransitionEvent", () => {
  it("names the fault without the path or the error text behind it", () => {
    const event = storageTransitionEvent(
      "storage.quarantined",
      "D:\\media: The storage reported a hard I/O failure. EIO reading D:\\media\\Movies\\Dune (2021)\\Dune.mkv",
    );
    expect(event).toMatchObject({
      severity: "critical",
      key: "storage",
      body: "The storage reported a hard I/O failure.",
    });
    expect(event?.body).not.toContain("Dune");
    expect(event?.body).not.toContain("D:\\");
  });

  it("closes the storage alert when the volume is back, and ignores the rest", () => {
    expect(
      storageTransitionEvent("storage.recovered", "D:\\media: ok"),
    ).toMatchObject({
      resolve: true,
      key: "storage",
    });
    expect(storageTransitionEvent("storage.something-else", "x")).toBeNull();
  });
});

describe("createAlertClient", () => {
  it("signs what it sends so the alert service accepts it", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const client = createAlertClient(
      { url: "https://alerts.test", secret: SECRET },
      {
        fetchImpl: async (url, init) => {
          sent.push({ url: String(url), init: init! });
          return new Response(null, { status: 202 });
        },
        now: () => 1_790_000_000_000,
      },
    );
    expect(
      await client.deliver({
        kind: "backup",
        severity: "critical",
        title: "Failed",
      }),
    ).toBe(true);
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(sent[0]!.url).toBe("https://alerts.test/v1/events");
    expect(
      await verifyRequest(
        SECRET,
        headers["X-Seyirlik-Timestamp"]!,
        headers["X-Seyirlik-Signature"]!,
        String(sent[0]!.init.body),
        1_790_000_000_000,
      ),
    ).toBe(true);
  });

  it("retries an undelivered event on a backoff, then gives up and says so", async () => {
    const delays: number[] = [];
    const logged: string[] = [];
    let attempts = 0;
    const client = createAlertClient(
      { url: "https://alerts.test", secret: SECRET },
      {
        fetchImpl: async () => {
          attempts += 1;
          return new Response(null, { status: 503 });
        },
        schedule: (callback, delay) => {
          delays.push(delay);
          queueMicrotask(callback);
        },
        log: (message) => logged.push(message),
      },
    );
    client.emit({
      kind: "storage",
      severity: "critical",
      title: "Hold",
      key: "storage",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attempts).toBe(4);
    expect(delays).toEqual([5_000, 30_000, 120_000]);
    expect(logged).toEqual(["[Seyirlik] alert not delivered: storage"]);
  });

  it("mints viewer tokens the alert service can check on its own", async () => {
    const client = createAlertClient({
      url: "https://alerts.test",
      secret: SECRET,
    });
    const token = await client.mintViewerToken("admin-1");
    expect(await verifyViewerToken(SECRET, token, Date.now())).toEqual({
      subject: "admin-1",
    });
  });
});
