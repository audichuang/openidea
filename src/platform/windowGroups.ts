import { create } from "zustand";
import { call, commands, isTauri, onIdeEvent, type SystemTabBar, type WindowTab } from "./ipc";
import { startupProjectKnown, useProject } from "./project";
import { setContext } from "./context";
import { usePlatform } from "./platformInfo";

const NO_TAB_BAR: SystemTabBar = { height: 0, top: false };

/** `systemTabBar`: macOS shows the group in its own tab bar over the page. */
export const useWindowGroup = create<{ tabs: WindowTab[]; systemTabBar: SystemTabBar }>(() => ({
  tabs: [],
  systemTabBar: NO_TAB_BAR,
}));

export function reorderedTabs(tabs: readonly WindowTab[], source: string, target: string): string[] {
  const labels = tabs.map((tab) => tab.label);
  const from = labels.indexOf(source);
  const to = labels.indexOf(target);
  if (from < 0 || to < 0 || from === to) return labels;
  labels.splice(to, 0, labels.splice(from, 1)[0]!);
  return labels;
}

export async function refreshWindowGroup() {
  if (!isTauri()) return;
  const tabs = await call(commands.windowGroupCurrent());
  const systemTabBar =
    usePlatform.getState().os === "macos" && tabs.length > 1
      ? ((await call(commands.windowGroupTabBar())) ?? NO_TAB_BAR)
      : NO_TAB_BAR;
  useWindowGroup.setState({ tabs, systemTabBar });
  setContext("windowGrouped", tabs.length > 1);
}

export async function selectWindowTab(label: string) {
  await call(commands.windowGroupSelect(label));
}

export async function cycleWindowTab(forward: boolean) {
  // macOS: the system tab bar may have reordered the tabs since the last refresh.
  await refreshWindowGroup();
  const tabs = useWindowGroup.getState().tabs;
  if (tabs.length < 2) return;
  const index = tabs.findIndex((tab) => tab.current);
  await selectWindowTab(tabs[(index + (forward ? 1 : -1) + tabs.length) % tabs.length]!.label);
}

export function installWindowGroups(): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  const refresh = () => void refreshWindowGroup().catch(console.warn);
  // Once this window's startup project is known, also when it stays on welcome: reopening the
  // groups only when `main` later opens a project would pop them all up then (`restore` runs once).
  const restore = async () => {
    await startupProjectKnown();
    if (disposed) return;
    await call(commands.windowGroupRestore());
    if (!disposed) await refreshWindowGroup();
  };
  const offEvent = onIdeEvent("windowGroupsChanged", refresh);

  const offProject = useProject.subscribe((state, prev) => {
    if (state.project?.root !== prev.project?.root) void restore().catch(console.warn);
  });
  refresh();
  void restore().catch(console.warn);
  return () => {
    disposed = true;
    offEvent();
    offProject();
  };
}
