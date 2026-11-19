import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const { apply, list } = vi.hoisted(() => ({ apply: vi.fn(), list: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsStashes: list } };
});
vi.mock("../changeOps", async (original) => ({
  ...(await original<typeof import("../changeOps")>()),
  applyStash: apply,
}));
import { StashesPanel } from "../StashesPanel";
import { useVcs } from "../store";

const stash = (message: string, id = "s1") => ({ index: 0, message: `On main: ${message}`, timeMs: 0, id, base: "b" });
const ok = (data: unknown) => ({ status: "ok", data });

/** The next `vcsStashes` call stays pending until the returned function resolves it. */
function deferList() {
  let resolve!: (value: unknown) => void;
  list.mockImplementation(() => new Promise((done) => (resolve = done)));
  return (data: unknown) => act(async () => resolve(ok(data)));
}

beforeEach(() => {
  apply.mockReset();
  list.mockReset().mockResolvedValue(ok([stash("First")]));
  useVcs.setState({ root: "/p", roots: ["/p"], repo: "/p", version: 1 });
});

it("keeps the list up while a Git refresh reloads it", async () => {
  render(<StashesPanel />);
  const row = await screen.findByText("First");
  const finish = deferList();
  act(() => useVcs.setState({ version: 2 }));
  expect(list).toHaveBeenCalledTimes(2);
  expect(screen.getByText("First")).toBe(row);
  expect(screen.queryByText("Loading…")).toBeNull();
  // Git may have moved the indexes since: the stale rows take no actions.
  expect(screen.getByRole("button", { name: "Drop Stash" })).toBeDisabled();
  await finish([stash("First")]);
  expect(screen.getByText("First")).toBe(row);
  fireEvent.click(screen.getByRole("button", { name: "Apply Stash" }));
  expect(apply).toHaveBeenCalledWith(0, false, "/p");
});

it("shows the refreshed list once it arrives", async () => {
  render(<StashesPanel />);
  await screen.findByText("First");
  const finish = deferList();
  act(() => useVcs.setState({ version: 2 }));
  await finish([stash("Second", "s2")]);
  expect(screen.getByText("Second")).toBeInTheDocument();
  expect(screen.queryByText("First")).toBeNull();
  const done = deferList();
  act(() => useVcs.setState({ version: 3 }));
  await done([]);
  expect(screen.getByText("No stashes")).toBeInTheDocument();
  deferList();
  act(() => useVcs.setState({ version: 4 }));
  expect(screen.getByText("No stashes")).toBeInTheDocument();
});
