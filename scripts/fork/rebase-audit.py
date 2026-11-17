#!/usr/bin/env python3
"""Audit a rebase of the fork onto a new upstream base: report what may have been lost.

Usage: rebase-audit.py --old-base <rev> --old-tip <rev> --new-base <rev> --new-tip <rev> [--json]

Run inside the repo. old-base..old-tip is the fork before the rebase, new-base..new-tip after it.

1. Commit mapping (git range-diff): counts of `=` (same patch), `!` (patch changed), `<` (old
   commit with no match, dropped) and `>` (new commit with no match, added). A `!` pair whose own
   +/- lines are identical changed only in context; the others are listed with the files whose
   +/- lines differ.
2. Residual: lines the fork added in the old delta (old-base -> old-tip) that are neither added in
   the new delta (new-base -> new-tip) nor present in any file of the new base (upstream took
   them). Lines are compared as a whitespace-normalized multiset across all files, so a hunk that
   moved to another file (upstream split a file) still matches. Trivial lines (blank, lone
   brackets, comment markers) and generated files are ignored.

The script reports, it does not judge: a finding is something to look at, not necessarily a bug.
Exit code: 0 nothing to review, 1 findings to review, 2 usage or git error.
"""
import argparse
import collections
import json
import re
import subprocess
import sys

GENERATED = {"Cargo.lock", "pnpm-lock.yaml", "src/bindings.ts"}
RANGE_LINE = re.compile(r"^\s*(?:\d+|-+):\s+([0-9a-f]+|-+)\s+([=!<>])\s+(?:\d+|-+):\s+([0-9a-f]+|-+)\s?(.*)$")
TRIVIAL_CHARS = re.compile(r"^[{}\[\]();,]*$")
LINES_SHOWN = 10
COMMENT_MARKERS = {"//", "/*", "*/", "*", "#", "--", "<!--", "-->", "///", "//!", "/**"}


class GitError(Exception):
    pass


def git(*args):
    proc = subprocess.run(["git", *args], capture_output=True)
    if proc.returncode != 0:
        raise GitError(f"git {' '.join(args)}: {proc.stderr.decode('utf-8', 'replace').strip()}")
    return proc.stdout.decode("utf-8", "replace")


def normalize(line):
    return " ".join(line.split())


def trivial(norm):
    return not norm or bool(TRIVIAL_CHARS.match(norm)) or norm in COMMENT_MARKERS


def changed_lines(diff):
    """Map each file of a unified diff to its +/- lines in order (headers excluded)."""
    files, current, old_path = {}, None, None
    for line in diff.split("\n"):
        if line.startswith("diff --git "):
            current, old_path = None, None
        elif line.startswith("--- ") and current is None:
            old_path = line[4:]
        elif line.startswith("+++ ") and current is None:
            new_path = line[4:]
            path = old_path if new_path == "/dev/null" else new_path
            current = path[2:] if path[:2] in ("a/", "b/") else path
            files.setdefault(current, [])
        elif current is not None and line[:1] in ("+", "-"):
            files[current].append(line)
    return files


def added_lines(diff):
    """Map each file to the lines it adds (without the leading +)."""
    return {
        path: [line[1:] for line in lines if line.startswith("+")]
        for path, lines in changed_lines(diff).items()
    }


def range_diff(old_base, old_tip, new_base, new_tip):
    out = git("range-diff", "--no-color", "-s", f"{old_base}..{old_tip}", f"{new_base}..{new_tip}")
    pairs = []
    for line in out.splitlines():
        m = RANGE_LINE.match(line)
        if m:
            old, status, new, subject = m.groups()
            pairs.append({
                "status": status,
                "old": None if old.startswith("-") else old,
                "new": None if new.startswith("-") else new,
                "subject": subject,
            })
    return pairs


def commit_changes(sha):
    return changed_lines(git("show", "--no-color", "--no-ext-diff", "--format=", sha))


def compare_changed(pair):
    """Files whose +/- lines differ between the two commits, and the lines only one side has.

    The pair changed only in context when neither side has a +/- line the other lacks, counted
    over all files: a hunk that moved to another file (upstream split a file) is the same change.
    """
    old, new = commit_changes(pair["old"]), commit_changes(pair["new"])
    files = sorted(path for path in set(old) | set(new) if old.get(path, []) != new.get(path, []))
    return files, only_in(old, new), only_in(new, old)


def only_in(a, b):
    """a's +/- lines (in order) that b lacks, counted as a multiset over all files."""
    extra = collections.Counter(line for lines in a.values() for line in lines)
    extra -= collections.Counter(line for lines in b.values() for line in lines)
    out = []
    for path in sorted(a):
        for line in a[path]:
            if extra[line] > 0:
                extra[line] -= 1
                out.append(line)
    return out


def tree_lines(rev):
    """Normalized lines of every text file in rev's tree."""
    paths = [p for p in git("ls-tree", "-r", "-z", "--name-only", rev).split("\0") if p]
    proc = subprocess.run(
        ["git", "cat-file", "--batch"],
        input="".join(f"{rev}:{p}\n" for p in paths).encode("utf-8"),
        capture_output=True,
    )
    if proc.returncode != 0:
        raise GitError(f"git cat-file --batch: {proc.stderr.decode('utf-8', 'replace').strip()}")
    data, pos, seen = proc.stdout, 0, set()
    while pos < len(data):
        end = data.index(b"\n", pos)
        header = data[pos:end].split()
        pos = end + 1
        if len(header) < 3 or header[1] == b"missing":
            continue
        size = int(header[2])
        blob = data[pos:pos + size]
        pos += size + 1
        if header[1] != b"blob" or b"\0" in blob[:8000]:
            continue
        for raw in blob.decode("utf-8", "replace").split("\n"):
            seen.add(normalize(raw))
    return seen


def residual(old_base, old_tip, new_base, new_tip):
    diff_args = ["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U0"]
    old_added = {p: ls for p, ls in added_lines(git(*diff_args, old_base, old_tip)).items() if p not in GENERATED}
    new_added = collections.Counter(
        normalize(line) for p, ls in added_lines(git(*diff_args, new_base, new_tip)).items()
        if p not in GENERATED for line in ls
    )
    missing = collections.Counter()
    for lines in old_added.values():
        for line in lines:
            norm = normalize(line)
            if not trivial(norm):
                missing[norm] += 1
    missing -= new_added
    if missing:
        in_base = tree_lines(new_base)
        missing = collections.Counter({k: n for k, n in missing.items() if k not in in_base})
    groups = {}
    for path in sorted(old_added):
        for line in old_added[path]:
            norm = normalize(line)
            if missing.get(norm, 0) > 0:
                missing[norm] -= 1
                groups.setdefault(path, []).append(line)
    return groups


def report_markdown(result):
    rd, res = result["range_diff"], result["residual"]
    c = rd["counts"]
    out = [
        "## Rebase audit",
        "",
        f"`{result['old_base'][:12]}..{result['old_tip'][:12]}` → `{result['new_base'][:12]}..{result['new_tip'][:12]}`",
        "",
        "### Commit mapping (range-diff)",
        "",
        f"- `=` same patch: {c['=']}",
        f"- `!` patch changed: {c['!']} ({len(rd['context_only'])} context only, {len(rd['changed'])} with different +/- lines)",
        f"- `<` dropped: {c['<']}",
        f"- `>` added: {c['>']}",
    ]
    if rd["changed"]:
        out += ["", "`!` with different +/- lines:", ""]
        for p in rd["changed"]:
            out.append(f"- `{p['old'][:9]}` → `{p['new'][:9]}` {p['subject']}")
            out += [f"  - `{f}`" for f in p["files"]]
            for label, lines in (("only before the rebase", p["only_old"]), ("only after it", p["only_new"])):
                if lines:
                    more = f", first {LINES_SHOWN}" if len(lines) > LINES_SHOWN else ""
                    out += [f"  - {label} ({len(lines)}{more}):", "    ```diff"]
                    out += [f"    {line}" for line in lines[:LINES_SHOWN]] + ["    ```"]
    if rd["dropped"]:
        out += ["", "Dropped:", ""] + [f"- `{p['old'][:9]}` {p['subject']}" for p in rd["dropped"]]
    if rd["added"]:
        out += ["", "Added:", ""] + [f"- `{p['new'][:9]}` {p['subject']}" for p in rd["added"]]
    total = sum(len(v) for v in res.values())
    out += ["", f"### Residual: {total} line(s) in {len(res)} file(s)", ""]
    if res:
        out.append("Lines the fork added before the rebase that are neither added after it nor in the new base:")
        for path, lines in res.items():
            out += ["", f"<details><summary><code>{path}</code> ({len(lines)})</summary>", "", "```"]
            out += lines
            out += ["```", "", "</details>"]
    else:
        out.append("None.")
    return "\n".join(out)


def audit(old_base, old_tip, new_base, new_tip):
    revs = {name: git("rev-parse", "--verify", f"{rev}^{{commit}}").strip()
            for name, rev in (("old_base", old_base), ("old_tip", old_tip), ("new_base", new_base), ("new_tip", new_tip))}
    pairs = range_diff(revs["old_base"], revs["old_tip"], revs["new_base"], revs["new_tip"])
    counts = collections.Counter(p["status"] for p in pairs)
    context_only, changed = [], []
    for p in pairs:
        if p["status"] == "!":
            files, only_old, only_new = compare_changed(p)
            entry = {**p, "files": files, "only_old": only_old, "only_new": only_new}
            (changed if only_old or only_new else context_only).append(entry)
    return {
        **revs,
        "range_diff": {
            "counts": {s: counts.get(s, 0) for s in "=!<>"},
            "context_only": context_only,
            "changed": changed,
            "dropped": [p for p in pairs if p["status"] == "<"],
            "added": [p for p in pairs if p["status"] == ">"],
        },
        "residual": residual(revs["old_base"], revs["old_tip"], revs["new_base"], revs["new_tip"]),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    for name in ("old-base", "old-tip", "new-base", "new-tip"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--json", action="store_true", help="print JSON instead of Markdown")
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    try:
        result = audit(args.old_base, args.old_tip, args.new_base, args.new_tip)
    except GitError as e:
        print(e, file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2) if args.json else report_markdown(result))
    rd = result["range_diff"]
    return 1 if rd["changed"] or rd["dropped"] or result["residual"] else 0


if __name__ == "__main__":
    sys.exit(main())
