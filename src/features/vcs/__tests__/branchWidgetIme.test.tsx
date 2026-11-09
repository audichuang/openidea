import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Branch, BranchInfo } from "@/bindings";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), branches: vi.fn(), tags: vi.fn() }));

vi.mock("@/platform/actions", async (original) => {
  const real = await original<typeof import("@/platform/actions")>();
  return { ...real, executeAction: mocks.execute };
});
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsBranches: mocks.branches, vcsTags: mocks.tags } };
});

import { BranchesPopupHost, BranchWidget, useBranchesPopup } from "../BranchWidget";
import { useVcs } from "../store";

const branch = (name: string) => ({ name, remote: false, current: name === "main" }) as Branch;
const info = { head: "main", headCommit: "abc", upstream: null, ahead: 0, behind: 0, operation: null } as BranchInfo;

function setupStore(roots: string[]) {
  const heads = Object.fromEntries(roots.map((r) => [r, { head: "main", headCommit: "abc" }]));
  useVcs.setState({
    available: true,
    roots,
    repo: roots[0]!,
    root: roots[0]!,
    branch: info,
    heads,
    branches: [branch("main"), branch("dev")],
    branchesLoaded: true,
    status: [],
  } as never);
}

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.branches.mockResolvedValue({ status: "ok", data: [branch("main"), branch("dev")] });
  mocks.tags.mockResolvedValue({ status: "ok", data: [] });
});
afterEach(() => {
  cleanup();
  useBranchesPopup.setState({ open: false });
});

async function openPopup() {
  render(
    <>
      <BranchWidget />
      <BranchesPopupHost />
    </>,
  );
  useBranchesPopup.setState({ open: true });
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
  return input;
}

describe.each([
  ["single repository", ["/w/a"]],
  ["several repositories", ["/w/a", "/w/b"]],
])("branches popup (%s)", (_name, roots) => {
  it("does not run the active row on the Enter that confirms an IME candidate", async () => {
    setupStore(roots);
    const input = await openPopup();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    // Running an action is async in the single-repository panel: let it settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.execute).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
  });
});
