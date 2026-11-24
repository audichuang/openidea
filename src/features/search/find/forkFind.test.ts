import { afterEach, expect, it } from "vitest";
import * as upstream from "./FindToolWindow";
import * as fork from "./ForkFindToolWindow";
import { findToolWindowModule, forkFind } from "./forkFind";

afterEach(() => {
  forkFind.upstream = false;
});

it("opens the fork's Find tool window unless the flag selects upstream's", async () => {
  expect((await findToolWindowModule()).FindToolWindow).toBe(fork.FindToolWindow);
  forkFind.upstream = true;
  expect((await findToolWindowModule()).FindToolWindow).toBe(upstream.FindToolWindow);
});
