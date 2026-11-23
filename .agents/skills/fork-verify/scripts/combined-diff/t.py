"""All-in-one diff helpers on top of lib.py.
Env: W = window label from `pnpm dev:status` (project-1), T = its AppKit title (u4-mix),
OUT = where <name>.jsonl records and shots/ go (default /tmp/oi-verify/<worktree>/combined-diff)."""
import json, os, subprocess
import lib
W = os.environ.get("W", "project-1"); T = os.environ.get("T", "u4-mix")
OUT = os.environ.get("OUT") or f"/tmp/oi-verify/{os.path.basename(lib.WT)}/combined-diff"
os.makedirs(f"{OUT}/shots", exist_ok=True)

# Content probe at a viewport y (fraction of the scroller height): file of the block there, the text and y of the
# CodeMirror line there. Also sticky header shown at the top.
PROBE = r"""
const s=document.querySelector('[data-combined-scroll]'); if(!s) return null;
const r=s.getBoundingClientRect();
const at=(fy)=>{ const y=r.top+r.height*fy, x=r.left+r.width*0.25;
  const e=document.elementFromPoint(x,y); if(!e) return null;
  const b=e.closest('[data-combined-block]'); const l=e.closest('.cm-line');
  return {file:b?b.dataset.combinedBlock.split('/').slice(-1)[0]:null, line:l?l.textContent.slice(0,40):null,
          y:l?Math.round(l.getBoundingClientRect().top*10)/10:null, by:b?Math.round(b.getBoundingClientRect().top):null}; };
const blocks=[...s.querySelectorAll('[data-combined-block]')];
const hdr=blocks.find(b=>{const q=b.getBoundingClientRect(); return q.bottom>r.top+2 && q.top<=r.top+2;});
const empty=blocks.filter(b=>{const q=b.getBoundingClientRect(); return q.bottom>r.top && q.top<r.bottom && !b.querySelector('.cm-editor') && !b.dataset.collapsed;}).map(b=>b.dataset.combinedBlock.split('/').slice(-1)[0]);
return {top:Math.round(s.scrollTop), h:s.scrollHeight, ch:s.clientHeight, hdr:hdr?hdr.dataset.combinedBlock.split('/').slice(-1)[0]:null,
  a:at(0.15), m:at(0.5), mounted:blocks.length, cm:document.querySelectorAll('.cm-editor').length, emptyVisible:empty,
  ae:document.activeElement&&document.activeElement.closest('[data-combined-block]')?document.activeElement.closest('[data-combined-block]').dataset.combinedBlock.split('/').slice(-1)[0]:null};
"""

def probe(): return lib.js(W, PROBE, timeout=30)

def center():
    r = lib.js(W, "const s=document.querySelector('[data-combined-scroll]'); const r=s.getBoundingClientRect(); return [r.x+r.width*0.25, r.y+r.height/2]")
    return lib.screen_point(T, *r)

def jsw(s, timeout=30): return lib.js(W, s, timeout=timeout)

def shot(name):
    p = f"{OUT}/shots/{name}.png"; subprocess.run(["screencapture", "-x", p]); return p

def log(name, rec):
    with open(f"{OUT}/{name}.jsonl", "a") as f: f.write(json.dumps(rec) + "\n")
    print(json.dumps(rec), flush=True)
