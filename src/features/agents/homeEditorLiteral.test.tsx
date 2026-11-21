import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentProvider, Branch, ProjectInfo } from "@/bindings";

const mocks = vi.hoisted(() => ({ branches: vi.fn(), info: vi.fn(), commands: vi.fn() }));

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: vi.fn(() => false),
    commands: {
      ...real.commands,
      agentCommands: mocks.commands,
      vcsBranchInfo: mocks.info,
      vcsBranches: mocks.branches,
    },
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { _resetI18nForTests, setLocale, tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { HomeEditor } from "./HomeEditor";
import { HOME, updateComposer, useAgents } from "./store";
import { emptyDraft } from "./composerModel";

const claude: AgentProvider = {
  id: "claude",
  name: "Claude Code",
  command: "npx",
  installed: true,
  env: {},
  config: [],
  source: { kind: "builtin" },
  program: "npx",
  args: [],
  defaultProgram: "npx",
  defaultArgs: [],
  loginHint: null,
  commandOverridden: false,
  commandEditable: true,
  commandReadOnlyReason: null,
  commands: [],
};
const branch = (name: string) => ({ name, remote: false, current: name === "dev" }) as Branch;
const project = {
  root: "/ws",
  name: "Workspace",
  trusted: true,
  isGit: true,
  workspace: { version: 1, name: "Workspace", projects: ["/ws/dev", "/ws/test"] },
} as ProjectInfo;

const optionTexts = () =>
  within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((o) => o.textContent);

beforeEach(() => {
  mocks.commands.mockResolvedValue({ status: "ok", data: [] });
  mocks.info.mockResolvedValue({ status: "ok", data: { head: "dev" } });
  mocks.branches.mockResolvedValue({ status: "ok", data: [branch("dev"), branch("test")] });
  useProject.setState({ project });
  useAgents.setState({
    providers: [claude],
    draft: { provider: "claude", config: {}, isolation: "worktree", base: null, projectRoot: "/ws/dev" },
  });
  updateComposer(HOME, emptyDraft());
});
afterEach(() => {
  cleanup();
  _resetI18nForTests();
  useProject.setState({ project: null });
});

describe("New Task pickers", () => {
  it("show project folder and branch names untranslated in zh", async () => {
    await setLocale("zh");
    // The zh catalog translates the words dev/test; folder and branch names must stay literal.
    expect(tx("dev")).not.toBe("dev");
    render(<HomeEditor />);

    const projectPicker = screen.getByRole("button", { name: tx("Project") });
    expect(projectPicker).toHaveTextContent(/^dev$/);
    fireEvent.click(projectPicker);
    expect(optionTexts()).toEqual(["dev/ws/dev", "test/ws/test"]);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

    const basePicker = await screen.findByRole("button", { name: tx("Base branch") });
    expect(basePicker).toHaveTextContent(/^dev$/);
    fireEvent.click(basePicker);
    await waitFor(() => expect(optionTexts()).toEqual(["dev", "test"]));
  });
});
