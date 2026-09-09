// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_GROUPS,
  ADMIN_SECTIONS,
  sectionsInGroup,
  visibleGroups,
} from "./adminSections";
import { en } from "../i18n/translations/en";
import { tr } from "../i18n/translations/tr";

describe("the administration registry", () => {
  it("gives every section a unique id and a unique route", () => {
    const ids = ADMIN_SECTIONS.map((section) => section.id);
    const paths = ADMIN_SECTIONS.map((section) => section.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("puts every section in a group that exists", () => {
    const groups = new Set(ADMIN_GROUPS.map((group) => group.id));
    for (const section of ADMIN_SECTIONS) {
      expect(groups.has(section.group)).toBe(true);
    }
  });

  it("leaves no group empty, so no heading is drawn over nothing", () => {
    for (const group of ADMIN_GROUPS) {
      expect(
        sectionsInGroup(group.id, { includeDevOnly: true }).length,
      ).toBeGreaterThan(0);
    }
  });

  it("hides the development-only section from a production build", () => {
    const shipped = visibleGroups({ includeDevOnly: false }).flatMap(
      (entry) => entry.sections,
    );
    expect(shipped.some((section) => section.devOnly)).toBe(false);
    expect(
      visibleGroups({ includeDevOnly: true }).flatMap((entry) => entry.sections)
        .length,
    ).toBeGreaterThan(shipped.length);
  });

  it("orders groups so the running system comes before the toolbox", () => {
    // An operator arrives to find out what the server is doing, not to open a
    // skeleton lab.
    expect(ADMIN_GROUPS.map((group) => group.id)).toEqual([
      "operations",
      "library",
      "configuration",
      "diagnostics",
    ]);
  });
});

describe("the registry and the router agree", () => {
  /*
   * The failure this prevents is a section that is listed and unreachable, or
   * reachable and unlisted — which is exactly what happened while the card
   * grid and the route table were maintained separately. Reading the route
   * table as text is blunt, but it holds the two together without restructuring
   * a working router.
   */
  it("registers a route for every section", async () => {
    const app = await readFile(
      fileURLToPath(new URL("../App.tsx", import.meta.url)),
      "utf8",
    );
    for (const section of ADMIN_SECTIONS) {
      expect(
        app.includes(`path="${section.path}"`),
        `${section.id} is listed in administration but has no route`,
      ).toBe(true);
    }
  });

  it("keeps the administration index itself reachable", async () => {
    const app = await readFile(
      fileURLToPath(new URL("../App.tsx", import.meta.url)),
      "utf8",
    );
    expect(app).toContain('path="/dev"');
    expect(app).toContain('path="/admin"');
  });
});

describe("every registry string is translated", () => {
  const keys = [
    ...ADMIN_GROUPS.flatMap((group) => [group.titleKey, group.descriptionKey]),
    ...ADMIN_SECTIONS.flatMap((section) => [
      section.titleKey,
      section.descriptionKey,
      section.tagKey,
    ]),
  ];

  it.each(["en", "tr"])("has every key in %s", (locale) => {
    const table = (locale === "en" ? en : tr) as Record<string, string>;
    const missing = keys.filter((key) => !table[key]);
    expect(missing).toEqual([]);
  });
});
