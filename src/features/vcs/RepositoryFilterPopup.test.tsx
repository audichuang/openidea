import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RepositoryFilterPopup } from "./RepositoryFilterPopup";

function setup(selected: string[] = []) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const anchor = document.createElement("button");
  document.body.append(anchor);
  render(
    <RepositoryFilterPopup
      anchor={anchor}
      repositories={["/w/alpha", "/w/beta", "/w/gamma"]}
      selected={selected}
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  return { onSelect, onClose };
}
const search = () => screen.getByRole("textbox", { name: "Search repositories" });

describe("RepositoryFilterPopup", () => {
  it("lists every repository and focuses the search field", () => {
    setup();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(search()).toHaveFocus();
  });
  it("filters while typing and Enter picks the filtered repository", () => {
    const { onSelect } = setup();
    fireEvent.change(search(), { target: { value: "gam" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("/w/gamma");
  });
  it("moves with arrow keys and shows a message when nothing matches", () => {
    const { onSelect } = setup();
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("/w/beta");
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(screen.getByText("No matching repositories")).toBeInTheDocument();
  });
  it("ignores the Enter that confirms an IME candidate (keyCode 229, isComposing already false)", () => {
    const { onSelect } = setup();
    fireEvent.keyDown(search(), { key: "Enter", keyCode: 229 });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(search(), { key: "Enter", isComposing: true });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("/w/alpha");
  });
  it("ignores IME navigation keys (keyCode 229) so a candidate ArrowDown does not move the highlight", () => {
    const { onSelect } = setup();
    for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown"]) {
      const notPrevented = fireEvent.keyDown(search(), { key: k, keyCode: 229 });
      expect(notPrevented).toBe(true);
    }
    fireEvent.keyDown(search(), { key: "ArrowDown", keyCode: 229 });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("/w/alpha");
  });
  it("highlights the currently selected repository when it opens", () => {
    const { onSelect } = setup(["/w/gamma"]);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("/w/gamma");
  });
  it("closes on Escape", () => {
    const { onClose } = setup();
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
