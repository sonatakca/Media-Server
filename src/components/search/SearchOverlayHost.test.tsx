import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { openSearchOverlay } from "../../lib/searchModel";
import { SearchOverlayHost } from "./SearchOverlayHost";

vi.mock("./SearchOverlay", () => ({
  SearchOverlay: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      overlay-open
    </button>
  ),
}));

describe("SearchOverlayHost", () => {
  it("stays closed until something asks for it", () => {
    render(<SearchOverlayHost />);

    expect(screen.queryByText("overlay-open")).not.toBeInTheDocument();
  });

  it("opens on the Cmd/Ctrl+K shortcut", async () => {
    render(<SearchOverlayHost />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    await waitFor(() => {
      expect(screen.getByText("overlay-open")).toBeInTheDocument();
    });
  });

  it("opens when the navigation button requests it", async () => {
    render(<SearchOverlayHost />);

    openSearchOverlay();

    await waitFor(() => {
      expect(screen.getByText("overlay-open")).toBeInTheDocument();
    });
  });

  it("closes again on a second shortcut press", async () => {
    render(<SearchOverlayHost />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByText("overlay-open")).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => {
      expect(screen.queryByText("overlay-open")).not.toBeInTheDocument();
    });
  });

  it("ignores unrelated keystrokes", () => {
    render(<SearchOverlayHost />);

    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "j", metaKey: true });

    expect(screen.queryByText("overlay-open")).not.toBeInTheDocument();
  });
});
