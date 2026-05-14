import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Button, ButtonLink } from "../components/Button";

describe("Button Component", () => {
  it("renders a standard button with children", () => {
    render(<Button>Click Me</Button>);
    const button = screen.getByRole("button", { name: "Click Me" });
    
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass("bg-[var(--accent)]"); // Primary default
  });

  it("applies the secondary variant class correctly", () => {
    render(<Button variant="secondary">Secondary Action</Button>);
    const button = screen.getByRole("button", { name: "Secondary Action" });
    
    expect(button).toHaveClass("border-white/15");
    expect(button).toHaveClass("bg-white/10");
  });

  it("handles the disabled state properly", () => {
    render(<Button disabled>Disabled</Button>);
    const button = screen.getByRole("button", { name: "Disabled" });
    
    expect(button).toBeDisabled();
    expect(button).toHaveClass("disabled:cursor-not-allowed");
  });
});

describe("ButtonLink Component", () => {
  it("renders an anchor tag pointing to the correct route", () => {
    render(
      <MemoryRouter>
        <ButtonLink to="/watch/123">Play Movie</ButtonLink>
      </MemoryRouter>
    );
    const link = screen.getByRole("link", { name: "Play Movie" });
    expect(link).toHaveAttribute("href", "/watch/123");
  });
});
