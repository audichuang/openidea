#!/usr/bin/env python3
"""Resolve the fork's mechanical rebase conflicts; exit 1 (file untouched) on anything else.

Usage: resolve-conflicts.py locale|append <file>...

Run during a rebase; it re-creates each file's conflict in diff3 form first. Sides: "ours" is
the new upstream base, "theirs" is the fork commit being replayed.

locale  flat locale JSON (src/platform/locales/**.json): keep upstream's side and add the keys
        the fork commit adds. Mechanical only when the fork side neither changes nor removes a
        key that existed before, and no key the fork adds got a different string upstream.
append  both sides appended at the same spot (tests at the end of a file): upstream's lines,
        then the fork's. Mechanical only when every conflict hunk has an empty base.
"""
import json
import re
import subprocess
import sys

ENTRY = re.compile(r'^\s*("(?:[^"\\]|\\.)*")\s*:\s*(.*?),?\s*$')


def hunks(text):
    """Split diff3 text into plain line lists and (ours, base, theirs) tuples."""
    lines, out, i = text.split("\n"), [], 0
    while i < len(lines):
        if not lines[i].startswith("<<<<<<<"):
            out.append(lines[i])
            i += 1
            continue
        parts, sect = {"o": [], "b": [], "t": []}, "o"
        i += 1
        while not lines[i].startswith(">>>>>>>"):
            s = lines[i]
            if s.startswith("|||||||"):
                sect = "b"
            elif s.startswith("======="):
                sect = "t"
            else:
                parts[sect].append(s)
            i += 1
        out.append((parts["o"], parts["b"], parts["t"]))
        i += 1
    return out


def entries(block, path):
    result = {}
    for line in block:
        if not line.strip():
            continue
        m = ENTRY.match(line)
        if not m:
            raise SystemExit(f"{path}: not a flat key/value line in a conflict: {line.strip()}")
        result[json.loads(m.group(1))] = line.rstrip().rstrip(",")
    return result


def resolve_locale(path, parts):
    out = []
    for part in parts:
        if isinstance(part, str):
            out.append(part)
            continue
        ours, base, theirs = (entries(b, path) for b in part)
        for key, line in base.items():
            if theirs.get(key) != line:
                raise SystemExit(f"{path}: the fork changes or removes upstream key {key!r}")
        for key, line in theirs.items():
            if key not in base and key in ours and ours[key] != line:
                raise SystemExit(f"{path}: key {key!r} has a different string upstream")
        merged = list(ours.values()) + [line for key, line in theirs.items() if key not in base and key not in ours]
        out.extend("  " + line.strip() for line in merged)
    # Every entry except the one before the closing brace carries a comma.
    for j, line in enumerate(out):
        if ENTRY.match(line):
            nxt = next((k for k in range(j + 1, len(out)) if out[k].strip()), None)
            closing = nxt is not None and out[nxt].strip().startswith("}")
            out[j] = line.rstrip().rstrip(",") + ("" if closing else ",")
    text = "\n".join(out)

    def no_duplicates(pairs):
        keys = [k for k, _ in pairs]
        if len(keys) != len(set(keys)):
            raise SystemExit(f"{path}: duplicate keys after the merge")
        return dict(pairs)

    json.loads(text, object_pairs_hook=no_duplicates)
    return text


def resolve_append(path, parts):
    out = []
    for part in parts:
        if isinstance(part, str):
            out.append(part)
            continue
        ours, base, theirs = part
        if any(line.strip() for line in base):
            raise SystemExit(f"{path}: a conflict hunk edits existing lines, not a pure append")
        out.extend(ours + theirs)
    return "\n".join(out)


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("locale", "append"):
        raise SystemExit(__doc__)
    mode, paths = sys.argv[1], sys.argv[2:]
    resolved = {}
    for path in paths:
        subprocess.run(["git", "checkout", "--conflict=diff3", "--", path], check=True, capture_output=True)
        with open(path, encoding="utf-8") as f:
            parts = hunks(f.read())
        if not any(isinstance(p, tuple) for p in parts):
            raise SystemExit(f"{path}: no conflict markers")
        resolved[path] = (resolve_locale if mode == "locale" else resolve_append)(path, parts)
    # Write only after every file resolved, so a refusal leaves the whole set as it was.
    for path, text in resolved.items():
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"resolved {path} ({mode})")


if __name__ == "__main__":
    main()
