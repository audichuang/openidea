"""Scroll the Changes tree until the row of <file> is shown and print its viewport and screen point.
Usage: rowpt.py <file> [click|dbl]"""
import sys, t, lib, time, json
FIND = """const e=[...document.querySelectorAll('[role=treeitem]')].find(x=>x.textContent.startsWith(%s)); if(!e) return null; const r=e.getBoundingClientRect(); return [r.x+60,r.y+r.height/2]"""
def row_point(name):
    """Viewport point of the Changes row whose text starts with `name` (the tree is virtualized: page through it)."""
    t.jsw("""const row=document.querySelector('[role=treeitem]'); let p=row; while(p&&!(p.scrollHeight>p.clientHeight+5&&getComputedStyle(p).overflowY!='visible')) p=p.parentElement; window.__tsc=p; if(p) p.scrollTop=0; return !!p""")
    for k in range(80):
        r = t.jsw("""const rows=[...document.querySelectorAll('[role=treeitem]')]; const e=rows.find(x=>x.textContent.startsWith(%s));
if(!e) return rows.length; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return [r.x+60,r.y+r.height/2]""" % json.dumps(name))
        if isinstance(r, list): break
        t.jsw("window.__tsc.scrollTop += 400; return 1"); time.sleep(0.3)
    time.sleep(0.5)
    r = t.jsw(FIND % json.dumps(name))
    if not isinstance(r, list): raise RuntimeError(f"no Changes row for {name}")
    return r
if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"): sys.exit(__doc__)
    r = row_point(sys.argv[1]); print(r)
    x, y = lib.screen_point(t.T, *r); print(x, y)
    if len(sys.argv) > 2:
        lib.focus(t.T); lib.click(x, y)
        if sys.argv[2] == "dbl": time.sleep(0.05); lib.click(x, y)
