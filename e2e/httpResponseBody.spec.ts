import { expect, test, type Page } from "@playwright/test";

const CHARS = 4_000_000;

const drawnChars = (page: Page) => page.evaluate(() => (window as never as { drawn: { chars: number } }).drawn.chars);
const body = (page: Page) => page.getByLabel("Response body");

/** Waits until the editor has settled: a few frames without new text nodes. */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = -1;
        let quiet = 0;
        const tick = () => {
          const now = (window as never as { drawn: { chars: number } }).drawn.chars;
          quiet = now === last ? quiet + 1 : 0;
          last = now;
          if (quiet >= 3) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** Opens the fixture with the long line shown, either from the start or by switching from the formatted text. */
async function open(page: Page, how: "opened" | "switched") {
  await page.goto(`/e2e/httpResponseBody.html?chars=${CHARS}${how === "opened" ? "&raw" : ""}`);
  await expect(body(page).locator(".cm-line").first()).toBeVisible();
  await settle(page);
  const before = await drawnChars(page);
  if (how === "switched") {
    await page.getByRole("button", { name: "Show Raw" }).click();
    await expect(body(page).locator(".cm-line").first()).toHaveText(/^\[\{"id":0/);
    await settle(page);
  }
  return how === "switched" ? before : 0;
}

for (const how of ["opened", "switched"] as const) {
  test(`one very long line ${how} in Raw is drawn only in part`, async ({ page }) => {
    const before = await open(page, how);
    expect((await drawnChars(page)) - before).toBeLessThan(CHARS / 20);
  });

  test(`every part of one very long line ${how} in Raw can be scrolled to`, async ({ page }) => {
    await open(page, how);
    const lengths = await page.evaluate(() => {
      const w = window as never as { rawLength: number; docLength(): number };
      return [w.docLength(), w.rawLength];
    });
    expect(lengths[0]).toBe(lengths[1]);
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      // Text, not an empty placeholder, at the top and the bottom of the scrolled-to part; at the end, the last record.
      await expect
        .poll(
          () =>
            body(page).evaluate((el, f) => {
              const scroller = el.closest(".cm-scroller") as HTMLElement;
              scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * f;
              const box = scroller.getBoundingClientRect();
              const isText = (y: number) => {
                const caret = document.caretRangeFromPoint(box.left + 40, y);
                return caret?.startContainer.nodeType === Node.TEXT_NODE && el.contains(caret.startContainer);
              };
              const ends = isText(box.top + 12) && isText(box.bottom - 12);
              if (f < 1) return ends;
              const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
              for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                const at = n.textContent!.indexOf("last-item");
                if (at < 0) continue;
                const range = document.createRange();
                range.setStart(n, at);
                range.setEnd(n, at + 9);
                const r = range.getBoundingClientRect();
                if (r.bottom > box.top && r.top < box.bottom) return ends;
              }
              return false;
            }, fraction),
          { message: `text on screen at ${fraction * 100}%`, timeout: 10_000 },
        )
        .toBe(true);
    }
  });
}
