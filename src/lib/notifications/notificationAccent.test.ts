/**
 * What colour a card wears, and why.
 *
 * The claims here are the ones the design depends on: trouble outranks the
 * job that produced it, every task type has a colour, and the ramp steps
 * downward in lightness so the order is still there for somebody who cannot
 * separate the hues.
 */

import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_ACCENTS,
  TASK_FAMILIES,
  resolveNotificationAccent,
} from "./notificationAccent";
import { TASK_METRICS } from "./taskPresentation";

/** WCAG relative luminance, for the contrast claims below. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Against the card's own background. */
function contrastOnCard(hex: string): number {
  const card = luminance("#0b0b10");
  const colour = luminance(hex);
  const [lighter, darker] = colour > card ? [colour, card] : [card, colour];
  return (lighter + 0.05) / (darker + 0.05);
}

describe("notification accents", () => {
  it("gives every known task type a family", () => {
    for (const type of Object.keys(TASK_METRICS)) {
      expect(TASK_FAMILIES[type as keyof typeof TASK_FAMILIES]).toBeDefined();
    }
  });

  it("colours a job by the family of work it belongs to", () => {
    expect(resolveNotificationAccent("progress", "library.scan")).toBe(
      NOTIFICATION_ACCENTS.discovery,
    );
    expect(resolveNotificationAccent("progress", "metadata.refresh")).toBe(
      NOTIFICATION_ACCENTS.description,
    );
    expect(resolveNotificationAccent("progress", "media.process")).toBe(
      NOTIFICATION_ACCENTS.encoding,
    );
    expect(resolveNotificationAccent("progress", "nfo.export.library")).toBe(
      NOTIFICATION_ACCENTS.export,
    );
  });

  it("keeps a family colour through a healthy outcome", () => {
    expect(resolveNotificationAccent("success", "media.process")).toBe(
      NOTIFICATION_ACCENTS.encoding,
    );
    expect(resolveNotificationAccent("info", "library.scan")).toBe(
      NOTIFICATION_ACCENTS.discovery,
    );
  });

  it("lets trouble outrank the job that produced it", () => {
    // A failed encode is red, not green: no family hue mutes a state somebody
    // has to act on.
    expect(resolveNotificationAccent("error", "media.process")).toBe(
      NOTIFICATION_ACCENTS.error,
    );
    expect(resolveNotificationAccent("warning", "library.scan")).toBe(
      NOTIFICATION_ACCENTS.warning,
    );
    expect(resolveNotificationAccent("error")).toBe(NOTIFICATION_ACCENTS.error);
  });

  it("leaves a notification that is not a job uncoloured", () => {
    expect(resolveNotificationAccent("info")).toBe(
      NOTIFICATION_ACCENTS.neutral,
    );
    expect(resolveNotificationAccent("success")).toBe(
      NOTIFICATION_ACCENTS.neutral,
    );
  });

  it("keeps an unrecognised task type inside the ramp", () => {
    // An older client against a newer server still has work to report.
    expect(resolveNotificationAccent("progress", "future.task")).toBe(
      NOTIFICATION_ACCENTS.encoding,
    );
  });

  it("clears text contrast on the card for every colour it can pick", () => {
    for (const [name, value] of Object.entries(NOTIFICATION_ACCENTS)) {
      if (!value.startsWith("#")) continue;
      expect(
        contrastOnCard(value),
        `${name} (${value}) against the card`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("steps the four families down in lightness, in pipeline order", () => {
    // The order survives without colour: discovery is the brightest, export
    // the deepest, and each stage sits between its neighbours.
    const ladder = [
      NOTIFICATION_ACCENTS.discovery,
      NOTIFICATION_ACCENTS.description,
      NOTIFICATION_ACCENTS.encoding,
      NOTIFICATION_ACCENTS.export,
    ].map(contrastOnCard);

    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i]).toBeLessThan(ladder[i - 1]);
    }
  });

  it("keeps every family distinct from every other", () => {
    const families = Object.values(TASK_FAMILIES).map(
      (family) => NOTIFICATION_ACCENTS[family],
    );
    expect(new Set(families).size).toBe(
      new Set(Object.values(TASK_FAMILIES)).size,
    );
  });
});
