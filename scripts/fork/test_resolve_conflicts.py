#!/usr/bin/env python3
"""Regression tests for resolve-conflicts.py: python3 scripts/fork/test_resolve_conflicts.py"""
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location(
    "resolve_conflicts", pathlib.Path(__file__).with_name("resolve-conflicts.py")
)
rc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rc)


def locale(text):
    return rc.resolve_locale("zh.json", rc.hunks(text))


# Upstream (ours) repeats "Go" outside the conflict, as v0.1.40's zh.json does.
UPSTREAM_DUP = """{
  "Go": "Go",
  "A": "甲",
<<<<<<< ours
  "B": "乙",
||||||| base
=======
  "C": "丙",
>>>>>>> theirs
  "Go": "Go"
}"""


# v0.1.47: upstream's l0ng-ai/openidea#3765 added "menu.navigate.relatedSymbol" near the other
# navigate keys while the fork's e1ca24d3c added it, with the same string, next to its own keys.
SAME_KEY_ELSEWHERE = """{
  "menu.navigate.related": "Related",
  "menu.navigate.relatedSymbol": "相关符号…",
  "menu.editor.unsplitAll": "全部取消拆分",
<<<<<<< ours
  "menu.navigate.showFilePath": "文件路径",
||||||| base
=======
  "menu.navigate.showFilePath": "文件路径",
  "menu.navigate.customRegion": "自定义折叠…",
  "menu.navigate.relatedSymbol": "相关符号…",
>>>>>>> theirs
  "menu.code.showErrorDescription": "错误描述"
}"""


class Locale(unittest.TestCase):
    def test_keeps_upstream_copy_of_a_key_both_add_with_the_same_string(self):
        merged = locale(SAME_KEY_ELSEWHERE)
        self.assertEqual(merged.count('"menu.navigate.relatedSymbol"'), 1)
        self.assertLess(merged.index("relatedSymbol"), merged.index("unsplitAll"))
        self.assertIn('"menu.navigate.customRegion": "自定义折叠…",', merged)
        self.assertEqual(merged.count('"menu.navigate.showFilePath"'), 1)

    def test_refuses_a_key_both_add_with_different_strings(self):
        differs = SAME_KEY_ELSEWHERE.replace('"相关符号…",\n>>>', '"相关符号",\n>>>')
        with self.assertRaises(SystemExit) as e:
            locale(differs)
        self.assertIn("different string upstream", str(e.exception))


    def test_keeps_a_duplicate_upstream_already_has(self):
        merged = locale(UPSTREAM_DUP)
        self.assertIn('"B": "乙"', merged)
        self.assertIn('"C": "丙"', merged)

    def test_drops_a_fork_key_upstream_already_has_outside_the_hunk(self):
        added = UPSTREAM_DUP.replace('  "C": "丙",\n', '  "A": "甲",\n')
        self.assertEqual(locale(added).count('"A"'), 1)

    def test_refuses_a_fork_key_upstream_has_outside_the_hunk_with_another_string(self):
        added = UPSTREAM_DUP.replace('  "C": "丙",\n', '  "A": "乙",\n')
        with self.assertRaises(SystemExit) as e:
            locale(added)
        self.assertIn("'A'", str(e.exception))


def imports(text):
    return rc.resolve_imports("f", rc.hunks(text))


# v0.1.47, 12b207995 replayed: upstream extended a `use`, the fork added one above it.
HISTORY_RS = """//! Commit history (topological walk) and per-commit changed files via gitoxide.

<<<<<<< ours
use crate::repo::{gx, link_target, resolve, to_string};
||||||| base
use crate::repo::{gx, resolve, to_string};
=======
use crate::log_index::LogIndex;
use crate::repo::{gx, resolve, to_string};
>>>>>>> theirs
use crate::{ChangeKind, ChangedFile, Commit, LogOrder, LogQuery, Repo, RevisionChange};"""

# v0.1.47, b84111453 replayed: upstream added an import above one the fork extended.
OPS_TS = """import { tx } from "@/platform/i18n";
<<<<<<< ours
import { AnsiStream, stripAnsi, type Span } from "@/ui/ansi";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
||||||| base
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
=======
import { call, commands, isCancelled, nextRequestId, type DocId } from "@/platform/ipc";
import { ipcBackend } from "@/editor/core/backend";
>>>>>>> theirs
import { attachDocument, editorsFor } from "@/editor/api";"""

# v0.1.47, 0fd62c6b5 replayed: both sides rewrapped the same `pub use` into a multi-line list.
LINUX_WINDOW_STATE_RS = """#[cfg(target_os = "linux")]
<<<<<<< ours
pub use runtime::{
    content_size, decoration_layout, is_wayland, normal_size_requested, plugin, prepare, save_before_close,
};
||||||| base
pub use runtime::{content_size, is_wayland, normal_size_requested, plugin, prepare, save_before_close};
=======
pub use runtime::{
    content_size, frame_inherited, is_wayland, normal_size_requested, plugin, prepare, save_before_close,
};
>>>>>>> theirs
"""


class Imports(unittest.TestCase):
    def test_keeps_the_fork_use_above_upstream_changed_one(self):
        self.assertEqual(
            imports(HISTORY_RS).split("\n")[2:5],
            [
                "use crate::log_index::LogIndex;",
                "use crate::repo::{gx, link_target, resolve, to_string};",
                "use crate::{ChangeKind, ChangedFile, Commit, LogOrder, LogQuery, Repo, RevisionChange};",
            ],
        )

    def test_keeps_upstream_import_and_the_fork_extended_one(self):
        self.assertEqual(
            imports(OPS_TS).split("\n"),
            [
                'import { tx } from "@/platform/i18n";',
                'import { AnsiStream, stripAnsi, type Span } from "@/ui/ansi";',
                'import { call, commands, isCancelled, nextRequestId, type DocId } from "@/platform/ipc";',
                'import { ipcBackend } from "@/editor/core/backend";',
                'import { attachDocument, editorsFor } from "@/editor/api";',
            ],
        )

    def test_refuses_a_multi_line_import(self):
        with self.assertRaises(SystemExit) as e:
            imports(LINUX_WINDOW_STATE_RS)
        self.assertIn("not a one-line import", str(e.exception))

    def test_refuses_when_both_sides_change_the_same_import(self):
        both = OPS_TS.replace(
            'import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";\n|||',
            'import { call, commands, isCancelled } from "@/platform/ipc";\n|||',
        )
        with self.assertRaises(SystemExit) as e:
            imports(both)
        self.assertIn("same import line", str(e.exception))

    def test_refuses_a_name_both_sides_import(self):
        twice = HISTORY_RS.replace("use crate::log_index::LogIndex;", "use crate::index::link_target;")
        with self.assertRaises(SystemExit) as e:
            imports(twice)
        self.assertIn("link_target", str(e.exception))


if __name__ == "__main__":
    unittest.main()
