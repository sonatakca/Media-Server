// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  defaultSoftwareEncoderThreads,
  defaultSoftwareFilterThreads,
  detectCpuTopology,
} from "./cpuTopology";

describe("CPU topology", () => {
  it("uses the macOS performance level on Apple silicon", () => {
    const readSysctl = vi.fn((key: string) =>
      key === "hw.perflevel0.name" ? "Performance\n" : "8\n",
    );

    expect(
      detectCpuTopology({
        platform: "darwin",
        arch: "arm64",
        availableCpuCount: 10,
        readSysctl,
      }),
    ).toEqual({ logicalCpuCount: 10, performanceCpuCount: 8 });
    expect(readSysctl).toHaveBeenCalledTimes(2);
  });

  it("clamps performance cores to the process CPU allowance", () => {
    expect(
      detectCpuTopology({
        platform: "darwin",
        arch: "arm64",
        availableCpuCount: 4,
        readSysctl: (key) =>
          key === "hw.perflevel0.name" ? "Performance" : "8",
      }),
    ).toEqual({ logicalCpuCount: 4, performanceCpuCount: 4 });
  });

  it.each([
    { label: "missing sysctl", readSysctl: () => undefined },
    { label: "garbage sysctl", readSysctl: () => "garbage" },
    {
      label: "unexpected performance-level name",
      readSysctl: () => "Efficiency",
    },
    {
      label: "failed sysctl",
      readSysctl: () => {
        throw new Error("unavailable");
      },
    },
  ])("falls back safely for $label", ({ readSysctl }) => {
    expect(
      detectCpuTopology({
        platform: "darwin",
        arch: "arm64",
        availableCpuCount: 10,
        readSysctl,
      }),
    ).toEqual({ logicalCpuCount: 10 });
  });

  it("does not call sysctl on Intel macOS, Linux, or Windows", () => {
    const readSysctl = vi.fn();
    for (const [platform, arch] of [
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
    ] as const) {
      expect(
        detectCpuTopology({
          platform,
          arch,
          availableCpuCount: 12,
          readSysctl,
        }),
      ).toEqual({ logicalCpuCount: 12 });
    }
    expect(readSysctl).not.toHaveBeenCalled();
  });

  it("shares the CPU budget between permitted concurrent encodes", () => {
    expect(
      defaultSoftwareEncoderThreads({
        topology: { logicalCpuCount: 10, performanceCpuCount: 8 },
      }),
    ).toBe(8);
    expect(
      defaultSoftwareEncoderThreads({
        topology: { logicalCpuCount: 10, performanceCpuCount: 8 },
        concurrentEncodes: 2,
      }),
    ).toBe(4);
  });

  it("keeps the filter pool separate and bounded", () => {
    expect(defaultSoftwareFilterThreads(1)).toBe(1);
    expect(defaultSoftwareFilterThreads(8)).toBe(4);
    expect(defaultSoftwareFilterThreads(64)).toBe(4);
  });
});
