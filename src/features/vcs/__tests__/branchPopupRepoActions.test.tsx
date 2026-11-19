import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeAction: vi.fn() }));

vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: mocks.executeAction,
}));

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  const branch = (name: string) => ({
    name,
    current: true,
    remote: false,
    upstream: `origin/${name}`,
    ahead: 0,
    behind: 0,
    lastCommitMs: null,
    commit: "1111111",
  });
  const head = (root: string) => (root === "/p/b" ? "feat-b" : "main");
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsTags: () => ok([]),
      vcsBranches: (repo: string) => ok([branch(head(repo))]),
      vcsBranchInfo: (repo: string) =>
        ok({ head: head(repo), headCommit: "1111111", upstream: null, ahead: 0, behind: 0, operation: null }),
      vcsStashes: () => ok([]),
      vcsStatus: () => ok([]),
      vcsRoots: () =>
        ok(["/p/a", "/p/b"].map((root) => ({ root, head: head(root), headCommit: "1111111", operation: null }))),
    },
  };
});

import { BranchesPopupHost, showBranchesPopup, useBranchesPopup } from "../BranchWidget";
import { useVcs } from "../store";
import { useProject } from "@/platform/project";

beforeEach(() => {
  mocks.executeAction.mockReset();
  useProject.setState({ project: { root: "/p" } as never });
  useVcs.setState({
    available: true,
    root: "/p",
    roots: ["/p/a", "/p/b"],
    repo: "/p/a",
    heads: { "/p/a": { head: "main", headCommit: "1111111" }, "/p/b": { head: "feat-b", headCommit: "1111111" } },
    branchesLoaded: false,
    branches: [],
  });
});

afterEach(() => {
  useBranchesPopup.setState({ open: false });
  localStorage.clear();
});

async function openRepoSubmenu(name: string) {
  render(<BranchesPopupHost />);
  act(showBranchesPopup);
  const list = screen.getByRole("listbox", { name: "Repositories and branches" });
  const row = await waitFor(() => {
    const option = within(list)
      .getAllByRole("option")
      .find((o) => o.querySelector(`[data-row-key="repo:/p/${name}"]`));
    if (!option) throw new Error(`no row of repository ${name}`);
    return option;
  });
  fireEvent.click(row);
  return screen.findByRole("dialog", { name: `Branches of ${name}` });
}

it.each([
  ["Update", "vcs.update"],
  ["Push…", "vcs.push"],
])("offers %s for that repository alone in a repository's submenu", async (label, action) => {
  const submenu = await openRepoSubmenu("b");
  const rows = within(submenu)
    .getAllByRole("option")
    .map((o) => o.textContent);
  // Above New Branch….
  expect(rows.slice(0, 2)).toEqual(["Update", "Push…"]);
  expect(rows.indexOf("Update")).toBeLessThan(rows.findIndex((t) => t?.startsWith("New Branch…")));

  fireEvent.click(within(submenu).getByText(label));
  await waitFor(() => expect(mocks.executeAction).toHaveBeenCalledWith(action, { repo: "/p/b" }));
  // The repository is selected first, so the dialog reads its branch.
  expect(useVcs.getState().repo).toBe("/p/b");
});
