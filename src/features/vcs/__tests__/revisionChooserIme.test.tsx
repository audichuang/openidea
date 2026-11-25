import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Branch } from "@/bindings";

const mocks = vi.hoisted(() => ({ branches: vi.fn(), tags: vi.fn() }));

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsBranches: mocks.branches, vcsTags: mocks.tags } };
});

import { VcsDialogHost } from "../dialogs";
import { chooseRevision } from "../RevisionChooser";

const branch = (name: string) => ({ name, remote: false, current: false }) as Branch;

beforeEach(() => {
  mocks.branches.mockResolvedValue({ status: "ok", data: [branch("alpha"), branch("beta")] });
  mocks.tags.mockResolvedValue({ status: "ok", data: [] });
});
afterEach(cleanup);

describe("revision chooser", () => {
  it("ignores the Enter that confirms an IME candidate and IME navigation keys", async () => {
    render(<VcsDialogHost />);
    const result = vi.fn();
    void chooseRevision("Checkout", { repositories: ["/w/a"] }).then(result);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(result).toHaveBeenCalledWith("alpha"));
  });
});
