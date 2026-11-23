"""Real-app harness: bridge JS, real OS input to this worktree's dev app, rAF frame probe.

- js(): runs JS in a webview window through ../bridge-js.mjs (no Tauri MCP needed).
- Real input: cliclick (clicks), wheel.swift (CGEvent pixel wheel, built once into the temp dir), osascript (focus).
- PERF_WT: worktree whose `target/debug/openidea` is measured (default: the git root of the current directory).
- PERF_PORT: MCP bridge port from `pnpm dev:status` (default 9223).
"""
import json, os, statistics, subprocess, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "..", "bridge-js.mjs")
WT = os.environ.get("PERF_WT") or subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
PORT = os.environ.get("PERF_PORT", "9223")
PROBE = open(os.path.join(HERE, "probe.js")).read()
WHEEL = os.path.join(tempfile.gettempdir(), "oi-verify-wheel")


def app_pid():
    out = subprocess.run(["pgrep", "-f", f"^{WT}/target/debug/openidea"], capture_output=True, text=True).stdout.split()
    if not out:
        raise SystemExit(f"dev app of {WT} not running")
    return int(out[0])


def js(win, script, timeout=20):
    """Run `script` (may `return`) in window `win`; returns parsed JSON (or raw text). None on bridge timeout."""
    try:
        p = subprocess.run(["node", BRIDGE, PORT, win, script], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    if p.returncode == 0:
        out = p.stdout.strip()
        try:
            return json.loads(out)
        except Exception:
            return out
    # A frozen page answers "Script execution timeout": treat like no answer, raise on real errors.
    if p.stdout.startswith("ERROR") and "timeout" not in p.stdout.lower():
        raise RuntimeError(p.stdout.strip())
    return None


def osa(*lines):
    args = []
    for l in lines:
        args += ["-e", l]
    return subprocess.run(["osascript", *args], capture_output=True, text=True).stdout.strip()


def frontmost_pid():
    return int(osa('tell application "System Events" to get unix id of first process whose frontmost is true') or 0)


def focus(title):
    pid = app_pid()
    osa('tell application "System Events"',
        f"set frontmost of (first process whose unix id is {pid}) to true",
        f'tell (first process whose unix id is {pid}) to perform action "AXRaise" of window "{title}"',
        "end tell")
    time.sleep(0.4)
    if frontmost_pid() != pid:
        raise RuntimeError("OpenIDEA is not frontmost")


def window_frame(title):
    pid = app_pid()
    out = osa(f'tell application "System Events" to tell (first process whose unix id is {pid}) '
              f'to get {{position, size}} of window "{title}"')
    x, y, w, h = [int(v) for v in out.replace(" ", "").split(",")]
    return x, y, w, h


def click(x, y):
    subprocess.run(["cliclick", f"c:{int(x)},{int(y)}"], check=True)


def wheel(x, y, delta, count, interval_ms=40):
    """`count` discrete pixel wheel events of `delta` px (> 0 scrolls content down), `interval_ms` apart."""
    if not os.path.exists(WHEEL):
        subprocess.run(["swiftc", "-O", "-o", WHEEL, os.path.join(HERE, "wheel.swift")], check=True)
    subprocess.run([WHEEL, str(int(x)), str(int(y)), str(int(delta)), str(int(count)), str(interval_ms)], check=True)


def screen_point(title, vx, vy):
    x, y, _, _ = window_frame(title)
    return x + vx, y + vy


def probe_start(win):
    if js(win, "return eval(" + json.dumps(PROBE) + ")") is not True:
        raise RuntimeError("probe install failed")


def probe_stop(win, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        v = js(win, "return window.__audit ? window.__audit.stop() : null", timeout=20)
        if isinstance(v, dict):
            return v
        time.sleep(1)
    raise RuntimeError("probe stop failed")


def idle(win, seconds=3.0):
    probe_start(win)
    time.sleep(seconds)
    return probe_stop(win)


def frame_stats(d):
    g = d["gaps"]
    return {
        "frames": len(g),
        "gt17": sum(x > 17 for x in g), "gt33": sum(x > 33 for x in g),
        "gt50": sum(x > 50 for x in g), "gt100": sum(x > 100 for x in g),
        "max": round(max(g), 1) if g else None,
        "delay_med": round(statistics.median(d["delays"]), 1) if d.get("delays") else None,
        "delay_max": round(max(d["delays"]), 1) if d.get("delays") else None,
        "dom": [d["before"][0], d["after"][0]], "cm": [d["before"][2], d["after"][2]],
        "ms": d["ms"], "visible": d["visible"], "focus": d["focus"],
    }
