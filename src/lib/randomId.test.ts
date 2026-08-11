import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "./randomId";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("randomUuid", () => {
  it("uses the platform generator when there is one", () => {
    const randomUUID = vi.fn(
      () => "11111111-1111-4111-8111-111111111111" as const,
    );
    vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID });

    expect(randomUuid()).toBe("11111111-1111-4111-8111-111111111111");
    expect(randomUUID).toHaveBeenCalled();
  });

  it("still produces a v4 UUID outside a secure context", () => {
    // crypto.randomUUID is secure-context only, so it is simply absent when the
    // dev server is reached over the LAN — which is where signing in broke.
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0xff);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    const value = randomUuid();
    expect(value).toMatch(UUID_V4);
    expect(getRandomValues).toHaveBeenCalled();
    // The version and variant nibbles must be set even though every random
    // byte came back as 0xff.
    expect(value[14]).toBe("4");
    expect(["8", "9", "a", "b"]).toContain(value[19]);
  });

  it("does not throw when there is no Web Crypto at all", () => {
    vi.stubGlobal("crypto", undefined);

    expect(randomUuid()).toMatch(UUID_V4);
  });

  it("does not repeat itself", () => {
    const values = new Set(Array.from({ length: 200 }, () => randomUuid()));
    expect(values.size).toBe(200);
  });
});
