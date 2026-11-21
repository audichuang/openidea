import { describe, expect, it } from "vitest";
import { toggleLinearFragment } from "../logStore";

const sha = (i: number) => i.toString(16).padStart(40, "0");

describe("toggleLinearFragment", () => {
  it("collapses and expands a long linear chain without going over it once per commit", () => {
    const chain = Array.from({ length: 150_000 }, (_, i) => `/repo\0${sha(i)}`);
    const empty = { expanded: new Set<string>(), collapsed: new Set<string>(), merges: new Set<string>() };
    const collapsed = toggleLinearFragment({ ...empty, expanded: new Set(chain) }, chain, false);
    expect(collapsed.expanded.size).toBe(0);
    expect(collapsed.collapsed.size).toBe(chain.length);
    const expanded = toggleLinearFragment(
      { ...collapsed, collapsed: new Set(["/repo\0other", ...chain]) },
      chain,
      true,
    );
    expect([...expanded.collapsed]).toEqual(["/repo\0other"]);
    expect(expanded.expanded.size).toBe(chain.length);
    expect(expanded.merges).toBe(empty.merges);
  });
});
