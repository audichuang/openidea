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
async function open(page: Page, how: "opened" | "switched", chars = CHARS, find = "") {
  await page.goto(`/e2e/httpResponseBody.html?chars=${chars}${how === "opened" ? "&raw" : ""}&find=${find}`);
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

async function expectEveryPartReachable(page: Page) {
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
}

for (const how of ["opened", "switched"] as const) {
  test(`one very long line ${how} in Raw is drawn only in part`, async ({ page }) => {
    const before = await open(page, how);
    expect((await drawnChars(page)) - before).toBeLessThan(CHARS / 20);
  });

  test(`every part of one very long line ${how} in Raw can be scrolled to`, async ({ page }) => {
    await open(page, how);
    await expectEveryPartReachable(page);
  });

  for (const from of [500, 800, 1000])
    test(`every part of one very long line ${how} in Raw can be scrolled to after the pane gets wider (${from} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: from, height: 900 });
      await open(page, how);
      await page.setViewportSize({ width: 1400, height: 900 });
      await settle(page);
      await expectEveryPartReachable(page);
    });
}

test("a line at the backend's 16 MB limit opened in Raw is drawn in part and every part can be scrolled to", async ({
  page,
}) => {
  await open(page, "opened", 16 * 1024 * 1024);
  expect(await drawnChars(page)).toBeLessThan(CHARS / 20);
  await expectEveryPartReachable(page);
});

/** The current find match, on screen. */
async function expectCurrentMatchOnScreen(page: Page) {
  await expect
    .poll(() =>
      body(page).evaluate((el) => {
        const scroller = el.closest(".cm-scroller") as HTMLElement;
        const box = scroller.getBoundingClientRect();
        const r = el.querySelector("[data-find-current]")?.getBoundingClientRect();
        return !!r && r.bottom > box.top && r.top < box.bottom
          ? el.querySelector("[data-find-current]")!.textContent
          : null;
      }),
    )
    .toBe("last-item");
}

test("a find match at the end of a long line opened in Raw is marked and scrolled to, also after the pane gets wider", async ({
  page,
}) => {
  await page.setViewportSize({ width: 500, height: 900 });
  await open(page, "opened", CHARS, "last-item");
  await expectCurrentMatchOnScreen(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await settle(page);
  await expect(body(page).locator("[data-find-current]")).toHaveText("last-item");
});

test("a selection in a long line stays as it was after the pane gets wider", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 900 });
  await open(page, "opened");
  await body(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  const selection = () => page.evaluate(() => (window as never as { selection(): unknown }).selection());
  const all = await selection();
  const length = await page.evaluate(() => (window as never as { rawLength: number }).rawLength);
  expect(all).toEqual({ anchor: 0, head: length });
  await page.setViewportSize({ width: 1400, height: 900 });
  await settle(page);
  expect(await selection()).toEqual(all);
});

test("a 16 MB line opened in a hidden pane is drawn in part and reachable once the pane is shown", async ({ page }) => {
  await page.goto(`/e2e/httpResponseBody.html?chars=${16 * 1024 * 1024}&raw&hidden`);
  await settle(page);
  await page.getByRole("button", { name: "Show Pane" }).click();
  await expect(body(page).locator(".cm-line").first()).toBeVisible();
  await settle(page);
  expect(await drawnChars(page)).toBeLessThan(CHARS / 20);
  await expectEveryPartReachable(page);
});

// Past the editor's scaling limit (7,000,000 px of height) a single line is taller than the editor can draw.
for (const width of [200, 300, 400])
  test(`a 16 MB line in a ${width} px pane: every part can be scrolled to and a match at its end is shown`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 900 });
    await open(page, "opened", 16 * 1024 * 1024, "last-item");
    await expectCurrentMatchOnScreen(page);
    await expectEveryPartReachable(page);
    expect(errors).toEqual([]);
  });

test("a 16 MB line shown wide, then in a 300 px pane: every part can be scrolled to", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, "opened", 16 * 1024 * 1024);
  await page.setViewportSize({ width: 300, height: 900 });
  await settle(page);
  await expectEveryPartReachable(page);
  expect(errors).toEqual([]);
});
