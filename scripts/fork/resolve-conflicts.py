#!/usr/bin/env python3
"""Resolve the fork's mechanical rebase conflicts; exit 1 (file untouched) on anything else.

Usage: resolve-conflicts.py locale|append|imports <file>...

Run during a rebase; it re-creates each file's conflict in diff3 form first. Sides: "ours" is
the new upstream base, "theirs" is the fork commit being replayed.

locale  flat locale JSON (src/platform/locales/**.json): keep upstream's side and add the keys
        the fork commit adds. Mechanical only when the fork side neither changes nor removes a
        key that existed before, and no key the fork adds got a different string upstream. A key
        upstream also added with the identical string, anywhere in the file, keeps upstream's copy.
append  both sides appended at the same spot (tests at the end of a file): upstream's lines,
        then the fork's. Mechanical only when every conflict hunk has an empty base.
imports both sides edited the same block of one-line import/use statements (an import added next
        to one the other side changed): apply both sides' line edits to the base. Mechanical only
        when every line of every hunk is a whole one-line TS/JS `import` or Rust `use`, no base
        line is edited by both sides (unless identically), and no name ends up imported twice.
"""
import collections
import difflib
import json
import re
import subprocess
import sys

ENTRY = re.compile(r'^\s*("(?:[^"\\]|\\.)*")\s*:\s*(.*?),?\s*$')
TS_IMPORT = re.compile(r"""^import\s+(?:(.+?)\s+from\s+)?["'][^"']+["'];$""")
RUST_USE = re.compile(r"^(?:pub(?:\([\w:]+\))?\s+)?use\s+([\w:*]+?)(?:::\{([^{}]*)\}|\s+as\s+(\w+))?;$")


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
    upstream = "\n".join(line for part in parts for line in ([part] if isinstance(part, str) else part[0]))
    # Every string upstream's side has per key, anywhere in the file: upstream may add a key the
    # fork also adds at another spot (v0.1.47's l0ng-ai/openidea#3765 and the fork's e1ca24d3c).
    upstream_lines = {}
    for line in upstream.split("\n"):
        m = ENTRY.match(line)
        if m:
            upstream_lines.setdefault(json.loads(m.group(1)), set()).add(line.strip().rstrip(","))
    out = []
    for part in parts:
        if isinstance(part, str):
            out.append(part)
            continue
        ours, base, theirs = (entries(b, path) for b in part)
        for key, line in base.items():
            if theirs.get(key) != line:
                raise SystemExit(f"{path}: the fork changes or removes upstream key {key!r}")
        added = {key: line for key, line in theirs.items() if key not in base}
        for key, line in added.items():
            if key in upstream_lines and upstream_lines[key] != {line.strip()}:
                raise SystemExit(f"{path}: key {key!r} has a different string upstream")
        # A key upstream already has with the same string keeps upstream's copy only.
        merged = list(ours.values()) + [line for key, line in added.items() if key not in upstream_lines]
        out.extend("  " + line.strip() for line in merged)
    # Every entry except the one before the closing brace carries a comma.
    for j, line in enumerate(out):
        if ENTRY.match(line):
            nxt = next((k for k in range(j + 1, len(out)) if out[k].strip()), None)
            closing = nxt is not None and out[nxt].strip().startswith("}")
            out[j] = line.rstrip().rstrip(",") + ("" if closing else ",")
    text = "\n".join(out)
    # Upstream's own file may already repeat a key (v0.1.40's zh.json does); only a duplicate the
    # merge adds is refused.
    before, after = key_counts(upstream), key_counts(text)
    added = sorted(k for k, n in after.items() if n > 1 and n > before.get(k, 0))
    if added:
        raise SystemExit(f"{path}: duplicate keys after the merge: {', '.join(map(repr, added))}")
    return text


def key_counts(text):
    """How often each key appears, per JSON object, summed over the file."""
    counts = {}

    def count(pairs):
        for key, _ in pairs:
            counts[key] = counts.get(key, 0) + 1
        return dict(pairs)

    json.loads(text, object_pairs_hook=count)
    return counts


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


def imported_names(line):
    """Names a one-line import/use statement binds, or None when it is not one."""
    line = line.strip()
    m = TS_IMPORT.match(line)
    if m:
        clause = re.sub(r"^type\s+", "", m.group(1) or "")
        names = []
        braced = re.search(r"\{([^{}]*)\}", clause)
        if braced:
            items = [re.sub(r"^type\s+", "", item.strip()) for item in braced.group(1).split(",")]
            names += [item.split(" as ")[-1].strip() for item in items if item]
            clause = clause.replace(braced.group(0), "")
        names += [part.strip().split(" as ")[-1].strip() for part in clause.split(",") if part.strip()]
        return names
    m = RUST_USE.match(line)
    if m:
        path, group, alias = m.groups()
        last = path.split("::")[-1]
        if alias:
            return [alias]
        if group is None:
            return [] if last == "*" else [last]
        names = []
        for item in (i.strip() for i in group.split(",")):
            if item and item != "*":
                name = item.split(" as ")[-1].strip().split("::")[-1]
                names.append(last if name == "self" else name)
        return names
    return None


def three_way(base, ours, theirs):
    """Apply both sides' line edits to base; None when they touch the same base lines differently."""
    edits = []
    for side, other in enumerate((ours, theirs)):
        matcher = difflib.SequenceMatcher(None, base, other, autojunk=False)
        edits += [(i1, i2, side, other[j1:j2]) for tag, i1, i2, j1, j2 in matcher.get_opcodes() if tag != "equal"]
    # At one base position: insertions before replacements, upstream's before the fork's.
    edits.sort(key=lambda e: (e[0], e[1] != e[0], e[2]))
    out, pos, prev = [], 0, None
    for i1, i2, side, lines in edits:
        if prev is not None and (prev[0], prev[1], prev[3]) == (i1, i2, lines):
            continue  # both sides made the same edit
        if i1 < pos:
            return None
        out += base[pos:i1] + lines
        pos, prev = max(pos, i2), (i1, i2, side, lines)
    return out + base[pos:]


def resolve_imports(path, parts):
    out = []
    for part in parts:
        if isinstance(part, str):
            out.append(part)
            continue
        for line in (line for side in part for line in side if line.strip()):
            if imported_names(line) is None:
                raise SystemExit(f"{path}: not a one-line import/use statement in a conflict: {line.strip()}")
        ours, base, theirs = part
        merged = three_way(base, ours, theirs)
        if merged is None:
            raise SystemExit(f"{path}: both sides edit the same import line differently")
        out.extend(merged)

    def counts(lines):
        found = collections.Counter()
        for line in lines:
            found.update(imported_names(line) or [])
        return found

    # Only a name the merge imports twice is refused, not one upstream's own file already repeats.
    before = counts(line for part in parts for line in ([part] if isinstance(part, str) else part[0]))
    twice = sorted(name for name, n in counts(out).items() if n > 1 and n > before.get(name, 0))
    if twice:
        raise SystemExit(f"{path}: imported twice after the merge: {', '.join(twice)}")
    return "\n".join(out)


RESOLVERS = {"locale": resolve_locale, "append": resolve_append, "imports": resolve_imports}


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in RESOLVERS:
        raise SystemExit(__doc__)
    mode, paths = sys.argv[1], sys.argv[2:]
    resolved = {}
    for path in paths:
        subprocess.run(["git", "checkout", "--conflict=diff3", "--", path], check=True, capture_output=True)
        with open(path, encoding="utf-8") as f:
            parts = hunks(f.read())
        if not any(isinstance(p, tuple) for p in parts):
            raise SystemExit(f"{path}: no conflict markers")
        resolved[path] = RESOLVERS[mode](path, parts)
    # Write only after every file resolved, so a refusal leaves the whole set as it was.
    for path, text in resolved.items():
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"resolved {path} ({mode})")


if __name__ == "__main__":
    main()
