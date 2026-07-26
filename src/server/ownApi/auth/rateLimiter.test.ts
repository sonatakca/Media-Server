// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createBoundedRateLimiter } from "./rateLimiter";

describe("bounded process-local authentication rate limiter", () => {
  it("throttles repeated failures and resets after successful authentication", () => {
    let now = 1_000;
    const limiter = createBoundedRateLimiter({
      maxAttempts: 3,
      windowMs: 60_000,
      maxEntries: 10,
      now: () => now,
    });

    expect(limiter.consume("127.0.0.1|person")).toMatchObject({
      allowed: true,
    });
    expect(limiter.consume("127.0.0.1|person")).toMatchObject({
      allowed: true,
    });
    limiter.reset("127.0.0.1|person");
    expect(limiter.consume("127.0.0.1|person")).toMatchObject({
      allowed: true,
    });
    expect(limiter.consume("127.0.0.1|person")).toMatchObject({
      allowed: true,
    });
    expect(limiter.consume("127.0.0.1|person")).toMatchObject({
      allowed: true,
    });
    expect(limiter.consume("127.0.0.1|person")).toMatchObject({
      allowed: false,
    });

    now += 60_001;
    expect(limiter.consume("127.0.0.1|person")).toMatchObject({
      allowed: true,
    });
  });

  it("keeps accounts separate even when they share an address", () => {
    const limiter = createBoundedRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      maxEntries: 10,
    });

    expect(limiter.consume("127.0.0.1|first").allowed).toBe(true);
    expect(limiter.consume("127.0.0.1|first").allowed).toBe(false);
    expect(limiter.consume("127.0.0.1|second").allowed).toBe(true);
  });

  it("evicts old entries so limiter storage remains bounded", () => {
    const limiter = createBoundedRateLimiter({
      maxAttempts: 3,
      windowMs: 60_000,
      maxEntries: 3,
    });

    for (let index = 0; index < 20; index += 1) {
      limiter.consume(`address|account-${index}`);
    }

    expect(limiter.size()).toBe(3);
  });
});
