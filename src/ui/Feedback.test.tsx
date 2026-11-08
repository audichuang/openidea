import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Toast } from "./Feedback";

describe("Toast body", () => {
  it("keeps each line of a multi-line body on its own line", () => {
    const body = "Unreadable: a\nName not portable: b\nSymlinked folder: c";
    const { container } = render(<Toast level="info" title="t" body={body} />);
    const el = container.querySelector("[class*=toastBody]")!;
    // The text carries one category per line ...
    expect(el.textContent).toBe(body);
    // ... and the stylesheet renders those newlines instead of collapsing them into spaces.
    const css = readFileSync("src/ui/Feedback.module.css", "utf8");
    expect(/\.toastBody \{[^}]*white-space:\s*pre-line/.test(css)).toBe(true);
  });
});
