#!/usr/bin/env python3
"""Tests for rebase-audit.py against small git repos: python3 scripts/fork/test_rebase_audit.py"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("rebase-audit.py").resolve()
ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
}

UI = "\n".join(f"ui line {i}" for i in range(20)) + "\n"
CORE = "\n".join(f"core line {i}" for i in range(20)) + "\n"
CORE_FEATURE = [f"fn fork_core_{c}() {{}}" for c in "abcdefghij"]


class Repo:
    def __init__(self, path):
        self.path = path

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.path, env=ENV, check=True, capture_output=True, text=True).stdout.strip()

    def write(self, name, text):
        p = pathlib.Path(self.path, name)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def read(self, name):
        return pathlib.Path(self.path, name).read_text()

    def insert(self, name, after, lines):
        text = self.read(name).replace(after + "\n", after + "\n" + "".join(f"{l}\n" for l in lines), 1)
        self.write(name, text)

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def audit(self, *revs, json_out=False):
        args = [sys.executable, str(SCRIPT)]
        for name, rev in zip(("--old-base", "--old-tip", "--new-base", "--new-tip"), revs):
            args += [name, rev]
        if json_out:
            args.append("--json")
        return subprocess.run(args, cwd=self.path, env=ENV, capture_output=True, text=True)


class RebaseAudit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        r = self.r = Repo(self.tmp.name)
        r.git("init", "-q", "-b", "main")
        r.write("ui.ts", UI)
        r.write("core.rs", CORE)
        r.write("Cargo.lock", "lock 1\n")
        self.old_base = r.commit("upstream v1")

        r.insert("ui.ts", "ui line 10", ["fork ui feature();", "}"])
        r.commit("fork: ui feature")
        r.insert("core.rs", "core line 5", CORE_FEATURE)
        r.write("Cargo.lock", "lock 1\nfork crate\n")
        r.commit("fork: core feature")
        r.insert("ui.ts", "ui line 15", ["upstream fixed this();"])
        r.commit("fork: fix upstream bug")
        self.old_tip = r.git("rev-parse", "HEAD")

        # Upstream v2: changes context near the fork's ui hunk, splits core.rs, takes the fork's fix.
        r.git("checkout", "-q", "-b", "upstream", self.old_base)
        r.write("ui.ts", UI.replace("ui line 9\n", "ui line 9 changed\n").replace("ui line 15\n", "ui line 15\nupstream fixed this();\n"))
        r.write("core.rs", "\n".join(f"core line {i}" for i in range(3)) + "\n")
        r.write("core/split.rs", "\n".join(f"core line {i}" for i in range(3, 20)) + "\n")
        r.write("Cargo.lock", "lock 2\n")
        self.new_base = r.commit("upstream v2")

    def tearDown(self):
        self.tmp.cleanup()

    def rebased(self, keep_core_b=True):
        r = self.r
        r.git("checkout", "-q", "-b", f"rebased-{keep_core_b}", self.new_base)
        r.insert("ui.ts", "ui line 10", ["fork ui feature();", "}"])
        r.commit("fork: ui feature")
        lines = [l for l in CORE_FEATURE if keep_core_b or l != "fn fork_core_b() {}"]
        r.insert("core/split.rs", "core line 5", lines)
        r.write("Cargo.lock", "lock 2\nfork crate\n")
        r.commit("fork: core feature")
        return r.git("rev-parse", "HEAD")

    def test_maps_commits_and_finds_the_lost_line(self):
        new_tip = self.rebased(keep_core_b=False)
        r = self.r
        r.write("extra.ts", "export const added = 1;\n")
        new_tip = r.commit("fork: fix after the rebase")
        out = r.audit(self.old_base, self.old_tip, self.new_base, new_tip, json_out=True)
        self.assertEqual(out.returncode, 1, out.stderr)
        result = json.loads(out.stdout)
        rd = result["range_diff"]
        self.assertEqual(rd["counts"], {"=": 0, "!": 2, "<": 1, ">": 1})
        self.assertEqual([p["subject"] for p in rd["context_only"]], ["fork: ui feature"])
        [changed] = rd["changed"]
        self.assertEqual(changed["subject"], "fork: core feature")
        self.assertIn("core/split.rs", changed["files"])
        self.assertIn("+fn fork_core_b() {}", changed["only_old"])
        self.assertEqual([p["subject"] for p in rd["dropped"]], ["fork: fix upstream bug"])
        self.assertEqual([p["subject"] for p in rd["added"]], ["fork: fix after the rebase"])
        # The moved line, the line upstream took, the lone brace and Cargo.lock are not residual.
        self.assertEqual(result["residual"], {"core.rs": ["fn fork_core_b() {}"]})

    def test_markdown_report(self):
        new_tip = self.rebased(keep_core_b=False)
        out = self.r.audit(self.old_base, self.old_tip, self.new_base, new_tip)
        self.assertEqual(out.returncode, 1, out.stderr)
        self.assertIn("- `<` dropped: 1", out.stdout)
        self.assertIn("### Residual: 1 line(s) in 1 file(s)", out.stdout)
        self.assertIn("<code>core.rs</code>", out.stdout)

    def test_clean_rebase_exits_zero(self):
        r = self.r
        new_tip = self.rebased()
        r.git("checkout", "-q", "-b", "old-without-fix", self.old_tip + "~1")
        out = r.audit(self.old_base, "old-without-fix", self.new_base, new_tip)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("### Residual: 0 line(s)", out.stdout)

    def test_bad_revision_exits_two(self):
        out = self.r.audit(self.old_base, "no-such-rev", self.new_base, self.new_base)
        self.assertEqual(out.returncode, 2)
        self.assertIn("no-such-rev", out.stderr)

    def test_missing_argument_exits_two(self):
        out = self.r.audit(self.old_base)
        self.assertEqual(out.returncode, 2)


if __name__ == "__main__":
    unittest.main()
