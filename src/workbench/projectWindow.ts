/** Where a project opens when this window already has one: System Settings › Project › "Open project in". */
import { t } from "@/platform/i18n";
import { call, commands, type RemoteTarget } from "@/platform/ipc";
import { confirmLeaveProject, useProject } from "@/platform/project";
import { connectRemote, isRemoteWindow } from "@/platform/remote";
import { ask } from "./messages";
import { maybeEditorService } from "./contributions";

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
 * "Open project in". `false`: cancelled.
 */
export async function openRemoteProject(
  target: RemoteTarget,
  path: string,
  here: () => Promise<unknown> = () => connectRemote(target, path),
): Promise<boolean> {
  if ((await call(commands.windowOpenRemote(target, path, false))).kind === "focused") return true;
  const mode = await chooseProjectWindow(path.replace(/\/+$/, "").split("/").pop() || path, false);
  if (!mode) return false;
  if (mode === "new" || mode === "tab") {
    await call(
      mode === "tab" ? commands.windowOpenRemoteTab(target, path) : commands.windowOpenRemote(target, path, true),
    );
    return true;
  }
  if (!(await confirmLeaveProject())) return false;
  try {
    await here();
    return true;
  } catch (e) {
    maybeEditorService()?.cancelClose?.();
    throw e;
  }
}
