/**
 * What the server's health actually means to an operator.
 *
 * The health endpoint answers six independent questions and the subsystems
 * answer several more, and the temptation is to reduce all of them to one
 * coloured dot. That dot is the problem: an unreachable SABnzbd and a dead
 * database would both make it red, so an operator who saw red would learn
 * nothing except to be alarmed.
 *
 * So signals are sorted into tiers by what their failure costs, and the overall
 * verdict is derived from the tiers rather than from a count of failures. A
 * download client that is switched off cannot make Seyirlik look dead, because
 * nothing in the `dependency` tier is allowed to reach the worst verdict.
 */

export type SignalState =
  | "ok"
  /** Working, but not doing everything it could. */
  | "degraded"
  /** Not working. What that costs depends on the tier. */
  | "down"
  /** Deliberately not configured. Not a fault, and never counted as one. */
  | "off"
  /** Not asked yet, or the answer has not come back. */
  | "unknown";

export type SignalTier =
  /** Seyirlik itself. If one of these is down, the server is not serving. */
  | "core"
  /** Limits what the server can do, without stopping it serving what it has. */
  | "capability"
  /** Something else entirely, that Seyirlik talks to. */
  | "dependency"
  /** Not a fault at all: work that is waiting for a person. */
  | "attention";

export interface HealthSignal {
  readonly id: string;
  readonly tier: SignalTier;
  readonly state: SignalState;
  /** A short, literal statement. Never a number without its unit. */
  readonly detail?: string;
  /** How many items are waiting, for `attention` signals. */
  readonly count?: number;
}

/** The one-line answer, derived from the tiers rather than from a tally. */
export type OverallVerdict =
  /** Everything that matters is working. */
  | "serving"
  /** Serving, and something is not doing its job. */
  | "degraded"
  /** Alive, and not finished starting. */
  | "starting"
  /** Alive, and unable to serve. */
  | "not-serving"
  /** Nothing answered at all. */
  | "unreachable";

export interface HealthInput {
  /** Null when the health request itself failed. */
  readonly health: {
    readonly alive: boolean;
    readonly ready: boolean;
    readonly checks: Record<string, string>;
    readonly startup?: { readonly state?: string } | undefined;
  } | null;
  /** Whether the download client answered, when one is configured. */
  readonly downloadClient?: {
    readonly configured: boolean;
    readonly reachable: boolean;
    readonly reason?: string;
  };
  /** Work that a person has to look at. */
  readonly attention?: {
    readonly imports?: number;
    readonly subtitlesNeedingAuthentication?: number;
    readonly failedJobs?: number;
  };
}

const CORE_CHECKS = ["database", "jobs"] as const;
const CAPABILITY_CHECKS = [
  "ffmpeg",
  "ffprobe",
  "mediaStorage",
  "generatedStorage",
] as const;

/** The endpoint's per-check vocabulary, in this module's terms. */
function stateOfCheck(value: string | undefined): SignalState {
  switch (value) {
    case "available":
    case "writable":
      return "ok";
    case "unavailable":
      return "down";
    case "disabled":
      // Configured off. A worker that was never enabled is not a fault.
      return "off";
    default:
      return "unknown";
  }
}

export function buildHealthSignals(input: HealthInput): HealthSignal[] {
  const signals: HealthSignal[] = [];

  if (!input.health) {
    return [
      {
        id: "server",
        tier: "core",
        state: "down",
        detail: "The server did not answer.",
      },
    ];
  }

  const { alive, ready, checks, startup } = input.health;
  signals.push({
    id: "server",
    tier: "core",
    state: alive ? (ready ? "ok" : "degraded") : "down",
    detail: alive
      ? ready
        ? "Serving requests."
        : `Alive, still starting${startup?.state ? ` (${startup.state})` : ""}.`
      : "Not alive.",
  });

  for (const check of CORE_CHECKS) {
    signals.push({
      id: check,
      tier: "core",
      state: stateOfCheck(checks[check]),
    });
  }
  for (const check of CAPABILITY_CHECKS) {
    signals.push({
      id: check,
      tier: "capability",
      state: stateOfCheck(checks[check]),
    });
  }

  if (input.downloadClient) {
    signals.push({
      id: "downloadClient",
      tier: "dependency",
      state: !input.downloadClient.configured
        ? "off"
        : input.downloadClient.reachable
          ? "ok"
          : "down",
      ...(input.downloadClient.reason
        ? { detail: input.downloadClient.reason }
        : {}),
    });
  }

  const attention = input.attention ?? {};
  const waiting: Array<[string, number | undefined]> = [
    ["importsNeedingAttention", attention.imports],
    [
      "subtitlesNeedingAuthentication",
      attention.subtitlesNeedingAuthentication,
    ],
    ["failedJobs", attention.failedJobs],
  ];
  for (const [id, count] of waiting) {
    if (count === undefined) continue;
    signals.push({
      id,
      tier: "attention",
      // Work waiting for a person is not the server being unwell, so it is
      // never worse than `degraded` however much of it there is.
      state: count > 0 ? "degraded" : "ok",
      count,
    });
  }

  return signals;
}

/**
 * The overall verdict.
 *
 * `dependency` and `attention` deliberately cannot produce anything worse than
 * `degraded`. A media server whose downloader is switched off still plays
 * everything in the library, and telling an operator it is down would send them
 * looking for a fault in the wrong machine.
 */
export function overallVerdict(
  signals: readonly HealthSignal[],
): OverallVerdict {
  const server = signals.find((signal) => signal.id === "server");
  if (!server || server.state === "down") return "unreachable";

  const core = signals.filter(
    (signal) => signal.tier === "core" && signal.id !== "server",
  );
  if (core.some((signal) => signal.state === "down")) return "not-serving";

  if (server.state === "degraded") return "starting";

  /*
   * `unknown` degrades too. A check whose vocabulary changed, or whose answer
   * never arrived, is not evidence of health — and reading it as `ok` would
   * turn a reporting gap into a green dot, which is the failure this module
   * exists to avoid. It is not `not-serving` either: not knowing is not proof.
   */
  const notWell = signals.some(
    (signal) =>
      signal.id !== "server" &&
      (signal.state === "down" ||
        signal.state === "degraded" ||
        signal.state === "unknown"),
  );
  return notWell ? "degraded" : "serving";
}

/** Whether the verdict is one an operator has to do something about. */
export function needsOperator(verdict: OverallVerdict): boolean {
  return verdict === "not-serving" || verdict === "unreachable";
}

/** Everything waiting for a person, as one number. */
export function attentionCount(signals: readonly HealthSignal[]): number {
  return signals
    .filter((signal) => signal.tier === "attention")
    .reduce((total, signal) => total + (signal.count ?? 0), 0);
}
