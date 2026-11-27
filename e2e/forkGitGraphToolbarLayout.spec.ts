/**
 * Fork: the Git Graph toolbar keeps a usable Find field and every button on screen when the
 * editor is narrow (#80). Git is stubbed at the IPC layer.
 */
import { expect, stubDesktop, test } from "./fixtures";

test("Git Graph toolbar keeps Find usable and its buttons visible when narrow", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const id = (i: number) => i.toString(16).padStart(40, "0");
    const commits = Array.from({ length: 5 }, (_, i) => ({
      id: id(i),
      shortId: id(i).slice(-8),
      parents: i + 1 < 5 ? [id(i + 1)] : [],
      refs: i === 0 ? ["HEAD", "main"] : [],
      author: "Author",
      email: "author@example.com",
      timeMs: 5 - i,
      summary: `Commit ${i}`,
      message: `Commit ${i}`,
    }));
    const h = window.__ipc.handlers;
    h.vcs_log = ({ query }) => {
      const { skip, limit, range } = query as { skip: number; limit: number; range?: string };
      return range ? [] : commits.slice(skip, limit ? skip + limit : undefined);
    };
    h.vcs_log_refs = () => ({});
    h.vcs_branches = () => [];
    h.vcs_tags = () => [];
    h.vcs_remotes = () => [];
    h.vcs_branch_info = () => ({
      head: "main",
      headCommit: id(0),
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    h.vcs_config_get = () => null;
    h.graph_stashes = () => [];
    h.graph_working_state = () => ({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0, files: 0 });
    h.graph_bisect_state = () => ({ active: false, current: null, culprit: null, output: "" });
    const storeModule = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ storeModule);
    useVcs.setState({ available: true, root, repo: root, roots: [root], branchesLoaded: true });
    const contextModule = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    setContext("vcsAvailable", true);
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("gitGraph.open");
  });
  const toolbar = page.getByRole("toolbar", { name: "Git Graph", exact: true });
  const find = toolbar.getByRole("textbox", { name: "Find commit", exact: true });
  await expect(find).toBeVisible();
  await page.setViewportSize({ width: 560, height: 600 });

  await expect
    .poll(() =>
      toolbar.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const search = element.querySelector('input[aria-label="Find commit"]')!.parentElement!.getBoundingClientRect();
        const buttons = [...element.querySelectorAll("button")].every((button) => {
          const box = button.getBoundingClientRect();
          return box.width > 0 && box.left >= bounds.left && box.right <= bounds.right;
        });
        return { search: search.width >= 100, buttons };
      }),
    )
    .toEqual({ search: true, buttons: true });

  // The field shrinks first: the buttons never wrap to a second row while it is still at full width.
  await page.setViewportSize({ width: 1600, height: 600 });
  await expect.poll(() => find.evaluate((el) => el.parentElement!.getBoundingClientRect().width)).toBe(260);
  const oneRow = (await toolbar.boundingBox())!.height;
  for (let width = 1550; width >= 600; width -= 50) {
    await page.setViewportSize({ width, height: 600 });
    const search = await find.evaluate((el) => el.parentElement!.getBoundingClientRect().width);
    const wrapped = (await toolbar.boundingBox())!.height > oneRow;
    if (wrapped) expect(search, `wrapped at ${width}px`).toBeLessThan(260);
  }
});
