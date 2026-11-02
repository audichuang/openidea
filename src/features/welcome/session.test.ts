import { beforeEach, describe, expect, it, vi } from "vitest";

const openProject = vi.fn();
const win = vi.hoisted(() => ({
  label: "main",
  owns: false,
  listeners: new Map<string, () => void>(),
  /** While set, `listen` registers its handler only once this settles. */
  listenGate: null as Promise<void> | null,
  /** Stands in for `startupProjectKnown`. */
  known: Promise.resolve(),
}));

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      settingsGet: async () => ({ general: { reopenLastProject: true } }),
      windowOwnsSession: async () => win.owns,
    },
  };
});
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: win.label,
    listen: async (event: string, handler: () => void) => {
      if (win.listenGate) await win.listenGate;
      win.listeners.set(event, handler);
      return () => win.listeners.delete(event);
    },
  }),
}));
vi.mock("@/platform/project", async (orig) => {
  const real = await orig<typeof import("@/platform/project")>();
  return { ...real, openProject: (p: string) => openProject(p), startupProjectKnown: () => win.known };
});

const { lastSessionProject, reopenLastProject, trackSession, _resetSessionForTests } = await import("./session");
const { provideStartupLaunch, useProject } = await import("@/platform/project");

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  win.label = "main";
  win.owns = false;
  win.listeners.clear();
  win.listenGate = null;
  win.known = Promise.resolve();
  openProject.mockReset();
  useProject.setState({ project: null, lightEdit: false });
  sessionStorage.clear();
  localStorage.setItem("openidea.session.openProject", "/p/last");
  _resetSessionForTests();
});

describe("reopenLastProject", () => {
  it("waits for the command-line project instead of opening the last one too", async () => {
    let finishLaunch!: () => void;
    provideStartupLaunch(
      new Promise<void>((resolve) => {
        finishLaunch = () => {
          useProject.setState({ project: { root: "/p/launch" } as never });
          resolve();
        };
      }),
    );
    const reopened = reopenLastProject();
    await new Promise((r) => setTimeout(r, 0));
    expect(openProject).not.toHaveBeenCalled();
    finishLaunch();
    await reopened;
    expect(openProject).not.toHaveBeenCalled();
  });

  it.each(["last session", "window session"])(
    "keeps launched loose files instead of restoring the %s project",
    async (remembered) => {
      if (remembered === "window session") sessionStorage.setItem("openidea.window.project", "/p/window");
      provideStartupLaunch(
        Promise.resolve().then(() => {
          useProject.setState({ lightEdit: true });
        }),
      );
      await reopenLastProject();
      expect(openProject).not.toHaveBeenCalled();
      expect(useProject.getState().lightEdit).toBe(true);
      expect(useProject.getState().project).toBeNull();
    },
  );

  it("reopens the last project when the launch named none", async () => {
    provideStartupLaunch(Promise.resolve());
    await reopenLastProject();
    expect(openProject).toHaveBeenCalledWith("/p/last");
  });
});

describe("trackSession", () => {
  const project = (root: string) => ({ root, name: root, trusted: true, isGit: false, settings: {} }) as never;

  // Restored window-group members open their projects after `main`: they must not replace the
  // project `main` reopens next launch.
  it("leaves main's project remembered when another window opens one", () => {
    localStorage.setItem("openidea.session.openProject", "/p/main");
    win.label = "window-1";
    const stop = trackSession();
    useProject.setState({ project: project("/p/member") });
    expect(lastSessionProject()).toBe("/p/main");
    // This window's own project still comes back when its webview reloads.
    expect(sessionStorage.getItem("openidea.window.project")).toBe("/p/member");
    useProject.setState({ project: null });
    expect(lastSessionProject()).toBe("/p/main");
    stop();
  });

  it("keeps main on welcome when another window opens a project", () => {
    localStorage.removeItem("openidea.session.openProject");
    win.label = "window-1";
    useProject.setState({ project: project("/p/member") });
    const stop = trackSession();
    useProject.setState({ project: project("/p/other") });
    expect(lastSessionProject()).toBeNull();
    stop();
  });

  it("keeps main's project when another window cannot reopen its own", async () => {
    localStorage.setItem("openidea.session.openProject", "/p/main");
    sessionStorage.setItem("openidea.window.project", "/p/gone");
    win.label = "window-1";
    openProject.mockRejectedValue(new Error("missing"));
    provideStartupLaunch(Promise.resolve());
    await reopenLastProject();
    expect(openProject).toHaveBeenCalledWith("/p/gone");
    expect(lastSessionProject()).toBe("/p/main");
  });

  it("remembers the project main opens", () => {
    const stop = trackSession();
    useProject.setState({ project: project("/p/next") });
    expect(lastSessionProject()).toBe("/p/next");
    stop();
  });

  // Main closed, the window left behind went back to welcome (Cmd-W): relaunching stays there.
  it("hands the remembered project to the window left once main is gone", async () => {
    localStorage.setItem("openidea.session.openProject", "/p/main");
    win.label = "window-1";
    useProject.setState({ project: project("/p/member") });
    const stop = trackSession();
    await flush();
    expect(lastSessionProject()).toBe("/p/main");
    win.listeners.get("openidea://session-owner")?.();
    expect(lastSessionProject()).toBe("/p/member");
    useProject.setState({ project: project("/p/next") });
    expect(lastSessionProject()).toBe("/p/next");
    useProject.setState({ project: null });
    expect(lastSessionProject()).toBeNull();
    stop();
  });

  it("forgets main's project when the window taking over is on welcome", async () => {
    localStorage.setItem("openidea.session.openProject", "/p/main");
    win.label = "window-1";
    const stop = trackSession();
    await flush();
    win.listeners.get("openidea://session-owner")?.();
    expect(lastSessionProject()).toBeNull();
    stop();
  });

  // A window opened after every other one closed, or one whose webview reloaded after taking over.
  it("remembers the projects of a window that already holds the session", async () => {
    localStorage.setItem("openidea.session.openProject", "/p/main");
    win.label = "window-1";
    win.owns = true;
    let settle!: () => void;
    win.known = new Promise((r) => (settle = r));
    const stop = trackSession();
    await flush();
    // Its startup project is not known yet: it may still reopen one.
    expect(lastSessionProject()).toBe("/p/main");
    settle();
    await flush();
    // Settled on welcome: the next launch shows welcome too.
    expect(lastSessionProject()).toBeNull();
    useProject.setState({ project: project("/p/new") });
    expect(lastSessionProject()).toBe("/p/new");
    stop();
  });

  // Main closed between the window asking whether it holds the session and its listener being
  // registered: the one hand-over event found no listener, so the answer must come after it.
  it.each([
    ["its project", "/p/member"],
    ["welcome", null],
  ])("takes over when main closes before the hand-over listener is registered (%s)", async (_, root) => {
    localStorage.setItem("openidea.session.openProject", "/p/main");
    win.label = "window-1";
    let register!: () => void;
    win.listenGate = new Promise((r) => (register = r));
    if (root) useProject.setState({ project: project(root) });
    const stop = trackSession();
    await flush();
    // Main closes now: the backend hands the session over and emits the event, which is lost.
    win.owns = true;
    win.listeners.get("openidea://session-owner")?.();
    register();
    await flush();
    expect(lastSessionProject()).toBe(root);
    stop();
  });
});
