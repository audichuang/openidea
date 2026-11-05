import { describe, expect, it, vi } from "vitest";
import { MergeView } from "@codemirror/merge";
import { arrowControls, arrowLook, diffArrows } from "../diffControls";

const press = (btn: Element) => btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

describe("diff arrow model", () => {
  it("keeps the plain copy arrows outside a staging diff", () => {
    expect(diffArrows({ toA: false, toB: true })).toEqual([{ dir: "a-to-b", action: "apply" }]);
    expect(diffArrows({ toA: true, toB: false })).toEqual([{ dir: "b-to-a", action: "apply" }]);
    expect(diffArrows({ toA: true, toB: true })).toEqual([
      { dir: "a-to-b", action: "apply" },
      { dir: "b-to-a", action: "apply" },
    ]);
    expect(diffArrows({ toA: false, toB: false })).toEqual([]);
  });

  it("turns the index → working copy arrow into a revert and adds a stage control", () => {
    expect(diffArrows({ toA: false, toB: true, staging: true })).toEqual([
      { dir: "a-to-b", action: "revert" },
      { dir: "b-to-a", action: "stage" },
    ]);
    // Nothing to stage from or discard into without an editable working copy.
    expect(diffArrows({ toA: false, toB: false, staging: true })).toEqual([]);
  });

  it("labels revert and stage controls by what they do", () => {
    expect(arrowLook({ dir: "a-to-b", action: "revert" })).toEqual({
      label: "Revert to staged version",
      icon: "revert",
    });
    expect(arrowLook({ dir: "b-to-a", action: "stage" })).toEqual({
      label: "Stage this change (git add hunk)",
      icon: "plus",
    });
    expect(arrowLook({ dir: "a-to-b", action: "apply" }).icon).toBe("chevron-right");
    expect(arrowLook({ dir: "b-to-a", action: "apply" }).icon).toBe("chevron-left");
  });
});

describe("staging diff controls", () => {
  const staging = () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const stage = vi.fn<(index: number) => void>();
    let mv: MergeView | null = null;
    mv = new MergeView({
      a: { doc: "1\nstaged\n3\n" },
      b: { doc: "1\nworking\n3\n" },
      parent,
    });
    const holder = arrowControls(() => mv, { toA: false, toB: true, staging: true }, stage)();
    holder.dataset.chunk = "0";
    return { mv, stage, holder, buttons: [...holder.querySelectorAll("button")] };
  };

  it("stages the hunk without touching the working copy", () => {
    const { mv, stage, buttons } = staging();
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Revert to staged version",
      "Stage this change (git add hunk)",
    ]);
    press(buttons[1]!);
    expect(stage).toHaveBeenCalledWith(0);
    expect(mv.b.state.doc.toString()).toBe("1\nworking\n3\n");
    mv.destroy();
  });

  it("reverts the working copy to the staged text", () => {
    const { mv, stage, buttons } = staging();
    expect(buttons[0]!.classList.contains("cm-diffArrow-revert")).toBe(true);
    press(buttons[0]!);
    expect(stage).not.toHaveBeenCalled();
    expect(mv.b.state.doc.toString()).toBe("1\nstaged\n3\n");
    expect(mv.a.state.doc.toString()).toBe("1\nstaged\n3\n");
    mv.destroy();
  });
});
