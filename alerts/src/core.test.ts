// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_STALE_MS,
  assessHost,
  backupIsStale,
  base64UrlDecode,
  decideEvent,
  describeDuration,
  mintViewerToken,
  parseEvent,
  signRequest,
  verifyRequest,
  verifyViewerToken,
  type StoredAlert,
} from "./core";
import { isPublicKey, vapidToken } from "./webPush";

const SECRET = "a-shared-secret-of-reasonable-length";
const NOW = 1_790_000_000_000;

describe("signed requests", () => {
  it("accepts the server's own signature and nothing else", async () => {
    const body = JSON.stringify({
      kind: "storage",
      severity: "critical",
      title: "x",
    });
    const signature = await signRequest(SECRET, NOW, body);
    expect(await verifyRequest(SECRET, String(NOW), signature, body, NOW)).toBe(
      true,
    );
    expect(
      await verifyRequest(SECRET, String(NOW), signature, body + " ", NOW),
    ).toBe(false);
    expect(
      await verifyRequest("another-secret", String(NOW), signature, body, NOW),
    ).toBe(false);
    expect(await verifyRequest(SECRET, String(NOW), null, body, NOW)).toBe(
      false,
    );
  });

  it("refuses a replay from outside the five-minute window", async () => {
    const signature = await signRequest(SECRET, NOW, "{}");
    expect(
      await verifyRequest(
        SECRET,
        String(NOW),
        signature,
        "{}",
        NOW + 6 * 60_000,
      ),
    ).toBe(false);
  });
});

describe("viewer tokens", () => {
  it("opens the alerts to the holder until it expires", async () => {
    const token = await mintViewerToken(SECRET, "admin-1", NOW + 60_000);
    expect(await verifyViewerToken(SECRET, token, NOW)).toEqual({
      subject: "admin-1",
    });
    expect(await verifyViewerToken(SECRET, token, NOW + 120_000)).toBeNull();
  });

  it("refuses a token whose claims were changed", async () => {
    const token = await mintViewerToken(SECRET, "admin-1", NOW + 60_000);
    const [version, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "admin-1", exp: NOW + 10 ** 12 }),
    ).toString("base64url");
    expect(
      await verifyViewerToken(SECRET, `${version}.${forged}.${signature}`, NOW),
    ).toBeNull();
    expect(await verifyViewerToken(SECRET, "nonsense", NOW)).toBeNull();
  });
});

describe("parseEvent", () => {
  it("keeps what an event may carry and refuses what it may not", () => {
    expect(
      parseEvent({
        kind: "storage",
        severity: "critical",
        title: "Hold",
        key: "storage",
        resolve: false,
      }),
    ).toEqual({
      kind: "storage",
      severity: "critical",
      title: "Hold",
      key: "storage",
    });
    expect(
      parseEvent({ kind: "storage", severity: "loud", title: "Hold" }),
    ).toBeNull();
    expect(parseEvent({ kind: "", severity: "info", title: "x" })).toBeNull();
    // A resolution needs a key to say what it resolves.
    expect(
      parseEvent({ kind: "k", severity: "info", title: "t", resolve: true }),
    ).toEqual({
      kind: "k",
      severity: "info",
      title: "t",
    });
  });
});

describe("decideEvent", () => {
  const open: StoredAlert = {
    id: "a1",
    kind: "storage",
    severity: "critical",
    title: "Hold",
    body: "",
    key: "storage",
    createdAt: NOW,
    resolvedAt: null,
    lastSeenAt: NOW,
  };

  it("opens a new problem and wakes somebody for it", () => {
    expect(
      decideEvent(
        {
          kind: "storage",
          severity: "critical",
          title: "Hold",
          key: "storage",
        },
        null,
      ),
    ).toEqual({
      action: "open",
      notify: true,
    });
  });

  it("counts the same open problem once", () => {
    expect(
      decideEvent(
        {
          kind: "storage",
          severity: "critical",
          title: "Hold",
          key: "storage",
        },
        open,
      ),
    ).toEqual({
      action: "touch",
      alertId: "a1",
    });
  });

  it("records information without waking anybody", () => {
    expect(
      decideEvent({ kind: "start", severity: "info", title: "Started" }, null),
    ).toEqual({
      action: "open",
      notify: false,
    });
  });

  it("closes an open problem, and ignores a resolution of nothing", () => {
    const resolution = {
      kind: "storage",
      severity: "info" as const,
      title: "OK",
      key: "storage",
      resolve: true,
    };
    expect(decideEvent(resolution, open)).toEqual({
      action: "resolve",
      alertId: "a1",
      notify: true,
    });
    expect(decideEvent(resolution, null)).toEqual({ action: "ignore" });
  });
});

describe("assessHost", () => {
  it("says nothing while heartbeats arrive", () => {
    expect(assessHost({ at: NOW }, NOW - 60_000, false, NOW).down).toBe(false);
  });

  it("calls a silent server down, and says whether it still answers", () => {
    const silent = NOW - HEARTBEAT_STALE_MS - 60_000;
    const unreachable = assessHost({ at: silent }, silent, false, NOW);
    expect(unreachable.down).toBe(true);
    expect(unreachable.detail).toContain("does not answer");
    expect(assessHost({ at: silent }, silent, true, NOW).detail).toContain(
      "wedged",
    );
  });

  it("does not cry wolf before the first heartbeat", () => {
    expect(assessHost(null, null, false, NOW).down).toBe(false);
  });
});

describe("backupIsStale", () => {
  it("flags a backup older than a day and a half, or none at all", () => {
    expect(
      backupIsStale({ at: NOW, lastVerifiedBackupAt: NOW - 3_600_000 }, NOW),
    ).toBe(false);
    expect(
      backupIsStale(
        { at: NOW, lastVerifiedBackupAt: NOW - 40 * 3_600_000 },
        NOW,
      ),
    ).toBe(true);
    expect(backupIsStale({ at: NOW, lastVerifiedBackupAt: null }, NOW)).toBe(
      true,
    );
    // A server that does not report backups is not accused of missing them.
    expect(backupIsStale({ at: NOW }, NOW)).toBe(false);
  });
});

describe("describeDuration", () => {
  it("reads like a person wrote it", () => {
    expect(describeDuration(30_000)).toBe("1 min");
    expect(describeDuration(25 * 60_000)).toBe("25 min");
    expect(describeDuration(130 * 60_000)).toBe("2 h 10 min");
  });
});

describe("vapidToken", () => {
  it("signs a token the public key verifies", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const publicKey = Buffer.from(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ).toString("base64url");
    expect(isPublicKey(publicKey)).toBe(true);

    const token = await vapidToken(
      "https://fcm.googleapis.com",
      {
        privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
        publicKey,
        subject: "https://www.seyirlik.org",
      },
      NOW,
    );
    const [header, claims, signature] = token.split(".");
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      base64UrlDecode(signature!),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
    expect(
      JSON.parse(new TextDecoder().decode(base64UrlDecode(claims!))),
    ).toMatchObject({
      aud: "https://fcm.googleapis.com",
      sub: "https://www.seyirlik.org",
    });
  });
});
