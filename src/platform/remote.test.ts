import { Channel } from "@tauri-apps/api/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invoke } from "./tauriCore";
import type { ProjectInfo, Settings } from "./ipc";
import { useProject } from "./project";
import { disableRemote, enableRemote, useRemote } from "./remote";
import { encodeArgs, remoteRouting } from "./remote";

describe("remote invoke", () => {
  beforeAll(() => {
    let next = 1;
    Object.assign(window, { __TAURI_INTERNALS__: { transformCallback: () => next++ } });
  });

  it("replaces channels with ids and keeps the rest", () => {
    const events = new Channel<unknown>();
    const { json, channels } = encodeArgs({ path: "/a", requestId: 3, onEvent: events });
    const parsed = JSON.parse(json) as { path: string; requestId: number; onEvent: { $channel: number } };
    expect(parsed.path).toBe("/a");
    expect(parsed.requestId).toBe(3);
    expect(channels.get(parsed.onEvent.$channel)).toBe(events);
  });

  it("routes served commands, keeps opening / closing local and sets global settings on both sides", () => {
    const served = new Set([
      "vcs_add_to_ignore",
      "fs_read_dir",
      "open_project",
      "close_project",
      "settings_set",
      "system_font_families",
    ]);
    expect(remoteRouting("vcs_add_to_ignore", { paths: ["/remote/file"], destination: "localExclude" }, served)).toBe(
      "remote",
    );
    expect(remoteRouting("system_font_families", { refresh: true }, served)).toBe("local");
    expect(remoteRouting("fs_read_dir", { path: "/a" }, served)).toBe("remote");
    expect(remoteRouting("window_open_settings", {}, served)).toBe("local");
    expect(remoteRouting("open_project", { path: "/a" }, served)).toBe("local");
    expect(remoteRouting("close_project", {}, served)).toBe("local");
    expect(remoteRouting("settings_set", { scope: "project", key: "k", value: "1" }, served)).toBe("remote");
    expect(remoteRouting("settings_set", { scope: "global", key: "k", value: "1" }, served)).toBe("both");
  });

  it.each(["agent_subscribe", "agent_entries", "agent_prompt"])("routes %s to the agent's host", (cmd) => {
    expect(remoteRouting(cmd, { task: "saved-codex-task", subagent: null }, new Set([cmd]))).toBe("remote");
  });

  it("encodes no arguments as an empty object", () => {
    expect(encodeArgs(undefined).json).toBe("{}");
  });
});

describe("remote session lifetime", () => {
  const session = {
    target: { kind: "wsl" as const, distro: "Ubuntu" },
    root: "/home/me/app",
    host: "Ubuntu",
    os: "linux",
    commands: ["vcs_roots"],
  };
  const project = {
    name: "app",
    root: "/home/me/app",
    trusted: true,
    isGit: true,
    settings: {},
  } as unknown as ProjectInfo;

  afterEach(() => {
    disableRemote();
    useProject.setState({ project: null, settings: null, opening: false, openingPath: null, lightEdit: false });
  });

  it("keeps routing when a window with no project of its own updates the settings only", () => {
    // The comparison window: it rides its parent's session and keeps just the settings
    // (restoring the project would overwrite the main window's editor session).
    enableRemote(session);
    useProject.setState({ settings: { editor: { fontSize: 12 } } as unknown as Settings });
    expect(useRemote.getState().session).not.toBeNull();
  });

  it("ends routing when the window's project leaves the session's root", () => {
    enableRemote(session);
    useProject.setState({ project });
    // Close Project (or a local project opened over the remote one) — the session goes.
    useProject.setState({ project: null });
    expect(useRemote.getState().session).toBeNull();
  });

  it("keeps routing while the project still sits at the session's root", () => {
    enableRemote(session);
    useProject.setState({ project });
    useProject.setState({ settings: { editor: { fontSize: 14 } } as unknown as Settings });
    expect(useRemote.getState().session).not.toBeNull();
  });
});

describe("remote channel lifetime", () => {
  type Callback = (message: unknown) => void;
  let callbacks: Map<number, Callback>;
  let calls: { cmd: string; args: string; relay: number; resolve: (result: string) => void }[];
  const session = {
    target: { kind: "wsl" as const, distro: "Ubuntu" },
    root: "/home/me/app",
    host: "Ubuntu",
    os: "linux",
    commands: ["search_start", "term_spawn"],
  };

  beforeEach(() => {
    let next = 1;
    callbacks = new Map();
    calls = [];
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        transformCallback: (callback: Callback) => {
          const id = next++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: (_cmd: string, args: { cmd: string; args: string; onChannel: Channel<unknown> }) =>
          new Promise<string>((resolve) =>
            calls.push({ cmd: args.cmd, args: args.args, relay: args.onChannel.id, resolve }),
          ),
      },
    });
    enableRemote(session);
  });

  afterEach(() => disableRemote());

  const callAt = (i: number) => {
    const call = calls[i];
    if (!call) throw new Error(`no remote call ${i}`);
    return call;
  };
  /** What the desktop backend sends through a call's relay channel, as Tauri delivers it. */
  const relay = (call: { relay: number }, index: number, frame: object) =>
    callbacks.get(call.relay)?.({ message: frame, index });
  const value = (id: number, data: unknown) => ({ id, data: JSON.stringify(data), end: false });
  const end = (id: number) => ({ id, data: "", end: true });
  /** The backend dropped its last clone of the relay channel. */
  const closeRelay = (call: { relay: number }, index: number) => callbacks.get(call.relay)?.({ end: true, index });
  /** The id the call's only streaming argument travels with. */
  const channelId = (call: { args: string }) => {
    const [argument] = Object.values(JSON.parse(call.args) as Record<string, { $channel: number }>);
    if (!argument) throw new Error("no streaming argument");
    return argument.$channel;
  };

  it("releases every callback of finished calls", async () => {
    const baseline = callbacks.size;
    for (let i = 0; i < 20; i++) {
      const received: unknown[] = [];
      const pending = invoke("search_start", { onEvent: new Channel<unknown>((m) => received.push(m)) });
      const call = callAt(i);
      const id = channelId(call);
      relay(call, 0, value(id, { match: i }));
      relay(call, 1, end(id));
      closeRelay(call, 2);
      call.resolve("null");
      await pending;
      expect(received).toEqual([{ match: i }]);
    }
    expect(callbacks.size).toBe(baseline);
  });

  it("keeps delivering a stream after the call returns until the server ends it", async () => {
    const baseline = callbacks.size;
    const received: unknown[] = [];
    const pending = invoke("term_spawn", { onOutput: new Channel<unknown>((m) => received.push(m)) });
    const call = callAt(0);
    call.resolve("1");
    await pending;
    const id = channelId(call);
    relay(call, 0, value(id, "$ "));
    relay(call, 1, value(id, "ls\n"));
    expect(received).toEqual(["$ ", "ls\n"]);
    expect(callbacks.size).toBe(baseline + 2);
    relay(call, 2, end(id));
    closeRelay(call, 3);
    expect(callbacks.size).toBe(baseline);
  });

  it("delivers a large value that arrives after the end notice", async () => {
    const baseline = callbacks.size;
    const received: unknown[] = [];
    const pending = invoke("search_start", { onEvent: new Channel<unknown>((m) => received.push(m)) });
    const call = callAt(0);
    call.resolve("null");
    await pending;
    const id = channelId(call);
    const large = "x".repeat(16 * 1024);
    // Tauri fetches values of 8 KB and more: the end notice, sent after, can arrive first.
    relay(call, 1, end(id));
    closeRelay(call, 2);
    expect(callbacks.size).toBe(baseline + 2);
    relay(call, 0, value(id, large));
    expect(received).toEqual([large]);
    expect(callbacks.size).toBe(baseline);
  });

  it("keeps channels of a server that never ends them, until the session ends", async () => {
    const baseline = callbacks.size;
    const received: unknown[] = [];
    const pending = invoke("search_start", { onEvent: new Channel<unknown>((m) => received.push(m)) });
    const call = callAt(0);
    relay(call, 0, value(channelId(call), 1));
    call.resolve("null");
    await pending;
    relay(call, 1, value(channelId(call), 2));
    expect(received).toEqual([1, 2]);
    expect(callbacks.size).toBe(baseline + 2);
    disableRemote();
    expect(callbacks.size).toBe(baseline);
  });
});
