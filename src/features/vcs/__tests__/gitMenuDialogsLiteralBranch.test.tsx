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

import { _resetI18nForTests, setLocale, tx } from "@/platform/i18n";
import { VcsDialogHost } from "../dialogs";
import { showMergeDialog } from "../gitMenuDialogs";

const branch = (name: string) => ({ name, remote: false, current: false }) as Branch;

beforeEach(() => {
  mocks.branches.mockResolvedValue({ status: "ok", data: [branch("develop"), branch("dev"), branch("test")] });
});
afterEach(() => {
  cleanup();
  _resetI18nForTests();
});

describe("branch names in Select options", () => {
  it("are never translated: zh locale, typing 'dev' + Enter picks 'dev' and shows 'dev'", async () => {
    await setLocale("zh");
    // The zh catalog translates the words dev/test; a branch of that name must stay literal.
    expect(tx("dev")).not.toBe("dev");
    render(<VcsDialogHost />);
    showMergeDialog();
    await waitFor(() => expect(mocks.branches).toHaveBeenCalled());
    const trigger = await screen.findByRole("button", { name: tx("Branch to merge") });
    fireEvent.click(trigger);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(3));
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["dev", "develop", "test"]);
    fireEvent.change(input, { target: { value: "dev" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(trigger).toHaveTextContent(/^dev$/);
  });
});
