// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  findOutputLinks,
  horizontalColumnWindow,
  joinPath,
  sliceRangesInWindow,
  visibleCharWindow,
  type OutputLink,
} from "./links";

function files(text: string) {
  return findOutputLinks(text)
    .filter((l): l is Extract<OutputLink, { kind: "file" }> => l.kind === "file")
    .map((l) => ({ ...l.target, text: text.slice(l.start, l.end) }));
}

describe("findOutputLinks", () => {
  it("rust diagnostics and panics", () => {
    expect(files("  --> src/main.rs:10:5")).toEqual([
      { path: "src/main.rs", line: 10, col: 5, resolve: "path", text: "src/main.rs:10:5" },
    ]);
    expect(files("thread 'main' panicked at crates/app/src/lib.rs:42:9:")[0]).toMatchObject({
      path: "crates/app/src/lib.rs",
      line: 42,
      col: 9,
    });
  });

  it("node / v8 stack frames", () => {
    expect(files("    at foo (src/server.ts:3:7)")).toEqual([
      { path: "src/server.ts", line: 3, col: 7, resolve: "path", text: "src/server.ts:3:7" },
    ]);
    expect(files("    at file:///Users/me/app/index.mjs:12:1")[0]).toMatchObject({
      path: "/Users/me/app/index.mjs",
      line: 12,
    });
    expect(files("    at Object.<anonymous> (/abs/dir/x.js:1:2)")[0]).toMatchObject({ path: "/abs/dir/x.js" });
  });

  it("python tracebacks", () => {
    const [link] = files('  File "app/main.py", line 3, in <module>');
    expect(link).toEqual({ path: "app/main.py", line: 3, resolve: "path", text: 'File "app/main.py", line 3' });
  });

  it("java / kotlin frames resolve by fully qualified class name", () => {
    const [link] = files("\tat com.acme.orders.OrderController.list(OrderController.kt:22)");
    expect(link).toEqual({
      path: "com/acme/orders/OrderController.kt",
      line: 22,
      resolve: "name",
      className: "com.acme.orders.OrderController",
      text: "OrderController.kt:22",
    });
    // Nested classes and lambdas live in the outer class's file; JDK module prefixes are skipped.
    expect(files("\tat com.acme.Outer$Inner.lambda$run$0(Outer.java:7)")[0]).toMatchObject({
      path: "com/acme/Outer.java",
      className: "com.acme.Outer$Inner",
    });
    expect(files("\tat java.base/java.util.ArrayList.get(ArrayList.java:427)")[0]).toMatchObject({
      path: "java/util/ArrayList.java",
      className: "java.util.ArrayList",
    });
    // The default package, and a bare `(File.java:3)` without a frame.
    expect(files("\tat Main.main(Main.java:3)")[0]).toMatchObject({ path: "Main.java", className: "Main" });
    expect(files("(Main.java:3)")[0]).toEqual({ path: "Main.java", line: 3, resolve: "name", text: "Main.java:3" });
  });

  it("go and generic path:line", () => {
    expect(files("    math_test.go:12: expected 1")[0]).toMatchObject({ path: "math_test.go", line: 12 });
    expect(files("./cmd/server/main.go:8:2: undefined: x")[0]).toMatchObject({
      path: "./cmd/server/main.go",
      line: 8,
      col: 2,
    });
    expect(files("src/App.tsx(14,3): error TS2322")[0]).toMatchObject({ path: "src/App.tsx", line: 14, col: 3 });
    // Go module cache paths with @version and stack frames
    expect(files("        /Users/user/go/pkg/mod/github.com/spf13/cobra@v1.10.2/command.go:1071")[0]).toMatchObject({
      path: "/Users/user/go/pkg/mod/github.com/spf13/cobra@v1.10.2/command.go",
      line: 1071,
    });
    // Go stack frames with trailing colon
    expect(files("        /Users/user/projects/demo/pkg/api/server.go:42:")[0]).toMatchObject({
      path: "/Users/user/projects/demo/pkg/api/server.go",
      line: 42,
    });
    // Relative paths in loggers (e.g. zap/zerolog/slog)
    expect(files("2026-01-01T12:00:00.000+0000\tDEBUG\tpkg/store/db.go:15\tfailed to connect")[0]).toMatchObject({
      path: "pkg/store/db.go",
      line: 15,
    });
  });

  it("maven diagnostics [ERROR] path:[line,col]", () => {
    expect(files("[ERROR] /p/src/main/java/a/A.java:[12,5] cannot find symbol")[0]).toEqual({
      path: "/p/src/main/java/a/A.java",
      line: 12,
      col: 5,
      resolve: "path",
      text: "/p/src/main/java/a/A.java:[12,5]",
    });
    expect(files("[WARNING] src/main/java/B.java:[3,8] [deprecation] old() has been deprecated")[0]).toMatchObject({
      path: "src/main/java/B.java",
      line: 3,
      col: 8,
    });
    expect(files("[ERROR] C:\\proj\\A.java:[7,1] error: x")[0]).toMatchObject({
      path: "C:\\proj\\A.java",
      line: 7,
      col: 1,
    });
  });

  it("URLs, trimming trailing punctuation", () => {
    const links = findOutputLinks("Listening on http://localhost:8080/api. (see https://x.dev/a_(b))");
    expect(links.filter((l) => l.kind === "url").map((l) => (l.kind === "url" ? l.url : ""))).toEqual([
      "http://localhost:8080/api",
      "https://x.dev/a_(b)",
    ]);
  });

  it("doesn't link URL ports or versions as files", () => {
    expect(files("Started at http://127.0.0.1:3000")).toEqual([]);
    expect(files("version 1.2.3:4")).toEqual([]);
    expect(files("plain text 12:30")).toEqual([]);
  });

  it("returns links sorted and non-overlapping", () => {
    const links = findOutputLinks("a.rs:1 then b.ts:2:3");
    expect(links.map((l) => l.start)).toEqual([0, 12]);
  });

  it("detects links at start, middle and end of a line just under the 4,000-character limit", () => {
    const pad = (n: number) => "x".repeat(n);
    const midJvm = "at com.acme.Service.run(Service.kt:99)";
    const midPy = 'File "app/worker.py", line 17';
    const midUrl = "https://example.dev/docs(v2)";
    const tail = "end/file.go:88";

    let line = "target.txt:1:1 ";
    line += pad(1900 - line.length) + " " + midJvm + " " + midPy + " " + midUrl + " ";
    line += pad(3999 - tail.length - 1 - line.length) + " " + tail;

    expect(line.length).toBe(3_999);
    const links = findOutputLinks(line);
    expect(
      links.map((l) => (l.kind === "url" ? l.url : `${l.target.path}:${l.target.line}:${l.target.col ?? ""}`)),
    ).toEqual([
      "target.txt:1:1",
      "com/acme/Service.kt:99:",
      "app/worker.py:17:",
      "https://example.dev/docs(v2)",
      "end/file.go:88:",
    ]);
  });

  it("scans long lines without links in linear time", () => {
    const t0 = performance.now();
    for (const s of ["x".repeat(3_999), "a.b.".repeat(999), "a/b/".repeat(999), "x:".repeat(1_999)]) {
      expect(findOutputLinks(s)).toEqual([]);
    }
    // The backtracking patterns took over 150 ms for the first four lines alone; a linear scan takes well under 1 ms.
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("detects links at start, middle, end and across 4000/8000-char boundaries on long lines", () => {
    const pad = (n: number) => "x".repeat(n);
    // Build a >10 KiB line with links at start, straddling 4000, middle, straddling 8000, and end.
    const head = "target.txt:1:1 ";
    const boundary4k = "src/cross4k.ts:42:7";
    const midJvm = "at com.acme.Service.run(Service.kt:99)";
    const midPy = 'File "app/worker.py", line 17';
    const midUrl = "https://example.dev/docs(v2)";
    const boundary8k = "[ERROR] /p/src/Cross8k.java:[12,5]";
    const tail = "end/file.go:88";

    let line = head;
    line += pad(3995 - line.length) + " " + boundary4k + " ";
    line += pad(5000 - line.length) + " " + midJvm + " " + midPy + " " + midUrl + " ";
    line += pad(7990 - line.length) + " " + boundary8k + " ";
    line += pad(10200 - line.length) + " " + tail;

    expect(line.length).toBeGreaterThan(10_000);
    const links = findOutputLinks(line);
    expect(
      links.map((l) => (l.kind === "url" ? l.url : `${l.target.path}:${l.target.line}:${l.target.col ?? ""}`)),
    ).toEqual([
      "target.txt:1:1",
      "src/cross4k.ts:42:7",
      "com/acme/Service.kt:99:",
      "app/worker.py:17:",
      "https://example.dev/docs(v2)",
      "/p/src/Cross8k.java:12:5",
      "end/file.go:88:",
    ]);
    for (const l of links) {
      expect(line.slice(l.start, l.end).length).toBeGreaterThan(0);
    }
  });

  it("scales linearly on long lines without links and caches repeated scans", () => {
    const t0 = performance.now();
    for (const s of ["x".repeat(3_999), "x".repeat(16_000), "a.b.".repeat(1_000), "a/b/".repeat(1_000)]) {
      expect(findOutputLinks(s)).toEqual([]);
    }
    const elapsed = performance.now() - t0;
    // Before the fix, "x".repeat(3999) + "a.b."*1000 + "a/b/"*1000 alone take >60 ms due to O(n^2) backtracking.
    expect(elapsed).toBeLessThan(25);

    const tailLine = `${"x".repeat(8_000)} src/tail.ts:12:3`;
    const tailLinks = findOutputLinks(tailLine);
    expect(tailLinks).toHaveLength(1);
    expect(tailLinks[0]).toMatchObject({ kind: "file", target: { path: "src/tail.ts", line: 12, col: 3 } });

    // Repeating the same line text must hit the cache instead of re-running regex scans.
    const cachedLine = `cached ${"y".repeat(2000)} src/cached.ts:5:2`;
    const first = findOutputLinks(cachedLine);
    const spy = vi.spyOn(RegExp.prototype, "exec");
    try {
      const second = findOutputLinks(cachedLine);
      expect(second).toEqual(first);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("joinPath", () => {
  it("joins and normalises", () => {
    expect(joinPath("/p/app", "src/main.rs")).toBe("/p/app/src/main.rs");
    expect(joinPath("/p/app", "./a/../b.ts")).toBe("/p/app/b.ts");
    expect(joinPath("/p/app", "/abs/x.py")).toBe("/abs/x.py");
    expect(joinPath("/p/app/", "file:///abs/y.js")).toBe("/abs/y.js");
  });
});

describe("horizontal window helpers", () => {
  it("maps visual columns to UTF-16 offsets across ASCII, tabs and CJK characters", () => {
    expect(visibleCharWindow("abcdefghij", 2, 6)).toEqual({ start: 2, end: 6 });
    expect(visibleCharWindow("a\tbcdefgh", 0, 5, 4)).toEqual({ start: 0, end: 3 });
    expect(visibleCharWindow("中文abcd", 2, 6)).toEqual({ start: 1, end: 4 });
  });

  it("slices ranges to the window while retaining alwaysKeep items", () => {
    const items = [
      { start: 0, end: 5, current: false },
      { start: 50, end: 55, current: false },
      { start: 100, end: 105, current: true },
    ];
    expect(sliceRangesInWindow(items, 40, 70)).toEqual([{ start: 50, end: 55, current: false }]);
    expect(sliceRangesInWindow(items, 40, 70, (m) => m.current)).toEqual([
      { start: 50, end: 55, current: false },
      { start: 100, end: 105, current: true },
    ]);
  });

  it("covers real 0.60em monospace columns when scrolled horizontally", () => {
    // At 13px and 0.60em (7.8px/ch), scrollLeft 20,280 in an 800px viewport displays cols 2600..2703.
    const win = horizontalColumnWindow(20_280, 800, 13);
    expect(win).not.toBeNull();
    expect(win!.start).toBeLessThanOrEqual(2_600);
    expect(win!.end).toBeGreaterThanOrEqual(2_703);

    // With a measured 1ch advance width and left padding, the window stays tight around the visible cols.
    const measured = horizontalColumnWindow(20_280, 800, 13, { charWidthPx: 7.8, paddingLeftPx: 12 });
    expect(measured).not.toBeNull();
    expect(measured!.start).toBeLessThanOrEqual(2_598);
    expect(measured!.end).toBeGreaterThanOrEqual(2_702);
    expect(measured!.end - measured!.start).toBeLessThan(400);

    // Wide (0.70em) and narrow (0.50em) fonts both stay covered when measured.
    const wide = horizontalColumnWindow(20_000, 800, 13, { charWidthPx: 9.1, paddingLeftPx: 12 });
    expect(wide!.start).toBeLessThanOrEqual(Math.floor((20_000 - 12) / 9.1));
    expect(wide!.end).toBeGreaterThanOrEqual(Math.ceil((20_800 - 12) / 9.1));
    const narrow = horizontalColumnWindow(20_000, 800, 13, { charWidthPx: 6.5, paddingLeftPx: 12 });
    expect(narrow!.start).toBeLessThanOrEqual(Math.floor((20_000 - 12) / 6.5));
    expect(narrow!.end).toBeGreaterThanOrEqual(Math.ceil((20_800 - 12) / 6.5));
  });
});
