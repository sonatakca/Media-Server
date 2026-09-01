import { execFileSync } from "node:child_process";
import { availableParallelism, cpus } from "node:os";

export interface CpuTopology {
  /** CPUs this process is allowed to schedule work on. */
  logicalCpuCount: number;
  /** Fast cores, when the operating system exposes a trustworthy distinction. */
  performanceCpuCount?: number;
}

interface DetectCpuTopologyOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  availableCpuCount?: number;
  readSysctl?: (key: string) => string | undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nodeAvailableCpuCount(): number {
  try {
    const available = positiveInteger(availableParallelism());
    if (available !== undefined) return available;
  } catch {
    // Older or constrained runtimes can fail here; os.cpus remains the fallback.
  }
  return positiveInteger(cpus().length) ?? 1;
}

/**
 * Reads one fixed sysctl key without involving a shell.
 *
 * `/usr/sbin/sysctl` is stable on macOS and does not depend on launchd's PATH.
 * A short timeout keeps topology detection from ever holding up startup.
 */
function readMacSysctl(key: string): string | undefined {
  try {
    return execFileSync("/usr/sbin/sysctl", ["-n", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    });
  } catch {
    return undefined;
  }
}

/**
 * Detects the CPU budget visible to this process.
 *
 * Apple silicon's first performance level is used only when macOS itself names
 * it `Performance`. That avoids assuming every heterogeneous topology orders
 * its levels the same way. The result is also clamped to Node's available CPU
 * count so process affinity or a container quota still wins.
 */
export function detectCpuTopology(
  options: DetectCpuTopologyOptions = {},
): CpuTopology {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const logicalCpuCount =
    positiveInteger(options.availableCpuCount) ?? nodeAvailableCpuCount();

  if (platform !== "darwin" || arch !== "arm64") {
    return { logicalCpuCount };
  }

  const readSysctl = options.readSysctl ?? readMacSysctl;
  try {
    const levelName = readSysctl("hw.perflevel0.name")?.trim().toLowerCase();
    const reportedPerformanceCpus = positiveInteger(
      readSysctl("hw.perflevel0.logicalcpu"),
    );
    if (levelName === "performance" && reportedPerformanceCpus !== undefined) {
      return {
        logicalCpuCount,
        performanceCpuCount: Math.min(logicalCpuCount, reportedPerformanceCpus),
      };
    }
  } catch {
    // Topology is an optimisation. A failed probe must never prevent startup.
  }

  return { logicalCpuCount };
}

let cachedCpuTopology: CpuTopology | undefined;

/** Immutable machine topology, detected at most once for this process. */
export function cpuTopology(): CpuTopology {
  cachedCpuTopology ??= detectCpuTopology();
  return cachedCpuTopology;
}

/**
 * Default encoder threads for one software encode.
 *
 * On Apple silicon this selects the performance cores. Elsewhere all CPUs made
 * available to Node form the portable budget. A caller that permits several
 * simultaneous software encodes divides that budget evenly between them.
 */
export function defaultSoftwareEncoderThreads({
  topology = cpuTopology(),
  concurrentEncodes = 1,
}: {
  topology?: CpuTopology;
  concurrentEncodes?: number;
} = {}): number {
  const budget =
    topology.performanceCpuCount ?? Math.max(1, topology.logicalCpuCount);
  const concurrency = positiveInteger(concurrentEncodes) ?? 1;
  return Math.max(1, Math.floor(budget / concurrency));
}

/**
 * Scaling benefits from a small shared pool, but it must not mirror a large
 * encoder pool blindly: both stages run at the same time in an FFmpeg pipeline.
 */
export function defaultSoftwareFilterThreads(encoderThreads: number): number {
  return Math.max(1, Math.min(4, Math.floor(encoderThreads) || 1));
}
