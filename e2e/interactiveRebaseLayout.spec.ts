import { expect, stubDesktop, test } from "./fixtures";

test("Interactive rebase keeps commit messages and plan controls usable at narrow widths", async ({
  workbench: page,
}) => {
  const first = "Keep regional settlement references stable when reconciling delayed ledger updates";
  const second = "Add settlement summary";
  await stubDesktop(page);
  await page.evaluate(
    async ({ first, second }) => {
      const root = "/dev/acme-api";
      const id = (n: string) => n.repeat(40);
      const commits = [
        { id: id("c"), shortId: "cccccccc", parents: [id("b")], summary: second, timeMs: 1795100200000 },
        { id: id("b"), shortId: "bbbbbbbb", parents: [id("a")], summary: first, timeMs: 1795100100000 },
      ].map((commit) => ({
        ...commit,
        refs: [],
        author: "Sam Rivera",
        email: "sam@example.com",
        message: commit.summary + "\n\nKeep the audit trail linked to the settlement job.",
      }));
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, operation: null, head: "main", headCommit: id("c") }];
      h.vcs_branch_info = () => ({
        head: "main",
        headCommit: id("c"),
        upstream: null,
        ahead: 0,
        behind: 0,
        operation: null,
      });
      h.vcs_status = () => [];
      h.vcs_log = () => commits;
      h.vcs_log_refs = () => ({});
      h.vcs_log_users = () => ["Sam Rivera <sam@example.com>"];
      h.vcs_config_get = () => null;
      h.vcs_commit_files = () => [];
      h.vcs_log_details_batch = () => [];
      const vcsPath = "/src/features/vcs/store.ts";
      const { useVcs } = await import(/* @vite-ignore */ vcsPath);
      useVcs.setState({ available: true, root, roots: [root], repo: root, branchesLoaded: true });
      const contextPath = "/src/platform/context.ts";
      (await import(/* @vite-ignore */ contextPath)).setContext("vcsAvailable", true);
      const actionsPath = "/src/platform/actions.ts";
      await (await import(/* @vite-ignore */ actionsPath)).executeAction("vcs.showLog");
    },
    { first, second },
  );
  const log = page.getByRole("listbox", { name: "Commits" });
  await log.getByRole("option", { name: new RegExp(first) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Interactively Rebase from Here/ }).click();
  const dialog = page.getByRole("dialog", { name: /Rebasing 2 commits/ });
  await expect(dialog).toBeVisible();

  await page.setViewportSize({ width: 440, height: 640 });
  const list = dialog.getByRole("list", { name: "Commits to rebase" });
  const originalRows = list.getByRole("listitem");
  await dialog.getByRole("button", { name: "Action for bbbbbbbb" }).click();
  await page.getByRole("option", { name: "Reword", exact: true }).click();
  const reword = dialog.getByRole("textbox", { name: "New message for bbbbbbbb" });
  await expect(reword).toHaveValue(first + "\n\nKeep the audit trail linked to the settlement job.");
  const editor = (await reword.boundingBox())!;
  expect(editor.width).toBeGreaterThan(260);
  expect(editor.height).toBeGreaterThan(160);

  const divider = dialog.getByRole("separator", { name: "Resize rebase panes" });
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  const start = dialog.getByRole("button", { name: "Start Rebasing" });
  await expect(start).toBeDisabled();
  const message = "Keep settlement references stable\n\nPreserve the audit trail.";
  await reword.fill(message);
  await expect(start).toBeEnabled();

  await dialog.getByRole("button", { name: "Move Down" }).click();
  await expect(originalRows.first()).toContainText(second);
  await expect(reword).toHaveValue(message);
  await originalRows
    .first()
    .getByRole("button", { name: new RegExp(second) })
    .click();
  const details = dialog.getByRole("region", { name: "Commit details" });
  await expect(details).toContainText("Keep the audit trail linked to the settlement job.");

  await page.setViewportSize({ width: 1120, height: 760 });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(details).toContainText(second);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("Interactive rebase shows the whole row Shift+Tab lands on below the viewport", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const hex = (n: number) => n.toString(16).padStart(8, "0").padEnd(40, "a");
    // Newest first, as git log returns; hex(0) is the base commit.
    const commits = Array.from({ length: 201 }, (_, k) => {
      const n = 200 - k;
      return {
        id: hex(n),
        shortId: hex(n).slice(0, 8),
        parents: n === 0 ? [] : [hex(n - 1)],
        summary: n === 0 ? "Initial base commit" : `Commit message #${n}`,
        message: `Commit message #${n}`,
        timeMs: 1795100000000 + n * 1000,
        refs: [],
        author: "Sam Rivera",
        email: "sam@example.com",
      };
    });
    const h = window.__ipc.handlers;
    h.vcs_roots = () => [{ root, operation: null, head: "main", headCommit: hex(200) }];
    h.vcs_branch_info = () => ({
      head: "main",
      headCommit: hex(200),
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    h.vcs_status = () => [];
    h.vcs_log = () => commits;
    h.vcs_log_refs = () => ({});
    h.vcs_log_users = () => ["Sam Rivera <sam@example.com>"];
    h.vcs_config_get = () => null;
    h.vcs_commit_files = () => [];
    h.vcs_log_details_batch = () => [];
    const vcsPath = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ vcsPath);
    useVcs.setState({ available: true, root, roots: [root], repo: root, branchesLoaded: true });
    // Commit #1 sits far below the log's rendered rows, so open the dialog the way its context menu does.
    const rebasePath = "/src/features/vcs/rebase.tsx";
    const { interactivelyRebaseFrom } = await import(/* @vite-ignore */ rebasePath);
    await interactivelyRebaseFrom(commits[199]);
  });
  const dialog = page.getByRole("dialog", { name: /Rebasing 200 commits/ });
  await expect(dialog).toBeVisible();
  const list = dialog.getByRole("list", { name: "Commits to rebase" });

  // Focus the last row's commit, scroll the list back to the top, then Shift+Tab into the row above it.
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const last = list.getByRole("button", { name: /Commit message #200\b/ });
  await last.focus();
  await list.evaluate((el) => (el.scrollTop = 0));
  await expect(list.getByRole("button", { name: /Commit message #1\b/ })).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  const target = list.getByRole("button", { name: `Action for ${(199).toString(16).padStart(8, "0")}` });
  await expect(target).toBeFocused();

  const row = target.locator("xpath=ancestor::*[@role='listitem'][1]");
  await expect
    .poll(async () => {
      const [r, l] = await Promise.all([
        row.evaluate((el) => el.getBoundingClientRect().bottom),
        list.evaluate((el) => el.getBoundingClientRect().top + el.clientTop + el.clientHeight),
      ]);
      return r - l;
    })
    .toBeLessThanOrEqual(0.5);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});
