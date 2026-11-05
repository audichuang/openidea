import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChangesTree } from "../CommitView";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";

beforeEach(() => {
  useVcs.setState({
    root: "/p",
    roots: ["/p"],
    status: [{ path: "/p/note.txt", relPath: "note.txt", staged: null, unstaged: "modified", renamedFrom: null }],
  });
  useCommit.setState({ groupByDir: false, checks: new Map(), selection: [] });
});

const fileRow = () => screen.queryByRole("treeitem", { name: /note\.txt/ });

describe("change tree expansion", () => {
  it("drops the choices made in a grouping once the grouping changes, even after switching back", () => {
    render(<ChangesTree mode="commit" />);
    expect(fileRow()).not.toBeNull();
    const tree = screen.getByRole("tree", { name: "Changes" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "Home" });
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(fileRow()).toBeNull();

    // A → B (no choice made in B) → A: A's collapsed group must not come back.
    act(() => useCommit.setState({ groupByDir: true }));
    act(() => useCommit.setState({ groupByDir: false }));
    expect(fileRow()).not.toBeNull();
  });
});
