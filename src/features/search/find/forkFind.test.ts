import { afterEach, expect, it } from "vitest";
import * as upstream from "./FindToolWindow";
import * as fork from "./ForkFindToolWindow";
import { findToolWindowModule, forkFind, newFindSession } from "./forkFind";
import { ForkFindSession } from "./forkFindSession";
import { FindSession, type FindDeps } from "./session";

afterEach(() => {
  forkFind.upstream = false;
});

it("opens the fork's Find tool window unless the flag selects upstream's", async () => {
  expect((await findToolWindowModule()).FindToolWindow).toBe(fork.FindToolWindow);
  forkFind.upstream = true;
  expect((await findToolWindowModule()).FindToolWindow).toBe(upstream.FindToolWindow);
});

it("streams through the fork's Find session unless the flag selects upstream's", () => {
  const deps = {} as FindDeps;
  expect(newFindSession(deps, () => {})).toBeInstanceOf(ForkFindSession);
  forkFind.upstream = true;
  expect(newFindSession(deps, () => {})).toBeInstanceOf(FindSession);
});
