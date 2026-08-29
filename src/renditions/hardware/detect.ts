import type { RenditionCodecFamily, RenditionVideoEncoder } from "../encoding";
import {
  adaptersForPlatform,
  adaptersNotOnPlatform,
  isDriveableEncoder,
  probeEncoder,
  type HardwareAdapter,
  type HardwareEncoderName,
} from "./adapters";

/**
 * Why a hardware path is not being used.
 *
 * Every value is something an operator can act on, or at least understand
 * without reading the source: a Mac will never grow an AMD AMF encoder, but a
 * Linux box missing VA-API might just need a driver.
 */
export type HardwareUnavailableReason =
  | "wrong-platform"
  | "not-implemented"
  | "no-encoder-for-codec"
  | "probe-failed";

export interface HardwareLaneReport {
  family: RenditionCodecFamily;
  tenBit: boolean;
  encoder: HardwareEncoderName | null;
  available: boolean;
  reason?: HardwareUnavailableReason;
  detail?: string;
}

export interface HardwareAdapterReport {
  id: string;
  label: string;
  platform: string;
  /** True when at least one lane probed successfully. */
  available: boolean;
  reason?: HardwareUnavailableReason;
  detail?: string;
  lanes: HardwareLaneReport[];
}

export interface HardwareReport {
  platform: string;
  ffmpegPath: string;
  probedAt: string;
  adapters: HardwareAdapterReport[];
  /** Best usable encoder per lane, or null when only software is left. */
  selected: {
    h264: RenditionVideoEncoder;
    hevc: RenditionVideoEncoder;
    hevcTenBit: RenditionVideoEncoder;
  };
  /** Adapter id backing `selected`, per lane. */
  selectedAdapter: { h264: string; hevc: string; hevcTenBit: string };
}

const LANES: ReadonlyArray<{ family: RenditionCodecFamily; tenBit: boolean }> =
  [
    { family: "h264", tenBit: false },
    { family: "hevc", tenBit: false },
    { family: "hevc", tenBit: true },
  ];

function laneKey(family: RenditionCodecFamily, tenBit: boolean): string {
  return `${family}${tenBit ? "-10bit" : ""}`;
}

export interface DetectHardwareOptions {
  ffmpegPath?: string;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** Injected so tests do not spawn FFmpeg. */
  probe?: typeof probeEncoder;
  /**
   * Frame size the probe encodes at. Production passes the largest rung it
   * intends to produce, because an encoder that opens at 320x240 can still
   * refuse a real frame size.
   */
  probeWidth?: number;
  probeHeight?: number;
}

/**
 * What this machine can actually encode with, proved by encoding.
 *
 * Adapters that cannot run here are still reported, with the reason, so the
 * administration page can explain an absent hardware path rather than leaving
 * a blank space where an operator expects their GPU.
 */
export async function detectHardware(
  options: DetectHardwareOptions = {},
): Promise<HardwareReport> {
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? probeEncoder;
  const adapters: HardwareAdapterReport[] = [];
  const usable = new Map<
    string,
    { adapter: HardwareAdapter; encoder: RenditionVideoEncoder }
  >();

  for (const adapter of adaptersForPlatform(platform)) {
    const lanes: HardwareLaneReport[] = [];
    for (const lane of LANES) {
      const encoder = adapter.encoderFor(lane.family, lane.tenBit);
      if (!encoder) {
        lanes.push({
          ...lane,
          encoder: null,
          available: false,
          reason: "no-encoder-for-codec",
        });
        continue;
      }
      if (!isDriveableEncoder(encoder)) {
        lanes.push({
          ...lane,
          encoder,
          available: false,
          reason: "not-implemented",
          detail: `${encoder} is recognised but this build does not configure it yet.`,
        });
        continue;
      }
      const result = await probe(ffmpegPath, encoder, {
        tenBit: lane.tenBit,
        ...(options.probeWidth === undefined
          ? {}
          : { width: options.probeWidth }),
        ...(options.probeHeight === undefined
          ? {}
          : { height: options.probeHeight }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      lanes.push({
        ...lane,
        encoder,
        available: result.ok,
        ...(result.ok ? {} : { reason: "probe-failed" as const }),
        ...(result.detail ? { detail: result.detail } : {}),
      });
      if (result.ok) {
        const key = laneKey(lane.family, lane.tenBit);
        if (!usable.has(key)) usable.set(key, { adapter, encoder });
      }
    }
    const available = lanes.some((lane) => lane.available);
    adapters.push({
      id: adapter.id,
      label: adapter.label,
      platform: adapter.platform,
      available,
      ...(available
        ? {}
        : {
            reason: (lanes.find((lane) => lane.reason)?.reason ??
              "probe-failed") as HardwareUnavailableReason,
            ...(lanes.find((lane) => lane.detail)?.detail
              ? { detail: lanes.find((lane) => lane.detail)!.detail }
              : {}),
          }),
      lanes,
    });
  }

  for (const adapter of adaptersNotOnPlatform(platform)) {
    adapters.push({
      id: adapter.id,
      label: adapter.label,
      platform: adapter.platform,
      available: false,
      reason: "wrong-platform",
      detail: `${adapter.label} is a ${adapter.platform} encoder; this server runs on ${platform}.`,
      lanes: [],
    });
  }

  const pick = (
    family: RenditionCodecFamily,
    tenBit: boolean,
    fallback: RenditionVideoEncoder,
  ) =>
    usable.get(laneKey(family, tenBit)) ?? {
      adapter: { id: "software" },
      encoder: fallback,
    };

  const h264 = pick("h264", false, "libx264");
  const hevc = pick("hevc", false, "libx265");
  const hevcTenBit = pick("hevc", true, "libx265");

  return {
    platform,
    ffmpegPath,
    probedAt: new Date().toISOString(),
    adapters,
    selected: {
      h264: h264.encoder,
      hevc: hevc.encoder,
      hevcTenBit: hevcTenBit.encoder,
    },
    selectedAdapter: {
      h264: h264.adapter.id,
      hevc: hevc.adapter.id,
      hevcTenBit: hevcTenBit.adapter.id,
    },
  };
}
