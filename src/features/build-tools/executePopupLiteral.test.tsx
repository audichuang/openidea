import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { GradleModel } from "@/bindings";
import { _resetI18nForTests, setLocale, tx } from "@/platform/i18n";
import { ExecutePopupHost } from "./ExecutePopup";
import { useBuild } from "./store";

afterEach(() => {
  cleanup();
  act(() => useBuild.setState({ executeOpen: null, model: null }));
  _resetI18nForTests();
});

describe("Execute Gradle Task project picker", () => {
  it("shows Gradle project names (folder names by default) untranslated in zh", async () => {
    await setLocale("zh");
    // The zh catalog translates the word dev; a project named after its folder must stay literal.
    expect(tx("dev")).not.toBe("dev");
    const gradle = {
      projects: [{ path: ":", name: "dev", dir: "", buildFile: null, tasks: [] }],
    } as unknown as GradleModel;
    act(() => useBuild.setState({ root: "/dev", model: { maven: null, gradle }, executeOpen: "gradle" }));
    render(<ExecutePopupHost />);
    expect(screen.getByRole("button", { name: tx("Project to run in") })).toHaveTextContent(/^dev$/);
  });
});
