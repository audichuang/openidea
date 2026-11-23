"""Reveal a file from the Changes view (real double-click) and record where the all-in-one diff lands.
Needs vcs.commit.doubleClickOpensDiff on and the all-in-one view on (see the features page).
Usage: reveal.py <tag> <file>...   e.g. reveal.py after m100 m200   ->  reveal.jsonl"""
import sys, t, lib, time, subprocess, rowpt
CLOSE = """return (async () => { const ed = (await import('/src/workbench/contributions.ts')).editorService();
const a = ed.activeInput?.(); if (a && a.kind === 'combined-diff') await ed.closeInput(a.key);
return document.querySelectorAll('[data-combined-scroll]').length })()"""
LAYOUT = """const s=document.querySelector('[data-combined-scroll]'); if(!s) return null; return [...s.querySelectorAll('[data-index]')].map(e=>[+e.dataset.index, e.querySelector('[data-combined-block]').dataset.combinedBlock.split('/').pop(), Math.round(e.getBoundingClientRect().top-s.getBoundingClientRect().top)])"""
def reveal(name, tag):
    if not name.endswith(".txt"): name += ".txt"
    t.jsw(CLOSE); time.sleep(1.5)
    x, y = lib.screen_point(t.T, *rowpt.row_point(name))
    lib.focus(t.T); subprocess.run(["cliclick", f"dc:{int(x)},{int(y)}"])
    res = {"tag": tag, "target": name}
    for s in (1, 3, 6):
        time.sleep(s - (0 if s == 1 else {3: 1, 6: 3}[s]))
        p = t.probe(); res[f"t{s}"] = {"hdr": p and p["hdr"], "a": p and p["a"], "top": p and p["top"]}
    lay = t.jsw(LAYOUT)
    res["target_top_px"] = next((r[2] for r in lay if r[1] == name), "unmounted") if lay else None
    res["ok"] = res["t6"]["hdr"] == name
    res["shot"] = t.shot(f"{tag}-reveal-{name}")
    t.log("reveal", res)
if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] in ("-h", "--help"): sys.exit(__doc__)
    for n in sys.argv[2:]: reveal(n, sys.argv[1])
