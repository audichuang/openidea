"""Fast wheel bursts (15x600 px) with a scroll-write recorder (scrollTo/scrollBy/scrollTop setter on the scroller),
a wheel-event counter (deltaY delivered to the page) and the per-frame content tracker from jump2.
Prints one summary line per burst; wheel_delta_sum shows the wheel input reached the page.
Usage: fast.py <tag> <label> <up|down> [n]   ->  fast.jsonl"""
import sys, t, lib, time, json
INSTALL = r"""
const el=document.querySelector('[data-combined-scroll]'); if(el.__rec) return 'already';
const desc=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop'); const sto=Element.prototype.scrollTo, sby=Element.prototype.scrollBy;
const R=window.__rec={writes:[],wheel:{n:0,sum:0}}; const src=()=>new Error().stack.split('\n').slice(2,5).map(s=>s.trim().replace(/https?:\/\/[^/]+/,'').slice(0,90)).join(' < ');
el.scrollTo=function(...a){R.writes.push(['scrollTo',JSON.stringify(a[0]??a),Math.round(desc.get.call(this)),src()]); return sto.apply(this,a)};
el.scrollBy=function(...a){R.writes.push(['scrollBy',JSON.stringify(a[0]??a),Math.round(desc.get.call(this)),src()]); return sby.apply(this,a)};
Object.defineProperty(el,'scrollTop',{configurable:true,get(){return desc.get.call(this)},set(v){R.writes.push(['set',Math.round(v),Math.round(desc.get.call(this)),src()]); desc.set.call(this,v)}});
el.addEventListener('wheel',e=>{R.wheel.n++; R.wheel.sum+=e.deltaY*(e.deltaMode===1?16:1)},{passive:true,capture:true});
el.__rec=true; return 'ok'"""
START = r"""
const R=window.__rec; R.writes=[]; R.wheel={n:0,sum:0};
const s=document.querySelector('[data-combined-scroll]'); const r=s.getBoundingClientRect();
const pick=()=>{const e=document.elementFromPoint(r.left+r.width*0.25, r.top+r.height*0.5); return e&&e.closest('[data-combined-block]');};
const st={frames:[],run:true,top0:s.scrollTop}; let cur=pick(), y=cur?cur.getBoundingClientRect().top:0, top=s.scrollTop;
const f=()=>{ if(!st.run) return; let dy=null; if(cur&&cur.isConnected) dy=cur.getBoundingClientRect().top-y;
  const nt=s.scrollTop; st.frames.push([dy===null?null:Math.round(dy), Math.round(nt-top), cur&&cur.dataset.combinedBlock.split('/').pop()]); top=nt;
  cur=pick(); y=cur?cur.getBoundingClientRect().top:0; requestAnimationFrame(f); };
requestAnimationFrame(f); window.__jt=st; return true"""
STOP = r"""const st=window.__jt; st.run=false; const R=window.__rec; const s=document.querySelector('[data-combined-scroll]');
return {frames:st.frames, st:Math.round(s.scrollTop-st.top0), writes:R.writes, wheel:R.wheel}"""
def burst(tag, label, direction, step=600, count=15, interval=30):
    sign = -1 if direction == "up" else 1
    x, y = t.center(); lib.focus(t.T); front0 = lib.frontmost_pid() == lib.app_pid()
    t.jsw(INSTALL); t.jsw(START); time.sleep(0.2)
    lib.wheel(x, y, sign * step, count, interval); time.sleep(2.0)
    d = t.jsw(STOP); front1 = lib.frontmost_pid() == lib.app_pid()
    fr = [f for f in d["frames"] if f[0] is not None]
    content = -sum(f[0] for f in fr) * sign  # positive = moved in the wheel's direction
    corr = []
    for w in d["writes"]:
        if w[0] == "set": corr.append(w[1] - w[2])
        elif w[0] == "scrollBy": corr.append(json.loads(w[1]).get("top", 0) if w[1].startswith("{") else 0)
        else: corr.append((json.loads(w[1]).get("top", w[2]) if w[1].startswith("{") else w[2]) - w[2])
    srcs = {}
    for w in d["writes"]: srcs[w[3].split(" < ")[0][:70]] = srcs.get(w[3].split(" < ")[0][:70], 0) + 1
    big = [f for f in fr if abs(f[0] - (-f[1])) > 2000]  # content moved >2k px more than scrollTop explains
    rec = {"tag": tag, "label": label, "dir": direction, "expected": step * count, "content_moved": content,
           "scrolltop_moved": d["st"] * sign, "wheel_events": d["wheel"]["n"], "wheel_delta_sum": round(d["wheel"]["sum"] * sign),
           "writes": len(d["writes"]), "correction_px": sum(corr), "sources": srcs, "writes_sample": d["writes"][:3],
           "big_frames": big[:3], "n_big": len(big), "frontmost": [front0, front1], "hdr_after": t.probe()["hdr"]}
    t.log("fast", rec); return rec
if __name__ == "__main__":
    if len(sys.argv) < 4 or sys.argv[1] in ("-h", "--help"): sys.exit(__doc__)
    tag, label, direction = sys.argv[1:4]; n = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    for i in range(n):
        r = burst(tag, f"{label}-{direction}-{i}", direction)
        print(r["label"], "content", r["content_moved"], "st", r["scrolltop_moved"], "wheelEv", r["wheel_events"], "wheelSum", r["wheel_delta_sum"],
              "writes", r["writes"], "corr", r["correction_px"], "big", r["n_big"], "front", r["frontmost"], r["hdr_after"], list(r["sources"].items())[:2])
