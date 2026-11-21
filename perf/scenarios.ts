/**
 * Interaction scenarios. Each returns flat metrics (lower is better); budgets in
 * `budgets.json` are keyed `<scenario>.<metric>`.
 */
import { Harness, type Metrics, type Scenario } from "./lib/harness.ts";
import { frameSummary, keySummary, latencySummary, totalBlockingTime } from "./lib/stats.ts";
import { startTuiRowObserver, stopTuiRowObserver } from "./lib/tuiRows.ts";

const ROOT = "/dev/acme-api";
const SAMPLE = `${ROOT}/src/main/kotlin/com/acme/orders/service/OrderService.kt`;

/** ~`lines` lines of TypeScript with a unique first line. */
function tsSource(lines: number, tag: string): string {
  const out = [`// ${tag}`, `import { Injectable } from "./di";`, ""];
  for (let i = 0; out.length < lines; i++) {
    out.push(
      `/** Repository for entity ${i}. */`,
      `export class Repository${i}<T extends { id: number }> {`,
      `  private readonly items = new Map<number, T>();`,
      `  constructor(private readonly name = "repo-${i}") {}`,
      `  find(id: number): T | undefined {`,
      `    return this.items.get(id) ?? (id > ${i} ? undefined : this.items.get(${i}));`,
      `  }`,
      `  save(item: T): void {`,
      `    if (item.id < 0) throw new Error(\`invalid id \${item.id} in \${this.name}\`);`,
      `    this.items.set(item.id, item);`,
      `  }`,
      `}`,
      ``,
    );
  }
  return out.join("\n");
}

/** ~`lines` lines of an Angular template: bindings, interpolations and control-flow blocks. */
function angularTemplate(lines: number, tag: string): string {
  const out = [`<!-- ${tag} -->`];
  for (let i = 0; out.length < lines; i++) {
    out.push(
      `<section class="card" [class.active]="selected() === ${i}">`,
      `  <h2 (click)="select(${i})">{{ title${i}() | titlecase }}</h2>`,
      `  @if (items${i}().length) {`,
      `    <ul>`,
      `      @for (item of items${i}(); track item.id; let last = $last) {`,
      `        <li [title]="item.label" (keydown.enter)="open(item)">{{ item.name }} &amp; {{ item.count }}</li>`,
      `      } @empty {`,
      `        <li>None</li>`,
      `      }`,
      `    </ul>`,
      `  } @else {`,
      `    <p>Loading</p>`,
      `  }`,
      `</section>`,
      `@let total${i} = items${i}().length + ${i};`,
      ``,
    );
  }
  return out.join("\n");
}

const TYPED = 'val total = orders.sumOf { it.amount * (1 + rate) }\nif (total > limit) log("over limit")\n';

/** Typing at a brisk pace (~12 keys/s) in the small Kotlin sample. */
const typing: Scenario = {
  id: "typing",
  title: "Type into a small Kotlin file",
  async run(h) {
    await h.openFile(SAMPLE);
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 2));
    await h.page.keyboard.press("End");
    await h.page.keyboard.press("Enter");
    return typeAndMeasure(h, TYPED, 80);
  },
};

/**
 * The same typing in the middle of a ~20k-line (≈ 700 KB) TypeScript file, once
 * the background parse after opening has settled.
 */
const typingLarge: Scenario = {
  id: "typingLarge",
  title: "Type into a 20k-line TypeScript file",
  async run(h) {
    const openMs = await h.openFile(`${ROOT}/src/big/Repositories.ts`, tsSource(20_000, "big"));
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 2));
    await h.parserIdle();
    await h.page.keyboard.press("End");
    await h.page.keyboard.press("Enter");
    return { openMs, ...(await typeAndMeasure(h, "const total = items.reduce((a, b) => a + b.id, 0);\n", 80)) };
  },
};

/**
 * The same typing in the middle of a ~12k-line Angular template (an
 * `angular.json` above it): its text, attributes and blocks are nested parses.
 */
const typingAngular: Scenario = {
  id: "typingAngular",
  title: "Type into a 12k-line Angular template",
  async run(h) {
    await h.seed(`${ROOT}/web/angular.json`, "{}");
    const openMs = await h.openFile(`${ROOT}/web/src/app/big.component.html`, angularTemplate(12_000, "big"));
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 2));
    await h.parserIdle();
    await h.page.keyboard.press("End");
    await h.page.keyboard.press("Enter");
    return { openMs, ...(await typeAndMeasure(h, "@if (open()) { {{ total + 1 }} items }\n", 80)) };
  },
};

/**
 * Code completion with a language server's 2,000 items: the first letter opens
 * the popup (after CodeMirror's 100 ms typing delay), each further letter
 * narrows it, arrows move the selection.
 */
const completion: Scenario = {
  id: "completion",
  title: "Code completion over 2,000 items",
  async run(h) {
    await h.page.evaluate(() =>
      (window as never as { __openideaPerf: { fakeCompletion(n: number): void } }).__openideaPerf.fakeCompletion(2_000),
    );
    try {
      await h.openFile(`${ROOT}/src/completion/Orders.ts`, tsSource(2_000, "completion"));
      const st = await h.editorState();
      await h.setCursor(Math.floor((st?.length ?? 0) / 2));
      await h.parserIdle();
      await h.page.keyboard.press("End");
      await h.page.keyboard.press("Enter");
      const refresh = await h.refreshMs();
      const openMs = await h.measure(() => h.page.keyboard.press("g"), ".cm-tooltip-autocomplete li", "Result<Order>");
      const t0 = await h.now();
      const before = await h.counters();
      const narrow = await h.typeMeasured("etOrd", 150);
      const work = Harness.delta(before, await h.counters());
      const arrows = await h.completionArrowsMeasured(20, 60);
      await h.page.keyboard.press("Escape");
      return {
        openMs,
        ...keySummary(narrow, refresh, "narrow"),
        narrowMainThreadMsPerKey: work.taskMs / 5,
        ...keySummary(arrows, refresh, "arrow"),
        tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
      };
    } finally {
      await h.page.evaluate(() =>
        (window as never as { __openideaPerf: { fakeCompletion(n: number): void } }).__openideaPerf.fakeCompletion(0),
      );
    }
  },
};

/**
 * A process printing 50,000 log lines (stack frames among them) at 200 lines a
 * frame (~4 s) into the Run console, while the user types in an editor: the
 * console must keep up and the editor must stay responsive.
 */
const consoleOutput: Scenario = {
  id: "consoleOutput",
  title: "Type while the Run console streams 50k lines",
  async run(h) {
    await h.openFile(SAMPLE);
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 2));
    await h.page.keyboard.press("End");
    await h.page.keyboard.press("Enter");
    const refresh = await h.refreshMs();
    const t0 = await h.now();
    await h.inPage((p) => p.startFrames());
    const streamMs = h.page.evaluate(async () => {
      const w = window as never as { __openideaPerf: { runAction(id: string, arg?: unknown): Promise<boolean> } };
      const started = performance.now();
      await w.__openideaPerf.runAction("run.sampleOutput", { lines: 50_000, perFrame: 200 });
      return performance.now() - started;
    });
    // The console takes focus with it; type back in the editor while it streams.
    await h.page.waitForTimeout(100);
    await h.setCursor((await h.editorState())?.head ?? 0);
    const keys = await h.typeMeasured(TYPED.slice(0, 40), 70);
    const total = await streamMs;
    const frames = await h.inPage((p) => p.stopFrames());
    await h.inPage((p) => p.waitShown("body", "processed order #49998", 5_000));
    return {
      // 250 frames of output at the display rate is the floor.
      streamMs: total,
      ...frameSummary(frames, refresh),
      ...keySummary(keys, refresh, "key"),
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
    };
  },
};

/**
 * Run console with 10 KiB long lines and high-rate output without newlines
 * (with Find open while streaming). `OPENIDEA_PERF_SCALE` scales counts across
 * 1× / 10× / 100× (default 10×).
 *
 * Why `consoleOutput` above missed the stall: its `SAMPLE_LINES`
 * (`src/features/run/store.ts`) are short (~70–150 char), newline-terminated
 * lines with Find closed, so it never runs link detection on multi-KiB lines.
 * The `x` fill is the worst case for path matching: one long run of path characters.
 */
const consoleLongLines: Scenario = {
  id: "consoleLongLines",
  title: "Stream 10 KiB long lines and no-newline output in the Run console",
  async run(h) {
    const scale = Math.max(1, Number(process.env.OPENIDEA_PERF_SCALE ?? "10"));
    const longCount = Math.round(100 * scale);
    const longPerFrame = Math.max(2, Math.ceil(longCount / 50));
    const noLfCount = Math.round(1_000 * scale);
    const noLfPerFrame = Math.max(20, Math.ceil(noLfCount / 60));

    type ConsolePerfWindow = {
      __openideaPerf: {
        openConsoleSession(mode: "long" | "no-lf"): Promise<string>;
        streamConsoleOutput(o: {
          mode: "long" | "no-lf";
          count: number;
          perFrame: number;
          sessionId?: string;
        }): Promise<{
          lines: number;
          dropped: number;
        }>;
      };
    };

    await h.openFile(SAMPLE);
    const refresh = await h.refreshMs();

    // Phase 1: 10 KiB unique long lines streaming (each splits at 8,000 + 2,239 chars in ConsoleModel).
    const longSessionId = await h.page.evaluate(() =>
      (window as never as ConsolePerfWindow).__openideaPerf.openConsoleSession("long"),
    );
    const longLog = h.page.locator('section[aria-label="Run"] [role="log"][aria-label="Sample long output"]').first();
    await longLog.waitFor({ timeout: 10_000 });
    const tLong = await h.now();
    await h.inPage((p) => p.startFrames());
    const longStream = h.page.evaluate(
      async ({ sessionId, count, perFrame }) => {
        const started = performance.now();
        await (window as never as ConsolePerfWindow).__openideaPerf.streamConsoleOutput({
          mode: "long",
          sessionId,
          count,
          perFrame,
        });
        return performance.now() - started;
      },
      { sessionId: longSessionId, count: longCount, perFrame: longPerFrame },
    );
    const longBox = await longLog.boundingBox();
    if (longBox) {
      await h.page.mouse.move(longBox.x + longBox.width / 2, longBox.y + longBox.height / 2);
      for (let i = 0; i < 6; i++) {
        // oxlint-disable-next-line no-await-in-loop -- wheel steps scroll the log one after another while it streams
        await h.page.mouse.wheel(0, -180);
        // oxlint-disable-next-line no-await-in-loop -- spaces the wheel steps out
        await h.page.waitForTimeout(40);
      }
    }
    const longStreamMs = await longStream;
    const longFrames = await h.inPage((p) => p.stopFrames());
    const longSummary = frameSummary(longFrames, refresh);
    const longTbtMs = totalBlockingTime(await h.longTasksSince(tLong));
    const longDomNodes = await h.page.evaluate(() => document.querySelectorAll("*").length);

    // Phase 2: mount the no-newline session and open Find ("t") before measurement or streaming starts,
    // so the entire stream is measured, then scroll horizontally across the 8,000-char rows.
    const noLfSessionId = await h.page.evaluate(() =>
      (window as never as ConsolePerfWindow).__openideaPerf.openConsoleSession("no-lf"),
    );
    const noLfLog = h.page.locator('section[aria-label="Run"] [role="log"][aria-label="Sample no-lf output"]').first();
    await noLfLog.waitFor({ timeout: 10_000 });
    const findBtn = h.page.locator('section[aria-label="Run"] button[aria-label="Find…"]').first();
    await findBtn.waitFor({ timeout: 10_000 });
    await findBtn.click();
    const findInput = h.page.locator("[data-console-find] input").first();
    await findInput.waitFor({ timeout: 10_000 });
    await findInput.fill("t");

    const tNoLf = await h.now();
    await h.inPage((p) => p.startFrames());
    const noLfStreamMs = await h.page.evaluate(
      async ({ sessionId, count, perFrame }) => {
        const started = performance.now();
        await (window as never as ConsolePerfWindow).__openideaPerf.streamConsoleOutput({
          mode: "no-lf",
          sessionId,
          count,
          perFrame,
        });
        return performance.now() - started;
      },
      { sessionId: noLfSessionId, count: noLfCount, perFrame: noLfPerFrame },
    );
    // Sweep scrollLeft across the wide 8,000-char rows with Find open.
    await noLfLog.evaluate(async (el) => {
      const maxLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        el.scrollLeft = Math.round((maxLeft * i) / steps);
        // oxlint-disable-next-line no-await-in-loop -- one horizontal scroll position per frame
        await new Promise(requestAnimationFrame);
      }
      el.scrollLeft = 0;
      await new Promise(requestAnimationFrame);
    });
    const noLfFrames = await h.inPage((p) => p.stopFrames());
    const noLfSummary = frameSummary(noLfFrames, refresh);
    const noLfTbtMs = totalBlockingTime(await h.longTasksSince(tNoLf));
    const noLfDomNodes = await h.page.evaluate(() => document.querySelectorAll("*").length);

    return {
      longStreamMs,
      longFrameP95Ms: longSummary.frameP95Ms,
      longFrameMaxMs: longSummary.frameMaxMs,
      longDroppedFramesPct: longSummary.droppedFramesPct,
      longTbtMs,
      longDomNodes,
      noLfStreamMs,
      noLfFrameP95Ms: noLfSummary.frameP95Ms,
      noLfFrameMaxMs: noLfSummary.frameMaxMs,
      noLfDroppedFramesPct: noLfSummary.droppedFramesPct,
      noLfTbtMs,
      noLfDomNodes,
    };
  },
};

/**
 * A full-screen agent TUI (Claude Code, Grok) repainting the terminal 10 times a second
 * for 6 s — every row rewritten, only the spinner row changed — while the user types in
 * an editor. Guards the terminal's unchanged-row skip: without it every frame restyles
 * and lays out the whole screen.
 */
const TUI_FRAMES = 60;
const terminalTui: Scenario = {
  id: "terminalTui",
  title: "Type while a full-screen TUI repaints the terminal",
  async run(h) {
    await h.openFile(SAMPLE);
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 2));
    // Open the terminal and let it settle before measuring.
    const opened = await h.page.evaluate(() =>
      (
        window as never as { __openideaPerf: { runAction(id: string, arg?: unknown): Promise<boolean> } }
      ).__openideaPerf.runAction("terminal.sampleTui", { frames: 1, fps: 10 }),
    );
    if (!opened) throw new Error("terminal.sampleTui is unavailable");
    await h.page.waitForTimeout(300);
    await h.setCursor((await h.editorState())?.head ?? 0);
    const refresh = await h.refreshMs();
    const t0 = await h.now();
    const before = await h.counters();
    await h.page.evaluate(startTuiRowObserver);
    await h.inPage((p) => p.startFrames());
    const stream = h.page.evaluate(
      (frames) =>
        (
          window as never as { __openideaPerf: { runAction(id: string, arg?: unknown): Promise<boolean> } }
        ).__openideaPerf.runAction("terminal.sampleTui", { frames, fps: 10 }),
      TUI_FRAMES,
    );
    let keys: number[];
    let rebuilt: number;
    try {
      await h.page.waitForTimeout(200);
      await h.setCursor((await h.editorState())?.head ?? 0);
      keys = await h.typeMeasured(TYPED.slice(0, 40), 70);
      if (!(await stream)) throw new Error("terminal.sampleTui is unavailable");
    } finally {
      rebuilt = await h.page.evaluate(stopTuiRowObserver);
    }
    const frames = await h.inPage((p) => p.stopFrames());
    const work = Harness.delta(before, await h.counters());
    return {
      // ~1 with unchanged rows left in place (only the spinner row changes), the screen height without.
      rowsRebuiltPerTuiFrame: rebuilt / TUI_FRAMES,
      styleLayoutMsPerTuiFrame: work.styleLayoutMs / TUI_FRAMES,
      scriptMsPerTuiFrame: work.scriptMs / TUI_FRAMES,
      ...frameSummary(frames, refresh),
      ...keySummary(keys, refresh, "key"),
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
    };
  },
};

/** Held key: auto-repeat at ~30 Hz must never fall behind. */
const keyRepeat: Scenario = {
  id: "keyRepeat",
  title: "Auto-repeat a key in a 20k-line file",
  async run(h) {
    await h.openFile(`${ROOT}/src/big/Repeat.ts`, tsSource(20_000, "repeat"));
    const st = await h.editorState();
    await h.setCursor(Math.floor((st?.length ?? 0) / 3));
    await h.parserIdle();
    return typeAndMeasure(h, "x".repeat(90), 33);
  },
};

async function typeAndMeasure(h: Harness, text: string, intervalMs: number): Promise<Metrics> {
  const refresh = await h.refreshMs();
  const t0 = await h.now();
  const before = await h.counters();
  const lat = await h.typeMeasured(text, intervalMs);
  const work = Harness.delta(before, await h.counters());
  const keys = text.length;
  return {
    ...keySummary(lat, refresh),
    // Counts look high (a frame re-styles after CodeMirror's measure writes), so budget the time.
    styleLayoutMsPerKey: work.styleLayoutMs / keys,
    scriptMsPerKey: work.scriptMs / keys,
    mainThreadMsPerKey: work.taskMs / keys,
    tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
  };
}

/**
 * Wheel-scrolling a large file: frame pacing while CodeMirror renders new lines.
 * `frame*` / `droppedFramesPct`: 120 px per frame (one wheel notch, ≈ 7 200 px/s,
 * a fast trackpad). `fling*`: 600 px per frame, a whole screen each frame — a
 * stress test without a budget.
 */
const scroll: Scenario = {
  id: "scroll",
  title: "Wheel-scroll a 20k-line file",
  async run(h) {
    await h.openFile(`${ROOT}/src/big/Scroll.ts`, tsSource(20_000, "scroll"));
    await h.parserIdle();
    const refresh = await h.refreshMs();
    const box = (await h.page.locator(".cm-scroller").first().boundingBox())!;
    await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const t0 = await h.now();
    const wheel = async (steps: number, dy: number) => {
      await h.inPage((p) => p.startFrames());
      for (let i = 0; i < steps; i++) {
        // oxlint-disable-next-line no-await-in-loop -- wheel notches scroll one at a time; direction depends on the step index
        await h.page.mouse.wheel(0, i < steps / 2 ? dy : -dy);
        // oxlint-disable-next-line no-await-in-loop -- 16 ms between wheel notches is part of the measured frame pacing
        await h.page.waitForTimeout(16);
      }
      await h.page.waitForTimeout(200);
      return h.inPage((p) => p.stopFrames());
    };
    const smooth = frameSummary(await wheel(160, 120), refresh);
    const tbtMs = totalBlockingTime(await h.longTasksSince(t0));
    const fling = frameSummary(await wheel(60, 600), refresh);
    // Jump far: document-end repositioning.
    await h.setCursor(0);
    const jumpMs = await h.jumpToEnd();
    return {
      ...smooth,
      tbtMs,
      flingFrameP95Ms: fling.frameP95Ms,
      flingDroppedFramesPct: fling.droppedFramesPct,
      jumpMs,
    };
  },
};

/**
 * Runs an action without a default shortcut from a key press: the press is the measured input,
 * and the action runs in its handler, as from a key binding. Pause is bound to nothing.
 */
async function runActionOnKey(h: Harness, id: string) {
  await h.page.evaluate((id) => {
    const probe = (window as never as { __openideaPerf: { runAction(id: string): Promise<boolean> } }).__openideaPerf;
    addEventListener("keydown", () => void probe.runAction(id), { capture: true, once: true });
  }, id);
  await h.page.keyboard.press("Pause");
}

/**
 * Git Log with 20,000 commits on branching lanes, loaded page by page as the
 * backend does (150 ms a page, like `git log`): showing it, walking the
 * selection with the arrow keys (the details pane follows) and wheel-scrolling
 * through several pages.
 */
const gitLog: Scenario = {
  id: "gitLog",
  title: "Show, navigate and scroll a 20k-commit Git Log",
  async run(h) {
    await h.page.evaluate(() =>
      (
        window as never as { __openideaPerf: { fakeGitLog(n: number, latencyMs?: number): void } }
      ).__openideaPerf.fakeGitLog(20_000, 150),
    );
    const showMs = await h.measure(
      () => runActionOnKey(h, "vcs.showLog"),
      '[role="listbox"][aria-label="Commits"]',
      "order flow step 0",
    );
    const refresh = await h.refreshMs();
    const list = h.page.getByRole("listbox", { name: "Commits" });
    await list.getByRole("option").first().click();
    const keyLat = await h.pressMeasured(Array(40).fill("ArrowDown"), 50);
    const box = (await list.boundingBox())!;
    await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const t0 = await h.now();
    await h.inPage((p) => p.startFrames());
    // Far enough to load several more pages on the way.
    for (let i = 0; i < 160; i++) {
      // oxlint-disable-next-line no-await-in-loop -- wheel notches must scroll in order to load several Git Log pages
      await h.page.mouse.wheel(0, i < 120 ? 600 : -600);
      // oxlint-disable-next-line no-await-in-loop -- 16 ms between wheel notches is part of the measured frame pacing
      await h.page.waitForTimeout(16);
    }
    await h.page.waitForTimeout(200);
    const frames = await h.inPage((p) => p.stopFrames());
    return {
      showMs,
      ...frameSummary(frames, refresh),
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
      ...keySummary(keyLat, refresh, "arrowKey"),
    };
  },
};

/** Scrollbar-sized jumps across a loaded graph, rather than incremental wheel scrolling. */
const gitLogScrollbar: Scenario = {
  id: "gitLogScrollbar",
  title: "Drag through a loaded 6k-commit Git Log",
  async run(h) {
    await h.page.evaluate(async () => {
      const probe = (
        window as never as {
          __openideaPerf: {
            fakeGitLog(n: number): void;
            runAction(id: string): Promise<boolean>;
          };
        }
      ).__openideaPerf;
      probe.fakeGitLog(6000);
      await probe.runAction("vcs.showLog");
    });
    const list = h.page.getByRole("listbox", { name: "Commits" });
    await list.waitFor();
    await list.evaluate(async (element) => {
      for (let i = 0; i < 300 && element.scrollHeight < 6000 * 26; i++) {
        element.scrollTop = element.scrollHeight;
        // oxlint-disable-next-line no-await-in-loop -- each scroll to the bottom waits a frame for the fake log to load more rows
        await new Promise(requestAnimationFrame);
      }
      if (element.scrollHeight < 6000 * 26) throw new Error("Git Log did not finish loading");
      element.scrollTop = 0;
    });
    await h.page.waitForTimeout(200);
    const refresh = await h.refreshMs();
    const t0 = await h.now();
    await h.inPage((p) => p.startFrames());
    await list.evaluate(async (element) => {
      const max = element.scrollHeight - element.clientHeight;
      for (let i = 0; i < 180; i++) {
        element.scrollTop = ((i < 90 ? i : 180 - i) / 90) * max;
        // oxlint-disable-next-line no-await-in-loop -- scrollbar drag advances one position per frame
        await new Promise(requestAnimationFrame);
      }
    });
    const frames = await h.inPage((p) => p.stopFrames());
    return {
      ...frameSummary(frames, refresh),
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
    };
  },
};

/** Fast wheel scrolling while pages add hundreds of overlapping branch lanes. */
const gitLogWide: Scenario = {
  id: "gitLogWide",
  title: "Page through Git Log with 240 long-lived branches",
  async run(h) {
    await h.page.evaluate(async () => {
      const { __openideaPerf: probe } = window as never as {
        __openideaPerf: {
          fakeGitLog(n: number, latencyMs: number, longBranches: number): void;
          runAction(id: string): Promise<boolean>;
        };
      };
      probe.fakeGitLog(3600, 15, 240);
      await probe.runAction("vcs.showLog");
    });
    const list = h.page.getByRole("listbox", { name: "Commits" });
    await list.getByRole("option").first().waitFor();
    const refresh = await h.refreshMs();
    const started = await h.now();
    await h.inPage((p) => p.startFrames());
    const height = await list.evaluate(async (el) => {
      for (let i = 0; i < 180; i++) {
        el.scrollTop += i < 120 ? 520 : -520;
        // oxlint-disable-next-line no-await-in-loop -- one scroll position per frame
        await new Promise(requestAnimationFrame);
      }
      return el.scrollHeight;
    });
    const frames = await h.inPage((p) => p.stopFrames());
    if (height < 2400 * 26) throw new Error("Wide Git Log did not load eight pages");
    return {
      ...frameSummary(frames, refresh),
      tbtMs: totalBlockingTime(await h.longTasksSince(started)),
    };
  },
};

type FindProbe = { __openideaPerf: { fakeFindStream(files: number, hits?: number, len?: number): Promise<void> } };

/**
 * Streams one Find search into the Find tool window while its results are
 * scrolled every frame; times until the final count is painted.
 */
async function streamFind(h: Harness, files: number, hits: number, lineLength: number, refresh: number) {
  const t0 = await h.now();
  const before = await h.counters();
  const run = await h.page.evaluate(
    async ({ files, hits, lineLength }) => {
      const started = performance.now();
      const frames: number[] = [];
      let last = -1;
      let finished = false;
      // The count reads e.g. "10,000 matches in 10,000 files" once the search is done.
      const final = `${files * hits}matchesin${files}file`;
      // Done: the final count is shown and the Stop button turned back into Rerun.
      const shown = () =>
        !!document.querySelector('button[aria-label="Rerun"]') &&
        (document.body.textContent ?? "").replace(/[\s,.\u202f]/g, "").includes(final);
      const tick = (now: number) => {
        if (last >= 0) frames.push(now - last);
        last = now;
        const tree = document.querySelector<HTMLElement>('[role="tree"][aria-label="Find results"]');
        // Keep scrolling while results stream in; turn back at the end.
        if (tree) {
          tree.scrollTop = tree.scrollTop + 96 >= tree.scrollHeight - tree.clientHeight ? 0 : tree.scrollTop + 96;
        }
        if (!finished) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // Slow builds give up after two minutes (reported as timedOut, streamMs then a lower bound).
      const deadline = started + 120_000;
      const delivered = (window as never as FindProbe).__openideaPerf.fakeFindStream(files, hits, lineLength);
      await Promise.race([delivered, new Promise((r) => setTimeout(r, 120_000))]);
      const deliveredMs = performance.now() - started;
      while (!shown() && performance.now() < deadline) await new Promise(requestAnimationFrame);
      const streamMs = performance.now() - started;
      finished = true;
      return { frames, deliveredMs, streamMs, timedOut: shown() ? 0 : 1 };
    },
    { files, hits, lineLength },
  );
  const work = Harness.delta(before, await h.counters());
  const longTasks = await h.longTasksSince(t0);
  return {
    streamMs: run.streamMs,
    deliveredMs: run.deliveredMs,
    timedOut: run.timedOut,
    ...frameSummary(run.frames, refresh),
    framesOver33: run.frames.filter((f) => f > 33).length,
    longTasks: longTasks.length,
    tbtMs: totalBlockingTime(longTasks),
    scriptMs: work.scriptMs,
    taskMs: work.taskMs,
  };
}

/**
 * Find in Files results opened in the Find tool window, streamed one file per
 * channel message as the backend sends them: 1,000, 4,000 and 10,000 files (the
 * backend's default match limit) with one match each, one file with 10,000
 * matches, and 2,000 files whose matching lines are 4,000 characters long.
 */
const findStream: Scenario = {
  id: "findStream",
  title: "Stream up to 10,000 results into the Find tool window",
  async run(h) {
    const refresh = await h.refreshMs();
    const shapes: Array<[string, number, number, number]> = [
      ["files1k", 1_000, 1, 80],
      ["files4k", 4_000, 1, 80],
      ["files10k", 10_000, 1, 80],
      ["hits10k", 1, 10_000, 80],
      ["longLines", 2_000, 1, 4_000],
    ];
    const out: Metrics = {};
    for (const [name, files, hits, lineLength] of shapes) {
      const m = await streamFind(h, files, hits, lineLength, refresh);
      for (const [k, v] of Object.entries(m)) out[`${name}${k[0]!.toUpperCase()}${k.slice(1)}`] = v;
      await h.page.waitForTimeout(300);
    }
    return out;
  },
};

/**
 * Deep paging: a Git Log of `OPENIDEA_PERF_GIT_LOG_DEEP` commits (default 50,000) with 200
 * long-lived branches, scrolled to the end until 60% of it is loaded page by page, then
 * arrow keys, hover over the graph and Refresh at that depth. Each page arriving must cost
 * the same at row 30,000 as at row 600.
 */
const gitLogDeep: Scenario = {
  id: "gitLogDeep",
  title: "Page a Git Log 30k commits deep, then navigate, hover and refresh",
  async run(h) {
    const total = Number(process.env.OPENIDEA_PERF_GIT_LOG_DEEP ?? 50_000);
    const target = Math.floor(total * 0.6);
    await h.page.evaluate(
      async ({ total }) => {
        const { __openideaPerf: probe } = window as never as {
          __openideaPerf: {
            fakeGitLog(n: number, latencyMs: number, longBranches: number): void;
            runAction(id: string): Promise<boolean>;
          };
        };
        probe.fakeGitLog(total, 15, 200);
        await probe.runAction("vcs.showLog");
      },
      { total },
    );
    const list = h.page.getByRole("listbox", { name: "Commits" });
    await list.getByRole("option").first().waitFor();
    const refresh = await h.refreshMs();

    const pagingStarted = await h.now();
    await h.inPage((p) => p.startFrames());
    const pagingMs = await list.evaluate(async (el, target) => {
      const started = performance.now();
      // 26 px rows; the Loading row and column headers add a little.
      while (el.scrollHeight < target * 26) {
        if (performance.now() - started > 20 * 60_000) throw new Error("Deep Git Log did not load");
        el.scrollTop = el.scrollHeight;
        await new Promise(requestAnimationFrame);
      }
      return performance.now() - started;
    }, target);
    const pagingFrames = await h.inPage((p) => p.stopFrames());
    const pagingTasks = await h.longTasksSince(pagingStarted);
    const paging = frameSummary(pagingFrames, refresh);

    await h.page.waitForTimeout(300);
    const box = (await list.boundingBox())!;
    await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const keyLat = await h.pressMeasured(Array(30).fill("ArrowDown"), 50);

    const hoverStarted = await h.now();
    await h.inPage((p) => p.startFrames());
    for (let i = 0; i < 40; i++) {
      await h.page.mouse.move(box.x + 8 + (i % 8) * 12, box.y + 40 + ((i * 7) % 20) * 13);
      await h.page.waitForTimeout(16);
    }
    const hover = frameSummary(await h.inPage((p) => p.stopFrames()), refresh);
    const hoverTasks = await h.longTasksSince(hoverStarted);

    // Refresh with no page request in flight: the perf backend has no request cancellation.
    await list.evaluate(async (el) => {
      el.scrollTop = 0;
      for (let i = 0; i < 600 && el.querySelector('[role="status"], [class*="Spinner"]'); i++)
        await new Promise((r) => setTimeout(r, 50));
    });
    await h.page.waitForTimeout(500);
    const refreshStarted = await h.now();
    // The log's own Refresh (its filter bar), not the Branches panel's, which reloads branches.
    const refreshButton = h.page.getByRole("button", { name: "Refresh", exact: true });
    const logPane = h.page.locator("div").filter({ has: list }).filter({ has: refreshButton }).last();
    await logPane.getByRole("button", { name: "Refresh", exact: true }).first().click();
    await h.page.waitForTimeout(1500);
    await h.inPage((p) => p.afterNextPaint().then(() => p.afterNextPaint()));
    const refreshTasks = await h.longTasksSince(refreshStarted);

    const longest = (tasks: ReadonlyArray<{ duration: number }>) => Math.max(0, ...tasks.map((t) => t.duration));
    return {
      pagingMs,
      pagingFrameP95Ms: paging.frameP95Ms,
      pagingFrameMaxMs: paging.frameMaxMs,
      pagingDroppedFramesPct: paging.droppedFramesPct,
      pagingLongTasks: pagingTasks.length,
      pagingLongTaskMaxMs: longest(pagingTasks),
      pagingTbtMs: totalBlockingTime(pagingTasks),
      ...keySummary(keyLat, refresh, "arrowKey"),
      hoverFrameMaxMs: hover.frameMaxMs,
      hoverLongTasks: hoverTasks.length,
      refreshLongTasks: refreshTasks.length,
      refreshLongTaskMaxMs: longest(refreshTasks),
    };
  },
};

/**
 * Dragging the splitters with an editor, the Project tree and the Git Log
 * open: every pointer move resizes the islands, so each frame relays them out.
 */
const resizePanels: Scenario = {
  id: "resizePanels",
  title: "Drag the tool window splitters",
  async run(h) {
    await h.openFile(SAMPLE);
    await h.page.evaluate(() =>
      (window as never as { __openideaPerf: { fakeGitLog(n: number): void } }).__openideaPerf.fakeGitLog(2_000),
    );
    await h.page.evaluate(() =>
      (window as never as { __openideaPerf: { runAction(id: string): Promise<boolean> } }).__openideaPerf.runAction(
        "vcs.showLog",
      ),
    );
    // Set-up, not measured: the splitters are dragged once the log is shown.
    await h.inPage((p) => p.waitShown('[role="listbox"][aria-label="Commits"]', "order flow step 0", 10_000));
    const refresh = await h.refreshMs();
    const drag = async (name: string, dx: number, dy: number) => {
      const box = (await h.page.getByRole("separator", { name }).boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await h.page.mouse.move(x, y);
      await h.page.mouse.down();
      await h.inPage((p) => p.startFrames());
      // Out and back twice, one pointer move a frame.
      for (let i = 0; i < 120; i++) {
        const t = Math.sin((i / 60) * Math.PI);
        // oxlint-disable-next-line no-await-in-loop -- pointer moves follow the drag path one frame at a time
        await h.page.mouse.move(x + dx * t, y + dy * t);
        // oxlint-disable-next-line no-await-in-loop -- 16 ms between pointer moves is part of the measured drag pacing
        await h.page.waitForTimeout(16);
      }
      await h.page.mouse.up();
      await h.page.waitForTimeout(200);
      return frameSummary(await h.inPage((p) => p.stopFrames()), refresh);
    };
    const t0 = await h.now();
    const side = await drag("Resize left tool window", 300, 0);
    const bottom = await drag("Resize bottom tool window", 0, -250);
    return {
      ...side,
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
      bottomFrameP95Ms: bottom.frameP95Ms,
      bottomDroppedFramesPct: bottom.droppedFramesPct,
    };
  },
};

/** Cold load: navigation → Project tree painted. */
const startup: Scenario = {
  id: "startup",
  title: "Load the workbench",
  blank: true,
  async run(h) {
    const readyMs = await h.load();
    const paints = await h.page.evaluate(() =>
      Object.fromEntries(performance.getEntriesByType("paint").map((e) => [e.name, e.startTime])),
    );
    await h.gc();
    const nodes = (await h.counters()).Nodes ?? NaN;
    return {
      readyMs,
      fcpMs: paints["first-contentful-paint"] ?? NaN,
      tbtMs: totalBlockingTime(await h.longTasksSince(0)),
      heapMb: await h.heapMb(),
      domNodes: nodes,
    };
  },
};

/** Opening files: small sample, then switching between eight open tabs. */
const tabs: Scenario = {
  id: "tabs",
  title: "Open files and switch tabs",
  async run(h) {
    const openSmallMs = await h.openFile(SAMPLE);
    const names: string[] = [];
    for (let i = 0; i < 8; i++) {
      const name = `Module${i}.ts`;
      names.push(name);
      // oxlint-disable-next-line no-await-in-loop -- opening files seeds and shows them in one shared editor; tab order matters
      await h.openFile(`${ROOT}/src/tabs/${name}`, tsSource(2_000, `tab-${i}`));
    }
    const switches: number[] = [];
    // Recently shown tabs keep their editor view: showing one again must not build a new one.
    let viewsRebuilt = 0;
    let switchWork = await h.counters();
    for (let round = 0; round < 3; round++) {
      // oxlint-disable-next-line no-await-in-loop -- counters are snapshotted between rounds, not concurrently with the switches
      if (round === 1) switchWork = await h.counters();
      for (let i = 0; i < names.length; i++) {
        const tab = h.page.getByRole("tab", { name: names[i], exact: true });
        // oxlint-disable-next-line no-await-in-loop -- each tab click is measured with its own armed page token; a concurrent click would cross-match the previous target
        switches.push(await h.measure(() => tab.click(), ".cm-content", `// tab-${i}`));
        // oxlint-disable-next-line no-await-in-loop -- view freshness must be checked right after this tab's measured click
        const fresh = await h.page.evaluate(() => {
          const view = document.querySelector("[data-editor-host] .cm-editor") as { perfSeen?: boolean } | null;
          if (!view || view.perfSeen) return false;
          view.perfSeen = true;
          return true;
        });
        if (round > 0 && fresh) viewsRebuilt++;
      }
    }
    const work = Harness.delta(switchWork, await h.counters());
    // The Switcher (Ctrl+Tab) back and forth between the two most recent tabs.
    const before = await h.counters();
    const switcher: number[] = [];
    for (let i = 0; i < 10; i++) {
      const tag = i % 2 ? names.length - 1 : names.length - 2;
      // oxlint-disable-next-line no-await-in-loop -- Switcher toggles are measured in order between the two most recent tabs
      switcher.push(await h.measure(() => h.pressAction("navigate.switcher"), ".cm-content", `// tab-${tag}`));
      // oxlint-disable-next-line no-await-in-loop -- 150 ms settle between Switcher toggles is part of the measured sequence
      await h.page.waitForTimeout(150);
    }
    const switcherWork = Harness.delta(before, await h.counters());
    return {
      openSmallMs,
      ...latencySummary(switches, "switch"),
      switchMainThreadMs: work.taskMs / (names.length * 2),
      viewsRebuilt,
      ...latencySummary(switcher, "switcher"),
      switcherMainThreadMs: switcherWork.taskMs / switcher.length,
    };
  },
};

/**
 * Two agent tasks with long conversations (150 turns, 2,100 entries) in editor tabs:
 * switching between them with the Switcher (Ctrl+Tab) shows a kept-alive conversation
 * again, which must not restyle its whole history; then scrolling up through one.
 * Chromium anchors scrolling on its own (WebKit doesn't), so anchoring is turned off
 * here: rows that take their real height only once scrolled into view would jump.
 */
const agentTabs: Scenario = {
  id: "agentTabs",
  title: "Switch between and scroll long agent conversations",
  async run(h) {
    await h.page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
    await h.page.evaluate(() =>
      (
        window as never as { __openideaPerf: { runAction(id: string, arg?: unknown): Promise<boolean> } }
      ).__openideaPerf.runAction("agents.openSampleConversations", { tasks: 2, turns: 150 }),
    );
    // The conversation shown: its requests end with its task's title.
    const SHOWN = "[data-editor-focus] [data-message]";
    const title = (n: number) => `(Sample task ${n})`;
    // Visit each conversation to let it finish painting and laying out its history.
    for (const n of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- visit conversations in order so each history is laid out before the next
      await h.page.getByRole("tab", { name: `Sample task ${n}` }).click();
      // oxlint-disable-next-line no-await-in-loop -- wait for this tab's conversation to attach before it can settle
      await h.page
        .locator(SHOWN, { hasText: title(n) })
        .filter({ hasText: "Turn 0:" })
        .first()
        .waitFor({ state: "attached", timeout: 30_000 });
      // oxlint-disable-next-line no-await-in-loop -- settle wait belongs to this tab's visit, before the next tab
      await h.page.waitForTimeout(300);
    }
    // WebKit restyles a hidden conversation in full when it is shown again (Chromium keeps its
    // style): what bounds that there is the history's DOM, and rows skipping rendering off screen.
    const { conversationNodes, rowsAlwaysRendered } = await h.page.evaluate((selector) => {
      const conversation = document.querySelector(selector)!;
      const rows = [...conversation.querySelector("[data-message]")!.parentElement!.children];
      return {
        conversationNodes: conversation.querySelectorAll("*").length,
        rowsAlwaysRendered: rows.filter((r) => getComputedStyle(r).contentVisibility !== "auto").length,
      };
    }, "[data-editor-focus]");

    const t0 = await h.now();
    const before = await h.counters();
    const switches: number[] = [];
    for (let i = 0; i < 10; i++) {
      // oxlint-disable-next-line no-await-in-loop -- Switcher toggles are measured in order between the two conversations
      switches.push(await h.measure(() => h.pressAction("navigate.switcher"), SHOWN, title(i % 2 ? 2 : 1)));
      // oxlint-disable-next-line no-await-in-loop -- 150 ms settle between Switcher toggles is part of the measured sequence
      await h.page.waitForTimeout(150);
    }
    const work = Harness.delta(before, await h.counters());
    const switchTbtMs = totalBlockingTime(await h.longTasksSince(t0));

    // Scrolling up from the end, a step at a time: how far the text under the pointer moves
    // beyond the scroll itself.
    const scrollJumps = await h.page.evaluate(async (selector) => {
      const stream = document.querySelector(selector)!.parentElement!;
      const frame = () => new Promise(requestAnimationFrame);
      stream.scrollTop = stream.scrollHeight;
      await frame();
      await frame();
      const top = stream.getBoundingClientRect().top;
      let jumps = 0;
      for (let i = 0; i < 100 && stream.scrollTop > 0; i++) {
        const row = [...stream.children].find((r) => r.getBoundingClientRect().bottom > top + 200)!;
        const from = row.getBoundingClientRect().top;
        const scrolled = stream.scrollTop;
        // A wheel step: the user scrolls, so the conversation stops following its end.
        stream.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
        stream.scrollTop -= 120;
        const by = scrolled - stream.scrollTop;
        // oxlint-disable-next-line no-await-in-loop -- two frame ticks per fake wheel step; row movement is read after them
        await frame();
        // oxlint-disable-next-line no-await-in-loop -- the second frame tick completes this step before its jump is measured
        await frame();
        if (Math.abs(row.getBoundingClientRect().top - from - by) > 2) jumps++;
      }
      stream.scrollTop = stream.scrollHeight;
      return jumps;
    }, SHOWN);

    const refresh = await h.refreshMs();
    const box = (await h.page.locator("[data-editor-focus]").boundingBox())!;
    await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await h.page.waitForTimeout(200);
    const t1 = await h.now();
    await h.inPage((p) => p.startFrames());
    for (let i = 0; i < 120; i++) {
      // oxlint-disable-next-line no-await-in-loop -- wheel steps scroll the conversation up one at a time
      await h.page.mouse.wheel(0, -120);
      // oxlint-disable-next-line no-await-in-loop -- 16 ms between wheel steps is part of the measured frame pacing
      await h.page.waitForTimeout(16);
    }
    await h.page.waitForTimeout(200);
    const scroll = frameSummary(await h.inPage((p) => p.stopFrames()), refresh);
    return {
      conversationNodes,
      rowsAlwaysRendered,
      ...latencySummary(switches, "switch"),
      switchMainThreadMs: work.taskMs / switches.length,
      switchStyleLayoutMs: work.styleLayoutMs / switches.length,
      switchTbtMs,
      scrollJumps,
      scrollFrameP95Ms: scroll.frameP95Ms,
      scrollDroppedFramesPct: scroll.droppedFramesPct,
      scrollTbtMs: totalBlockingTime(await h.longTasksSince(t1)),
    };
  },
};

/** Find Action and Search Everywhere: open, then query → first result painted. */
const popups: Scenario = {
  id: "popups",
  title: "Find Action / Search Everywhere",
  async run(h) {
    await h.openFile(SAMPLE);
    const findActionOpenMs = await h.measure(() => h.pressAction("navigate.findAction"), '[role="dialog"] input');
    const findActionQueryMs = await h.measure(
      () => h.page.keyboard.insertText("memory indicator"),
      '[role="dialog"] [role="option"]',
      "Memory Indicator",
    );
    // Editing the query: Backspace → list re-filtered and painted.
    const refresh = await h.refreshMs();
    const keyLat = await h.typeMeasured("\b\b\b\b\b\b", 80, "input");
    await h.page.keyboard.press("Escape");
    await h.page.locator('[role="dialog"]').waitFor({ state: "detached" });

    const seOpenMs = await h.measure(
      () => h.pressAction("navigate.searchEverywhere"),
      '[role="dialog"][aria-label="Search Everywhere"] input',
    );
    const seQueryMs = await h.measure(
      () => h.page.keyboard.insertText("language servers"),
      '[role="dialog"] [role="option"]',
      "Language Servers",
    );
    await h.page.keyboard.press("Escape");
    return {
      findActionOpenMs,
      findActionQueryMs,
      ...keySummary(keyLat, refresh, "findActionKey"),
      searchEverywhereOpenMs: seOpenMs,
      searchEverywhereQueryMs: seQueryMs,
    };
  },
};

const TOOL_WINDOWS: Array<[string, string]> = [
  ["toolwindow.problems", "Problems"],
  ["toolwindow.run", "Run"],
  ["toolwindow.structure", "Structure"],
  ["toolwindow.commit", "Commit"],
  ["toolwindow.git", "Git"],
  ["toolwindow.terminal", "Terminal"],
];

/** Showing tool windows by shortcut (first show loads and mounts the view). */
const toolWindows: Scenario = {
  id: "toolWindows",
  title: "Show tool windows",
  async run(h) {
    await h.openFile(SAMPLE);
    const m: Metrics = {};
    const all: number[] = [];
    for (const [action, title] of TOOL_WINDOWS) {
      // Until the view's content is laid out (lazily loaded views render nothing at first).
      // oxlint-disable-next-line no-await-in-loop -- tool windows are shown and measured one at a time in the shared page
      const ms = await h.measure(
        () => h.pressAction(action),
        `section[aria-label="${title}"] [data-toolwindow-body] > *`,
      );
      m[`${title.toLowerCase()}Ms`] = ms;
      all.push(ms);
      // oxlint-disable-next-line no-await-in-loop -- hide this window before showing the next one
      await h.pressAction(action);
      // oxlint-disable-next-line no-await-in-loop -- wait for the hide before the next measurement starts
      await h.page.locator(`section[aria-label="${title}"]`).waitFor({ state: "hidden" });
    }
    return { maxMs: Math.max(...all), ...m };
  },
};

/** Project tree: expand a 10 000-entry folder and scroll through it. */
const projectTree: Scenario = {
  id: "projectTree",
  title: "Expand and scroll a 10k-entry folder",
  async run(h) {
    const generated = h.page.locator('[role="treeitem"][aria-level="2"]', { hasText: "generated" }).first();
    await generated.click();
    // Measure from a settled selection: a key pressed in the click's own frame also pays for that frame.
    await generated.and(h.page.locator('[aria-selected="true"]')).waitFor();
    await h.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const expandMs = await h.measure(
      () => h.page.keyboard.press("ArrowRight"),
      '[role="tree"][aria-label="Project"]',
      "item1.json",
    );
    const refresh = await h.refreshMs();
    // Selection walks into the expanded folder (rows stay rendered: no scroll yet).
    const keyLat = await h.pressMeasured(Array(30).fill("ArrowDown"), 50);
    const box = (await h.page.getByRole("tree", { name: "Project" }).boundingBox())!;
    await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const t0 = await h.now();
    await h.inPage((p) => p.startFrames());
    for (let i = 0; i < 60; i++) {
      // oxlint-disable-next-line no-await-in-loop -- wheel steps scroll the tree one at a time
      await h.page.mouse.wheel(0, 500);
      // oxlint-disable-next-line no-await-in-loop -- 16 ms between wheel steps is part of the measured frame pacing
      await h.page.waitForTimeout(16);
    }
    await h.page.waitForTimeout(200);
    const frames = await h.inPage((p) => p.stopFrames());
    return {
      expandMs,
      ...frameSummary(frames, refresh),
      tbtMs: totalBlockingTime(await h.longTasksSince(t0)),
      ...keySummary(keyLat, refresh, "arrowKey"),
    };
  },
};

/**
 * Selects from `item<first>.json` of the 10 000-entry folder to the end of the tree (speed search,
 * Escape, Shift+End), then presses Copy and Delete. `items`: the count the Delete dialog shows;
 * `copyMs`: key → next frame; `deleteMs`: key → dialog shown (then cancelled).
 */
async function copyAndDelete(h: Harness, first: number) {
  const tree = h.page.getByRole("tree", { name: "Project" });
  await h.page.keyboard.type(`item${first}.json`);
  await tree.getByRole("treeitem", { name: `item${first}.json`, exact: true, selected: true }).waitFor();
  await h.page.keyboard.press("Escape");
  await h.page.keyboard.press("Shift+End");
  await h.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // Hold the modifiers first: only the main key's keydown is measured.
  const [copyKey] = await h.keysFor("project.copy");
  const mods = copyKey!.split("+");
  const key = mods.pop()!;
  // oxlint-disable-next-line no-await-in-loop -- modifiers go down (and up) one at a time
  for (const m of mods) await h.page.keyboard.down(m);
  const [copyMs] = await h.pressMeasured([key], 50);
  // oxlint-disable-next-line no-await-in-loop -- modifiers go down (and up) one at a time
  for (const m of mods) await h.page.keyboard.up(m);
  const deleteMs = await h.measure(
    () => h.pressAction("project.delete"),
    '[role="dialog"]',
    "Items are moved to the Trash.",
    120_000,
  );
  const dialog = h.page.getByRole("dialog", { name: "Delete", exact: true });
  const text = (await dialog.textContent()) ?? "";
  const items = Number(/Delete (\d+) items/.exec(text)?.[1]);
  if (!items) throw new Error(`unexpected Delete dialog: ${text}`);
  await h.page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  return { items, copyMs: copyMs!, deleteMs };
}

/** Project tree: Copy and Delete on about 10, 1 000, 5 000 and 10 000 selected rows. */
const projectTreeSelection: Scenario = {
  id: "projectTreeSelection",
  title: "Copy and Delete thousands of selected tree rows",
  async run(h) {
    const generated = h.page.locator('[role="treeitem"][aria-level="2"]', { hasText: "generated" }).first();
    await generated.click();
    await generated.and(h.page.locator('[aria-selected="true"]')).waitFor();
    await h.page.keyboard.press("ArrowRight");
    await h.page.getByRole("treeitem", { name: "item1.json", exact: true }).waitFor();
    const out: Metrics = {};
    for (const [label, first] of [
      ["10", 9995],
      ["1k", 9001],
      ["5k", 5001],
      ["All", 1],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one selection at a time in the same tree
      const m = await copyAndDelete(h, first);
      out[`items${label}`] = m.items;
      out[`copy${label}Ms`] = m.copyMs;
      out[`delete${label}Ms`] = m.deleteMs;
    }
    return out;
  },
};

/** Files in the `combinedDiff` scenarios (`OPENIDEA_PERF_COMBINED_FILES`). */
const COMBINED_FILES = Number(process.env.OPENIDEA_PERF_COMBINED_FILES ?? 500);
/** Farthest the wheel pass scrolls before turning back: about 100 files of 40 lines. */
const COMBINED_WHEEL_PX = 100_000;

/**
 * Opens an all-in-one diff of `COMBINED_FILES` files from a key press, then scrolls down and back
 * up, for at most 60 s each way. `wheel`: 120 px per 16 ms of wall time (a fast wheel; the
 * compositor keeps scrolling through a slow frame), down to the end or `COMBINED_WHEEL_PX`.
 * `stress`: a viewport (or 1/300 of the whole height, if more) a frame, down to the end.
 * `blankFrames`: frames whose viewport centre shows neither a diff nor a file header.
 * `slowFrameMs` / `slowTimePct`: time in frames over 33 ms, and its share of the scroll time:
 * shares of frame counts mislead when one side renders far fewer, longer frames.
 */
async function combinedDiffScroll(h: Harness, mode: "wheel" | "stress") {
  // Opened from a key press, the measured input (no default shortcut opens it).
  await h.page.evaluate((n) => {
    const w = window as never as {
      __openideaPerf: { openCombinedDiff(n: number): Promise<{ first: string; last: string }> };
      __combinedPaths?: Promise<{ first: string; last: string }>;
    };
    addEventListener("keydown", () => (w.__combinedPaths = w.__openideaPerf.openCombinedDiff(n)), {
      capture: true,
      once: true,
    });
  }, COMBINED_FILES);
  const openMs = await h.measure(
    () => h.page.keyboard.press("Pause"),
    "[data-combined-scroll] .cm-content",
    null,
    30_000,
  );
  const paths = await h.page.evaluate(
    () => (window as never as { __combinedPaths: Promise<{ first: string; last: string }> }).__combinedPaths,
  );
  await h.page.waitForTimeout(500);
  const refresh = await h.refreshMs();
  const t0 = await h.now();
  await h.inPage((p) => p.startFrames());
  const pass = await h.page.locator("[data-combined-scroll]").evaluate(
    async (el, { first, last, wheel, maxPx }) => {
      const editors = () => el.querySelectorAll(".cm-editor").length;
      const box = el.getBoundingClientRect();
      const blank = () => {
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !hit?.closest(".cm-editor, [data-combined-block] > :first-child");
      };
      const shown = (path: string) => !!el.querySelector(`[data-combined-block="${CSS.escape(path)}"]`);
      const step = () => Math.max(el.clientHeight, Math.ceil((el.scrollHeight - el.clientHeight) / 300));
      let peakEditors = editors();
      let blankFrames = 0;
      let frames = 0;
      let reachedEnd = false;
      const walk = async (down: boolean) => {
        const started = performance.now();
        const from = el.scrollTop;
        // The end only once the view has stayed there for 30 frames: blocks loading near the bottom
        // still grow the view, so a first touch of the bottom isn't the end of the whole change.
        let settled = 0;
        while (performance.now() - started < 60_000) {
          const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && shown(last);
          settled = down && atEnd ? settled + 1 : 0;
          if (settled >= 30) reachedEnd = true;
          if (down ? reachedEnd || (wheel && el.scrollTop - from >= maxPx) : el.scrollTop <= 0 && shown(first))
            return true;
          const moved = wheel ? ((performance.now() - started) * 120) / 16 : 0;
          if (wheel) el.scrollTop = down ? Math.min(from + moved, from + maxPx) : Math.max(0, from - moved);
          else el.scrollTop = down ? el.scrollTop + step() : Math.max(0, el.scrollTop - step());
          // oxlint-disable-next-line no-await-in-loop -- rAF ticks advance the simulated scroll and its frame counters together
          await new Promise(requestAnimationFrame);
          frames++;
          if (blank()) blankFrames++;
          peakEditors = Math.max(peakEditors, editors());
        }
        return false;
      };
      await walk(true);
      const scrolledPx = el.scrollTop;
      const backAtTop = await walk(false);
      return { reachedEnd, backAtTop, scrolledPx, peakEditors, blankFrames, frames };
    },
    { ...paths, wheel: mode === "wheel", maxPx: COMBINED_WHEEL_PX },
  );
  const frames = await h.inPage((p) => p.stopFrames());
  const tbtMs = totalBlockingTime(await h.longTasksSince(t0));
  const slow = frames.filter((f) => f > 33);
  const slowFrameMs = slow.reduce((sum, f) => sum + f, 0);
  const totalMs = frames.reduce((sum, f) => sum + f, 0);
  return {
    openMs,
    ...frameSummary(frames, refresh),
    slowFramesPct: frames.length ? (100 * slow.length) / frames.length : 0,
    slowFrameMs,
    slowTimePct: totalMs ? (100 * slowFrameMs) / totalMs : 0,
    tbtMs,
    peakEditors: pass.peakEditors,
    blankFrames: pass.blankFrames,
    scrollFrames: pass.frames,
    blankPct: pass.frames ? (100 * pass.blankFrames) / pass.frames : 0,
    scrolledPx: pass.scrolledPx,
    reachedEnd: pass.reachedEnd ? 1 : 0,
    backAtTop: pass.backAtTop ? 1 : 0,
    domNodes: (await h.counters()).Nodes ?? NaN,
  };
}

const combinedDiff: Scenario = {
  id: "combinedDiff",
  title: `Wheel through an all-in-one diff of ${COMBINED_FILES} files`,
  run: (h) => combinedDiffScroll(h, "wheel"),
};

const combinedDiffStress: Scenario = {
  id: "combinedDiffStress",
  title: `Scroll an all-in-one diff of ${COMBINED_FILES} files a screen a frame`,
  run: (h) => combinedDiffScroll(h, "stress"),
};

interface CombinedProbe {
  openCombinedDiff(
    files: number,
    bigLines: number,
    options?: { allEditable?: boolean; lines?: number; tag?: string },
  ): Promise<{ first: string; big: string; editable: string; last: string; binary: string; paths: string[] }>;
  hasEditor(path: string): boolean;
  editAndSaveDiff(path: string, marker: string): Promise<{ text: string; unsaved: boolean; savedText: string }>;
  unsaved(path: string): boolean;
  runAction(id: string): Promise<boolean>;
}

/** Files in the `combinedDiff` / `combinedDiffAcceptance` scenarios (`OPENIDEA_PERF_COMBINED_FILES`, default 500). */
const COMBINED_FILES = Number(process.env.OPENIDEA_PERF_COMBINED_FILES ?? 500);

/**
 * Brings a file's block to the top of `[data-combined-scroll]` and waits for its content (unless
 * `waitContent` is false). Works for both unvirtualized (all blocks in DOM) and virtualized
 * (`[data-index]` slots) implementations.
 */
function revealCombinedBlock(
  scroller: ReturnType<Harness["page"]["locator"]>,
  path: string,
  opts: { waitContent?: boolean; waitText?: string } = {},
) {
  const { waitContent = true, waitText = "" } = opts;
  return scroller.evaluate(
    async (el, { sel, target, expectContent, expectText }) => {
      const frames = async (n: number) => {
        for (let k = 0; k < n; k++) await new Promise(requestAnimationFrame);
      };
      const loaded = () => {
        const block = el.querySelector<HTMLElement>(sel);
        if (!block) return false;
        if (expectText) return !!block.textContent?.includes(expectText);
        if (!expectContent) return true;
        const content = block.querySelector<HTMLElement>(".cm-content");
        return !!content && !content.closest("[hidden]");
      };
      const started = performance.now();
      let lo = 0;
      let hi = el.scrollHeight;
      while (performance.now() - started < 60_000) {
        if (el.querySelector(sel)) {
          // Until its diff is loaded and it has stayed at the top (or visible at bottom) for 10 frames.
          let still = 0;
          for (let j = 0; j < 1200 && still < 10; j++) {
            const block = el.querySelector(sel);
            if (!block) break;
            const blockRect = block.getBoundingClientRect();
            const elRect = el.getBoundingClientRect();
            const atTop = Math.abs(blockRect.top - elRect.top) <= 1;
            const inView = blockRect.top >= elRect.top - 1 && blockRect.bottom <= elRect.bottom + 1;
            const atBottom = inView && el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
            if (loaded() && (atTop || atBottom)) still++;
            else {
              still = 0;
              block.scrollIntoView({ block: "start" });
            }
            await frames(1);
          }
          if (still >= 10) return true;
          if (el.querySelector(sel)) return false;
          // Moved out of view as the blocks around it were measured: bisect again from here.
          lo = 0;
          hi = el.scrollHeight;
          continue;
        }
        const slots = [...el.querySelectorAll<HTMLElement>("[data-index]")];
        if (!slots.length) {
          await frames(1);
          continue;
        }
        // Pick the slot closest to the viewport top so far-away pinned dirty blocks cannot skew bisection.
        const elTop = el.getBoundingClientRect().top;
        let nearest = slots[0]!;
        let bestDist = Math.abs(nearest.getBoundingClientRect().top - elTop);
        for (let k = 1; k < slots.length; k++) {
          const dist = Math.abs(slots[k]!.getBoundingClientRect().top - elTop);
          if (dist < bestDist) {
            bestDist = dist;
            nearest = slots[k]!;
          }
        }
        const cur = Number(nearest.dataset.index);
        const below = target > cur;
        if (below) lo = el.scrollTop;
        else hi = el.scrollTop;
        if (below && hi - lo < el.clientHeight) hi = el.scrollHeight;
        el.scrollTop =
          hi - lo < el.clientHeight
            ? el.scrollTop + (below ? 1 : -1) * (el.clientHeight / 2)
            : Math.round((lo + hi) / 2);
        await frames(2);
      }
      return false;
    },
    {
      sel: `[data-combined-block="${path}"]`,
      target: Number(/(\d+)\.\w+$/.exec(path)![1]),
      expectContent: waitContent,
      expectText: waitText,
    },
  );
}

/**
 * Timed performance benchmark for an all-in-one diff of many mixed files (`COMBINED_FILES`,
 * binary `.png` files, 2,000-line files, and one large file with up to 50,000 changed lines).
 * Runs identically against both unvirtualized (before) and virtualized (after) implementations:
 * scrolls top → bottom → top (cap 1,200 steps / 60 s per direction), records `reachedEnd`,
 * verifies sticky header on the large diff, verifies blurred unsaved-edit retention on a
 * working file half-way down, and measures `Next File` header alignment (`nextFileOffPx`).
 * Full per-file reachability, expansion, editing, and read-back across all files live in
 * `combinedDiffAcceptance`.
 */
const combinedDiff: Scenario = {
  id: "combinedDiff",
  title: `Scroll an all-in-one diff of ${COMBINED_FILES} files and edit one`,
  async run(h) {
    const files = COMBINED_FILES;
    const bigLines = Math.min(50_000, files * 10);
    let first = "";
    let editable = "";
    let big = "";
    let last = "";
    const openMs = await h.measure(
      async () => {
        ({ first, editable, big, last } = await h.page.evaluate(
          ([f, b]) => (window as never as { __openideaPerf: CombinedProbe }).__openideaPerf.openCombinedDiff(f!, b!),
          [files, bigLines],
        ));
      },
      "[data-combined-scroll] .cm-content",
      null,
      30_000,
    );
    const scroller = h.page.locator("[data-combined-scroll]");
    await h.page.waitForTimeout(500);
    await h.page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    const refresh = await h.refreshMs();
    const t0 = await h.now();
    await h.inPage((p) => p.startFrames());
    const pass = await scroller.evaluate(
      async (el, { firstPath, lastPath }) => {
        const editors = () => el.querySelectorAll(".cm-editor").length;
        const frame = () => new Promise(requestAnimationFrame);
        const started = performance.now();
        const step = () => Math.max(el.clientHeight, Math.ceil((el.scrollHeight - el.clientHeight) / 300));
        let peak = editors();
        let steps = 0;
        let reachedEnd = false;
        for (let i = 0; i < 1200 && performance.now() - started < 60_000; i++, steps++) {
          if (
            el.scrollTop + el.clientHeight >= el.scrollHeight - 1 &&
            el.querySelector(`[data-combined-block="${lastPath}"]`)
          ) {
            reachedEnd = true;
            break;
          }
          el.scrollTop += step();
          await frame();
          peak = Math.max(peak, editors());
        }
        let backAtTop = false;
        for (let i = 0; i < 1200 && performance.now() - started < 120_000; i++, steps++) {
          if (el.scrollTop <= 0 && el.querySelector(`[data-combined-block="${firstPath}"]`)) {
            backAtTop = true;
            break;
          }
          el.scrollTop = Math.max(0, el.scrollTop - step());
          await frame();
          peak = Math.max(peak, editors());
        }
        return { peak, steps, reachedEnd, backAtTop, ms: performance.now() - started };
      },
      { firstPath: first, lastPath: last },
    );
    const frames = await h.inPage((p) => p.stopFrames());
    const longTasks = await h.longTasksSince(t0);
    await h.page.waitForTimeout(500);
    const editorsAfter = await scroller.evaluate((el) => el.querySelectorAll(".cm-editor").length);
    const domNodes = (await h.counters()).Nodes ?? NaN;

    // The header of a file stays at the top while its diff scrolls by.
    const bigBlock = `[data-combined-block="${big}"]`;
    if (!(await revealCombinedBlock(scroller, big))) throw new Error(`the diff of ${big} never loaded`);
    const sticky = await scroller.evaluate(async (el, sel) => {
      const block = el.querySelector<HTMLElement>(sel)!;
      el.scrollTop += Math.min(2000, block.offsetHeight / 2);
      await new Promise(requestAnimationFrame);
      const now = el.querySelector<HTMLElement>(sel);
      if (now !== block) return { off: NaN, remounted: true };
      const header = block.firstElementChild!.getBoundingClientRect().top;
      return { off: Math.abs(header - el.getBoundingClientRect().top), remounted: false };
    }, bigBlock);
    if (!(sticky.off <= 1)) throw new Error(`the file header did not stay at the top (${JSON.stringify(sticky)})`);

    // Edit the working file half-way down, blur, scroll it far away and come back.
    const block = `[data-combined-block="${editable}"]`;
    if (!(await revealCombinedBlock(scroller, editable))) throw new Error(`the diff of ${editable} never loaded`);
    const pane = h.page.locator(`${block} .cm-content`).last();
    await pane.click();
    await h.page.keyboard.press("End");
    await h.page.keyboard.type(" // PERF_EDIT");
    await h.page
      .locator(`${block} .cm-editor`)
      .last()
      .evaluate((el) => ((el as HTMLElement).dataset.perfMark = "1"));
    // Blur before scrolling away so the dirty-document guard (not keyboard focus) keeps the block mounted.
    await h.page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    const preScroll = await scroller.evaluate(
      (el, path) => ({
        focused: el.contains(document.activeElement),
        unsaved: (window as never as { __openideaPerf: CombinedProbe }).__openideaPerf.unsaved(path),
      }),
      editable,
    );
    if (preScroll.focused || !preScroll.unsaved)
      throw new Error(`expected blurred dirty editor before scrolling away: ${JSON.stringify(preScroll)}`);
    await scroller.evaluate(async (el) => {
      for (let i = 0; i < 300 && el.scrollTop + el.clientHeight < el.scrollHeight - 1; i++) {
        el.scrollTop += Math.max(el.clientHeight, Math.ceil((el.scrollHeight - el.clientHeight) / 300));
        await new Promise(requestAnimationFrame);
      }
    });
    await h.page.waitForTimeout(300);
    await revealCombinedBlock(scroller, editable);
    const kept = await h.page.evaluate(
      ({ sel, path }) => {
        const cm = document.querySelector<HTMLElement>(`${sel} .cm-editor[data-perf-mark]`);
        return {
          sameEditor: !!cm,
          text: !!cm?.textContent?.includes("PERF_EDIT"),
          unsaved: (window as never as { __openideaPerf: CombinedProbe }).__openideaPerf.unsaved(path),
        };
      },
      { sel: block, path: editable },
    );
    if (!kept.sameEditor || !kept.text || !kept.unsaved)
      throw new Error(`the edit did not survive scrolling away: ${JSON.stringify(kept)}`);

    // Next File from there: how far the next file's header lands from the top of the view.
    const toolbar = h.page.getByRole("toolbar", { name: "Combined Changes Diff" });
    await toolbar.getByRole("button", { name: "Next File" }).click();
    await h.page.waitForTimeout(500);
    const nextFileOffPx = await scroller.evaluate((el, sel) => {
      const blocks = [...el.querySelectorAll("[data-combined-block]")];
      const next = blocks[blocks.findIndex((b) => b.matches(sel)) + 1];
      return next ? Math.abs(next.getBoundingClientRect().top - el.getBoundingClientRect().top) : NaN;
    }, block);

    return {
      openMs,
      ...frameSummary(frames, refresh),
      longTasks: longTasks.length,
      longTasksOver200: longTasks.filter((t) => t.duration > 200).length,
      tbtMs: totalBlockingTime(longTasks),
      peakEditors: pass.peak,
      editorsAfter,
      domNodes,
      scrollSteps: pass.steps,
      scrollMs: pass.ms,
      reachedEnd: pass.reachedEnd ? 1 : 0,
      nextFileOffPx,
    };
  },
};

/**
 * Exhaustive per-file acceptance pass separated from timed perf (`OPENIDEA_PERF_COMBINED_FILES`,
 * default 500; run with `5000` and `--warmup 0 --runs 1` for full 5,000-file proof):
 * 1. Opens `N` editable working-tree text files, collapses all, steps by at most ~0.75 viewport
 *    keeping a set of seen indexes/paths across frames with strict contiguity (no skipped ranges),
 *    and verifies EVERY SINGLE file `0..N-1`: index/path, expand, write, read back, save/cleanup,
 *    plus bounded editor count and zero leak back at top.
 * 2. Opens `N` mixed files (binary `.png` every 25th, 2,000-line every 100th, one large diff up
 *    to 50,000 changed lines), steps by at most ~0.75 viewport asserting all `N` indexes/paths
 *    are seen without skips, then verifies expansion of binary, large (with sticky header),
 *    2,000-line, blurred-dirty-retention, and last editable files.
 */
const combinedDiffAcceptance: Scenario = {
  id: "combinedDiffAcceptance",
  title: `Per-file acceptance across all ${COMBINED_FILES} editable and mixed combined diff files`,
  async run(h) {
    const files = COMBINED_FILES;
    const scroller = h.page.locator("[data-combined-scroll]");
    const toolbar = h.page.getByRole("toolbar", { name: "Combined Changes Diff" });

    // Pass 1: all `files` editable worktree text files — reach, expand, write, read back, clean up every one.
    const editableData = await h.page.evaluate(
      (f) =>
        (window as never as { __openideaPerf: CombinedProbe }).__openideaPerf.openCombinedDiff(f, 0, {
          allEditable: true,
          lines: 4,
          tag: "acceptance-editable",
        }),
      files,
    );
    await h.page.locator("[data-combined-scroll] .cm-content").first().waitFor({ state: "visible", timeout: 30_000 });
    await h.page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await toolbar.getByRole("button", { name: "Collapse All Files" }).click();

    const editablePass = await scroller.evaluate(
      async (el, { expectedPaths }) => {
        const probe = (window as never as { __openideaPerf: CombinedProbe }).__openideaPerf;
        const frames = async (n = 1) => {
          for (let k = 0; k < n; k++) await new Promise(requestAnimationFrame);
        };
        const total = expectedPaths.length;
        const seenIndexes = new Set<number>();
        const seenPaths = new Set<string>();
        let verified = 0;
        let nextExpected = 0;
        let peakEditors = el.querySelectorAll(".cm-editor").length;
        const started = performance.now();
        await frames(2);

        const maxStep = () => Math.max(1, Math.floor(el.clientHeight * 0.75));

        while (nextExpected < total) {
          if (performance.now() - started > 600_000)
            throw new Error(`editable acceptance timed out at index ${nextExpected}/${total}`);

          const slots = [...el.querySelectorAll<HTMLElement>("[data-index]")];
          if (!slots.length) {
            await frames(1);
            continue;
          }
          const idxs = slots.map((s) => Number(s.dataset.index));
          for (let k = 1; k < idxs.length; k++) {
            if (idxs[k]! !== idxs[k - 1]! + 1)
              throw new Error(`non-contiguous slots at index ${nextExpected}: [${idxs.join(",")}]`);
          }
          for (let k = 0; k < slots.length; k++) {
            const idx = idxs[k]!;
            const block = slots[k]!.querySelector<HTMLElement>("[data-combined-block]");
            const gotPath = block?.dataset.combinedBlock;
            if (gotPath !== expectedPaths[idx])
              throw new Error(`path mismatch at index ${idx}: expected ${expectedPaths[idx]}, got ${gotPath}`);
            seenIndexes.add(idx);
            seenPaths.add(gotPath!);
          }
          if (idxs[0]! > nextExpected)
            throw new Error(`skipped range before index ${nextExpected}: first mounted slot is ${idxs[0]}`);

          const elRect = el.getBoundingClientRect();
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
          const batch: Array<{ idx: number; path: string; block: HTMLElement }> = [];
          for (let idx = nextExpected; idx < total && batch.length < 4; idx++) {
            const pos = idxs.indexOf(idx);
            if (pos < 0) break;
            const slot = slots[pos]!;
            if (!atBottom && slot.getBoundingClientRect().top >= elRect.bottom) break;
            const block = slot.querySelector<HTMLElement>("[data-combined-block]")!;
            batch.push({ idx, path: expectedPaths[idx]!, block });
          }

          if (!batch.length) {
            const before = el.scrollTop;
            el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + maxStep());
            await frames(2);
            if (el.scrollTop === before && el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
              // At bottom but nextExpected still not mounted: let layout settle once more.
              await frames(2);
            }
            continue;
          }

          // Expand every block in the small batch.
          for (const entry of batch) {
            const btn = entry.block.querySelector<HTMLButtonElement>('button[aria-label="Expand File"]');
            if (btn) btn.click();
          }

          // Wait for every expanded block in the batch to render `.cm-content` and attach its editor handle.
          const waitStart = performance.now();
          while (true) {
            const ready = batch.every(({ path }) => {
              const block = el.querySelector<HTMLElement>(`[data-combined-block="${path}"]`);
              const content = block?.querySelector<HTMLElement>(".cm-content");
              return !!content && !content.closest("[hidden]") && probe.hasEditor(path);
            });
            if (ready) break;
            if (performance.now() - waitStart > 15_000)
              throw new Error(`batch starting at ${batch[0]!.idx} (${batch[0]!.path}) never loaded`);
            await frames(1);
          }
          peakEditors = Math.max(peakEditors, el.querySelectorAll(".cm-editor").length);

          // Write a unique marker to each file, read back from editor + dirty state + saved backend, then collapse.
          for (const { idx, path } of batch) {
            const marker = ` // ACC_${idx}`;
            const res = await probe.editAndSaveDiff(path, marker);
            if (!res.text.includes(marker)) throw new Error(`editor read-back failed for ${idx} (${path})`);
            if (!res.unsaved) throw new Error(`expected dirty state after write for ${idx} (${path})`);
            if (!res.savedText.includes(marker)) throw new Error(`saved read-back failed for ${idx} (${path})`);
            if (probe.unsaved(path)) throw new Error(`expected clean state after save for ${idx} (${path})`);
            const block = el.querySelector<HTMLElement>(`[data-combined-block="${path}"]`);
            const collapseBtn = block?.querySelector<HTMLButtonElement>('button[aria-label="Collapse File"]');
            if (collapseBtn) collapseBtn.click();
            verified++;
            nextExpected = idx + 1;
          }
          await frames(1);

          // Gently scroll verified blocks off the top (always <= 0.75 viewport) so virtualizer unmounts them promptly.
          if (nextExpected < total) {
            const nextSlot = el.querySelector<HTMLElement>(`[data-index="${nextExpected}"]`);
            if (nextSlot) {
              const delta = nextSlot.getBoundingClientRect().top - el.getBoundingClientRect().top;
              if (delta > 0) {
                el.scrollTop += Math.min(maxStep(), delta);
                await frames(1);
              }
            }
          }
        }

        // Return to top and verify editors unmount cleanly (no leak).
        el.scrollTop = 0;
        await frames(3);
        const editorsAfter = el.querySelectorAll(".cm-editor").length;
        return {
          seenIndexes: seenIndexes.size,
          seenPaths: seenPaths.size,
          verified,
          peakEditors,
          editorsAfter,
          ms: performance.now() - started,
        };
      },
      { expectedPaths: editableData.paths },
    );

    if (editablePass.seenIndexes !== files || editablePass.seenPaths !== files || editablePass.verified !== files)
      throw new Error(`editable acceptance incomplete: ${JSON.stringify(editablePass)} (expected ${files})`);
    if (editablePass.editorsAfter > 16)
      throw new Error(`editable acceptance leaked editors back at top: ${editablePass.editorsAfter}`);

    // Pass 2: mixed data (binary .png, 2,000-line files, 50,000-line large file, editable worktree files).
    await h.page.evaluate(() =>
      (window as never as { __openideaPerf: CombinedProbe }).__openideaPerf.runAction("editor.closeAllTabs"),
    );
    await scroller.waitFor({ state: "detached", timeout: 15_000 });

    const bigLines = Math.min(50_000, files * 10);
    const mixedData = await h.page.evaluate(
      ([f, b]) =>
        (window as never as { __openideaPerf: CombinedProbe }).__openideaPerf.openCombinedDiff(f!, b!, {
          tag: "acceptance-mixed",
        }),
      [files, bigLines],
    );
    await h.page.locator("[data-combined-scroll] .cm-content").first().waitFor({ state: "visible", timeout: 30_000 });
    await h.page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await toolbar.getByRole("button", { name: "Collapse All Files" }).click();

    const mixedSweep = await scroller.evaluate(
      async (el, { expectedPaths }) => {
        const frames = async (n = 1) => {
          for (let k = 0; k < n; k++) await new Promise(requestAnimationFrame);
        };
        const total = expectedPaths.length;
        const seenIndexes = new Set<number>();
        const seenPaths = new Set<string>();
        let maxSeen = -1;
        let peakEditors = el.querySelectorAll(".cm-editor").length;
        const started = performance.now();
        await frames(2);

        const maxStep = () => Math.max(1, Math.floor(el.clientHeight * 0.75));

        for (let iter = 0; iter < total * 4 && performance.now() - started < 120_000; iter++) {
          const slots = [...el.querySelectorAll<HTMLElement>("[data-index]")];
          if (!slots.length) {
            await frames(1);
            continue;
          }
          const idxs = slots.map((s) => Number(s.dataset.index));
          for (let k = 1; k < idxs.length; k++) {
            if (idxs[k]! !== idxs[k - 1]! + 1) throw new Error(`mixed sweep non-contiguous slots: [${idxs.join(",")}]`);
          }
          if (maxSeen >= 0 && idxs[0]! > maxSeen + 1)
            throw new Error(`mixed sweep skipped range (${maxSeen + 1}..${idxs[0]! - 1})`);
          for (let k = 0; k < slots.length; k++) {
            const idx = idxs[k]!;
            const block = slots[k]!.querySelector<HTMLElement>("[data-combined-block]");
            const gotPath = block?.dataset.combinedBlock;
            if (gotPath !== expectedPaths[idx])
              throw new Error(`mixed path mismatch at ${idx}: expected ${expectedPaths[idx]}, got ${gotPath}`);
            seenIndexes.add(idx);
            seenPaths.add(gotPath!);
            if (idx > maxSeen) maxSeen = idx;
          }
          peakEditors = Math.max(peakEditors, el.querySelectorAll(".cm-editor").length);
          if (seenIndexes.has(total - 1) && el.scrollTop + el.clientHeight >= el.scrollHeight - 1) break;
          const elRect = el.getBoundingClientRect();
          const lastSlot = slots[slots.length - 1]!;
          if (idxs[idxs.length - 1]! < total - 1 && lastSlot.getBoundingClientRect().bottom < elRect.bottom) {
            // Virtualizer is still filling the viewport as newly mounted collapsed headers shrink from ESTIMATE.
            await frames(1);
            continue;
          }
          // Step at most 0.75 viewport and never past the last mounted visible slot so no unmeasured block is skipped.
          let targetDelta = maxStep();
          for (let k = slots.length - 1; k >= 0; k--) {
            const top = slots[k]!.getBoundingClientRect().top - elRect.top;
            if (top > 0 && top <= targetDelta) {
              targetDelta = Math.floor(top);
              break;
            }
          }
          el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.max(1, targetDelta));
          await frames(2);
        }
        return {
          seenIndexes: seenIndexes.size,
          seenPaths: seenPaths.size,
          peakEditors,
          ms: performance.now() - started,
        };
      },
      { expectedPaths: mixedData.paths },
    );

    if (mixedSweep.seenIndexes !== files || mixedSweep.seenPaths !== files)
      throw new Error(`mixed sweep incomplete: ${JSON.stringify(mixedSweep)} (expected ${files})`);

    // Expand binary .png file and verify binary notice renders.
    if (mixedData.binary) {
      if (!(await revealCombinedBlock(scroller, mixedData.binary, { waitContent: false })))
        throw new Error(`collapsed binary file ${mixedData.binary} could not be reached`);
      const binSel = `[data-combined-block="${mixedData.binary}"]`;
      await h.page.locator(`${binSel} button[aria-label="Expand File"]`).click();
      if (
        !(await revealCombinedBlock(scroller, mixedData.binary, { waitText: "Binary files cannot be shown as text" }))
      )
        throw new Error(`binary file ${mixedData.binary} did not render binary notice`);
    }

    // Expand the large diff (50,000 changed lines at 5,000 files) and verify content + sticky header.
    if (!(await revealCombinedBlock(scroller, mixedData.big, { waitContent: false })))
      throw new Error(`collapsed large file ${mixedData.big} could not be reached`);
    const bigSel = `[data-combined-block="${mixedData.big}"]`;
    if ((await h.page.locator(`${bigSel} .cm-content`).count()) !== 0)
      throw new Error(`collapsed large file ${mixedData.big} unexpectedly mounted editors before expand`);
    await h.page.locator(`${bigSel} button[aria-label="Expand File"]`).click();
    if (!(await revealCombinedBlock(scroller, mixedData.big)))
      throw new Error(`large file ${mixedData.big} never loaded after expand`);
    const sticky = await scroller.evaluate(async (el, sel) => {
      const block = el.querySelector<HTMLElement>(sel)!;
      el.scrollTop += Math.min(2000, block.offsetHeight / 2);
      await new Promise(requestAnimationFrame);
      const now = el.querySelector<HTMLElement>(sel);
      if (now !== block) return { off: NaN, remounted: true };
      const header = block.firstElementChild!.getBoundingClientRect().top;
      return { off: Math.abs(header - el.getBoundingClientRect().top), remounted: false };
    }, bigSel);
    if (!(sticky.off <= 1)) throw new Error(`large file sticky header off: ${JSON.stringify(sticky)}`);

    // Expand a 2,000-line file when present.
    if (files > 50) {
      const medium = mixedData.paths[50]!;
      if (!(await revealCombinedBlock(scroller, medium, { waitContent: false })))
        throw new Error(`collapsed medium file ${medium} could not be reached`);
      await h.page.locator(`[data-combined-block="${medium}"] button[aria-label="Expand File"]`).click();
      if (!(await revealCombinedBlock(scroller, medium)))
        throw new Error(`medium file ${medium} never loaded after expand`);
    }

    // Expand editable file half-way down, edit, blur, scroll away and back: unsaved edit survives without focus.
    if (!(await revealCombinedBlock(scroller, mixedData.editable, { waitContent: false })))
      throw new Error(`collapsed editable file ${mixedData.editable} could not be reached`);
    const editSel = `[data-combined-block="${mixedData.editable}"]`;
    await h.page.locator(`${editSel} button[aria-label="Expand File"]`).click();
    if (!(await revealCombinedBlock(scroller, mixedData.editable)))
      throw new Error(`editable file ${mixedData.editable} never loaded after expand`);
    await h.page.locator(`${editSel} .cm-content`).last().click();
    await h.page.keyboard.press("End");
    await h.page.keyboard.type(" // MIXED_EDIT");
    await h.page
      .locator(`${editSel} .cm-editor`)
      .last()
      .evaluate((el) => ((el as HTMLElement).dataset.perfMark = "1"));
    await h.page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    const preScroll = await scroller.evaluate(
      (el, path) => ({
        focused: el.contains(document.activeElement),
        unsaved: (window as never as { __openideaPerf: CombinedProbe }).__openideaPerf.unsaved(path),
      }),
      mixedData.editable,
    );
    if (preScroll.focused || !preScroll.unsaved)
      throw new Error(`expected blurred dirty editor before scroll: ${JSON.stringify(preScroll)}`);
    await scroller.evaluate(async (el) => {
      el.scrollTop = 0;
      await new Promise(requestAnimationFrame);
    });
    await h.page.waitForTimeout(200);
    if (!(await revealCombinedBlock(scroller, mixedData.editable)))
      throw new Error(`editable file ${mixedData.editable} could not be re-revealed`);
    const kept = await h.page.evaluate(
      ({ sel, path }) => {
        const cm = document.querySelector<HTMLElement>(`${sel} .cm-editor[data-perf-mark]`);
        return {
          sameEditor: !!cm,
          text: !!cm?.textContent?.includes("MIXED_EDIT"),
          unsaved: (window as never as { __openideaPerf: CombinedProbe }).__openideaPerf.unsaved(path),
        };
      },
      { sel: editSel, path: mixedData.editable },
    );
    if (!kept.sameEditor || !kept.text || !kept.unsaved)
      throw new Error(`mixed unsaved edit did not survive scroll: ${JSON.stringify(kept)}`);

    // Expand and edit the last file (`N - 1`).
    if (!(await revealCombinedBlock(scroller, mixedData.last, { waitContent: false })))
      throw new Error(`collapsed last file ${mixedData.last} could not be reached`);
    const lastSel = `[data-combined-block="${mixedData.last}"]`;
    if ((await h.page.locator(`${lastSel} .cm-content`).count()) !== 0)
      throw new Error(`collapsed last file ${mixedData.last} unexpectedly mounted editors before expand`);
    await h.page.locator(`${lastSel} button[aria-label="Expand File"]`).click();
    if (!(await revealCombinedBlock(scroller, mixedData.last)))
      throw new Error(`last file ${mixedData.last} never loaded after expand`);
    await h.page.locator(`${lastSel} .cm-content`).last().click();
    await h.page.keyboard.press("End");
    await h.page.keyboard.type(" // LAST_EDIT");
    await h.page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    const lastKept = await h.page.evaluate(
      ({ sel, path }) => ({
        text: [...document.querySelectorAll<HTMLElement>(`${sel} .cm-editor`)].some((e) =>
          e.textContent?.includes("LAST_EDIT"),
        ),
        unsaved: (window as never as { __openideaPerf: CombinedProbe }).__openideaPerf.unsaved(path),
      }),
      { sel: lastSel, path: mixedData.last },
    );
    if (!lastKept.text || !lastKept.unsaved)
      throw new Error(`editing the last file ${mixedData.last} failed: ${JSON.stringify(lastKept)}`);

    return {
      editableVerified: editablePass.verified,
      mixedSeen: mixedSweep.seenIndexes,
      peakEditors: Math.max(editablePass.peakEditors, mixedSweep.peakEditors),
      editableEditorsAfter: editablePass.editorsAfter,
      editableMs: editablePass.ms,
      mixedMs: mixedSweep.ms,
    };
  },
};

/** Opening and closing editors repeatedly must not grow the heap or the DOM. */
const leaks: Scenario = {
  id: "leaks",
  title: "Open / close 10 editors × 4",
  async run(h) {
    const cycle = async (n: number) => {
      for (let i = 0; i < 10; i++)
        // oxlint-disable-next-line no-await-in-loop -- files open into one shared editor; parallel opens would race on its state
        await h.openFile(`${ROOT}/src/leak/File${n}_${i}.ts`, tsSource(1_500, `leak-${n}-${i}`));
      await h.page.evaluate(() =>
        (window as never as { __openideaPerf: { runAction(id: string): Promise<boolean> } }).__openideaPerf.runAction(
          "editor.closeAllTabs",
        ),
      );
      await h.page.locator(".cm-editor").waitFor({ state: "detached" });
    };
    await cycle(0);
    await h.gc();
    const heap0 = await h.heapMb();
    const c0 = await h.counters();
    // oxlint-disable-next-line no-await-in-loop -- leak cycles run one after another; parallel cycles would invalidate heap growth
    for (let n = 1; n <= 3; n++) await cycle(n);
    await h.gc();
    const c1 = await h.counters();
    return {
      heapGrowthMb: (await h.heapMb()) - heap0,
      domNodeGrowth: (c1.Nodes ?? 0) - (c0.Nodes ?? 0),
      listenerGrowth: (c1.JSEventListeners ?? 0) - (c0.JSEventListeners ?? 0),
    };
  },
};

/** Git Graph PR tab Commits list: switch to Commits and scroll through all commits to the end. */
const prCommits: Scenario = {
  id: "prCommits",
  title: "Show and scroll the Git Graph PR Commits list",
  async run(h) {
    const count = Math.max(1, Number(process.env.OPENIDEA_PERF_PR_COMMITS) || 10_000);
    await h.page.evaluate((n) => {
      const probe = (
        window as never as {
          __openideaPerf: { fakePrCommits(n: number): void; runAction(id: string): Promise<boolean> };
        }
      ).__openideaPerf;
      probe.fakePrCommits(n);
      return probe.runAction("gitGraph.open");
    }, count);
    try {
      const prTab = h.page.getByRole("tab", { name: "PR", exact: true });
      await prTab.waitFor();
      await prTab.click();
      const commitsTab = h.page.getByRole("tab", { name: /^Commits/ });
      await commitsTab.waitFor();
      await h.page.getByText(`Commits: ${count} ahead`).waitFor();

      const tShow = await h.now();
      const beforeShow = await h.counters();
      const showMs = await h.measure(() => commitsTab.click(), '[aria-label="Commits"]', "order flow step 0", 30_000);
      const showWork = Harness.delta(beforeShow, await h.counters());
      const showTasks = await h.longTasksSince(tShow);

      const list = h.page.locator('[aria-label="Commits"]').first();
      const mountedRows = await list.evaluate((el) => el.querySelectorAll('[title="Show in Graph"]').length);

      const refresh = await h.refreshMs();
      const tScroll = await h.now();
      const beforeScroll = await h.counters();
      await h.inPage((p) => p.startFrames());
      const lastReached = await list.evaluate(
        async (el, lastText) => {
          const max = Math.max(0, el.scrollHeight - el.clientHeight);
          let sawLast = false;
          for (let i = 0; i <= 120; i++) {
            const frac = i <= 60 ? i / 60 : (120 - i) / 60;
            el.scrollTop = frac * max;
            await new Promise(requestAnimationFrame);
            if (i === 60) {
              await new Promise(requestAnimationFrame);
              sawLast = (el.textContent ?? "").includes(lastText);
            }
          }
          return sawLast;
        },
        `order flow step ${count - 1}`,
      );
      const frames = await h.inPage((p) => p.stopFrames());
      const scrollWork = Harness.delta(beforeScroll, await h.counters());
      const scrollTasks = await h.longTasksSince(tScroll);
      if (!lastReached) throw new Error(`last commit (order flow step ${count - 1}) not reachable at bottom`);

      return {
        mountedRows,
        showMs,
        showTaskMs: showWork.taskMs,
        showStyleLayoutMs: showWork.styleLayoutMs,
        showTbtMs: totalBlockingTime(showTasks),
        ...frameSummary(frames, refresh),
        scrollTaskMsPerFrame: frames.length ? scrollWork.taskMs / frames.length : NaN,
        framesOver8ms: frames.filter((f) => f > 8).length,
        longTasks: showTasks.length + scrollTasks.length,
        scrollTbtMs: totalBlockingTime(scrollTasks),
      };
    } finally {
      await h.page.evaluate(() =>
        (window as never as { __openideaPerf: { fakePrCommits(n: number): void } }).__openideaPerf.fakePrCommits(0),
      );
    }
  },
};

/** Git Graph PR tab refresh when head is far behind base (and has many commits ahead). */
const prRefresh: Scenario = {
  id: "prRefresh",
  title: "Refresh the Git Graph PR tab when far behind base",
  async run(h) {
    const ahead = Math.max(1, Number(process.env.OPENIDEA_PERF_PR_AHEAD) || 1_000);
    const behind = Math.max(1, Number(process.env.OPENIDEA_PERF_PR_BEHIND) || 100_000);
    const rounds = 5;
    await h.page.evaluate(
      ({ a, b }) => {
        const probe = (
          window as never as {
            __openideaPerf: {
              fakePrRefresh(ahead: number, behind: number): void;
              runAction(id: string): Promise<boolean>;
            };
          }
        ).__openideaPerf;
        probe.fakePrRefresh(a, b);
        return probe.runAction("gitGraph.open");
      },
      { a: ahead, b: behind },
    );
    try {
      const prTab = h.page.getByRole("tab", { name: "PR", exact: true });
      await prTab.waitFor();
      await prTab.click();
      await h.page.getByText(`Commits: ${ahead} ahead, ${behind} behind main`).waitFor({ timeout: 60_000 });
      const commitsTab = h.page.getByRole("tab", { name: /^Commits/ });
      await commitsTab.click();
      const list = h.page.locator('[aria-label="Commits"]').first();
      await list.getByText("order flow step 0").waitFor({ timeout: 30_000 });
      await h.page.waitForTimeout(100);

      const refresh = await h.refreshMs();
      await h.page.evaluate(() =>
        (window as never as { __openideaPerf: { resetPrRefreshStats(): void } }).__openideaPerf.resetPrRefreshStats(),
      );
      const t0 = await h.now();
      const before = await h.counters();
      await h.inPage((p) => p.startFrames());
      const latencies: number[] = [];
      for (let i = 0; i < rounds; i++) {
        const ms = await h.page.evaluate(async () => {
          const probe = (
            window as never as {
              __openideaPerf: {
                triggerPrRefresh(): void;
                prRefreshStats(): { diffCalls: number };
              };
            }
          ).__openideaPerf;
          const prevDiffs = probe.prRefreshStats().diffCalls;
          const start = performance.now();
          probe.triggerPrRefresh();
          while (probe.prRefreshStats().diffCalls === prevDiffs) {
            await new Promise((r) => setTimeout(r, 0));
          }
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          return performance.now() - start;
        });
        latencies.push(ms);
      }
      const frames = await h.inPage((p) => p.stopFrames());
      const work = Harness.delta(before, await h.counters());
      const tasks = await h.longTasksSince(t0);
      const stats = await h.page.evaluate(() =>
        (
          window as never as {
            __openideaPerf: {
              prRefreshStats(): { logCalls: number; commitsFetched: number; countCalls: number; diffCalls: number };
            };
          }
        ).__openideaPerf.prRefreshStats(),
      );

      // Verify the last ahead commit is reachable by scrolling to the bottom.
      const lastReached = await list.evaluate(
        async (el, lastText) => {
          el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
          for (let i = 0; i < 30; i++) {
            await new Promise(requestAnimationFrame);
            if ((el.textContent ?? "").includes(lastText)) return true;
          }
          return false;
        },
        `order flow step ${ahead - 1}`,
      );
      if (!lastReached) throw new Error(`last commit (order flow step ${ahead - 1}) not reachable at bottom`);

      return {
        ...latencySummary(latencies, "refresh"),
        refreshMainThreadMs: work.taskMs / rounds,
        commitsFetchedPerRefresh: stats.commitsFetched / rounds,
        logCallsPerRefresh: stats.logCalls / rounds,
        countCallsPerRefresh: stats.countCalls / rounds,
        ...frameSummary(frames, refresh),
        framesOver8ms: frames.filter((f) => f > 8).length,
        longTasks: tasks.length,
        tbtMs: totalBlockingTime(tasks),
      };
    } finally {
      await h.page.evaluate(() =>
        (
          window as never as { __openideaPerf: { fakePrRefresh(a: number, b: number): void } }
        ).__openideaPerf.fakePrRefresh(0, 0),
      );
    }
  },
};

type HttpBodyShape = "json" | "nested" | "xml" | "text";

/** The HTTP Client backend's response body limit (`MAX_BODY` in crates/ide-http/src/exec.rs). */
const HTTP_MAX_BODY = 16 * 1024 * 1024;

/**
 * First line of the response body as shown, wherever the view keeps it: a line
 * element of a virtualized viewer or the first text node of a single block.
 */
function bodyFirstLine(h: Harness, t0: number, expected: string, prefix: boolean, timeoutMs = 120_000) {
  return h.inPage(
    (_p, a) =>
      new Promise<number>((resolve, reject) => {
        const deadline = performance.now() + a.timeoutMs;
        const tick = () => {
          const el = document.querySelector('[aria-label="Response body"]');
          const line =
            el?.querySelector(".cm-line")?.textContent ??
            (el?.firstChild?.textContent ?? "").slice(0, 400).split("\n")[0];
          if (line !== undefined && (a.prefix ? line.startsWith(a.expected) : line === a.expected))
            resolve(performance.now() - a.t0);
          else if (performance.now() > deadline) reject(new Error(`response body never showed ${a.expected}`));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { t0, expected, prefix, timeoutMs },
  );
}

/**
 * Characters put into text nodes so far (what the page had to lay out), counted
 * from the first call on.
 */
function drawnChars(h: Harness): Promise<number> {
  return h.page.evaluate(() => {
    const w = window as never as { __drawnChars?: { n: number } };
    if (!w.__drawnChars) {
      const counter = { n: 0 };
      const create = document.createTextNode.bind(document);
      document.createTextNode = (text: string) => {
        counter.n += text.length;
        return create(text);
      };
      w.__drawnChars = counter;
    }
    return w.__drawnChars.n;
  });
}

/** Scrolls the response body to its end until the last record is on screen; ms. */
function bodyScrollToEnd(h: Harness) {
  return h.inPage(
    () =>
      new Promise<number>((resolve, reject) => {
        const el = document.querySelector('[aria-label="Response body"]') as HTMLElement | null;
        const scroller = (el?.closest(".cm-scroller") ?? el?.parentElement) as HTMLElement | null;
        if (!el || !scroller) return reject(new Error("no response body"));
        const t0 = performance.now();
        let n = 0;
        const tick = () => {
          scroller.scrollTop = scroller.scrollHeight;
          const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
          // Lines on screen; the editor also keeps the cursor's line (the start) in the DOM.
          const box = scroller.getBoundingClientRect();
          const lines = [...el.querySelectorAll(".cm-line")].filter((l) => {
            const r = l.getBoundingClientRect();
            return r.bottom > box.top && r.top < box.bottom;
          });
          // The last record sits a few closing lines above the end (`}`, `]`, `</root>`).
          const tail = el.querySelector(".cm-line") ? lines.map((l) => l.textContent ?? "") : ["last-item"];
          if (atEnd && tail.some((l) => l.includes("last-item"))) resolve(performance.now() - t0);
          else if (++n > 600)
            reject(
              new Error(
                `response body never reached its end (scrollTop ${scroller.scrollTop}, height ${scroller.scrollHeight}, ` +
                  `client ${scroller.clientHeight}, tail ${JSON.stringify(tail.map((l) => l.slice(0, 60)))})`,
              ),
            );
          else requestAnimationFrame(tick);
        };
        tick();
      }),
  );
}

/**
 * One response of `shape` at `bytes`: open it (Formatted), switch to Raw and
 * back, scroll to the end and search it. Metrics are prefixed with `prefix`.
 */
async function httpResponseRun(h: Harness, shape: HttpBodyShape, bytes: number, prefix: string): Promise<Metrics> {
  const key = (k: string) => `${prefix}${k[0]!.toUpperCase()}${k.slice(1)}`;
  await h.page.evaluate(
    ({ shape, bytes }) =>
      (
        window as never as { __openideaPerf: { fakeHttpResponse(s: string, b: number): void } }
      ).__openideaPerf.fakeHttpResponse(shape, bytes),
    { shape, bytes },
  );
  await h.page.evaluate(() =>
    (window as never as { __openideaPerf: { runAction(id: string): Promise<boolean> } }).__openideaPerf.runAction(
      "http.showToolWindow",
    ),
  );
  await h.page.getByRole("button", { name: "Reload History" }).click();
  const entry = h.page.getByRole("list", { name: "Response history" }).getByRole("button").first();
  await entry.waitFor();
  const refresh = await h.refreshMs();
  // Formatted and raw first lines: `[` / `{` / `<root>` alone vs the whole minified body.
  const formatted = { json: "[", nested: "[", xml: "<root>", text: "0 INFO" }[shape];
  const raw = { json: "[{", nested: "[{", xml: "<root><", text: "0 INFO" }[shape];
  const m: Metrics = {};
  const t0 = await h.now();
  await h.inPage((p) => p.startFrames());
  let mark = await h.now();
  const c0 = await h.counters();
  await entry.click();
  m[key("openMs")] = await bodyFirstLine(h, mark, formatted, shape === "text");
  const c1 = await h.counters();
  const open = Harness.delta(c0, c1);
  m[key("openScriptMs")] = open.scriptMs;
  m[key("openLayoutMs")] = open.styleLayoutMs;
  m[key("domNodes")] = c1.Nodes ?? 0;
  if (shape !== "text") {
    const drawn0 = await drawnChars(h);
    mark = await h.now();
    await h.page.getByRole("button", { name: "Show Raw" }).click();
    m[key("rawMs")] = await bodyFirstLine(h, mark, raw, true);
    const c2 = await h.counters();
    const rawStep = Harness.delta(c1, c2);
    m[key("rawScriptMs")] = rawStep.scriptMs;
    m[key("rawLayoutMs")] = rawStep.styleLayoutMs;
    m[key("rawDrawnChars")] = (await drawnChars(h)) - drawn0;
    mark = await h.now();
    await h.page.getByRole("button", { name: "Show Formatted" }).click();
    m[key("formattedMs")] = await bodyFirstLine(h, mark, formatted, false);
    const toggle = Harness.delta(c2, await h.counters());
    m[key("formattedScriptMs")] = toggle.scriptMs;
    m[key("formattedLayoutMs")] = toggle.styleLayoutMs;
  }
  m[key("endMs")] = await bodyScrollToEnd(h);
  await h.page.getByRole("button", { name: "Find…" }).click();
  await h.page.getByRole("textbox", { name: "Find in response" }).waitFor();
  const keys = await h.typeMeasured("last-item", 120);
  await h.page.getByText("1/1").waitFor({ timeout: 60_000 });
  const frames = await h.inPage((p) => p.stopFrames());
  const tasks = await h.longTasksSince(t0);
  Object.assign(m, {
    ...keySummary(keys, refresh, key("findKey")),
    [key("frameMaxMs")]: frames.length ? Math.max(...frames) : NaN,
    [key("framesOver8Ms")]: frames.filter((f) => f > 8.4).length,
    [key("longTasks")]: tasks.length,
    [key("longTaskMaxMs")]: tasks.length ? Math.max(...tasks.map((t) => t.duration)) : 0,
    [key("tbtMs")]: totalBlockingTime(tasks),
  });
  await h.page.keyboard.press("Escape");
  return m;
}

/**
 * A JSON response from the HTTP Client at 1%, 10% and 100% of the backend's
 * 16 MB body limit, one single minified line: open it formatted, switch to Raw
 * and back, scroll to the very end and search for the last record.
 */
const httpLargeResponse: Scenario = {
  id: "httpLargeResponse",
  title: "Format, scroll and search 0.16 / 1.6 / 16 MB HTTP responses",
  async run(h) {
    const m: Metrics = {};
    for (const [pct, bytes] of [
      [1, HTTP_MAX_BODY / 100],
      [10, HTTP_MAX_BODY / 10],
      [100, HTTP_MAX_BODY],
    ] as const) {
      Object.assign(m, await httpResponseRun(h, "json", bytes, `s${pct}`));
    }
    return m;
  },
};

/** The same at the 16 MB limit for deeply nested JSON, XML and plain-text lines. */
const httpLargeResponseShapes: Scenario = {
  id: "httpLargeResponseShapes",
  title: "Format, scroll and search 16 MB nested JSON, XML and text responses",
  async run(h) {
    const m: Metrics = {};
    for (const shape of ["nested", "xml", "text"] as const)
      Object.assign(m, await httpResponseRun(h, shape, HTTP_MAX_BODY, shape));
    return m;
  },
};

/**
 * Git Log commit details with a large multi-selection: Shift+End selects all
 * loaded commits, then scrolls through the commit messages and jumps to the
 * last selected commit. Scale defaults to 10,000 commits and can be overridden
 * via `OPENIDEA_PERF_MULTISELECT_COUNT`.
 */
const gitLogMultiSelect: Scenario = {
  id: "gitLogMultiSelect",
  title: "Multi-select commits and scroll commit details",
  async run(h) {
    const count = Math.max(2, Number(process.env.OPENIDEA_PERF_MULTISELECT_COUNT) || 10_000);
    await h.page.evaluate(async (n) => {
      const probe = (
        window as never as {
          __openideaPerf: {
            fakeGitLog(n: number): void;
            fakeGitLogLoaded(n: number): Promise<void>;
            runAction(id: string): Promise<boolean>;
          };
        }
      ).__openideaPerf;
      probe.fakeGitLog(Math.min(n, 300));
      await probe.runAction("vcs.showLog");
    }, count);
    const list = h.page.getByRole("listbox", { name: "Commits" });
    await list.getByRole("option").first().waitFor();
    try {
      await h.page.evaluate(async (n) => {
        const probe = (
          window as never as {
            __openideaPerf: {
              fakeGitLogLoaded(n: number): Promise<void>;
            };
          }
        ).__openideaPerf;
        await probe.fakeGitLogLoaded(n);
      }, count);
      // Wait for the loaded commit list and initial single-commit details to settle before measuring.
      await h.page.locator('button[title="Copy revision number"]').first().waitFor({ timeout: 30_000 });
      await list.getByRole("option").first().click();
      await h.page.waitForTimeout(300);

      const refresh = await h.refreshMs();
      const tSelect = await h.now();
      const beforeSelect = await h.counters();
      const selectMs = await h.measure(
        () => h.page.keyboard.press("Shift+End"),
        '[role="toolbar"][aria-label="Changed files"]',
        `in ${count} commits`,
        60_000,
      );
      await h.inPage((p) => p.afterNextPaint());
      const selectWork = Harness.delta(beforeSelect, await h.counters());
      const selectLong = await h.longTasksSince(tSelect);
      const afterSelect = await h.page.evaluate(() => {
        const btn = document.querySelector<HTMLElement>('button[title="Copy revision number"]');
        let box: HTMLElement | null = btn?.parentElement ?? null;
        while (box && getComputedStyle(box).overflowY !== "auto") box = box.parentElement;
        if (!box) throw new Error("Commit details message box not found");
        return {
          mountedMessages: box.querySelectorAll('button[title="Copy revision number"]').length,
          messageDomNodes: box.querySelectorAll("*").length,
        };
      });

      const tScroll = await h.now();
      const beforeScroll = await h.counters();
      await h.inPage((p) => p.startFrames());
      await h.page.evaluate(async () => {
        const btn = document.querySelector<HTMLElement>('button[title="Copy revision number"]');
        let box: HTMLElement | null = btn?.parentElement ?? null;
        while (box && getComputedStyle(box).overflowY !== "auto") box = box.parentElement;
        if (!box) throw new Error("Commit details message box not found");
        const max = Math.max(0, box.scrollHeight - box.clientHeight);
        for (let i = 1; i <= 60; i++) {
          box.scrollTop = Math.min(max, i * 480);
          await new Promise(requestAnimationFrame);
        }
      });
      const frames = await h.inPage((p) => p.stopFrames());
      const scrollWork = Harness.delta(beforeScroll, await h.counters());
      const scrollLong = await h.longTasksSince(tScroll);

      const lastText = `order flow step ${count - 1}`;
      const scrollToLastMs = await h.page.evaluate(async (expected) => {
        const btn = document.querySelector<HTMLElement>('button[title="Copy revision number"]');
        let box: HTMLElement | null = btn?.parentElement ?? null;
        while (box && getComputedStyle(box).overflowY !== "auto") box = box.parentElement;
        if (!box) throw new Error("Commit details message box not found");
        const started = performance.now();
        box.scrollTop = box.scrollHeight;
        for (let i = 0; i < 120; i++) {
          await new Promise(requestAnimationFrame);
          if ((box.textContent ?? "").includes(expected)) return performance.now() - started;
          box.scrollTop = box.scrollHeight;
        }
        throw new Error(`last selected commit "${expected}" not reachable by scrolling`);
      }, lastText);

      const afterScroll = await h.page.evaluate(() => {
        const btn = document.querySelector<HTMLElement>('button[title="Copy revision number"]');
        let box: HTMLElement | null = btn?.parentElement ?? null;
        while (box && getComputedStyle(box).overflowY !== "auto") box = box.parentElement;
        if (!box) throw new Error("Commit details message box not found");
        return {
          mountedMessagesAtEnd: box.querySelectorAll('button[title="Copy revision number"]').length,
          messageDomNodesAtEnd: box.querySelectorAll("*").length,
        };
      });

      const scrollSummary = frameSummary(frames, refresh);
      return {
        selectMs,
        selectMainThreadMs: selectWork.taskMs,
        selectStyleLayoutMs: selectWork.styleLayoutMs,
        selectScriptMs: selectWork.scriptMs,
        selectLongTasks: selectLong.length,
        selectTbtMs: totalBlockingTime(selectLong),
        ...afterSelect,
        scrollFrameP95Ms: scrollSummary.frameP95Ms,
        scrollFrameMaxMs: scrollSummary.frameMaxMs,
        scrollDroppedFramesPct: scrollSummary.droppedFramesPct,
        scrollFramesOver8Ms: frames.filter((f) => f > 8.33).length,
        scrollMainThreadMsPerFrame: frames.length ? scrollWork.taskMs / frames.length : NaN,
        scrollLongTasks: scrollLong.length,
        scrollTbtMs: totalBlockingTime(scrollLong),
        scrollToLastMs,
        ...afterScroll,
      };
    } finally {
      await h.page.evaluate(async () => {
        const probe = (
          window as never as {
            __openideaPerf: {
              fakeGitLog(n: number): void;
              fakeGitLogLoaded(n: number): Promise<void>;
            };
          }
        ).__openideaPerf;
        await probe.fakeGitLogLoaded(0);
        probe.fakeGitLog(0);
      });
    }
  },
};

/**
 * Interactive rebase dialog at 1×, 10× and 100× scales (50, 500 and 5,000 commits):
 * opening the dialog, measuring mounted row Selects and DOM size, and scrolling to the last commit.
 */
const interactiveRebase: Scenario = {
  id: "interactiveRebase",
  title: "Open and scroll Interactive Rebase (50 / 500 / 5,000 commits)",
  async run(h) {
    const refresh = await h.refreshMs();
    const out: Metrics = {};
    try {
      // Warm up the dialog and VCS action path so the 1× scale does not include first-load JIT cost.
      const warmTarget = await h.page.evaluate(() =>
        (
          window as never as { __openideaPerf: { fakeInteractiveRebase(c: number): unknown } }
        ).__openideaPerf.fakeInteractiveRebase(5),
      );
      await h.measure(
        () =>
          h.page.evaluate(
            (arg) =>
              (
                window as never as { __openideaPerf: { runAction(id: string, a?: unknown): Promise<boolean> } }
              ).__openideaPerf.runAction("vcs.log.interactiveRebase", arg),
            warmTarget,
          ),
        '[role="list"][aria-label="Commits to rebase"]',
        "Commit 0:",
        30_000,
      );
      await h.page.keyboard.press("Escape");
      await h.page.locator('[role="dialog"]').waitFor({ state: "detached" });
      await h.gc();

      for (const count of [50, 500, 5_000]) {
        const target = await h.page.evaluate((n) => {
          const probe = (window as never as { __openideaPerf: { fakeInteractiveRebase(c: number): unknown } })
            .__openideaPerf;
          return probe.fakeInteractiveRebase(n);
        }, count);
        const t0 = await h.now();
        const beforeOpen = await h.counters();
        const openMs = await h.measure(
          () =>
            h.page.evaluate(
              (arg) =>
                (
                  window as never as { __openideaPerf: { runAction(id: string, a?: unknown): Promise<boolean> } }
                ).__openideaPerf.runAction("vcs.log.interactiveRebase", arg),
              target,
            ),
          '[role="list"][aria-label="Commits to rebase"]',
          "Commit 0:",
          30_000,
        );
        await h.inPage((p) => p.afterNextPaint());
        const openWork = Harness.delta(beforeOpen, await h.counters());
        const openLongTasks = await h.longTasksSince(t0);
        const { selects, domNodes } = await h.page.evaluate(() => {
          const list = document.querySelector('[role="list"][aria-label="Commits to rebase"]')!;
          const dialog = list.closest('[role="dialog"]')!;
          return {
            selects: list.querySelectorAll('button[aria-haspopup="listbox"]').length,
            domNodes: dialog.querySelectorAll("*").length,
          };
        });

        const list = h.page.getByRole("list", { name: "Commits to rebase" });
        const t1 = await h.now();
        const beforeScroll = await h.counters();
        await h.inPage((p) => p.startFrames());
        const reachedLast = await list.evaluate(
          async (el, lastLabel) => {
            const max = Math.max(0, el.scrollHeight - el.clientHeight);
            for (let i = 0; i <= 60; i++) {
              el.scrollTop = (i / 60) * max;
              await new Promise(requestAnimationFrame);
            }
            await new Promise(requestAnimationFrame);
            const found = (el.textContent ?? "").includes(lastLabel);
            for (let i = 60; i >= 0; i--) {
              el.scrollTop = (i / 60) * max;
              await new Promise(requestAnimationFrame);
            }
            return found;
          },
          `Commit ${count - 1}:`,
        );
        if (!reachedLast) throw new Error(`Interactive Rebase (${count}) did not render last commit`);
        const scrollFrames = await h.inPage((p) => p.stopFrames());
        const scrollWork = Harness.delta(beforeScroll, await h.counters());
        const scrollLongTasks = await h.longTasksSince(t1);
        const scrollSummary = frameSummary(scrollFrames, refresh);
        const p = `n${count}`;
        out[`${p}OpenMs`] = openMs;
        out[`${p}OpenTaskMs`] = openWork.taskMs;
        out[`${p}OpenLongTasks`] = openLongTasks.length;
        out[`${p}OpenTbtMs`] = totalBlockingTime(openLongTasks);
        out[`${p}Selects`] = selects;
        out[`${p}DomNodes`] = domNodes;
        out[`${p}ScrollFrameP95Ms`] = scrollSummary.frameP95Ms;
        out[`${p}ScrollFrameMaxMs`] = scrollSummary.frameMaxMs;
        out[`${p}ScrollDroppedFramesPct`] = scrollSummary.droppedFramesPct;
        out[`${p}ScrollWorkMsPerFrame`] = scrollFrames.length ? scrollWork.taskMs / scrollFrames.length : 0;
        out[`${p}ScrollLongTasks`] = scrollLongTasks.length;
        out[`${p}ScrollTbtMs`] = totalBlockingTime(scrollLongTasks);

        await h.page.keyboard.press("Escape");
        await h.page.locator('[role="dialog"]').waitFor({ state: "detached" });
        await h.gc();
      }
    } finally {
      await h.page.evaluate(() =>
        (
          window as never as { __openideaPerf: { fakeInteractiveRebase(c: number): unknown } }
        ).__openideaPerf.fakeInteractiveRebase(0),
      );
    }
    return out;
  },
};

export const SCENARIOS: Scenario[] = [
  startup,
  typing,
  typingLarge,
  typingAngular,
  completion,
  consoleOutput,
  consoleLongLines,
  terminalTui,
  gitLog,
  gitLogScrollbar,
  gitLogWide,
  prCommits,
  prRefresh,
  findStream,
  gitLogDeep,
  gitLogMultiSelect,
  interactiveRebase,
  resizePanels,
  keyRepeat,
  scroll,
  tabs,
  agentTabs,
  popups,
  toolWindows,
  projectTree,
  projectTreeSelection,
  combinedDiff,
  combinedDiffStress,
  combinedDiff,
  combinedDiffAcceptance,
  leaks,
  httpLargeResponse,
  httpLargeResponseShapes,
];
