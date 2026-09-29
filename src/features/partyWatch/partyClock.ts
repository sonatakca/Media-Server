/**
 * The server's clock, as seen from this tab.
 *
 * The group timeline is anchored in server time, so every participant must
 * agree on what "now" is on the server — a phone whose clock is two seconds
 * off would otherwise sit two seconds from everyone else and seek forever
 * trying to fix it. Each request that returns the server's time is a sample:
 * the server stamped it somewhere between sending and receiving, so the
 * midpoint is the best estimate, and the round trip bounds the error. The
 * estimate kept is the one from the fastest recent round trip, because a slow
 * one is usually slow in one direction and skews the midpoint.
 */

export interface ClockSample {
  /** Local time the request left. */
  sentAt: number;
  /** Local time the response arrived. */
  receivedAt: number;
  serverTimeMs: number;
}

export interface PartyClock {
  addSample(sample: ClockSample): void;
  /** Server time now; local time until the first sample arrives. */
  serverNow(): number;
  /** Server minus local, or null before any sample. */
  offsetMs(): number | null;
  /** Round trip of the sample in use, or null before any sample. */
  roundTripMs(): number | null;
  /** Forgets every sample: after sleep, or a clock change on this device. */
  reset(): void;
}

/** How many recent samples the estimate is chosen from. */
const SAMPLE_WINDOW = 8;
/**
 * A sample older than this no longer describes the clocks: devices correct
 * their own time, and a laptop that slept may have been corrected on wake.
 */
const SAMPLE_MAX_AGE_MS = 3 * 60_000;
/** A round trip this slow says too little about either direction to use. */
const MAX_USEFUL_ROUND_TRIP_MS = 10_000;

export function createPartyClock(now: () => number = Date.now): PartyClock {
  let samples: Array<{ at: number; offset: number; roundTrip: number }> = [];

  const best = () => {
    const cutoff = now() - SAMPLE_MAX_AGE_MS;
    samples = samples.filter((sample) => sample.at >= cutoff);
    let chosen: (typeof samples)[number] | null = null;
    for (const sample of samples) {
      if (!chosen || sample.roundTrip < chosen.roundTrip) chosen = sample;
    }
    return chosen;
  };

  return {
    addSample: ({ sentAt, receivedAt, serverTimeMs }) => {
      const roundTrip = receivedAt - sentAt;
      if (
        !Number.isFinite(serverTimeMs) ||
        roundTrip < 0 ||
        roundTrip > MAX_USEFUL_ROUND_TRIP_MS
      ) {
        return;
      }
      samples.push({
        at: receivedAt,
        offset: serverTimeMs - (sentAt + receivedAt) / 2,
        roundTrip,
      });
      if (samples.length > SAMPLE_WINDOW) samples.shift();
    },
    serverNow: () => now() + (best()?.offset ?? 0),
    offsetMs: () => best()?.offset ?? null,
    roundTripMs: () => best()?.roundTrip ?? null,
    reset: () => {
      samples = [];
    },
  };
}
