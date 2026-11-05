import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FileStatus } from "@/bindings";

const mocks = vi.hoisted(() => ({ ipc: vi.fn(), shelve: vi.fn(), mounts: 0 }));
vi.mock("../DiffEditor", async () => {
  const React = await import("react");
  return {
    DiffEditor: ({ input }: { input: { path: string } }) => {
      const [id] = React.useState(() => ++mocks.mounts);
      return (
        <div
          data-testid="diff-preview"
          data-mount={id}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.preventDefault();
          }}
        >
          {input.path}
        </div>
      );
    },
  };
});
vi.mock("../ops", async (original) => ({
  ...(await original<typeof import("../ops")>()),
  runOp: (_title: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  call: mocks.ipc,
  commands: {
    ...(await original<typeof import("@/platform/ipc")>()).commands,
    vcsShelve: mocks.shelve,
    vcsShelves: () => Promise.resolve(null),
  },
}));
import { shelveChanges } from "../shelf";
import { useVcs } from "../store";
import { VcsDialogHost } from "../dialogs";

const fs = (path: string, unstaged: FileStatus["unstaged"] = "modified"): FileStatus => ({
  path,
  relPath: path.slice("/repo/".length),
  staged: null,
  unstaged,
  renamedFrom: null,
});
const status = [fs("/repo/src/a.ts"), fs("/repo/src/b.ts"), fs("/repo/README.md")];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mounts = 0;
  mocks.ipc.mockResolvedValue({ id: "x", name: "n", files: [], timeMs: 0, branch: null, repo: null });
  useVcs.setState({ root: "/repo", roots: ["/repo"], repo: "/repo", available: true, status });
});
afterEach(cleanup);

describe("Shelve Changes dialog", () => {
  it("shows the changes by directory and previews the selected file's diff", async () => {
    render(<VcsDialogHost />);
    act(() => shelveChanges(status.map((f) => f.path)));
    expect(await screen.findByText("src")).toBeTruthy();
    expect(screen.getByText("2 files")).toBeTruthy();
    expect(screen.getByTestId("diff-preview").textContent).toBe("/repo/src/a.ts");
    fireEvent.mouseDown(screen.getByText("README.md"), { button: 0 });
    expect(screen.getByTestId("diff-preview").textContent).toBe("/repo/README.md");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.shelve).not.toHaveBeenCalled();
  });

  it("excludes a folder through its checkbox and shelves only the remaining files", async () => {
    render(<VcsDialogHost />);
    act(() => shelveChanges(status.map((f) => f.path)));
    const folder = await screen.findByRole("checkbox", { name: "Include src" });
    expect(folder.getAttribute("aria-checked")).toBe("true");
    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Include a.ts" }), { button: 0 });
    expect(folder.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.mouseDown(folder, { button: 0 });
    expect(folder.getAttribute("aria-checked")).toBe("true");
    fireEvent.mouseDown(folder, { button: 0 });
    expect(folder.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("1 of 3 files will be shelved and reverted in the working tree.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Shelve Changes" }));
    await waitFor(() => expect(mocks.shelve).toHaveBeenCalledWith("Uncommitted changes", ["/repo/README.md"]));
  });

  it("remounts the preview editor per file so a late result cannot leak into the next file", async () => {
    render(<VcsDialogHost />);
    act(() => shelveChanges(status.map((f) => f.path)));
    await screen.findByText("src");
    const first = screen.getByTestId("diff-preview").getAttribute("data-mount");
    fireEvent.mouseDown(screen.getByText("README.md"), { button: 0 });
    expect(screen.getByTestId("diff-preview").getAttribute("data-mount")).not.toBe(first);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });

  it("keeps Enter and an already-handled Escape inside the preview from reaching the dialog", async () => {
    render(<VcsDialogHost />);
    act(() => shelveChanges(status.map((f) => f.path)));
    await screen.findByText("src");
    const pane = screen.getByTestId("diff-preview");
    pane.focus();
    fireEvent.keyDown(pane, { key: "Enter" });
    expect(mocks.shelve).not.toHaveBeenCalled();
    fireEvent.keyDown(pane, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Shelve Changes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });
});
