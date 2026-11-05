#!/usr/bin/env python3
"""Black-box IDE comparison: startup, readiness, memory, idle CPU, disk.

Launches each app from apps.toml on the same project, measures it from the
outside (process tree, window list, log lines), optionally opens a file so the
language servers start, closes it, and repeats with the apps interleaved.
Runs on Windows, macOS and Linux; see README.md. `--self-test` checks the
pure helpers without launching anything.
"""

from __future__ import annotations

import argparse
import collections
import ctypes
import datetime as dt
import glob
import json
import os
import platform
import re
import shutil
import signal
import statistics
import subprocess
import sys
import time
import tomllib
from pathlib import Path

try:
    import psutil
except ImportError:
    sys.exit("psutil is required: pip install -r perf/compare/requirements.txt")

OS = {"Windows": "windows", "Darwin": "macos", "Linux": "linux"}[platform.system()]
HERE = Path(__file__).resolve().parent
LANGUAGES_DIR = HERE.parent.parent / "languages"
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
GONE = (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied)
MB = 1024 * 1024
POLL_S = 0.2


# ── config ──────────────────────────────────────────────────────────────────


def per_os(value):
    """A value, or a {windows, macos, linux} table of per-platform values."""
    if isinstance(value, dict) and value and value.keys() <= {"windows", "macos", "linux"}:
        return value.get(OS)
    return value


def as_list(value) -> list:
    return [] if value is None else [value] if isinstance(value, str) else list(value)


def expand(s: str, project: Path, file: str | None = None) -> str:
    s = s.replace("{project}", str(project)).replace("{project_name}", project.name)
    if file is not None:
        s = s.replace("{file}", file)
    return os.path.expandvars(os.path.expanduser(s))


def pattern(s: str, project: Path) -> re.Pattern:
    return re.compile(s.replace("{project_name}", re.escape(project.name)))


def default_open_command(exe: str, file: str, os_name: str = OS) -> list[str]:
    """How to hand a file to the running app: through LaunchServices for a macOS
    bundle, otherwise by launching the executable again (single-instance apps
    forward the path to the running instance)."""
    if os_name == "macos":
        i = exe.find(".app/Contents/MacOS/")
        if i != -1:
            return ["open", "-a", exe[: i + len(".app")], file]
    return [exe, file]


class App:
    def __init__(self, key: str, raw: dict, project: Path, open_file: Path | None = None):
        self.key = key
        self.name = raw.get("name", key)
        command = per_os(raw.get("command"))
        if not command:
            raise SystemExit(f"apps.{key}: no command for {OS}")
        args = per_os(raw.get("args", ["{project}"]))
        self.command = [expand(command, project), *(expand(a, project) for a in args)]
        self.logs = [expand(g, project) for g in as_list(per_os(raw.get("logs")))]
        self.markers = {k: pattern(v, project) for k, v in raw.get("markers", {}).items()}
        self.ready_after = as_list(raw.get("ready_after"))
        self.window_title = pattern(raw.get("window_title", "{project_name}"), project)
        self.cache_dirs = [expand(d, project) for d in as_list(per_os(raw.get("cache_dirs")))]
        self.install_dir = per_os(raw.get("install_dir"))
        self.install_dir = expand(self.install_dir, project) if self.install_dir else None
        self.quit_command = as_list(per_os(raw.get("quit_command")))
        self.single_instance = raw.get("single_instance", True)
        self.daemons = {n.lower() for n in as_list(raw.get("daemons"))}
        self.open_file = open_file
        self.open_command: list[str] = []
        if open_file is not None:
            template = as_list(per_os(raw.get("open_command")))
            file = str(open_file)
            self.open_command = (
                [expand(a, project, file) for a in template] if template else default_open_command(self.command[0], file)
            )
        lsp = raw.get("language_server_process")
        self.language_server_process = re.compile(lsp) if lsp else None
        unknown = set(self.ready_after) - self.markers.keys()
        if unknown:
            raise SystemExit(f"apps.{key}.ready_after names unknown markers: {sorted(unknown)}")

    def cache_paths(self) -> list[Path]:
        return [Path(p) for d in self.cache_dirs for p in sorted(glob.glob(d))]


# ── windows ─────────────────────────────────────────────────────────────────

if OS == "windows":
    from ctypes import wintypes

    _user32 = ctypes.WinDLL("user32")
    _ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    _user32.EnumWindows.argtypes = [_ENUM, wintypes.LPARAM]
    _user32.IsWindowVisible.argtypes = [wintypes.HWND]
    _user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    _user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    _user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]


def _win_windows(pids: set[int]) -> list[tuple[object, str]]:
    found = []

    def visit(hwnd, _):
        if _user32.IsWindowVisible(hwnd):
            pid = wintypes.DWORD()
            _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value in pids:
                buf = ctypes.create_unicode_buffer(_user32.GetWindowTextLengthW(hwnd) + 1)
                _user32.GetWindowTextW(hwnd, buf, len(buf))
                found.append((hwnd, buf.value))
        return True

    _user32.EnumWindows(_ENUM(visit), 0)
    return found


def _mac_windows(pids: set[int]) -> list[tuple[object, str]] | None:
    try:
        import Quartz
    except ImportError:
        return None
    infos = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements, Quartz.kCGNullWindowID
    )
    # Titles need the Screen Recording permission; without it they come back empty.
    return [
        (None, str(w.get("kCGWindowName") or ""))
        for w in infos
        if w.get("kCGWindowOwnerPID") in pids and w.get("kCGWindowLayer") == 0
    ]


def _x11_windows(pids: set[int]) -> list[tuple[object, str]] | None:
    if not shutil.which("wmctrl"):
        return None
    try:
        out = subprocess.run(["wmctrl", "-lp"], capture_output=True, text=True, timeout=2).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    found = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) >= 4 and parts[2].isdigit() and int(parts[2]) in pids:
            found.append((parts[0], parts[4] if len(parts) > 4 else ""))
    return found


def visible_windows(pids: set[int]) -> list[tuple[object, str]] | None:
    """(handle, title) of the visible top-level windows owned by `pids`; None when this platform can't tell."""
    if OS == "windows":
        return _win_windows(pids)
    if OS == "macos":
        return _mac_windows(pids)
    return _x11_windows(pids)


# ── process categories ──────────────────────────────────────────────────────

# Runtimes that run a language server script; the server is named by the script.
INTERPRETERS = {"node", "bun", "deno", "python", "python3", "pythonw", "ruby", "perl", "dotnet", "sh", "bash", "cmd"}
JAVA = {"java", "javaw"}
_STRIP_EXT = (".exe", ".cmd", ".bat", ".js", ".cjs", ".mjs", ".py", ".jar")
_JAVA_VALUE_OPTS = {
    "-cp", "-classpath", "--class-path", "-p", "--module-path", "--add-modules", "--add-opens", "--add-exports",
    "--add-reads", "--patch-module", "--upgrade-module-path", "--limit-modules",
}  # fmt: skip


def stem(path: str) -> str:
    """Lower-case file name without directories or a script/executable extension."""
    name = re.split(r"[\\/]", path)[-1].lower()
    for ext in _STRIP_EXT:
        if name.endswith(ext):
            return name[: -len(ext)]
    return name


def language_server_names(languages_dir: Path = LANGUAGES_DIR) -> frozenset[str]:
    """Executable names of the language servers OpenIDEA's languages/*.toml can start."""
    names = set()
    for f in sorted(languages_dir.glob("*.toml")):
        try:
            servers = tomllib.loads(f.read_text(encoding="utf-8")).get("language-servers", [])
        except (OSError, tomllib.TOMLDecodeError):
            continue
        for server in servers if isinstance(servers, list) else []:
            command = server.get("command") if isinstance(server, dict) else None
            if isinstance(command, str) and command and stem(command) not in INTERPRETERS | JAVA:
                names.add(stem(command))
    return frozenset(names)


_known_lsp: frozenset[str] | None = None


def known_language_servers() -> frozenset[str]:
    global _known_lsp
    if _known_lsp is None:
        _known_lsp = language_server_names()
    return _known_lsp


def _is_language_server(name: str, known: frozenset[str]) -> bool:
    return name in known or name == "jdtls" or name.endswith(("-language-server", "-langserver", "-lsp"))


def java_main(cmdline: list[str]) -> str:
    """The jar or main class a `java` command line runs, shortened."""
    args = iter(cmdline[1:])
    for a in args:
        if a == "-jar":
            return stem(next(args, "?"))
        if a in ("-m", "--module"):
            return next(args, "?").rsplit("/", 1)[-1].rsplit(".", 1)[-1]
        if a in _JAVA_VALUE_OPTS:
            next(args, None)
            continue
        if not a.startswith("-"):
            return a.rsplit(".", 1)[-1]
    return "?"


def categorize(name: str, cmdline: list[str], is_root: bool, known: frozenset[str] = frozenset()) -> str:
    """What a process in an app's tree is: main, webview:*, lsp:*, jvm:*, or its own name."""
    if is_root:
        return "main"
    if name.startswith("com.apple.WebKit."):  # macOS WKWebView helpers
        return "webview:" + name[len("com.apple.WebKit.") :]
    base = stem(name)
    if base == "msedgewebview2":  # Windows WebView2
        kind = next((a.split("=", 1)[1] for a in cmdline if a.startswith("--type=")), "browser")
        return "webview:" + kind
    if base.startswith("webkit"):  # Linux webkit2gtk: WebKitWebProcess, WebKitNetworkProcess
        return "webview:" + (stem(cmdline[0]) if cmdline else base)
    if base in JAVA:
        joined = " ".join(cmdline)
        if "org.eclipse.jdt.ls" in joined or "equinox.launcher" in joined or "jdtls" in joined:
            return "lsp:jdtls"
        return "jvm:" + java_main(cmdline)
    if _is_language_server(base, known):
        return "lsp:" + base
    if base in INTERPRETERS or base.rstrip("0123456789.") in INTERPRETERS:  # python3.12, node22
        for a in cmdline[1:]:
            s = stem(a)
            if _is_language_server(s, known):
                return "lsp:" + s
            if "langserver" in s or "language-server" in s:
                # e.g. node …/node_modules/pyright/langserver.index.js: the package names it.
                parts = re.split(r"[\\/]", a)
                return "lsp:" + (parts[-2].lower() if len(parts) > 1 else s)
    return base


_rusage = None
if OS == "macos":
    try:
        _rusage = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pid_rusage
        _rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_uint64)]
        _rusage.restype = ctypes.c_int
    except (OSError, AttributeError):
        _rusage = None

RUSAGE_INFO_V2 = 2
# rusage_info_v2: a 16-byte uuid (2 slots), then user, system, pkg_idle_wkups,
# interrupt_wkups, pageins, wired_size, resident_size, phys_footprint.
FOOTPRINT_SLOT = 9


def footprint(pid: int) -> int | None:
    """macOS phys_footprint, the Memory column of Activity Monitor. Unlike USS it
    needs no task port, so it works on hardened-runtime apps without root."""
    if _rusage is None:
        return None
    buf = (ctypes.c_uint64 * 32)()
    if _rusage(pid, RUSAGE_INFO_V2, buf) != 0:
        return None
    return buf[FOOTPRINT_SLOT]


# Per-process fields, in bytes; which ones exist depends on the platform.
MEMORY_FIELDS = ("rss", "uss", "pss", "private", "footprint")
# The headline number per platform: what the OS's own task manager shows, or
# the fairest figure available without root.
PRIMARY = {"macos": "footprint_mb", "linux": "pss_mb", "windows": "uss_mb"}[OS]


def _sum_field(rows: list[dict], field: str) -> tuple[float | None, int]:
    """(sum in MB, or None when a process lacks the value; how many lack it)."""
    missing = sum(1 for r in rows if r.get(field) is None)
    if missing:
        return None, missing
    return sum(r[field] for r in rows) / MB, 0


def summarize_memory(rows: list[dict]) -> dict:
    """Totals and per-category sums of per-process memory rows.

    A row is {"pid", "name", "cat", <field>: bytes or None, ...} for the fields this
    platform measures. A total is None rather than an undercount when any process
    lacked the value (macOS denies USS for hardened apps); `<field>_missing` says how many.
    """
    fields = [f for f in MEMORY_FIELDS if any(f in r for r in rows)]
    out: dict = {"procs": len(rows)}
    for f in fields:
        total, missing = _sum_field(rows, f)
        out[f"{f}_mb"] = total
        if missing:
            out[f"{f}_missing"] = missing
    cats: dict[str, list[dict]] = collections.defaultdict(list)
    for r in rows:
        cats[r["cat"]].append(r)
    by_cat = {}
    for cat, members in cats.items():
        entry: dict = {"n": len(members)}
        for f in fields:
            total, _ = _sum_field(members, f)
            entry[f"{f}_mb"] = None if total is None else round(total, 1)
        by_cat[cat] = entry
    key = PRIMARY if PRIMARY in [f"{f}_mb" for f in fields] else "rss_mb"
    out["by_category"] = dict(sorted(by_cat.items(), key=lambda kv: -(kv[1].get(key) or 0)))
    out["processes"] = sorted(
        (
            {"pid": r["pid"], "name": r["name"], "cat": r["cat"]}
            | {f"{f}_mb": None if r.get(f) is None else round(r[f] / MB, 1) for f in fields}
            for r in rows
        ),
        key=lambda r: -(r.get(key) or 0),
    )
    return out


# ── process tree ────────────────────────────────────────────────────────────

_responsible = None
if OS == "macos":
    try:
        _responsible = ctypes.CDLL("/usr/lib/libSystem.B.dylib").responsibility_get_pid_responsible_for_pid
        _responsible.argtypes = [ctypes.c_int]
        _responsible.restype = ctypes.c_int
    except (OSError, AttributeError):
        _responsible = None


class Tree:
    """Every process the app started, including ones whose parent already exited.

    On macOS, WKWebView's helper processes are children of launchd, so they are
    attributed through the responsible-pid API (or, failing that, by name and
    start time).
    """

    def __init__(self, root: psutil.Process, started: float):
        self.root = root
        self.started = started
        self.procs: dict[tuple[int, float], psutil.Process] = {}
        self.cpu: dict[tuple[int, float], float] = {}
        self.cpu_exited = 0.0
        self.cats: dict[tuple[int, float], str] = {}
        self.peak_rss = 0

    def _discover(self):
        found = [self.root]
        for p in list(self.procs.values()):
            try:
                found += p.children(recursive=True)
            except GONE:
                pass
        if OS == "macos":
            found += self._webkit()
        for p in found:
            try:
                self.procs.setdefault((p.pid, p.create_time()), p)
            except GONE:
                pass

    def _webkit(self) -> list[psutil.Process]:
        out = []
        for p in psutil.process_iter(["name", "create_time"]):
            if not (p.info["name"] or "").startswith("com.apple.WebKit"):
                continue
            if _responsible:
                if _responsible(p.pid) == self.root.pid:
                    out.append(p)
            elif (p.info["create_time"] or 0) >= self.started - 1:
                out.append(p)
        return out

    def sample(self) -> tuple[float, int]:
        """(total CPU seconds ever used by the tree, current summed RSS bytes)."""
        self._discover()
        rss = 0
        for key, p in list(self.procs.items()):
            try:
                with p.oneshot():
                    t = p.cpu_times()
                    self.cpu[key] = t.user + t.system
                    rss += p.memory_info().rss
            except GONE:
                self.cpu_exited += self.cpu.pop(key, 0.0)
                del self.procs[key]
                self.cats.pop(key, None)
        self.peak_rss = max(self.peak_rss, rss)
        return self.cpu_exited + sum(self.cpu.values()), rss

    def pids(self) -> set[int]:
        return {pid for pid, _ in self.procs}

    def alive(self) -> list[psutil.Process]:
        return [p for p in self.procs.values() if p.is_running()]

    def category(self, key: tuple[int, float], p: psutil.Process) -> str:
        if key not in self.cats:
            try:
                cmdline = p.cmdline()
            except GONE:
                cmdline = []
            self.cats[key] = categorize(p.name(), cmdline, p.pid == self.root.pid, known_language_servers())
        return self.cats[key]

    def categories(self) -> set[str]:
        """Categories of the processes alive now."""
        out = set()
        for key, p in list(self.procs.items()):
            try:
                if p.is_running():
                    out.add(self.category(key, p))
            except GONE:
                pass
        return out

    def memory(self) -> dict:
        """Memory of the live tree, in total and per category (see summarize_memory).

        RSS double-counts shared pages; USS leaves them out; PSS (Linux) splits them.
        """
        rows = []
        for key, p in list(self.procs.items()):
            try:
                if not p.is_running():
                    continue
                with p.oneshot():
                    info = p.memory_info()
                    row = {"pid": p.pid, "name": p.name(), "cat": self.category(key, p), "rss": info.rss}
                if OS == "windows":
                    row["private"] = getattr(info, "private", None)
                if OS == "macos":
                    row["footprint"] = footprint(p.pid)
                try:
                    full = p.memory_full_info()
                    row["uss"] = full.uss
                    if OS == "linux":
                        row["pss"] = full.pss
                except psutil.AccessDenied:
                    # Hardened-runtime apps on macOS: no task port without root.
                    row["uss"] = None
                    if OS == "linux":
                        row["pss"] = None
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                continue
            except psutil.AccessDenied:
                continue  # not even RSS: not a process this user can measure
            rows.append(row)
        return summarize_memory(rows)


# ── logs ────────────────────────────────────────────────────────────────────


class LogTail:
    """New lines appended to the files matching some globs since construction."""

    def __init__(self, globs: list[str], extra: list[Path]):
        self.globs = globs
        self.extra = extra
        self.offsets: dict[str, int] = {}
        self.partial: dict[str, str] = {}
        for path in self._paths():
            self.offsets[path] = os.path.getsize(path)

    def _paths(self) -> list[str]:
        paths = [p for g in self.globs for p in glob.glob(g)]
        return paths + [str(p) for p in self.extra if p.exists()]

    def lines(self) -> list[str]:
        out = []
        for path in self._paths():
            try:
                with open(path, "rb") as f:
                    f.seek(self.offsets.get(path, 0))
                    chunk = f.read()
                    self.offsets[path] = f.tell()
            except OSError:
                continue
            if not chunk:
                continue
            text = self.partial.pop(path, "") + chunk.decode("utf-8", "replace")
            *complete, rest = text.split("\n")
            if rest:
                self.partial[path] = rest
            out += [ANSI.sub("", line) for line in complete]
        return out


# ── one run ─────────────────────────────────────────────────────────────────


def running_instances(app: App) -> list[psutil.Process]:
    """Processes with the app's executable name, from any install or build: a
    single-instance app hands the launch to them even when the paths differ."""
    name = os.path.normcase(Path(app.command[0]).name)
    return [p for p in psutil.process_iter(["name"]) if os.path.normcase(p.info["name"] or "") == name]


def dir_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def close(app: App, tree: Tree, proc: subprocess.Popen, timeout: float) -> tuple[float | None, list[str]]:
    """Asks the app to quit, waits for the whole tree, kills what's left.

    Returns (seconds until every process exited, or None if it had to kill; names of killed leftovers).
    """
    t0 = time.perf_counter()
    if app.quit_command:
        subprocess.run(app.quit_command, check=False)
    elif OS == "windows":
        # Only the project windows: closing a framework's hidden message windows
        # (Tauri's single-instance and event-target ones) stalls the real shutdown.
        for hwnd, title in _win_windows(tree.pids()):
            if app.window_title.search(title):
                _user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
    else:
        proc.send_signal(signal.SIGTERM)

    def remaining() -> list[psutil.Process]:
        out = []
        for p in tree.alive():
            try:
                if p.name().lower() not in app.daemons:
                    out.append(p)
            except GONE:
                pass
        return out

    while time.perf_counter() - t0 < timeout:
        tree.sample()
        if not remaining():
            return time.perf_counter() - t0, []
        time.sleep(POLL_S)
    leftovers = remaining()
    names = []
    for p in leftovers:
        try:
            names.append(p.name())
            p.kill()
        except GONE:
            pass
    psutil.wait_procs(leftovers, timeout=10)
    return None, names


class Quiet:
    """Tracks whether a tree's CPU stayed under `cores` busy for the last `secs`."""

    def __init__(self, secs: float, cores: float):
        self.secs = secs
        self.cores = cores
        self.history: collections.deque[tuple[float, float]] = collections.deque()

    def add(self, now: float, cpu: float) -> float | None:
        """Records total CPU seconds at `now`; returns when the quiet span began, or None if not quiet."""
        self.history.append((now, cpu))
        while self.history and now - self.history[0][0] > self.secs:
            self.history.popleft()
        span = now - self.history[0][0]
        if span > 0 and span >= self.secs * 0.95 and (cpu - self.history[0][1]) / span < self.cores:
            return now - span
        return None


class OpenGate:
    """Decides when an opened file has settled.

    With a language server to wait for, the CPU must stay quiet for a whole
    window that begins after the server first appeared, and the server must be
    running at that tick. A server that disappears is forgotten until it returns.
    """

    def __init__(self, wants_lsp: bool):
        self.wants_lsp = wants_lsp
        self.lsp_s: float | None = None

    def update(self, now: float, quiet_from: float | None, lsp_present: bool) -> float | None:
        """Returns the ready time (seconds from the open), or None while still waiting."""
        if self.wants_lsp:
            if not lsp_present:
                self.lsp_s = None
                return None
            if self.lsp_s is None:
                self.lsp_s = now
            if quiet_from is None or quiet_from < self.lsp_s:
                return None
            return quiet_from
        return quiet_from


def scan_markers(tail: LogTail, app: App, result: dict, now: float):
    for line in tail.lines():
        for name, rx in app.markers.items():
            if rx.search(line):
                result["markers_first_s"].setdefault(name, now)
                result["markers_last_s"][name] = now


def open_and_settle(app: App, tree: Tree, args, on_tick) -> dict:
    """Opens `app.open_file` in the running app, waits for the language server
    process (when the app names one) and for the CPU to settle again.

    Times are seconds from the open. A timeout is recorded, not fatal, so the
    idle sample still runs.
    """
    out: dict = {}
    cpu0, _ = tree.sample()
    o0 = time.perf_counter()
    opener = subprocess.Popen(
        app.open_command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    quiet = Quiet(args.quiet_secs, args.quiet_cores)
    want = app.language_server_process
    gate = OpenGate(want is not None)
    while True:
        now = time.perf_counter() - o0
        cpu, _ = tree.sample()
        quiet_from = quiet.add(now, cpu)
        on_tick()
        present = bool(want) and any(want.search(c) for c in tree.categories())
        ready = gate.update(now, quiet_from, present)
        if ready is not None:
            out["open_ready_s"] = ready
            break
        if not tree.alive():
            raise SystemExit(f"{app.name} exited after opening {app.open_file}")
        if now > args.open_timeout:
            out["open_timed_out"] = True
            break
        time.sleep(POLL_S)
    out["lsp_s"] = gate.lsp_s
    out["open_cpu_s"] = cpu - cpu0
    # The opener only forwards the file (LaunchServices, or a second instance that
    # hands over and exits); one still running is a second app, not part of the tree.
    try:
        out["opener_exit_code"] = opener.wait(timeout=5)
    except subprocess.TimeoutExpired:
        opener.kill()
        opener.wait()
        out["opener_killed"] = True
    return out


def run_once(app: App, args, out_dir: Path, label: str) -> dict:
    running = running_instances(app) if app.single_instance else []
    if running:
        pids = ", ".join(str(p.pid) for p in running)
        raise SystemExit(f"{app.name} is already running (pid {pids}); close it first, it would take over the launch.")
    if args.wipe_caches:
        for path in app.cache_paths():
            shutil.rmtree(path, ignore_errors=True) if path.is_dir() else path.unlink(missing_ok=True)
    if args.drop_os_cache:
        subprocess.run(args.drop_os_cache, shell=True, check=True)
    if args.cooldown:
        time.sleep(args.cooldown)

    stdout_path = out_dir / f"{label}.stdout.log"
    tail = LogTail(app.logs, [stdout_path])
    started_wall = time.time()
    with open(stdout_path, "wb") as stdout:
        t0 = time.perf_counter()
        proc = subprocess.Popen(app.command, stdout=stdout, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    tree = Tree(psutil.Process(proc.pid), started_wall)

    result: dict = {"app": app.key, "label": label, "markers_first_s": {}, "markers_last_s": {}}
    window_supported = True
    window_s = None
    quiet = Quiet(args.quiet_secs, args.quiet_cores)
    ready_s = None

    while True:
        now = time.perf_counter() - t0
        cpu, _ = tree.sample()
        quiet_from = quiet.add(now, cpu)
        scan_markers(tail, app, result, now)

        if window_s is None and window_supported:
            windows = visible_windows(tree.pids())
            if windows is None:
                window_supported = False
            elif any(app.window_title.search(title) for _, title in windows):
                window_s = now

        if not tree.alive():
            raise SystemExit(
                f"{app.name} exited during startup (code {proc.poll()}); an instance started elsewhere may have "
                f"taken the launch. Output: {stdout_path}"
            )

        waited = (window_s is not None or not window_supported) and all(
            m in result["markers_first_s"] for m in app.ready_after
        )
        if waited and quiet_from is not None:
            # Never before what it waited for (the quiet span can start earlier).
            ready_s = max(quiet_from, window_s or 0, *(result["markers_first_s"][m] for m in app.ready_after))
            break
        if now > args.timeout:
            result["timed_out"] = True
            break
        time.sleep(POLL_S)

    result["window_s"] = window_s
    result["ready_s"] = ready_s
    result["total_cpu_s"] = cpu

    if app.open_file is not None and ready_s is not None:
        # Language servers start on the first opened file, so without this step
        # the samples below would leave them out.
        at_ready = tree.memory()
        result["at_ready_mb"] = at_ready.get(PRIMARY)
        result["at_ready_by_category"] = at_ready["by_category"]
        # Markers keep counting from launch, e.g. OpenIDEA's lsp_initialized.
        def tick():
            scan_markers(tail, app, result, time.perf_counter() - t0)

        result.update(open_and_settle(app, tree, args, tick))

    # Idle: what it costs to just sit there with the project (and file) open.
    idle_cpu0, _ = tree.sample()
    i0 = time.perf_counter()
    while time.perf_counter() - i0 < args.idle_secs:
        time.sleep(POLL_S * 5)
        tree.sample()
    idle_cpu1, _ = tree.sample()
    result["idle_cpu_pct"] = 100 * (idle_cpu1 - idle_cpu0) / (time.perf_counter() - i0)
    result["peak_rss_mb"] = tree.peak_rss / MB
    result.update(tree.memory())

    exit_s, killed = close(app, tree, proc, args.close_timeout)
    result["exit_s"] = exit_s
    if killed:
        result["killed_on_exit"] = killed
    result["cache_mb"] = sum(dir_size(p) for p in app.cache_paths()) / MB
    return result


# ── report ──────────────────────────────────────────────────────────────────

MEMORY_TITLES = {
    "footprint_mb": "Footprint",
    "uss_mb": "USS",
    "pss_mb": "PSS",
    "rss_mb": "RSS",
    "private_mb": "Private bytes",
}

METRICS = [
    ("window_s", "Window with project title (s)"),
    ("ready_s", "Ready: CPU settled (s)"),
    ("at_ready_mb", f"{MEMORY_TITLES[PRIMARY]} at ready, before open_file (MB)"),
    ("lsp_s", "open_file → language server process (s)"),
    ("open_ready_s", "open_file → CPU settled (s)"),
    ("open_cpu_s", "CPU used by open_file (s)"),
    ("peak_rss_mb", "Peak RSS, whole run (MB)"),
    ("footprint_mb", "Footprint after idle (MB, Activity Monitor)"),
    ("rss_mb", "RSS after idle (MB)"),
    ("uss_mb", "USS after idle (MB)"),
    ("pss_mb", "PSS after idle (MB)"),
    ("private_mb", "Private bytes after idle (MB)"),
    ("procs", "Processes"),
    ("total_cpu_s", "CPU used until ready (s)"),
    ("idle_cpu_pct", "Idle CPU (% of a core)"),
    ("exit_s", "Exit (s)"),
    ("cache_mb", "Cache dirs on disk (MB)"),
]


def fmt(value: float | None) -> str:
    return "–" if value is None else f"{value:.2f}"


def summarize(values: list[float]) -> str:
    if not values:
        return "–"
    med = statistics.median(values)
    if len(values) == 1:
        return f"{med:.2f}"
    return f"{med:.2f} ({min(values):.2f}–{max(values):.2f})"


def report(apps: list[App], runs: list[dict], meta: dict) -> str:
    def column(app: App, getter) -> str:
        vals = [v for r in runs if r["app"] == app.key and (v := getter(r)) is not None]
        return summarize(vals)

    rows = [(title, lambda r, k=key: r.get(k)) for key, title in METRICS]
    # Per-category memory after idle, in the order categories first appear.
    cats = list(dict.fromkeys(c for r in runs for c in r.get("by_category", {})))
    for cat in cats:
        rows.append(
            (
                f"{MEMORY_TITLES[PRIMARY]} after idle · {cat} (MB)",
                lambda r, c=cat: r.get("by_category", {}).get(c, {}).get(PRIMARY),
            )
        )
    for app in apps:
        for m in app.markers:
            rows.append((f"{app.name}: log `{m}` first (s)", lambda r, m=m: r["markers_first_s"].get(m)))
            rows.append((f"{app.name}: log `{m}` last (s)", lambda r, m=m: r["markers_last_s"].get(m)))

    lines = [
        f"# IDE benchmark: {meta['project']}",
        "",
        f"{meta['os']} · {meta['cpu']} · {meta['cores']} cores · {meta['ram_gb']:.0f} GB RAM · "
        f"mode **{meta['mode']}** · {meta['runs']} runs · {meta['date']}",
        "",
        "Median (min–max). Times are seconds from launch. "
        + (
            f"After ready, `{meta['open_file']}` was opened and memory sampled once it settled."
            if meta.get("open_file")
            else "No file was opened, so language servers that start on the first open file are not included."
        ),
        "",
        "| Metric | " + " | ".join(a.name for a in apps) + " |",
        "|---|" + "---|" * len(apps),
    ]
    for title, getter in rows:
        cells = [column(a, getter) for a in apps]
        if any(c != "–" for c in cells):
            lines.append(f"| {title} | " + " | ".join(cells) + " |")
    for app in apps:
        if app.install_dir and Path(app.install_dir).exists():
            lines.append(f"\n{app.name} install size: {dir_size(Path(app.install_dir)) / MB:.0f} MB")
    timeouts = [r["label"] for r in runs if r.get("timed_out")]
    if timeouts:
        lines.append(f"\n⚠ CPU never settled within the timeout: {', '.join(timeouts)}")
    open_timeouts = [r["label"] for r in runs if r.get("open_timed_out")]
    if open_timeouts:
        lines.append(
            f"\n⚠ After open_file, no language server or no settled CPU within --open-timeout: {', '.join(open_timeouts)}"
        )
    opener_failed = [
        r["label"] for r in runs if r.get("opener_killed") or r.get("opener_exit_code") not in (None, 0)
    ]
    if opener_failed:
        lines.append(f"\n⚠ The open_file command failed or hung, so the file may never have opened: {', '.join(opener_failed)}")
    missing = [r["label"] for r in runs if r.get(PRIMARY) is None]
    if missing:
        lines.append(f"\n⚠ {MEMORY_TITLES[PRIMARY]} unavailable for some processes (no total): {', '.join(missing)}")
    killed = [f"{r['label']}: {', '.join(r['killed_on_exit'])}" for r in runs if r.get("killed_on_exit")]
    if killed:
        lines.append("\n⚠ Killed after the exit timeout: " + "; ".join(killed))
    return "\n".join(lines) + "\n"


# ── main ────────────────────────────────────────────────────────────────────


def self_test():
    """Checks the pure helpers; runs without launching any app."""
    assert per_os({"windows": 1, "macos": 2, "linux": 3}) == {"windows": 1, "macos": 2, "linux": 3}[OS]
    assert per_os({"name": "x"}) == {"name": "x"}

    assert default_open_command("/Applications/OpenIDEA Fork.app/Contents/MacOS/openidea", "/p/A.java", "macos") == [
        "open", "-a", "/Applications/OpenIDEA Fork.app", "/p/A.java",
    ]  # fmt: skip
    assert default_open_command("/usr/bin/openidea", "/p/A.java", "macos") == ["/usr/bin/openidea", "/p/A.java"]
    assert default_open_command("C:/x/openidea.exe", "C:/p/A.java", "windows") == ["C:/x/openidea.exe", "C:/p/A.java"]

    known = language_server_names()
    if LANGUAGES_DIR.is_dir():
        assert {"basedpyright-langserver", "gopls", "rust-analyzer"} <= known, sorted(known)
        assert not known & (INTERPRETERS | JAVA), known & (INTERPRETERS | JAVA)

    assert stem("C:\\tools\\gopls.exe") == "gopls"
    assert java_main(["java", "-Xmx1g", "-cp", "a.jar:b.jar", "org.example.Main", "arg"]) == "Main"
    assert java_main(["java", "-jar", "/x/kotlin-lsp.jar"]) == "kotlin-lsp"
    jdtls = ["/jdk/bin/java", "-Declipse.application=org.eclipse.jdt.ls.core.id1", "-jar",
             "/opt/jdtls/plugins/org.eclipse.equinox.launcher_1.8.0.jar", "-data", "/ws"]  # fmt: skip
    cases = [
        (("openidea", [], True), "main"),
        (("com.apple.WebKit.WebContent", [], False), "webview:WebContent"),
        (("msedgewebview2.exe", ["msedgewebview2.exe", "--type=renderer"], False), "webview:renderer"),
        (("msedgewebview2.exe", ["msedgewebview2.exe"], False), "webview:browser"),
        (("WebKitWebProcess", ["/usr/lib/webkit2gtk-4.1/WebKitWebProcess", "7"], False), "webview:webkitwebprocess"),
        (("java", jdtls, False), "lsp:jdtls"),
        (("java", ["java", "-cp", "x", "org.jetbrains.maven.RemoteMavenServer"], False), "jvm:RemoteMavenServer"),
        (("gopls", ["gopls"], False), "lsp:gopls"),
        (("rust-analyzer.exe", ["rust-analyzer.exe"], False), "lsp:rust-analyzer"),
        (("node", ["node", "/u/.bin/pyright-langserver", "--stdio"], False), "lsp:pyright-langserver"),
        (("node", ["node", "/u/node_modules/basedpyright/langserver.index.js", "--stdio"], False), "lsp:basedpyright"),
        (("python3.12", ["python3.12", "/u/lib/fake-language-server.py"], False), "lsp:fake-language-server"),
        (("node", ["node", "vite.js"], False), "node"),
        (("fsnotifier", [], False), "fsnotifier"),
    ]
    for (name, cmdline, root), want in cases:
        got = categorize(name, cmdline, root, known)
        assert got == want, (name, cmdline, got, want)

    # One core busy until t=4, then idle: the first 5 s span under 0.1 cores is 4..9.
    q = Quiet(secs=5, cores=0.1)
    first = next((t, f) for t in (i * 0.5 for i in range(40)) if (f := q.add(t, min(t, 4.0))) is not None)
    assert first == (9.0, 4.0), first
    assert q.add(9.0, 6.0) is None  # busy again

    # LSP first seen at 3 after a quiet 0..3: that early quiet must not count.
    g = OpenGate(True)
    assert g.update(3.0, 0.0, True) is None
    assert g.update(8.0, 3.0, True) == 3.0  # quiet window began at the LSP's appearance
    g = OpenGate(True)
    assert g.update(1.0, None, False) is None
    assert g.update(6.0, 1.0, False) is None  # quiet but no LSP
    assert g.update(7.0, 2.0, True) is None  # first seen at 7, quiet began earlier
    assert g.update(12.0, 7.0, True) == 7.0
    g = OpenGate(True)
    assert g.update(1.0, None, True) is None
    assert g.update(2.0, 0.0, False) is None and g.lsp_s is None  # exited: forgotten
    assert OpenGate(False).update(5.0, 0.0, False) == 0.0

    base = {"label": "a", "app": "x", PRIMARY: 1, "markers_first_s": {}, "markers_last_s": {}}
    fake = App.__new__(App)
    fake.name, fake.key, fake.markers, fake.install_dir = "X", "x", {}, None
    meta = {"project": "p", "os": "o", "cpu": "c", "cores": 1, "ram_gb": 1, "mode": "m", "runs": 1, "date": "d"}
    for bad in ({"opener_exit_code": 1}, {"opener_killed": True}):
        assert "open_file command failed" in report([fake], [{**base, **bad}], meta)
    assert "open_file command failed" not in report([fake], [{**base, "opener_exit_code": 0}], meta)

    rows = [
        {"pid": 1, "name": "openidea", "cat": "main", "rss": 100 * MB, "uss": 80 * MB},
        {"pid": 2, "name": "java", "cat": "lsp:jdtls", "rss": 600 * MB, "uss": None},
        {"pid": 3, "name": "java", "cat": "lsp:jdtls", "rss": 50 * MB, "uss": 40 * MB},
    ]
    m = summarize_memory(rows)
    assert m["procs"] == 3 and m["rss_mb"] == 750 and m["uss_mb"] is None and m["uss_missing"] == 1, m
    assert m["by_category"]["main"] == {"n": 1, "rss_mb": 100.0, "uss_mb": 80.0}, m
    assert m["by_category"]["lsp:jdtls"] == {"n": 2, "rss_mb": 650.0, "uss_mb": None}, m
    assert "footprint_mb" not in m

    if OS == "macos":
        fp = footprint(os.getpid())
        assert fp and 1 * MB < fp < 64 * 1024 * MB, fp
    print("self-test ok")


def main():
    if "--self-test" in sys.argv[1:]:
        self_test()
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path, help="project directory every app opens")
    ap.add_argument("--self-test", action="store_true", help="check the pure helpers and exit (no project needed)")
    ap.add_argument("--config", type=Path, default=HERE / "apps.toml")
    ap.add_argument("--apps", help="comma-separated keys from the config (default: all)")
    ap.add_argument("--runs", type=int, default=5, help="measured runs per app (default 5)")
    ap.add_argument("--warmup", type=int, default=1, help="discarded runs per app first (default 1)")
    ap.add_argument("--wipe-caches", action="store_true", help="delete each app's cache_dirs before every run (cold index)")
    ap.add_argument("--drop-os-cache", metavar="CMD", help="shell command run before every run to drop the OS file cache")
    ap.add_argument("--quiet-secs", type=float, default=5, help="CPU must stay low this long to count as ready")
    ap.add_argument("--quiet-cores", type=float, default=0.1, help="'low' = below this many cores busy (default 0.1)")
    ap.add_argument("--idle-secs", type=float, default=30, help="idle period measured after ready")
    ap.add_argument("--timeout", type=float, default=900, help="give up waiting for ready after this many seconds")
    ap.add_argument(
        "--open-file",
        help="file (relative to the project) to open after ready; default: the project's open_file in the config",
    )
    ap.add_argument("--no-open-file", action="store_true", help="skip the open_file step (samples exclude language servers)")
    ap.add_argument(
        "--open-timeout", type=float, default=600, help="give up waiting after open_file after this many seconds"
    )
    ap.add_argument("--close-timeout", type=float, default=60)
    ap.add_argument("--cooldown", type=float, default=5, help="pause before each launch")
    ap.add_argument("--out", type=Path, default=HERE / "results")
    ap.add_argument("--yes", action="store_true", help="don't ask before wiping caches")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    project = args.project.resolve()
    if not project.is_dir():
        raise SystemExit(f"not a directory: {project}")
    config = tomllib.loads(args.config.read_text(encoding="utf-8"))
    open_rel = None
    if not args.no_open_file:
        open_rel = args.open_file or config.get("projects", {}).get(project.name, {}).get("open_file")
    open_path = None
    if open_rel:
        open_path = (project / open_rel).resolve()
        if not open_path.is_file():
            raise SystemExit(f"open_file is not a file: {open_path}")
    if args.apps:
        keys = args.apps.split(",")
    else:
        # Entries without a command for this platform (e.g. the macOS-only fork app) are skipped.
        keys = [k for k, raw in config["apps"].items() if per_os(raw.get("command"))]
        skipped = [k for k in config["apps"] if k not in keys]
        if skipped:
            print(f"Skipping apps with no command for {OS}: {', '.join(skipped)}")
    apps = [App(k, config["apps"][k], project, open_path) for k in keys]

    if args.wipe_caches:
        targets = [p for a in apps for p in a.cache_paths()]
        for p in targets:
            if len(p.resolve().parts) < 4 or p.resolve() == Path.home():
                raise SystemExit(f"refusing to wipe a top-level path: {p}")
        print("Before every run these will be deleted:\n  " + "\n  ".join(map(str, targets)))
        if targets and not args.yes and input("Continue? [y/N] ").strip().lower() != "y":
            return

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = args.out / f"{stamp}-{project.name}"
    out_dir.mkdir(parents=True)
    mode = "cold index" if args.wipe_caches else "warm"
    if args.drop_os_cache:
        mode += " + cold OS cache"
    meta = {
        "project": str(project),
        "os": f"{platform.system()} {platform.release()}",
        "cpu": platform.processor() or platform.machine(),
        "cores": psutil.cpu_count(logical=True),
        "ram_gb": psutil.virtual_memory().total / 1024**3,
        "mode": mode,
        "open_file": open_rel,
        "memory_metric": PRIMARY,
        "runs": args.runs,
        "date": stamp,
        "commands": {a.key: a.command for a in apps},
        "open_commands": {a.key: a.open_command for a in apps if a.open_command},
        "args": {k: str(v) for k, v in vars(args).items()},
    }

    runs: list[dict] = []
    total = args.warmup + args.runs
    for i in range(total):
        # Rotate the order so neither app always runs right after the other.
        order = apps[i % len(apps) :] + apps[: i % len(apps)]
        for app in order:
            warm = i < args.warmup
            label = f"{app.key}-{'warmup' if warm else 'run'}{i + 1 if warm else i - args.warmup + 1}"
            print(f"[{label}] launching…", flush=True)
            r = run_once(app, args, out_dir, label)
            opened = f"language server {fmt(r.get('lsp_s'))} s after open · " if app.open_file else ""
            print(
                f"[{label}] window {fmt(r['window_s'])} s · ready {fmt(r['ready_s'])} s · {opened}"
                f"{MEMORY_TITLES[PRIMARY]} {fmt(r.get(PRIMARY))} MB · idle CPU {r['idle_cpu_pct']:.1f}%",
                flush=True,
            )
            if not warm:
                runs.append(r)
            (out_dir / "results.json").write_text(json.dumps({"meta": meta, "runs": runs}, indent=2), encoding="utf-8")

    text = report(apps, runs, meta)
    (out_dir / "report.md").write_text(text, encoding="utf-8")
    print("\n" + text)
    print(f"Raw results: {out_dir / 'results.json'}")


if __name__ == "__main__":
    main()
