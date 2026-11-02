import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setTheme = vi.fn(async (_t: unknown) => undefined);
const setBackgroundColor = vi.fn(async (_c: unknown) => undefined);

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ setTheme, setBackgroundColor }),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true };
});

import { useProject } from "@/platform/project";
import { useApplyTheme, useThemeOverride } from "./theme";

const appearance = (a: Record<string, unknown>) => useProject.setState({ settings: { appearance: a } } as never);
const last = () => setTheme.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
    getPropertyValue: () => "#eee8d5",
  } as unknown as CSSStyleDeclaration);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useThemeOverride.setState({ theme: null });
  useProject.setState({ settings: null } as never);
  delete document.documentElement.dataset.theme;
});

describe("native appearance follows Sync with OS", () => {
  it("re-sends setTheme when Sync with OS toggles but the resolved theme id stays the same", () => {
    // jsdom has no matchMedia, so the OS counts as dark and "dark" is the preferred dark theme.
    appearance({ theme: "dark", syncWithOs: false });
    renderHook(() => useApplyTheme());
    expect(last()).toBe("dark");
    act(() => appearance({ theme: "dark", syncWithOs: true, preferredDarkTheme: "dark" }));
    expect(last()).toBeNull();
    act(() => appearance({ theme: "dark", syncWithOs: false }));
    expect(last()).toBe("dark");
  });

  it("re-sends setTheme when the session override switches to or from system", () => {
    appearance({ theme: "dark", syncWithOs: false });
    renderHook(() => useApplyTheme());
    act(() => useThemeOverride.setState({ theme: "system" }));
    expect(last()).toBeNull();
    act(() => useThemeOverride.setState({ theme: "dark" }));
    expect(last()).toBe("dark");
  });
});
