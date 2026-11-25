/** Where a project opens when this window already has one: System Settings › Project › "Open project in". */
import { t } from "@/platform/i18n";
import { call, commands, type RemoteTarget } from "@/platform/ipc";
import { confirmLeaveProject, useProject } from "@/platform/project";
import { connectRemote, isRemoteWindow } from "@/platform/remote";
import { isMacHost } from "@/platform/keymap";
import { ask } from "./messages";
import { maybeEditorService } from "./contributions";

/** The window a modifier key picks for opening a recent project, whatever "Open project in" says. */
export type ProjectWindowOverride = "new" | "same";

/** The modifier keys of a click or a key press. */
export type ModifierKeys = Pick<KeyboardEvent | MouseEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

/**
 * The window a recent project opens in when it is picked with a modifier key, as in IntelliJ IDEA:
 * Shift or Ctrl (⌘ on macOS, where Ctrl+click is a right-click) is a new window, Alt this one.
 * `null`: no modifier, so "Open project in" decides.
 */
export function projectWindowOverride(e: ModifierKeys): ProjectWindowOverride | null {
  if (e.shiftKey || e.ctrlKey || (isMacHost() && e.metaKey)) return "new";
  return e.altKey ? "same" : null;
}

export type OpenMode = "new" | "tab" | "same";

/** "Open project in": `new` | `tab` | `same` | `ask`. */
export function openPolicy(): "ask" | OpenMode {
  const v = useProject.getState().settings?.general?.openProjectIn;
  return v === "new" || v === "tab" || v === "same" ? v : "ask";
}

/**
 * The window to open project `name` in: this one when it has no project (or LightEdit session), else
 * per "Open project in", asking when set to (and remembering "Don't ask again").
 * `null`: cancelled.
 */
export async function chooseProjectWindow(name: string, allowAttach = true): Promise<OpenMode | null> {
  const { project, lightEdit } = useProject.getState();
  if (!project && !lightEdit) return "same";
  const canAttach = allowAttach && !!project && !isRemoteWindow();
  // Project tabs group project windows; a LightEdit window opens the project in a new one.
  const canTab = !!project || isRemoteWindow();
  const policy = openPolicy();
  const mode = policy === "tab" && !canTab ? "ask" : policy;
  if (mode !== "ask") return mode;
  const r = await ask({
    title: t("app.window.askTitle"),
    width: canAttach ? 720 : canTab ? 600 : undefined,
    body: t("app.window.askBody", { name }),
    buttons: [
      { id: "cancel", label: t("common.cancel") },
      ...(canAttach ? [{ id: "attach", label: t("app.window.askAttach") }] : []),
      { id: "new", label: t("app.window.askNew") },
      ...(canTab ? [{ id: "tab", label: t("app.window.askTab") }] : []),
      { id: "same", label: t("app.window.askThis"), primary: true },
    ],
    checkbox: t("app.window.askRemember"),
  });
  if (r.button !== "same" && r.button !== "new" && r.button !== "tab" && r.button !== "attach") return null;
  if (r.checked && r.button !== "attach") {
    try {
      useProject.setState({
        settings: await call(commands.settingsSet("global", "general.openProjectIn", JSON.stringify(r.button))),
      });
    } catch {
      /* the choice still applies to this open */
    }
  }
  return r.button;
}

/**
 * Opens folder `path` of `target` (an SSH host or a WSL distribution): focuses the
 * window that has it, else opens it in a new window or (`here`) this one per
 * "Open project in", or where `override` says. `false`: cancelled.
 */
export async function openRemoteProject(
  target: RemoteTarget,
  path: string,
  here: () => Promise<unknown> = () => connectRemote(target, path),
  override?: ProjectWindowOverride | null,
): Promise<boolean> {
  if ((await call(commands.windowOpenRemote(target, path, false))).kind === "focused") return true;
  const mode = override ?? (await chooseProjectWindow(path.replace(/\/+$/, "").split("/").pop() || path, false));
  if (!mode) return false;
  if (mode === "new" || mode === "tab") {
    await call(
      mode === "tab" ? commands.windowOpenRemoteTab(target, path) : commands.windowOpenRemote(target, path, true),
    );
    return true;
  }
  // The remote host's project doesn't take this window's untitled buffers.
  if (!(await confirmLeaveProject(false))) return false;
  try {
    await here();
    return true;
  } catch (e) {
    maybeEditorService()?.cancelClose?.();
    throw e;
  }
}
