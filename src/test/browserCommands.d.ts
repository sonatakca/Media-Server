/**
 * The custom browser commands `vitest.browser.config.ts` registers.
 *
 * Declared here rather than beside the command itself because the config file
 * is outside the typechecked program, and a command the tests cannot see the
 * type of is a command they would have to reach through `any`.
 */
import "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    /**
     * A real mouse, in the coordinates of the page under test: move to a
     * point, press, release. `userEvent` can click and it can drag from one
     * element to another; it cannot hold the button down while the test looks
     * at what the page did, which is the only interesting moment of a reorder.
     */
    pointer: (
      action: "move" | "down" | "up",
      x?: number,
      y?: number,
    ) => Promise<void>;
  }
}
