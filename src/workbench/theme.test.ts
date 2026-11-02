import { afterEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import {
  nativeAppearance,
  rememberStartupTheme,
  STARTUP_THEME_KEY,
  useThemeOverride,
  windowBackgroundColor,
  windowBackgroundHex,
} from "./theme";

const mockFrame = (token: string, resolved = "") =>
  vi
    .spyOn(globalThis, "getComputedStyle")
    .mockReturnValue({ getPropertyValue: () => token, color: resolved } as unknown as CSSStyleDeclaration);

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("window background", () => {
  it("resolves the frame to Tauri's RGBA tuple instead of passing CSS hsl() or mixes", () => {
    mockFrame("#26282c");
    expect(windowBackgroundColor()).toEqual([38, 40, 44, 255]);
    mockFrame("hsl(230, 1%, 92%)", "rgb(234, 234, 235)");
    expect(windowBackgroundColor()).toEqual([234, 234, 235, 255]);
    expect(windowBackgroundHex()).toBe("#eaeaeb");
    mockFrame("color-mix(in srgb, #8040bf 80%, transparent)", "color(srgb 0.5 0.25 0.75 / 0.8)");
    expect(windowBackgroundColor()).toEqual([128, 64, 191, 204]);
    expect(windowBackgroundHex()).toBe("#8040bfcc");
    mockFrame("", "");
    expect(windowBackgroundColor()).toBeNull();
    expect(windowBackgroundHex()).toBeNull();
  });

  it("remembers the base and the resolved splash colours for the next window", () => {
    const root = document.documentElement;
    root.dataset.theme = "light";
    const values: Record<string, string> = { "--bg-frame": "#eee8d5", "--fg-muted": "#657b83", "--accent": "#268bd2" };
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
      getPropertyValue: (n: string) => values[n] ?? "",
    } as unknown as CSSStyleDeclaration);
    rememberStartupTheme(root);
    expect(JSON.parse(localStorage.getItem(STARTUP_THEME_KEY)!)).toEqual({
      theme: "light",
      frame: "#eee8d5",
      fg: "#657b83",
      accent: "#268bd2",
    });
  });
});

describe("native appearance", () => {
  const root = document.documentElement;
  afterEach(() => {
    useThemeOverride.setState({ theme: null });
    useProject.setState({ settings: null } as never);
    delete root.dataset.theme;
    delete root.dataset.pluginThemeKind;
  });
  const appearance = (a: Record<string, unknown>) => useProject.setState({ settings: { appearance: a } } as never);

  it("pins native chrome to the IDE theme's base so a dark OS doesn't darken a light IDE's tabs", () => {
    appearance({ theme: "solarized-light", syncWithOs: false });
    root.dataset.theme = "light";
    expect(nativeAppearance(root)).toBe("light");
    root.dataset.theme = "dark";
    expect(nativeAppearance(root)).toBe("dark");
  });

  it("follows the OS under Sync with OS, whose theme pick reads prefers-color-scheme", () => {
    root.dataset.theme = "dark";
    appearance({ theme: "light", syncWithOs: true });
    expect(nativeAppearance(root)).toBeNull();
    appearance({ theme: "system" });
    expect(nativeAppearance(root)).toBeNull();
    appearance({ theme: "light" });
    useThemeOverride.setState({ theme: "system" });
    expect(nativeAppearance(root)).toBeNull();
  });

  it("takes a plugin theme's kind in either mode", () => {
    appearance({ theme: "light", syncWithOs: true });
    root.dataset.theme = "dark";
    root.dataset.pluginThemeKind = "dark";
    expect(nativeAppearance(root)).toBe("dark");
  });
});
