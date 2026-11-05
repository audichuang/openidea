import { expect, test, type Locator, type Page } from "@playwright/test";

// CSS Module class names keep their source name in dev builds.
const part = (row: Locator, name: string) => row.locator(`[class*="_${name}_"]`).first();
const box = async (el: Locator) => (await el.boundingBox())!;

async function open(page: Page, query: string) {
  await page.goto(`/e2e/commitTreeLabels.html?${query}`);
  const tree = page.getByRole("tree", { name: "Changes" });
  await expect(tree.getByRole("treeitem").first()).toBeVisible();
  return tree;
}

test("Stage and Unstage stay inside a narrow, deep tree and take the click", async ({ page }) => {
  const tree = await open(page, "width=260");
  const treeBox = await box(tree);
  const rows = tree.getByRole("treeitem");
  let checked = 0;
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    await row.hover();
    const action = row.getByRole("button", { name: /^(Stage|Unstage)/ });
    if (!(await action.count())) continue;
    await expect(action).toBeVisible();
    const b = await box(action);
    expect(b.x + b.width).toBeLessThanOrEqual(treeBox.x + treeBox.width);
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.closest('[role="button"]')?.getAttribute("aria-label"),
      [b.x + b.width / 2, b.y + b.height / 2],
    );
    expect(hit).toBe(await action.getAttribute("aria-label"));
    checked++;
  }
  expect(checked).toBeGreaterThan(4);
});

test("repository rows: the branch chip gives way before the name, the count stays whole", async ({ page }) => {
  const tree = await open(page, "width=320");
  // Narrower than its text by any amount, which already draws an ellipsis.
  const cut = (el: Locator) =>
    el.evaluate((n) => {
      const range = document.createRange();
      range.selectNodeContents(n);
      const style = getComputedStyle(n);
      const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      return n.getBoundingClientRect().width - pad < range.getBoundingClientRect().width - 0.01;
    });
  for (let width = 320; width >= 150; width -= 5) {
    await page.locator("#panel").evaluate((n, w) => ((n as HTMLElement).style.width = `${w}px`), width);
    const treeBox = await box(tree);
    for (const name of ["openidea", "openidea-plugins"]) {
      const row = tree
        .getByRole("treeitem")
        .filter({ has: page.getByText(name, { exact: true }) })
        .first();
      const label = part(row, "label");
      const chip = part(row, "headChip");
      const count = part(row, "count");
      const chipFloor = await chip.evaluate((n) => parseFloat(getComputedStyle(n).minWidth));
      if (await cut(label))
        expect((await box(chip)).width, `${name} at ${width}px`).toBeLessThanOrEqual(chipFloor + 0.5);
      // At least a character and its ellipsis of the name.
      expect((await box(label)).width, `${name} at ${width}px`).toBeGreaterThan(10);
      const c = await box(count);
      expect(c.x + c.width, `${name} at ${width}px`).toBeLessThanOrEqual(treeBox.x + treeBox.width);
      expect(await cut(count), `${name} at ${width}px`).toBe(false);
    }
  }
});

test("a flat-mode directory is one middle-cut string with the full path as its tooltip", async ({ page }) => {
  const tree = await open(page, "width=480&flat");
  const path = part(tree.getByRole("treeitem", { name: /workspace_symbols/ }), "pathDetail");
  await expect(path).toHaveAttribute("title", "src-tauri/src/commands");
  // The visible text nodes, and how wide they draw against the box that clips them.
  const shown = () =>
    path.evaluate((n) => {
      const nodes = [n, ...n.querySelectorAll("*")]
        .filter((el) => getComputedStyle(el).visibility !== "hidden")
        .flatMap((el) => [...el.childNodes].filter((c) => c.nodeType === Node.TEXT_NODE));
      const range = document.createRange();
      range.selectNodeContents(nodes[0]!);
      return {
        texts: nodes.map((c) => c.textContent),
        overflow: range.getBoundingClientRect().width - n.getBoundingClientRect().width,
      };
    });
  // Every stage of the cut, whatever the font: whole, head cut, last segment cut too, ellipsis alone.
  const stages = [/^src-tauri\/src\/commands$/, /^[^…]+…\/commands$/, /^[^…]…\/[^…]+…$/, /^…$/];
  const seen = new Set<number>();
  for (let width = 640; width >= 200; width -= 4) {
    await page.locator("#panel").evaluate((n, w) => ((n as HTMLElement).style.width = `${w}px`), width);
    // ResizeObserver delivers before the next paint.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const { texts, overflow } = await shown();
    expect(texts, `${width}px`).toHaveLength(1);
    const stage = stages.findIndex((re) => re.test(texts[0]!));
    expect(stage, `${width}px: ${texts[0]}`).toBeGreaterThanOrEqual(0);
    expect(overflow, `${width}px: ${texts[0]}`).toBeLessThanOrEqual(0);
    seen.add(stage);
  }
  expect([...seen].sort()).toEqual([0, 1, 2, 3]);
});
