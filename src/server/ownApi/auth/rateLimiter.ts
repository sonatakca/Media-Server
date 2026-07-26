export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export interface BoundedRateLimiter {
  consume(key: string): RateLimitDecision;
  reset(key: string): void;
  size(): number;
}

export interface BoundedRateLimiterOptions {
  maxAttempts: number;
  windowMs: number;
  maxEntries: number;
  now?: () => number;
}

interface RateLimitEntry {
  attempts: number;
  resetAt: number;
}

export function createBoundedRateLimiter({
  maxAttempts,
  windowMs,
  maxEntries,
  now = Date.now,
}: BoundedRateLimiterOptions): BoundedRateLimiter {
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1
  ) {
    throw new Error("Rate limiter configuration is invalid.");
  }

  const entries = new Map<string, RateLimitEntry>();

  const pruneExpired = (checkedAt: number) => {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= checkedAt) {
        entries.delete(key);
      }
    }
  };

  const enforceBound = () => {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    consume(key) {
      const checkedAt = now();
      let entry = entries.get(key);

      if (!entry || entry.resetAt <= checkedAt) {
        pruneExpired(checkedAt);
        entry = { attempts: 0, resetAt: checkedAt + windowMs };
      } else {
        entries.delete(key);
      }

      entry.attempts += 1;
      entries.set(key, entry);
      enforceBound();

      return {
        allowed: entry.attempts <= maxAttempts,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((entry.resetAt - checkedAt) / 1_000),
        ),
        remaining: Math.max(0, maxAttempts - entry.attempts),
      };
    },

    reset(key) {
      entries.delete(key);
    },

    size: () => entries.size,
  };
}
