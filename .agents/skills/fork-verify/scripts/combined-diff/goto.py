"""Scroll the open all-in-one diff so block <name> (mNNN, fixture naming) sits at the top (8 px), iterating as heights load.
Usage: goto.py m200"""
import sys, time, t, json
JS = r"""const s=document.querySelector('[data-combined-scroll]'); const r=s.getBoundingClientRect(); const want=%s;
const v=[...s.querySelectorAll('[data-index]')].map(e=>[+e.dataset.index, e.querySelector('[data-combined-block]').dataset.combinedBlock.split('/').pop(), e.getBoundingClientRect().top-r.top]);
const hit=v.find(x=>x[1]===want); if(hit){ if(Math.abs(hit[2]-8)<2) return 'done'; s.scrollTop+=hit[2]-8; return 'adj'; }
const at=v.filter(x=>x[2]<=12).pop()||v[0]; const wi=+want.slice(1,4); const ci=+at[1].slice(1,4);
s.scrollTop += (wi-ci)*300; return 'far'"""
def goto(name):
    for i in range(60):
        r = t.jsw(JS % json.dumps(name + ".txt")); time.sleep(0.6)
        if r == "done":
            time.sleep(1.5)
            if t.jsw(JS % json.dumps(name + ".txt")) == "done": return True
    return False
if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"): sys.exit(__doc__)
    print(goto(sys.argv[1]))
