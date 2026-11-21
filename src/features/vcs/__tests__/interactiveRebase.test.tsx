import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Commit, GitOperation } from "@/bindings";

const mocks = vi.hoisted(() => ({
  virtualizerKeys: [] as Array<(index: number) => unknown>,
  history: [] as Commit[],
  operations: [] as Array<{ repo: string | null; op: GitOperation }>,
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (line: string) => void = () => {};
  },
}));

vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tanstack/react-virtual")>();
  return {
    ...real,
    useVirtualizer: (options: Parameters<typeof real.useVirtualizer>[0]) => {
      mocks.virtualizerKeys.push(options.getItemKey as (index: number) => unknown);
      return real.useVirtualizer(options);
    },
  };
});

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: () => ok(mocks.history),
      vcsBranchInfo: () =>
        ok({
          head: "feature",
          headCommit: mocks.history[0]?.id ?? null,
          upstream: null,
          ahead: 0,
          behind: 0,
          operation: null,
        }),
      vcsOperation: (repo: string | null, _request: number, op: GitOperation) => {
        mocks.operations.push({ repo, op });
        return ok(null);
      },
    },
  };
});

import { VcsDialogHost } from "../dialogs";
import { interactivelyRebaseFrom } from "../rebase";
import { useVcs } from "../store";

/** Builds a linear history of `count` commits plus one base commit, newest first (as `git log` returns). */
function makeHistory(count: number): { base: Commit; commits: Commit[]; history: Commit[] } {
  // Put the unique counter in the first 8 hex chars so `short(id)` / `aria-label` is unique per commit.
  const hex = (n: number) => n.toString(16).padStart(8, "0").padEnd(40, "a");
  const baseId = hex(0);
  const base: Commit = {
    id: baseId,
    shortId: baseId.slice(0, 8),
    parents: [],
    author: "Dev",
    email: "dev@example.com",
    committer: "Dev",
    committerEmail: "dev@example.com",
    timeMs: 1_700_000_000_000,
    commitTimeMs: 1_700_000_000_000,
    summary: "Initial base commit",
    message: "Initial base commit",
    messageTruncated: false,
    refs: [],
  };
  // Oldest to newest: commits[0] has parent base, commits[k] has parent commits[k - 1].
  const commits: Commit[] = [];
  for (let i = 1; i <= count; i++) {
    const id = hex(i);
    const parent = i === 1 ? baseId : hex(i - 1);
    commits.push({
      id,
      shortId: id.slice(0, 8),
      parents: [parent],
      author: "Dev",
      email: "dev@example.com",
      committer: "Dev",
      committerEmail: "dev@example.com",
      timeMs: 1_700_000_000_000 + i * 1000,
      commitTimeMs: 1_700_000_000_000 + i * 1000,
      summary: `Commit message #${i}`,
      message: `Commit message #${i}`,
      messageTruncated: false,
      refs: [],
    });
  }
  const history = [...commits].reverse();
  return { base, commits, history };
}

async function openRebase(count: number, mountHost = true) {
  const data = makeHistory(count);
  mocks.history = data.history;
  if (mountHost) render(<VcsDialogHost />);
  await act(() => interactivelyRebaseFrom(data.commits[0]!));
  const list = await screen.findByRole("list", { name: "Commits to rebase" });
  return { ...data, list };
}

async function chooseAction(commitId: string, actionLabel: string) {
  const trigger = screen.getByRole("button", { name: `Action for ${commitId.slice(0, 8)}` });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: actionLabel }));
}

function scrollToBottom(list: HTMLElement) {
  const sizer = list.firstElementChild as HTMLElement | null;
  const height = sizer ? parseFloat(sizer.style.height) : 0;
  list.scrollTop = Number.isFinite(height) && height > 0 ? height : 1_000_000;
  fireEvent.scroll(list);
}

function scrollToTop(list: HTMLElement) {
  list.scrollTop = 0;
  fireEvent.scroll(list);
}

beforeEach(() => {
  mocks.history = [];
  mocks.operations = [];
  mocks.virtualizerKeys = [];
  useVcs.setState({
    root: "/p",
    roots: ["/p"],
    repo: null,
    branch: { head: "feature", headCommit: null, upstream: null, ahead: 0, behind: 0, operation: null },
    available: false,
    remoteBusy: null,
  });
});

afterEach(() => {
  for (const cancel of screen.queryAllByRole("button", { name: "Cancel" })) fireEvent.click(cancel);
});

describe("InteractiveRebaseDialog", () => {
  it("bounds mounted row Selects to the viewport instead of growing with commit count", async () => {
    const first = await openRebase(200);
    const selectsAt200 = first.list.querySelectorAll('button[aria-haspopup="listbox"]').length;
    const rowsAt200 = within(first.list).getAllByRole("listitem").length;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const second = await openRebase(2_000, false);
    const selectsAt2000 = second.list.querySelectorAll('button[aria-haspopup="listbox"]').length;
    const rowsAt2000 = within(second.list).getAllByRole("listitem").length;

    // Virtualization must cap mounted controls to viewport + overscan, well below total commits.
    expect(selectsAt200).toBeGreaterThan(0);
    expect(selectsAt200).toBeLessThan(60);
    expect(rowsAt200).toBeLessThan(60);
    expect(selectsAt2000).toBeGreaterThan(0);
    expect(selectsAt2000).toBeLessThan(60);
    expect(rowsAt2000).toBeLessThan(60);
  });

  it("keeps the virtualizer key function stable across edits and replaces it only when rows are reordered", async () => {
    const { commits, list } = await openRebase(6);
    const lastKey = () => mocks.virtualizerKeys[mocks.virtualizerKeys.length - 1]!;
    const initial = lastKey();

    await chooseAction(commits[1]!.id, "Reword");
    fireEvent.change(screen.getByLabelText(`New message for ${commits[1]!.id.slice(0, 8)}`), {
      target: { value: "typed" },
    });
    expect(lastKey()).toBe(initial);

    fireEvent.click(within(within(list).getAllByRole("listitem")[2]!).getByRole("button", { name: "Move Up" }));
    expect(lastKey()).not.toBe(initial);
    expect(lastKey()(1)).toBe(commits[2]!.id);
    expect(lastKey()(2)).toBe(commits[1]!.id);
  });

  it("supports per-row action selection, validation, reordering, and submitting the exact plan", async () => {
    const { base, commits, list } = await openRebase(4);

    // Initially a noop: Start Rebasing is disabled.
    const startBtn = screen.getByRole("button", { name: "Start Rebasing" });
    expect(startBtn).toBeDisabled();

    // First row cannot move up; last row cannot move down.
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByRole("button", { name: "Move Up" })).toBeDisabled();
    expect(within(rows[0]!).getByRole("button", { name: "Move Down" })).toBeEnabled();
    expect(within(rows[3]!).getByRole("button", { name: "Move Down" })).toBeDisabled();

    // Choosing Squash on the first commit reports a validation error and keeps Start Rebasing disabled.
    await chooseAction(commits[0]!.id, "Squash");
    expect(screen.getByText(/first commit cannot be squashed/i)).toBeInTheDocument();
    expect(startBtn).toBeDisabled();

    // Switch commit 0 to Drop (strikethrough), commit 1 to Reword, commit 2 to Fixup, commit 3 to Stop to Edit.
    await chooseAction(commits[0]!.id, "Drop");
    expect(screen.getByText("Commit message #1")).toHaveStyle({ textDecoration: "line-through" });

    await chooseAction(commits[1]!.id, "Reword");
    const textarea = screen.getByLabelText(`New message for ${commits[1]!.id.slice(0, 8)}`);
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(screen.getByText(/reworded commit needs a message/i)).toBeInTheDocument();
    expect(startBtn).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "  Updated commit #2  " } });
    expect(screen.queryByText(/reworded commit needs a message/i)).toBeNull();

    await chooseAction(commits[2]!.id, "Fixup");
    await chooseAction(commits[3]!.id, "Stop to Edit");

    // Reorder: move commit 3 up by one slot (swapping indices 2 and 3).
    const moveUpLast = within(within(list).getAllByRole("listitem")[3]!).getByRole("button", { name: "Move Up" });
    moveUpLast.focus();
    fireEvent.click(moveUpLast);
    expect(document.activeElement).toBe(moveUpLast);

    expect(startBtn).toBeEnabled();
    fireEvent.click(startBtn);

    await waitFor(() => expect(mocks.operations).toHaveLength(1));
    expect(mocks.operations[0]).toEqual({
      repo: null,
      op: {
        op: "interactiveRebase",
        base: base.id,
        entries: [
          { commit: commits[0]!.id, action: "drop", message: null },
          { commit: commits[1]!.id, action: "reword", message: "Updated commit #2" },
          { commit: commits[3]!.id, action: "edit", message: null },
          { commit: commits[2]!.id, action: "fixup", message: null },
        ],
      },
    });
  });

  it("handles 5,000 commits with bounded DOM, preserves edits across scroll, and lets the last commit be edited and submitted", async () => {
    const { base, commits, list } = await openRebase(5_000);

    // Bounded mounted row controls even at 5,000 commits.
    expect(list.querySelectorAll('button[aria-haspopup="listbox"]').length).toBeLessThan(60);

    // Initial focus lands on the first row's action Select button.
    const firstCommit = commits[0]!;
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: `Action for ${firstCommit.id.slice(0, 8)}` }),
    );

    // ARIA set size reflects all 5,000 commits.
    const initialItems = within(list).getAllByRole("listitem");
    expect(initialItems[0]).toHaveAttribute("aria-posinset", "1");
    expect(initialItems[0]).toHaveAttribute("aria-setsize", "5000");

    // Edit the first commit (reword), scroll to the very last commit, edit and reorder it, then verify both survive.
    const secondLastCommit = commits[4_998]!;
    const lastCommit = commits[4_999]!;

    await chooseAction(firstCommit.id, "Reword");
    fireEvent.change(screen.getByLabelText(`New message for ${firstCommit.id.slice(0, 8)}`), {
      target: { value: "Reworded first commit" },
    });

    // Scroll all the way to the last commit (commit #5000).
    scrollToBottom(list);
    await waitFor(() => {
      expect(screen.getByText("Commit message #5000")).toBeInTheDocument();
    });
    // First commit was unmounted while scrolled to the end.
    expect(screen.queryByText("Commit message #1")).toBeNull();

    const lastRow = screen.getByText("Commit message #5000").closest('[role="listitem"]') as HTMLElement;
    expect(lastRow).toHaveAttribute("aria-posinset", "5000");
    expect(lastRow).toHaveAttribute("aria-setsize", "5000");
    expect(within(lastRow).getByRole("button", { name: "Move Down" })).toBeDisabled();
    expect(within(lastRow).getByRole("button", { name: "Move Up" })).toBeEnabled();

    // Edit and move up the last commit.
    await chooseAction(lastCommit.id, "Reword");
    fireEvent.change(screen.getByLabelText(`New message for ${lastCommit.id.slice(0, 8)}`), {
      target: { value: "Reworded commit #5000" },
    });
    const lastRewordRow = screen
      .getByLabelText(`New message for ${lastCommit.id.slice(0, 8)}`)
      .closest('[role="listitem"]') as HTMLElement;
    fireEvent.click(within(lastRewordRow).getByRole("button", { name: "Move Up" }));

    // Scroll back to the top and verify the first commit's reword message survived unmount/remount.
    scrollToTop(list);
    await waitFor(() => {
      expect(screen.getByLabelText(`New message for ${firstCommit.id.slice(0, 8)}`)).toHaveValue(
        "Reworded first commit",
      );
    });

    // Submit and verify the exact 5,000-entry plan.
    fireEvent.click(screen.getByRole("button", { name: "Start Rebasing" }));
    await waitFor(() => expect(mocks.operations).toHaveLength(1));

    const submitted = mocks.operations[0]!.op;
    expect(submitted.op).toBe("interactiveRebase");
    if (submitted.op !== "interactiveRebase") throw new Error("unexpected op");
    expect(submitted.base).toBe(base.id);
    expect(submitted.entries).toHaveLength(5_000);
    expect(submitted.entries[0]).toEqual({
      commit: firstCommit.id,
      action: "reword",
      message: "Reworded first commit",
    });
    expect(submitted.entries[2_500]).toEqual({
      commit: commits[2_500]!.id,
      action: "pick",
      message: null,
    });
    expect(submitted.entries[4_998]).toEqual({
      commit: lastCommit.id,
      action: "reword",
      message: "Reworded commit #5000",
    });
    expect(submitted.entries[4_999]).toEqual({
      commit: secondLastCommit.id,
      action: "pick",
      message: null,
    });
  });

  it("supports keyboard Select shortcuts, all-dropped validation, and autosquash ordering", async () => {
    const data = makeHistory(3);
    // Make commit #3 a fixup of commit #1 to verify autosquash ordering stays intact.
    data.commits[2]!.summary = "fixup! Commit message #1";
    data.commits[2]!.message = "fixup! Commit message #1";
    mocks.history = [...data.commits].reverse();

    render(<VcsDialogHost />);
    await act(() => interactivelyRebaseFrom(data.commits[0]!));
    const list = await screen.findByRole("list", { name: "Commits to rebase" });

    // Autosquash placed commit #3 right after commit #1 with action Fixup.
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Commit message #1")).toBeInTheDocument();
    expect(within(items[1]!).getByText("fixup! Commit message #1")).toBeInTheDocument();
    expect(
      within(items[1]!).getByRole("button", { name: `Action for ${data.commits[2]!.id.slice(0, 8)}` }),
    ).toHaveTextContent("Fixup");

    // Keyboard interaction on Select: ArrowDown opens listbox, typing 'd' + Enter chooses Drop.
    const thirdTrigger = screen.getByRole("button", { name: `Action for ${data.commits[1]!.id.slice(0, 8)}` });
    thirdTrigger.focus();
    fireEvent.keyDown(thirdTrigger, { key: "ArrowDown" });
    const popupInner = (await screen.findByRole("listbox", { name: `Action for ${data.commits[1]!.id.slice(0, 8)}` }))
      .parentElement as HTMLElement;
    fireEvent.keyDown(popupInner, { key: "d" });
    fireEvent.keyDown(popupInner, { key: "Enter" });
    expect(thirdTrigger).toHaveTextContent("Drop");

    // Dropping every commit surfaces the validation error and disables Start Rebasing.
    await chooseAction(data.commits[0]!.id, "Drop");
    await chooseAction(data.commits[2]!.id, "Drop");
    expect(screen.getByText(/at least one commit must be kept/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Rebasing" })).toBeDisabled();

    // Cancel closes the dialog without running a rebase.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("list", { name: "Commits to rebase" })).toBeNull();
    expect(mocks.operations).toEqual([]);
  });
});
