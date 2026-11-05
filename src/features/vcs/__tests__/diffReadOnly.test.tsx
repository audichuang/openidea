import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { EditorInput } from "@/workbench/contributions";
import type { FileStatus } from "@/bindings";

let working = "a\nb\n";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsProbe: () => Promise.resolve({ status: "ok", data: { size: 3, binary: false, tooLarge: false } }),
      vcsFileAt: () => Promise.resolve({ status: "ok", data: "a\n" }),
      fsReadText: () => Promise.resolve({ status: "ok", data: working }),
      vcsDiffHunks: () =>
        Promise.resolve([{ kind: "added", start: 1, lines: 1, oldStart: 1, oldLines: 0, oldText: "" }]),
    },
  };
});

vi.mock("@/editor/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/editor/api")>()),
  attachDocument: (path: string) =>
    Promise.resolve({
      path,
      text: () => working,
      readOnly: false,
      extension: [],
      save: () => Promise.resolve(),
      release: () => {},
    }),
}));

import { DiffEditor } from "../DiffEditor";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";

const file: FileStatus = { path: "/p/a.ts", relPath: "a.ts", staged: null, unstaged: "modified", renamedFrom: null };
const data = { path: "/p/a.ts", left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } };
const inputOf = (extra: object = {}) =>
  ({ kind: "diff", key: "diff:ro", data: { ...data, ...extra } }) as unknown as EditorInput;

beforeEach(() => {
  working = "a\nb\n";
  useVcs.setState({
    root: "/p",
    roots: ["/p"],
    repo: "/p",
    available: true,
    status: [file],
    byPath: new Map([[file.path, file]]),
  });
});

describe("DiffEditor readOnly preview", () => {
  it("control: a normal working-copy diff offers hunk inclusion, Revert and Stage", async () => {
    const { container } = render(<DiffEditor input={inputOf()} />);
    await waitFor(() => expect(container.querySelector(".cm-include-hunk")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Revert Change" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stage Change (git add hunk)" })).toBeTruthy();
  });

  it("renders no inclusion checkbox, Revert, Stage or arrows, and leaves useCommit alone", async () => {
    const before = useCommit.getState();
    const { container } = render(<DiffEditor input={inputOf({ readOnly: true })} />);
    await waitFor(() => expect(container.querySelectorAll(".cm-editor").length).toBeGreaterThan(0));
    await screen.findByRole("button", { name: "Refresh" });
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".cm-include-hunk")).toBeNull();
    expect(container.querySelector(".cm-include-gutter")).toBeNull();
    expect(screen.queryByRole("button", { name: "Revert Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stage Change (git add hunk)" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Revert$/ })).toBeNull();
    expect(container.querySelector(".cm-content[contenteditable='true']")).toBeNull();
    expect(useCommit.getState()).toBe(before);
  });
});
