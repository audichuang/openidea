import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import type { BlockHistorySummary, BlockRevision, BlockRevisionSpot } from "@/bindings";

const vcsBlockHistory = vi.fn();
const vcsBlockHistorySummary = vi.fn();
const vcsBlockHistoryRevisions = vi.fn();
const vcsBlockHistoryStreamed = vi.fn();
const vcsBlockHistorySpots = vi.fn();
const vcsBlockHistoryRevisionsAt = vi.fn();
const remoteSession = vi.fn<() => { commands: string[] } | null>(() => null);
const cancelRequest = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      vcsBlockHistorySummary: (...args: unknown[]) => vcsBlockHistorySummary(...args),
      vcsBlockHistoryStreamed: (...args: unknown[]) => vcsBlockHistoryStreamed(...args),
      vcsBlockHistoryRevisions: (...args: unknown[]) => vcsBlockHistoryRevisions(...args),
      vcsBlockHistory: (...args: unknown[]) => vcsBlockHistory(...args),
      vcsBlockHistorySpots: (...args: unknown[]) => vcsBlockHistorySpots(...args),
      vcsBlockHistoryRevisionsAt: (...args: unknown[]) => vcsBlockHistoryRevisionsAt(...args),
      cancelRequest: (id: number) => cancelRequest(id),
    },
  };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));
vi.mock("@/platform/remote", () => ({ useRemote: { getState: () => ({ session: remoteSession() }) } }));
vi.mock("../DiffEditor", () => ({
  DiffEditor: ({
    input,
  }: {
    input: { data: { left: { label: string; text: string }; right: { label: string; text: string } } };
  }) => (
    <div data-testid="diff">
      {`${input.data.left.label}: ${input.data.left.text}| ${input.data.right.label}: ${input.data.right.text}`}
    </div>
  ),
}));

import { SelectionHistoryEditor, blockOf, historyRows } from "../SelectionHistory";
import { selectedLines, selectionHistoryInput, type SelectionHistoryData } from "../selectionHistoryKind";

const revision = (id: string, summary: string, before: string, after: string): BlockRevision => ({
  id: id.repeat(40),
  shortId: id.repeat(7),
  author: "Ada",
  email: "ada@example.com",
  timeMs: 1_700_000_000_000,
  summary,
  path: "src/a.txt",
  before,
  after,
  beforeLine: 1,
  afterLine: 1,
});

const TEXT = "one\nTWO\nTHREE\nfour\n";
const first = revision("a", "Shout three", "TWO\nthree\n", "TWO\nTHREE\n");
const second = revision("b", "Shout two", "two\nthree\n", "TWO\nthree\n");
const anchor = { commit: "a".repeat(40), lines: [1, 2] as [number, number] };
const history: BlockHistorySummary = { anchor, revisions: [first, second], diffs: [first] };
const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
const summaryOf = ({ id, shortId, author, email, timeMs, summary }: BlockRevision) => ({
  id,
  shortId,
  author,
  email,
  timeMs,
  summary,
});

/** The streamed command: the first rows of `summary` on the channel, then `list` (default: its revisions). */
function streams(summary: BlockHistorySummary, list: Promise<unknown> = ok(summary.revisions)) {
  vcsBlockHistoryStreamed.mockImplementation(
    (_request, _path, _text, _lines, channel: { onmessage: (m: BlockHistorySummary) => void }) => {
      channel.onmessage({ ...summary, revisions: summary.revisions.slice(0, summary.diffs.length) });
      return list;
    },
  );
}

function open(data: SelectionHistoryData) {
  return render(<SelectionHistoryEditor input={selectionHistoryInput(data)} />);
}

beforeEach(() => {
  vcsBlockHistory.mockReset();
  vcsBlockHistorySummary.mockReset();
  vcsBlockHistoryRevisions.mockReset();
  vcsBlockHistoryStreamed.mockReset();
  vcsBlockHistorySpots.mockReset().mockReturnValue(new Promise(() => {}));
  vcsBlockHistoryRevisionsAt.mockReset();
  remoteSession.mockReset().mockReturnValue(null);
  cancelRequest.mockReset().mockReturnValue(ok(null));
});

describe("selected lines", () => {
  const doc = EditorState.create({ doc: "zero\none\ntwo\nthree\n" }).doc;
  it.each([
    ["the caret line without a selection", 6, 6, [1, 1]],
    ["every line the selection touches", 7, 11, [1, 2]],
    ["a selection backwards", 11, 7, [1, 2]],
    ["not the line a selection ends at the start of", 5, 13, [1, 2]],
    ["the line itself when selecting just its start", 9, 9, [2, 2]],
  ])("%s", (_, from, to, expected) => {
    expect(selectedLines(doc, Math.min(from, to), Math.max(from, to))).toEqual(expected);
  });
});

describe("rows", () => {
  it("cuts the block out of the text as Git prints it", () => {
    expect(blockOf(TEXT, [1, 2])).toBe("TWO\nTHREE\n");
    expect(blockOf("a\r\nb\r\n", [0, 1])).toBe("a\nb\n");
  });

  it("lists Local Changes only when the block differs from HEAD", () => {
    expect(historyRows(history, "TWO\nTHREE\n").map((r) => r.kind)).toEqual(["revision", "revision"]);
    const edited = historyRows(history, "TWO\nTHREE!\n");
    expect(edited[0]).toEqual({ kind: "local", head: "TWO\nTHREE\n", current: "TWO\nTHREE!\n" });
    expect(edited).toHaveLength(3);
    expect(historyRows({ anchor: null, revisions: [], diffs: [] }, "new\n")).toEqual([]);
  });
});

describe("History for Selection tab", () => {
  it("asks for the selected lines of the editor's text and diffs each commit's block", async () => {
    streams(history);
    vcsBlockHistoryRevisions.mockReturnValue(ok([second]));
    open({ path: "/p/src/a.txt", lines: [1, 2], text: "one\nTWO\nTHREE!\nfour\n" });
    await screen.findByText("Shout three");
    const [request, path, text, lines] = vcsBlockHistoryStreamed.mock.calls[0]!;
    expect([typeof request, path, text, lines]).toEqual(["number", "/p/src/a.txt", "one\nTWO\nTHREE!\nfour\n", [1, 2]]);
    expect(screen.getByText("a.txt:2-3")).toBeTruthy();
    // The unsaved edit comes first, against HEAD's block.
    expect(screen.getByTestId("diff").textContent).toBe("HEAD: TWO\nTHREE\n| Local Changes: TWO\nTHREE!\n");
    fireEvent.click(screen.getByText("Shout two"));
    await waitFor(() =>
      expect(screen.getByTestId("diff").textContent).toBe("bbbbbbb^: two\nthree\n| bbbbbbb: TWO\nthree\n"),
    );
    expect(screen.getByText(/^bbbbbbb · Ada · /)).toBeTruthy();
    expect(vcsBlockHistoryRevisions).toHaveBeenCalledWith(expect.any(Number), "/p/src/a.txt", anchor, 1, [second.id]);
    fireEvent.click(screen.getByText("Shout three"));
    fireEvent.click(screen.getByText("Shout two"));
    expect(vcsBlockHistoryRevisions).toHaveBeenCalledTimes(1);
  });

  it("ignores an older response after the user changes revision", async () => {
    streams(history);
    let complete!: (result: { status: string; data: BlockRevision[] }) => void;
    vcsBlockHistoryRevisions.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
    await screen.findByText("Shout two");
    fireEvent.click(screen.getByText("Shout two"));
    await waitFor(() => expect(vcsBlockHistoryRevisions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Shout three"));
    expect(cancelRequest).toHaveBeenCalledWith(vcsBlockHistoryRevisions.mock.calls[0]![0]);
    await act(async () => complete({ status: "ok", data: [second] }));
    expect(screen.getByTestId("diff").textContent).toBe("aaaaaaa^: TWO\nthree\n| aaaaaaa: TWO\nTHREE\n");
  });

  it("still shows revisions from a released remote server", async () => {
    remoteSession.mockImplementation(() => ({ commands: ["vcs_block_history"] }));
    vcsBlockHistory.mockReturnValue(ok({ headLines: [1, 2], revisions: [first, second] }));
    open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
    fireEvent.click(await screen.findByText("Shout two"));
    expect(screen.getByTestId("diff").textContent).toContain("bbbbbbb: TWO");
    expect(vcsBlockHistoryRevisions).not.toHaveBeenCalled();
  });

  it("says why there is nothing to show", async () => {
    streams({ anchor: null, revisions: [], diffs: [] });
    const { unmount } = open({ path: "/p/a.txt", lines: [0, 0], text: "new\n" });
    await screen.findByText("These lines are not committed yet");
    unmount();
    streams({ anchor, revisions: [], diffs: [] });
    open({ path: "/p/a.txt", lines: [0, 0], text: "old\n" });
    await screen.findByText("No commits changed these lines");
  });

  it("shows Git's error and cancels a request still running when closed", async () => {
    vcsBlockHistoryStreamed.mockReturnValueOnce(
      Promise.resolve({ status: "error", error: { kind: "internal", message: "fatal: bad range" } }),
    );
    const { unmount } = open({ path: "/p/a.txt", lines: [0, 0], text: "x\n" });
    await screen.findByText(/fatal: bad range/);
    unmount();
    expect(cancelRequest).not.toHaveBeenCalled();
    // Closed after the first rows, while Git still lists the rest.
    streams(history, new Promise(() => {}));
    const pending = open({ path: "/p/a.txt", lines: [1, 2], text: TEXT });
    await screen.findByText("Shout three");
    pending.unmount();
    expect(cancelRequest).toHaveBeenCalledWith(vcsBlockHistoryStreamed.mock.calls.at(-1)![0]);
  });

  it("shows the first rows while Git lists the rest, then every row without moving the selection", async () => {
    const third = revision("c", "Add", "", "two\nthree\n");
    const full: BlockHistorySummary = {
      anchor,
      revisions: [first, second, third].map(summaryOf),
      diffs: [first, second],
    };
    let complete!: (result: { status: string; data: unknown }) => void;
    streams(full, new Promise((resolve) => (complete = resolve)));
    open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
    fireEvent.click(await screen.findByText("Shout two"));
    expect(screen.queryByText("Add")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.getByTestId("diff").textContent).toBe("bbbbbbb^: two\nthree\n| bbbbbbb: TWO\nthree\n");
    await act(async () => complete({ status: "ok", data: full.revisions }));
    await screen.findByText("Add");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("diff").textContent).toBe("bbbbbbb^: two\nthree\n| bbbbbbb: TWO\nthree\n");
    expect(vcsBlockHistoryRevisions).not.toHaveBeenCalled();
  });

  it("takes the full list even when it arrives before the first rows", async () => {
    const third = revision("c", "Add", "", "two\nthree\n");
    const full = [first, second, third].map(summaryOf);
    let send!: () => void;
    vcsBlockHistoryStreamed.mockImplementation(
      (_request, _path, _text, _lines, channel: { onmessage: (m: BlockHistorySummary) => void }) => {
        send = () => channel.onmessage({ anchor, revisions: full.slice(0, 1), diffs: [first] });
        return ok(full);
      },
    );
    open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
    await waitFor(() => expect(vcsBlockHistoryStreamed).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText("Shout three")).toBeNull();
    act(() => send());
    await screen.findByText("Add");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("asks a server without the streamed command for the summary", async () => {
    remoteSession.mockImplementation(() => ({
      commands: ["vcs_block_history", "vcs_block_history_summary", "vcs_block_history_revisions"],
    }));
    vcsBlockHistorySummary.mockReturnValue(ok(history));
    open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
    await screen.findByText("Shout two");
    expect(vcsBlockHistoryStreamed).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  describe("deep rows", () => {
    const deep = ["c", "d", "e", "f"].map((id, i) => revision(id, `Edit ${i}`, `${id}\n`, `${id}!\n`));
    const all = [first, second, ...deep];
    const long: BlockHistorySummary = {
      anchor,
      revisions: all.map(summaryOf),
      diffs: [first, second, ...deep.slice(0, 2)],
    };
    const spotOf = (r: BlockRevision): BlockRevisionSpot => ({
      id: r.id,
      ranges: [{ path: "src/a.txt", start: 2, end: 3 }],
    });

    it("reads a deep row's diff from its spot once Git has walked past it", async () => {
      streams(long);
      let send!: (spots: BlockRevisionSpot[]) => void;
      vcsBlockHistorySpots.mockImplementation((_request, _path, _anchor, channel) => {
        send = (spots) => channel.onmessage(spots);
        return new Promise(() => {});
      });
      vcsBlockHistoryRevisionsAt.mockReturnValue(ok(deep.slice(3)));
      open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
      await screen.findByText("Edit 3");
      expect(vcsBlockHistorySpots).toHaveBeenCalledWith(expect.any(Number), "/p/src/a.txt", anchor, expect.anything());
      act(() => send(all.slice(0, 3).map(spotOf)));
      act(() => send(all.slice(3).map(spotOf)));
      fireEvent.click(screen.getByText("Edit 3"));
      await waitFor(() => expect(screen.getByTestId("diff").textContent).toBe("fffffff^: f\n| fffffff: f!\n"));
      expect(vcsBlockHistoryRevisionsAt).toHaveBeenCalledWith(
        expect.any(Number),
        "/p/src/a.txt",
        all.slice(5).map(spotOf),
      );
      expect(vcsBlockHistoryRevisions).not.toHaveBeenCalled();
    });

    it("walks down to rows Git has not reached yet, and to rows whose spot is unusable", async () => {
      streams(long);
      let send!: (spots: BlockRevisionSpot[]) => void;
      vcsBlockHistorySpots.mockImplementation((_request, _path, _anchor, channel) => {
        send = (spots) => channel.onmessage(spots);
        return new Promise(() => {});
      });
      vcsBlockHistoryRevisions.mockReturnValue(ok(deep.slice(3)));
      const pending = open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
      await screen.findByText("Edit 3");
      act(() => send([...all.slice(0, 5).map(spotOf), { id: deep[3]!.id, ranges: null }]));
      fireEvent.click(screen.getByText("Edit 3"));
      await waitFor(() => expect(screen.getByTestId("diff").textContent).toBe("fffffff^: f\n| fffffff: f!\n"));
      expect(vcsBlockHistoryRevisions).toHaveBeenCalledWith(expect.any(Number), "/p/src/a.txt", anchor, 5, [
        deep[3]!.id,
      ]);
      expect(vcsBlockHistoryRevisionsAt).not.toHaveBeenCalled();
      // Closing the tab stops the walk.
      pending.unmount();
      expect(cancelRequest).toHaveBeenCalledWith(vcsBlockHistorySpots.mock.calls[0]![0]);
    });

    it("does not ask a server without spots for them", async () => {
      remoteSession.mockImplementation(() => ({
        commands: ["vcs_block_history", "vcs_block_history_summary", "vcs_block_history_streamed"],
      }));
      streams(long);
      vcsBlockHistoryRevisions.mockReturnValue(ok(deep.slice(3)));
      open({ path: "/p/src/a.txt", lines: [1, 2], text: TEXT });
      fireEvent.click(await screen.findByText("Edit 3"));
      await waitFor(() => expect(vcsBlockHistoryRevisions).toHaveBeenCalled());
      expect(vcsBlockHistorySpots).not.toHaveBeenCalled();
    });
  });
});
