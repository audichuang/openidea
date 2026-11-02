import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Branch } from "@/bindings";

const mocks = vi.hoisted(() => ({ branches: vi.fn(), merge: vi.fn() }));

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsBranches: mocks.branches, vcsMergeWith: mocks.merge } };
});
vi.mock("../ops", async (original) => {
  const real = await original<typeof import("../ops")>();
  return {
    ...real,
    saveAll: vi.fn(async () => undefined),
    runOp: vi.fn(async (_t: string, fn: () => Promise<unknown>) => void (await fn())),
  };
});
vi.mock("../store", async (original) => {
  const real = await original<typeof import("../store")>();
  return { ...real, refreshNow: vi.fn(async () => undefined) };
});

import { VcsDialogHost } from "../dialogs";
import { showMergeDialog } from "../gitMenuDialogs";

const branch = (name: string, remote = false) => ({ name, remote, current: false }) as Branch;

beforeEach(() => {
  mocks.branches.mockResolvedValue({
    status: "ok",
    data: [branch("main"), branch("feature/login"), branch("feature/logout"), branch("origin/release", true)],
  });
  mocks.merge.mockResolvedValue({ status: "ok", data: null });
});
afterEach(cleanup);

async function openBranchSelect() {
  render(<VcsDialogHost />);
  showMergeDialog();
  await waitFor(() => expect(mocks.branches).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole("button", { name: "Branch to merge" }));
  return screen.findByRole("textbox");
}

describe("Merge dialog branch chooser", () => {
  it("filters branches as you type and Enter picks the filtered branch", async () => {
    const input = await openBranchSelect();
    await waitFor(() => expect(within(screen.getByRole("listbox")).getAllByRole("option").length).toBe(4));
    fireEvent.change(input, { target: { value: "logout" } });
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["feature/logout"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Branch to merge" })).toHaveTextContent("feature/logout");
  });
});
