import { afterEach, beforeEach, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ChangesTree } from "../CommitView";
import { useCommit } from "../commitStore";
import { forkShelveButton } from "../forkShelveButton";
import { useVcs } from "../store";

beforeEach(() => {
  useVcs.setState({
    root: "/p",
    roots: ["/p"],
    status: [{ path: "/p/note.txt", relPath: "note.txt", staged: null, unstaged: "modified", renamedFrom: null }],
  });
  useCommit.setState({ groupByDir: false, checks: new Map(), selection: [] });
});
afterEach(() => {
  forkShelveButton.upstream = false;
});

// No action is registered here, so each button is labelled with its action id.
const tools = () =>
  within(screen.getByRole("toolbar", { name: "Changes" }))
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label"));

it("keeps the fork's Shelve right after Show Diff by default (#437)", () => {
  render(<ChangesTree mode="local" />);
  const ids = tools();
  expect(ids).toContain("vcs.shelve");
  expect(ids).not.toContain("vcs.shelveSilently");
  expect(ids.indexOf("vcs.shelve")).toBe(ids.indexOf("vcs.showDiff") + 1);
});

it("shows upstream's Shelve Silently behind the switch", () => {
  forkShelveButton.upstream = true;
  render(<ChangesTree mode="local" />);
  const ids = tools();
  expect(ids).toContain("vcs.shelveSilently");
  expect(ids).not.toContain("vcs.shelve");
});
