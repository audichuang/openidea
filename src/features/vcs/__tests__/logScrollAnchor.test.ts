import { describe, expect, it } from "vitest";
import { survivingRowShift } from "../logScrollAnchor";
import type { RepoCommit } from "../multiRoot";

let reads = 0;
const row = (id: string, repo: string | null = "/repo"): RepoCommit =>
  ({
    get id() {
      reads++;
      return id;
    },
    repo,
  }) as unknown as RepoCommit;
const rows = (prefix: string, n: number, repo?: string | null) =>
  Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, repo));

describe("survivingRowShift", () => {
  it("shifts by where the first surviving row at or below the top moved", () => {
    const [a, b, c, d] = rows("c", 4);
    expect(survivingRowShift([a!, b!, c!, d!], [row("new"), c!, d!], 0)).toBe(-1);
    expect(survivingRowShift([a!, b!, c!, d!], [row("x"), row("y"), a!, b!], 1)).toBe(2);
  });

  it("takes the first match of a commit listed twice, and repositories apart", () => {
    expect(survivingRowShift([row("a")], [row("b"), row("a"), row("a")], 0)).toBe(1);
    expect(survivingRowShift([row("a", "/one")], [row("a", "/two"), row("a", "/one")], 0)).toBe(1);
  });

  it("is null when no row survives or the top is past the end", () => {
    expect(survivingRowShift(rows("old", 3), rows("new", 3), 0)).toBeNull();
    expect(survivingRowShift(rows("c", 2), rows("c", 2), 5)).toBeNull();
  });

  // Checkout from main to an older commit: the newest ~21k rows of the old list are gone.
  // Searching the new list once per old row froze the window for minutes.
  it("reads each row a bounded number of times when the leading rows are gone", () => {
    const kept = rows("kept", 3000);
    const previous = [...rows("gone", 3000), ...kept];
    reads = 0;
    expect(survivingRowShift(previous, kept, 0)).toBe(-3000);
    expect(reads).toBeLessThan(4 * (previous.length + kept.length));
  });
});
