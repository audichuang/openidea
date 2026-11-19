import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const data = vi.hoisted(() => {
  const branch = (name: string, current = false) => ({
    name,
    current,
    remote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    lastCommitMs: null,
    commit: "1111111",
  });
  return {
    heads: { "/p/a": "main-a", "/p/b": "main-b" } as Record<string, string>,
    branches: {
      "/p/a": [branch("main-a", true), branch("dev"), branch("only-a")],
      "/p/b": [branch("main-b", true), branch("dev"), branch("only-b")],
    } as Record<string, ReturnType<typeof branch>[]>,
  };
});

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const ok = (value: unknown) => Promise.resolve({ status: "ok" as const, data: value });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsTags: () => ok([]),
      vcsBranches: (repo: string) => ok(data.branches[repo] ?? []),
    },
  };
});

import { BranchesPopupHost, showBranchesPopup, useBranchesPopup } from "../BranchWidget";
import { favoriteBranches, useFavoriteBranches } from "../branchOps";
import { BranchesPanel } from "../log/BranchesPanel";
import { registerLogPaneActions } from "../logPaneActions";
import { emptyFilters, useGitLog } from "../logStore";
import { useVcs } from "../store";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { hideContextMenu, useContextMenuStore } from "@/ui/Menu";

const RECENT = "openidea.vcs.recentBranches:";
const PROJECT_FAVORITES = "openidea.vcs.favoriteBranches:/p";

beforeEach(() => {
  // The popup lists the selected repository's own branches with branch operations on it alone
  // (upstream's "Execute branch operations on all repositories" off; on, it lists common ones).
  useProject.setState({
    project: { root: "/p" } as never,
    settings: { vcs: { git: { syncBranchOperations: false } } } as never,
  });
  useFavoriteBranches.setState({ byRepo: {} });
  useVcs.setState({
    available: true,
    root: "/p",
    roots: ["/p/a", "/p/b"],
    repo: "/p/a",
    heads: Object.fromEntries(Object.entries(data.heads).map(([root, head]) => [root, { head, headCommit: "1" }])),
    branch: { head: "main-a", headCommit: "1", upstream: null, ahead: 0, behind: 0, operation: null },
    branchesLoaded: true,
    branches: data.branches["/p/a"]!,
  });
});

afterEach(() => {
  useBranchesPopup.setState({ open: false });
  localStorage.clear();
});

const texts = (el: HTMLElement) =>
  within(el)
    .getAllByRole("option")
    .map((o) => o.textContent);

async function openPopup() {
  render(<BranchesPopupHost />);
  act(showBranchesPopup);
  const list = screen.getByRole("listbox", { name: "Repositories and branches" });
  await waitFor(() => expect(texts(list)).toContain("only-a"));
  return list;
}

async function openRepoSubmenu(list: HTMLElement, name: string) {
  const row = within(list)
    .getAllByRole("option")
    .find((o) => o.querySelector(`[data-row-key="repo:/p/${name}"]`))!;
  fireEvent.click(row);
  return screen.findByRole("dialog", { name: `Branches of ${name}` });
}

/** The rows between the `Recent…` group and the next group. */
function recentOf(rows: (string | null)[]): (string | null)[] {
  const from = rows.findIndex((t) => t?.startsWith("Recent"));
  if (from < 0) return [];
  const to = rows.findIndex((t, i) => i > from && t?.startsWith("Local"));
  return rows.slice(from + 1, to);
}

it("lists each repository's own recent branches, in the popup and in a repository's submenu", async () => {
  localStorage.setItem(`${RECENT}/p/a`, JSON.stringify(["only-a"]));
  localStorage.setItem(`${RECENT}/p/b`, JSON.stringify(["dev"]));
  const list = await openPopup();
  expect(recentOf(texts(list))).toEqual(["only-a"]);

  const submenu = await openRepoSubmenu(list, "b");
  expect(recentOf(texts(submenu))).toEqual(["dev"]);
});

it("stars a branch in the repository it is shown for, leaving the other repositories' favorites alone", async () => {
  const list = await openPopup();
  const submenu = await openRepoSubmenu(list, "b");
  const dev = within(submenu)
    .getAllByRole("option")
    .find((o) => o.textContent === "dev")!;
  fireEvent.click(within(dev).getByRole("button", { name: "Add to Favorites" }));

  const devOf = (el: HTMLElement) =>
    within(el)
      .getAllByRole("option")
      .find((o) => o.textContent === "dev")!;
  expect(within(devOf(submenu)).getByRole("button", { name: "Remove from Favorites" })).toBeInTheDocument();
  // The branch of the same name in repository a, listed in the popup itself, is not starred.
  expect(within(devOf(list)).getByRole("button", { name: "Add to Favorites" })).toBeInTheDocument();
  expect(favoriteBranches("/p/b")).toEqual(["dev"]);
  expect(favoriteBranches("/p/a")).toBeNull();
  expect(JSON.parse(localStorage.getItem("openidea.vcs.favoriteBranches.v2:/p/b")!)).toEqual(["dev"]);
});

it("keeps the favorites marked when there was one list per project, until a repository edits its own", async () => {
  localStorage.setItem(PROJECT_FAVORITES, JSON.stringify(["dev", "only-a"]));
  expect(favoriteBranches("/p/a")).toEqual(["dev", "only-a"]);
  expect(favoriteBranches("/p/b")).toEqual(["dev", "only-a"]);

  const list = await openPopup();
  const submenu = await openRepoSubmenu(list, "b");
  const dev = within(submenu)
    .getAllByRole("option")
    .find((o) => o.textContent === "dev")!;
  fireEvent.click(within(dev).getByRole("button", { name: "Remove from Favorites" }));

  expect(favoriteBranches("/p/b")).toEqual(["only-a"]);
  expect(favoriteBranches("/p/a")).toEqual(["dev", "only-a"]);
  expect(JSON.parse(localStorage.getItem(PROJECT_FAVORITES)!)).toEqual(["dev", "only-a"]);
});

it("keeps a repository's favorites from when it was opened as a project itself, with the project's", async () => {
  localStorage.setItem(PROJECT_FAVORITES, JSON.stringify(["dev"]));
  localStorage.setItem(`${PROJECT_FAVORITES}/b`, JSON.stringify(["only-b"]));
  expect(favoriteBranches("/p/b")).toEqual(["only-b", "dev"]);
  expect(favoriteBranches("/p/a")).toEqual(["dev"]);

  const list = await openPopup();
  const submenu = await openRepoSubmenu(list, "b");
  const dev = within(submenu)
    .getAllByRole("option")
    .find((o) => o.textContent === "dev")!;
  fireEvent.click(within(dev).getByRole("button", { name: "Remove from Favorites" }));

  // The repository's own list starts from both earlier lists, which stay as they were.
  expect(JSON.parse(localStorage.getItem("openidea.vcs.favoriteBranches.v2:/p/b")!)).toEqual(["only-b"]);
  expect(JSON.parse(localStorage.getItem(PROJECT_FAVORITES)!)).toEqual(["dev"]);
  expect(JSON.parse(localStorage.getItem(`${PROJECT_FAVORITES}/b`)!)).toEqual(["only-b"]);
});

it("stars another repository's branch found by the search with that repository's favorites", async () => {
  localStorage.setItem("openidea.vcs.favoriteBranches.v2:/p/b", JSON.stringify(["dev"]));
  const list = await openPopup();
  fireEvent.change(screen.getByLabelText("Search for branches, actions, repositories"), {
    target: { value: "dev" },
  });
  const devOf = (repo: string) =>
    within(list)
      .getAllByRole("option")
      .find((o) => o.querySelector(`[data-row-key="branch:/p/${repo}:local:dev"]`))!;
  await waitFor(() => expect(devOf("b")).toBeTruthy());
  expect(within(devOf("a")).getByRole("button", { name: "Add to Favorites" })).toBeInTheDocument();

  fireEvent.click(within(devOf("b")).getByRole("button", { name: "Remove from Favorites" }));
  expect(within(devOf("b")).getByRole("button", { name: "Add to Favorites" })).toBeInTheDocument();
  expect(favoriteBranches("/p/b")).toEqual([]);
  expect(favoriteBranches("/p/a")).toBeNull();
});

describe("a Git Log tab of a repository that is not the selected one", () => {
  const B_FAVORITES = "openidea.vcs.favoriteBranches.v2:/p/b";
  const A_FAVORITES = "openidea.vcs.favoriteBranches.v2:/p/a";
  let unregister: () => void;
  let listedInB: (typeof data.branches)[string];

  beforeEach(() => {
    unregister = registerLogPaneActions();
    setContext("vcsAvailable", true);
    listedInB = data.branches["/p/b"]!;
    // `main` is a favorite by default, until the repository's list is edited.
    data.branches["/p/b"] = [...listedInB, { ...listedInB[1]!, name: "main" }];
    useGitLog.setState({
      filters: emptyFilters(),
      shownLog: "of-b",
      logTabs: [{ id: "of-b", kind: "branch", target: "dev", repo: "/p/b" }],
    });
  });

  afterEach(() => {
    unregister();
    setContext("vcsAvailable", false);
    hideContextMenu();
    data.branches["/p/b"] = listedInB;
    useGitLog.setState({ logTabs: [], shownLog: "log" });
  });

  async function openPane() {
    render(<BranchesPanel />);
    await screen.findByText("only-b");
  }

  const expectOnlyBEdited = (names: string[]) => {
    expect(favoriteBranches("/p/b")).toEqual(names);
    expect(JSON.parse(localStorage.getItem(B_FAVORITES)!)).toEqual(names);
    expect(favoriteBranches("/p/a")).toBeNull();
    expect(localStorage.getItem(A_FAVORITES)).toBeNull();
    // Starring does not move the selection to the tab's repository either.
    expect(useVcs.getState().repo).toBe("/p/a");
  };

  it("stars a branch from the toolbar in the tab's repository, not in the selected one", async () => {
    await openPane();
    fireEvent.mouseDown(screen.getByText("dev"));
    fireEvent.click(screen.getByRole("button", { name: "Add to Favorites" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Remove from Favorites" })).toBeInTheDocument());
    expectOnlyBEdited(["main", "dev"]);
  });

  it("stars a branch from its context menu in the tab's repository, not in the selected one", async () => {
    await openPane();
    fireEvent.contextMenu(screen.getByText("dev"));
    const add = useContextMenuStore.getState().menu!.items.find((i) => "label" in i && i.label === "Add to Favorites");
    if (add && "run" in add) add.run?.();
    expectOnlyBEdited(["main", "dev"]);

    // The entry reads the same list it writes.
    fireEvent.contextMenu(screen.getByText("dev"));
    const labels = useContextMenuStore.getState().menu!.items.map((i) => ("label" in i ? i.label : null));
    expect(labels).toContain("Remove from Favorites");
  });
});
