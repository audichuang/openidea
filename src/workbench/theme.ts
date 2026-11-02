/** Applies `data-theme` and the accent colour from appearance settings. */
import { useEffect, useSyncExternalStore } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { BUILTIN_THEMES, isBuiltinTheme, themeKind, type BuiltinThemeId } from "@/platform/themes";
import { resolveTokenColor, toHex } from "@/platform/cssColor";

export type ThemeSetting = BuiltinThemeId | "system";
/** PyCharm's brand blue: the accent both Islands themes ship with. */
export const DEFAULT_ACCENT = "#3871e1";
/** Accent presets (Settings › Appearance, Welcome › Customize); the first is the Islands default. */
export const ACCENT_PRESETS = [
  { value: DEFAULT_ACCENT, label: "Blue" },
  { value: "#24a394", label: "Teal" },
  { value: "#955ae0", label: "Purple" },
  { value: "#e08855", label: "Orange" },
] as const;
/** Accents that mean "use the theme's own" (the current default and the pre-Islands one). */
const THEME_ACCENTS = new Set([DEFAULT_ACCENT, "#8fa5d6"]);

/** Session override used when settings can't be persisted (no backend). */
export const useThemeOverride = create<{ theme: ThemeSetting | null }>(() => ({ theme: null }));

const media = () =>
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

function subscribeScheme(cb: () => void) {
  const m = media();
  m?.addEventListener?.("change", cb);
  return () => m?.removeEventListener?.("change", cb);
}

const prefersLight = () => !!media()?.matches;

interface AppearanceLike {
  theme?: string;
  syncWithOs?: boolean;
  preferredLightTheme?: string;
  preferredDarkTheme?: string;
}

/**
 * Concrete theme id: the chosen theme, or with "Sync with OS" (legacy
 * `theme = "system"`) the preferred light / dark theme for the OS mode.
 */
export function resolveThemeId(a: AppearanceLike | undefined, systemLight: boolean): BuiltinThemeId {
  const concrete = (v: string | undefined, d: "dark" | "light") => (isBuiltinTheme(v) ? v : d);
  if (a?.syncWithOs || a?.theme === "system")
    return systemLight ? concrete(a?.preferredLightTheme, "light") : concrete(a?.preferredDarkTheme, "dark");
  return concrete(a?.theme, "light");
}

/** `dark-hc` resolves to `dark` plus `data-contrast="high"`. */
export function resolveTheme(setting: string | undefined, systemLight: boolean): "dark" | "light" {
  return themeKind(resolveThemeId({ theme: setting }, systemLight));
}

/** Whether "Sync with OS" (or the session override `system`) picks the theme. */
function followsOsTheme(override: ThemeSetting | null, a: AppearanceLike | undefined): boolean {
  return override ? override === "system" : !!(a?.syncWithOs || a?.theme === "system");
}

const ACCENT_RE = /^#[0-9a-f]{3,8}$/i;

export function useApplyTheme() {
  const appearance = useProject((s) => s.settings?.appearance);
  const override = useThemeOverride((s) => s.theme);
  const systemLight = useSyncExternalStore(subscribeScheme, prefersLight, () => false);
  const id = override
    ? resolveThemeId({ theme: override }, systemLight)
    : resolveThemeId(appearance as AppearanceLike | undefined, systemLight);
  const accent = appearance?.accent;
  // Native chrome follows the OS or is pinned (nativeAppearance), which can change while `id` stays put.
  const followsOs = followsOsTheme(override, appearance as AppearanceLike | undefined);

  // Until settings arrive, keep the theme public/boot.js restored rather than the light default.
  const pending = !override && !appearance;
  useEffect(() => {
    const root = document.documentElement;
    if (pending && root.dataset.theme) return;
    applyThemeAttributes(id, root);
    // Each theme ships its own accent; only a deliberate choice overrides it.
    const custom = !!accent && ACCENT_RE.test(accent) && !THEME_ACCENTS.has(accent.toLowerCase());
    if (custom) root.style.setProperty("--accent", accent);
    else root.style.removeProperty("--accent");
    syncWindowBackground();
  }, [pending, id, accent, followsOs]);
}

/**
 * Sets `data-theme` / `data-contrast` / `data-color-theme` (the palette themes
 * over a light / dark base, tokens.css) for a built-in theme id. While a plugin
 * theme is active (`data-plugin-theme-kind`), its light / dark base wins.
 */
export function applyThemeAttributes(id: BuiltinThemeId, root: HTMLElement = document.documentElement) {
  const pluginKind = root.dataset.pluginThemeKind;
  if (pluginKind === "light" || pluginKind === "dark") {
    delete root.dataset.colorTheme;
    root.dataset.theme = pluginKind;
    delete root.dataset.contrast;
    return;
  }
  if (id === "light" || id === "dark" || id === "dark-hc") delete root.dataset.colorTheme;
  else root.dataset.colorTheme = id;
  root.dataset.theme = themeKind(id);
  if (id === "dark-hc") root.dataset.contrast = "high";
  else delete root.dataset.contrast;
}

/**
 * The frame colour as Tauri's `[r, g, b, a]` (0–255). Tauri parses neither
 * `hsl()` nor `color-mix()`, which themes may use, so it is resolved here.
 */
export function windowBackgroundColor(
  root: HTMLElement = document.documentElement,
): [number, number, number, number] | null {
  const c = resolveTokenColor("--bg-frame", root);
  if (!c) return null;
  const [r, g, b, a] = c;
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)];
}

/** The frame colour as `#rrggbb[aa]`, for native window commands that take a string. */
export function windowBackgroundHex(root: HTMLElement = document.documentElement): string | null {
  const c = resolveTokenColor("--bg-frame", root);
  return c ? toHex(c) : null;
}

/** localStorage key read by public/boot.js. */
export const STARTUP_THEME_KEY = "openidea.theme";

/**
 * Remembers the theme for public/boot.js, which applies it to the next window
 * before any stylesheet loads: the light / dark base, and the resolved frame,
 * text and accent colours its splash is painted in.
 */
export function rememberStartupTheme(root: HTMLElement = document.documentElement) {
  const hex = (name: string) => {
    const c = resolveTokenColor(name, root);
    return c ? toHex(c) : undefined;
  };
  try {
    localStorage.setItem(
      STARTUP_THEME_KEY,
      JSON.stringify({
        theme: root.dataset.theme,
        contrast: root.dataset.contrast,
        colorTheme: root.dataset.colorTheme,
        frame: hex("--bg-frame"),
        fg: hex("--fg-muted"),
        accent: hex("--accent"),
      }),
    );
  } catch {
    /* storage unavailable */
  }
}

/**
 * Where a live resize outruns the page, the native window and the webview (WebView2's default
 * background) show their own colours; match both to the frame. The webview one is only set at
 * window creation otherwise, so a theme switched later left it light. Also remembers the theme
 * for the next window's start-up.
 */
export function syncWindowBackground() {
  rememberStartupTheme();
  if (!isTauri()) return;
  const win = getCurrentWebviewWindow();
  // Native chrome (macOS window tabs, title bar, menus) follows the app appearance, the OS one
  // unless set: a light IDE theme under a dark OS got a dark tab strip. Not on Linux: tao maps
  // SetTheme(None) to "GTK prefer dark = false", which would force light over a dark desktop and
  // never restore the user's GTK setting; the frameless title bar is drawn by the page anyway.
  if (usePlatform.getState().os !== "linux") win.setTheme(nativeAppearance()).catch(() => {});
  const color = windowBackgroundColor();
  if (!color) return;
  win.setBackgroundColor(color).catch(() => {});
}

/**
 * The appearance native chrome should take: the page's light / dark base, or null (follow the OS)
 * under "Sync with OS", where they agree anyway. Forcing it there would flip
 * `prefers-color-scheme`, which that mode reads to pick the theme. A plugin theme wins either way.
 */
export function nativeAppearance(root: HTMLElement = document.documentElement): "light" | "dark" | null {
  const pluginKind = root.dataset.pluginThemeKind;
  if (pluginKind === "light" || pluginKind === "dark") return pluginKind;
  const override = useThemeOverride.getState().theme;
  const appearance = useProject.getState().settings?.appearance as AppearanceLike | undefined;
  if (followsOsTheme(override, appearance)) return null;
  const base = root.dataset.theme;
  return base === "light" || base === "dark" ? base : null;
}

export function currentTheme(): "dark" | "light" {
  return themeKind(currentThemeId());
}

/** Themes offered by quick switch menus, in IDEA's order. */
export const THEME_CHOICES = BUILTIN_THEMES;

/** The concrete theme in effect (`dark-hc` kept distinct). */
export function currentThemeId(): BuiltinThemeId {
  const override = useThemeOverride.getState().theme;
  return override
    ? resolveThemeId({ theme: override }, prefersLight())
    : resolveThemeId(useProject.getState().settings?.appearance as AppearanceLike | undefined, prefersLight());
}

export async function setTheme(next: ThemeSetting) {
  useThemeOverride.setState({ theme: next });
  if (!isTauri()) return;
  try {
    let settings = await call(commands.settingsSet("global", "appearance.theme", JSON.stringify(next)));
    // An explicit choice ends "Sync with OS", as in IDEA.
    if (settings.appearance?.syncWithOs)
      settings = await call(commands.settingsSet("global", "appearance.syncWithOs", "false"));
    useProject.setState({ settings });
    useThemeOverride.setState({ theme: null });
  } catch {
    /* keep the session override */
  }
}

export async function toggleTheme() {
  await setTheme(currentTheme() === "dark" ? "light" : "dark");
}
