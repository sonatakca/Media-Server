import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SeasonPicker } from "./SeasonPicker";

function SeasonPickerHarness() {
  const location = useLocation();

  return (
    <>
      <SeasonPicker
        activeSeasonId="season-1"
        currentLabel="Season 1"
        options={[
          { id: "season-1", label: "Season 1" },
          { id: "season-2", label: "Season 2" },
        ]}
        selectLabel="Select season"
      />
      <output data-testid="path">{location.pathname}</output>
    </>
  );
}

describe("SeasonPicker", () => {
  it("opens without navigation, closes outside, and navigates after selection", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/library/season-1"]}>
        <SeasonPickerHarness />
      </MemoryRouter>,
    );

    const trigger = screen.getByRole("button", {
      name: "Select season: Season 1",
    });

    await user.click(trigger);

    expect(screen.getByTestId("path")).toHaveTextContent("/library/season-1");
    expect(screen.getByRole("menuitem", { name: "Season 2" })).toBeVisible();

    await user.click(document.body);

    expect(
      screen.queryByRole("menuitem", { name: "Season 2" }),
    ).not.toBeInTheDocument();

    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Season 2" }));

    expect(screen.getByTestId("path")).toHaveTextContent("/library/season-2");
    expect(
      screen.queryByRole("menuitem", { name: "Season 2" }),
    ).not.toBeInTheDocument();
  });
});
