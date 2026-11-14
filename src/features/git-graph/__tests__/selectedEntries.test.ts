// @vitest-environment node
import { describe, expect, it } from "vitest";
import { selectedEntries, type GraphEntry } from "../entries";

let reads = 0;
const entry = (id: string, tag = id): GraphEntry =>
  ({
    kind: "commit",
    get id() {
      reads++;
      return id;
    },
    parents: [],
    commit: { tag },
  }) as unknown as GraphEntry;

describe("selectedEntries", () => {
  it("keeps the selection order, skips unknown ids and takes the first entry of an id", () => {
    const a = entry("a");
    const b = entry("b");
    const first = entry("c", "first");
    const entries = [a, b, first, entry("c", "second")];
    expect(selectedEntries(entries, ["c", "x", "a", "b", "a"])).toEqual([first, a, b, a]);
  });

  // Select All on a 45k-row graph searched the entries once per selected id on every render.
  it("reads each entry a bounded number of times when everything is selected", () => {
    const entries = Array.from({ length: 5000 }, (_, i) => entry(`sha-${i}`));
    const ids = entries.map((_, i) => `sha-${i}`).reverse();
    reads = 0;
    expect(selectedEntries(entries, ids)).toEqual([...entries].reverse());
    selectedEntries(entries, ids);
    expect(reads).toBeLessThan(4 * entries.length);
  });

  it("matches a linear search on random selections", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 200; round++) {
      const entries = Array.from({ length: Math.floor(rand() * 30) }, (_, i) =>
        entry(`e${Math.floor(rand() * 20)}`, `${i}`),
      );
      const ids = Array.from({ length: Math.floor(rand() * 30) }, () => `e${Math.floor(rand() * 25)}`);
      const expected = ids.map((id) => entries.find((e) => e.id === id)).filter((e) => !!e);
      expect(selectedEntries(entries, ids)).toEqual(expected);
      selectedEntries(entries, ids).forEach((e, i) => expect(e).toBe(expected[i]));
    }
  });
});
