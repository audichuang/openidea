import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useVcs } from "@/features/vcs/store";
import { provideEditorService, type EditorService } from "@/workbench/contributions";
import type { GHCommitFile, GHRepository, GHUser } from "../api/types";
import { useGhRepository } from "../data/repository";
import { ChangesTree } from "./ChangesTree";

const menu = vi.hoisted(() => vi.fn());
vi.mock("@/ui", async (original) => ({ ...(await original<typeof import("@/ui")>()), showContextMenu: menu }));

const file: GHCommitFile = {
  sha: "s",
  filename: "src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch: null,
  previousFilename: null,
};

afterEach(() => {
  cleanup();
  useGhRepository.setState({ connection: null });
  useVcs.setState({ roots: [], root: null, repo: null });
});

describe("ChangesTree", () => {
  it("Jump to Source opens the file in the connected repository, not the one selected in the VCS widgets", () => {
    const openFile = vi.fn();
    provideEditorService({ openFile } as unknown as EditorService);
    // The primary repository has no GitHub remote: the connection is the nested one's.
    useVcs.setState({ root: "/a", roots: ["/a", "/b"], repo: "/a" });
    useGhRepository.setState({
      connection: {
        coordinates: { owner: "o", name: "r" },
        repository: { id: "R1" } as GHRepository,
        currentUser: { login: "me" } as GHUser,
        root: "/b",
        remotes: [],
      },
    });
    render(<ChangesTree number={1} files={[file]} commitSha="c" viewedState={undefined} threads={[]} checkedOut />);
    fireEvent.contextMenu(screen.getByText("a.ts"));
    const items = menu.mock.calls.at(-1)![1] as Array<{ label?: string; run?: () => void }>;
    items.find((i) => i.label === "Jump to Source")!.run!();
    expect(openFile).toHaveBeenCalledWith("/b/src/a.ts", { focus: true });
  });
});
