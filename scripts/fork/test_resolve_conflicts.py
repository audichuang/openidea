#!/usr/bin/env python3
"""Regression tests for resolve-conflicts.py's locale mode: python3 scripts/fork/test_resolve_conflicts.py"""
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


class Locale(unittest.TestCase):
    def test_keeps_a_duplicate_upstream_already_has(self):
        merged = locale(UPSTREAM_DUP)
        self.assertIn('"B": "乙"', merged)
        self.assertIn('"C": "丙"', merged)

    def test_refuses_a_duplicate_the_merge_adds(self):
        added = UPSTREAM_DUP.replace('  "C": "丙",\n', '  "A": "甲",\n')
        with self.assertRaises(SystemExit) as e:
            locale(added)
        self.assertIn("'A'", str(e.exception))


if __name__ == "__main__":
    unittest.main()
