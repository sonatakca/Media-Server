// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_GROUPS,
  ADMIN_INDEX_PATHS,
  ADMIN_PATH_ALIASES,
  ADMIN_SECTIONS,
  sectionForPath,
  isAdminIndexPath,
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

  it("orders groups by errand, and leaves development until last", () => {
    // An operator arrives to run a library, not to open a skeleton lab. The
    // last group is the one that is about building Seyirlik rather than using
    // it, and it must stay visibly apart from the rest.
    expect(ADMIN_GROUPS.map((group) => group.id)).toEqual([
      "library",
      "downloads",
      "subtitles",
      "playback",
      "system",
      "curation",
      "development",
    ]);
  });

  it("keeps wanted media and the wanted-features backlog in different groups", () => {
    // "Wanted features" is a development board. Listing it beside monitoring
    // would put a feature request next to a film someone is waiting for.
    const byId = new Map(
      ADMIN_SECTIONS.map((section) => [section.id, section]),
    );
    expect(byId.get("wanted-features")?.group).toBe("development");
    expect(byId.get("monitoring")?.group).toBe("downloads");
  });

  it("keeps the errand of getting a film in one group", () => {
    // Monitoring, decisions and acquisitions are three backend concepts and
    // one human task. Splitting them across groups is what made "from where do
    // I download a wanted movie?" unanswerable from the UI.
    for (const id of ["monitoring", "decisions", "acquisitions"]) {
      expect(
        ADMIN_SECTIONS.find((section) => section.id === id)?.group,
        `${id} belongs with the rest of the download errand`,
      ).toBe("downloads");
    }
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

  it("lists every administrative route, so none can be orphaned", async () => {
    /*
     * The reverse of the check above, and the one that matters for
     * discoverability: a page can be added to the router, work perfectly, and
     * be reachable only by someone who already knows the URL. Every
     * administrative route has to be either a listed section, the index, or a
     * deliberately recorded alias.
     */
    const app = await readFile(
      fileURLToPath(new URL("../App.tsx", import.meta.url)),
      "utf8",
    );
    const routed = [...app.matchAll(/path="(\/(?:admin|dev)[^"]*)"/g)].map(
      (match) => match[1] as string,
    );
    expect(routed.length).toBeGreaterThan(15);

    const accounted = new Set<string>([
      ...ADMIN_SECTIONS.map((section) => section.path),
      ...ADMIN_INDEX_PATHS,
      ...Object.keys(ADMIN_PATH_ALIASES),
    ]);

    const orphans = routed.filter((path) => !accounted.has(path));
    expect(orphans, "administrative routes nothing links to").toEqual([]);
  });

  it("resolves a route to the section the navigation should highlight", () => {
    expect(sectionForPath("/admin/subtitles")?.id).toBe("subtitles");
    expect(sectionForPath("/admin/subtitles/")?.id).toBe("subtitles");
    // The alias renders curation, so it highlights curation.
    expect(sectionForPath("/dev/home-curation")?.id).toBe("curation");
    expect(sectionForPath("/admin")).toBeUndefined();
    expect(isAdminIndexPath("/dev")).toBe(true);
    expect(isAdminIndexPath("/admin/health")).toBe(false);
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
