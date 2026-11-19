import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAction } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { registerVcsActions } from "../actions";
import { useVcs } from "../store";

const runRemote = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../ops", async (original) => ({ ...(await original<typeof import("../ops")>()), runRemote }));

const vcs = useVcs.getState();
let unregister: () => void;

beforeEach(() => {
  runRemote.mockClear();
  useVcs.setState({ root: "/work", roots: ["/work/app", "/work/lib"], repo: "/work/app" });
  unregister = registerVcsActions();
});

afterEach(() => {
  unregister();
  useVcs.setState(vcs);
});

describe("Fetch", () => {
  it("fetches every repository without one named, as in IDEA", async () => {
    await getAction("vcs.fetch")!.run({ ctx: getContext() });
    expect(runRemote).toHaveBeenLastCalledWith({ op: "fetch" }, undefined, ["/work/app", "/work/lib"]);
  });

  it("fetches only the repository a caller names (Git Graph's toolbar)", async () => {
    await getAction("vcs.fetch")!.run({ ctx: getContext(), arg: { repo: "/work/lib" } });
    expect(runRemote).toHaveBeenLastCalledWith({ op: "fetch" }, undefined, ["/work/lib"]);
  });
});
