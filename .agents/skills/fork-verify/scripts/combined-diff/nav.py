"""Press the all-in-one diff's Previous File / Next File button <n> times (real clicks); record the block at the top
and its offset after each press (a correct landing is the next block at 8 px).
Usage: nav.py <tag> "Previous File"|"Next File" <n> [setup-js]   ->  nav.jsonl"""
import sys, time, json, t, lib
TOP = """const s=document.querySelector('[data-combined-scroll]'); const r=s.getBoundingClientRect();
const v=[...s.querySelectorAll('[data-index]')].map(e=>[+e.dataset.index, e.querySelector('[data-combined-block]').dataset.combinedBlock.split('/').pop(), Math.round(e.getBoundingClientRect().top-r.top)]);
const at=v.filter(x=>x[2]<=12).pop(); return {at, top:Math.round(s.scrollTop)}"""
BTN = """const b=[...document.querySelectorAll('button')].find(b=>(b.title||b.getAttribute('aria-label'))==%s); if(!b) return null; const r=b.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]"""
def state(): return t.jsw(TOP)
def press(title, wait=1.5):
    x, y = lib.screen_point(t.T, *t.jsw(BTN % json.dumps(title))); lib.focus(t.T); lib.click(x, y); time.sleep(wait)
def run(tag, btn, n, start_js=None):
    if start_js: t.jsw(start_js); time.sleep(2)
    out = [state()]
    for i in range(n):
        press(btn); out.append(state())
    rec = {"tag": tag, "btn": btn, "seq": [(o["at"], o["top"]) for o in out]}
    t.log("nav", rec); return rec
if __name__ == "__main__":
    if len(sys.argv) < 4 or sys.argv[1] in ("-h", "--help"): sys.exit(__doc__)
    run(sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4] if len(sys.argv) > 4 else None)
