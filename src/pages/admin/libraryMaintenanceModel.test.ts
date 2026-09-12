import { describe, expect, it } from "vitest";
import { formatTemplate } from "./libraryMaintenanceModel";

describe("libraryMaintenanceModel", () => {
  it("fills every placeholder, as often as it appears", () => {
    expect(
      formatTemplate("{count} of {total} · {count}", { count: 2, total: 5 }),
    ).toBe("2 of 5 · 2");
  });
});
