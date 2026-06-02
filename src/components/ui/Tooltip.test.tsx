import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  it("strips native title attributes and shows the custom tooltip on hover", async () => {
    render(
      <Tooltip content="Open details">
        <button type="button" title="Native tooltip">
          Details
        </button>
      </Tooltip>,
    );

    const button = screen.getByRole("button", { name: "Details" });
    expect(button).not.toHaveAttribute("title");

    fireEvent.mouseEnter(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Open details",
    );

    fireEvent.mouseLeave(button);
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  it("supports keyboard focus without showing touch-triggered stuck tooltips", async () => {
    render(
      <Tooltip content="Change theme">
        <button type="button">Theme</button>
      </Tooltip>,
    );

    const button = screen.getByRole("button", { name: "Theme" });

    fireEvent.focusIn(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Change theme",
    );

    fireEvent.focusOut(button);
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    fireEvent.pointerDown(button, { pointerType: "touch" });
    fireEvent.focusIn(button);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
