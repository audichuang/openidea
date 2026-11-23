"""Fast upward bursts (15x600 px) crossing the large block m020 from below, each in a fresh tab (reveal m035, goto m026).
Per frame: tracked content block shift, scrollTop, and m020's slot top/height relative to the viewport, so a big jump
can be classified by where m020 was when it grew (above / straddling the top / in view).
Usage: cross.py <tag> <mode-label> <n>   ->  cross.jsonl"""
import sys, time, json, t, lib, goto, reveal
START = r"""
const s=document.querySelector('[data-combined-scroll]'); const r=s.getBoundingClientRect();
const pick=()=>{const e=document.elementFromPoint(r.left+r.width*0.25, r.top+r.height*0.5); return e&&e.closest('[data-combined-block]');};
const m20=()=>{const b=[...s.querySelectorAll('[data-combined-block]')].find(b=>b.dataset.combinedBlock.endsWith('/m020.txt')); if(!b) return null; const q=b.parentElement.getBoundingClientRect(); return [Math.round(q.top-r.top), Math.round(q.height)];};
const st={frames:[],run:true,top0:s.scrollTop,vh:Math.round(r.height),m0:m20()}; let cur=pick(), y=cur?cur.getBoundingClientRect().top:0, top=s.scrollTop;
const f=()=>{ if(!st.run) return; let dy=null; if(cur&&cur.isConnected) dy=cur.getBoundingClientRect().top-y;
  const nt=s.scrollTop; st.frames.push([dy===null?null:Math.round(dy), Math.round(nt-top), cur&&cur.dataset.combinedBlock.split('/').pop(), m20()]); top=nt;
  cur=pick(); y=cur?cur.getBoundingClientRect().top:0; requestAnimationFrame(f); };
requestAnimationFrame(f); window.__jt=st; return st.m0"""
STOP = r"""const st=window.__jt; st.run=false; const s=document.querySelector('[data-combined-scroll]'); return {frames:st.frames, st:Math.round(s.scrollTop-st.top0), vh:st.vh, m0:st.m0}"""
def burst(tag, mode, i):
    reveal.reveal("m035.txt", f"{tag}-pre"); goto.goto("m026"); time.sleep(1.5)
    x, y = t.center(); lib.focus(t.T)
    m0 = t.jsw(START); time.sleep(0.2)
    lib.wheel(x, y, -600, 15, 30); time.sleep(2.5)
    d = t.jsw(STOP)
    fr = d["frames"]; vh = d["vh"]
    shifts = [f[0] for f in fr if f[0] is not None]
    content = sum(shifts)  # positive = content moved down = scrolled up
    maxshift = max((abs(v) for v in shifts), default=0)
    # m020 height changes: where was it relative to the viewport when its height changed
    grows = []; prev = d["m0"]
    for k, f in enumerate(fr):
        m = f[3]
        if m and prev and m[1] != prev[1]:
            top_, h0 = m[0], prev[1]  # its own growth does not move its top: classify at the frame it grew
            where = "above" if top_ + h0 <= 0 else ("below" if top_ >= vh else ("straddle-top" if top_ < 0 else "in-view"))
            grows.append({"frame": k, "top": top_, "h": [h0, m[1]], "where": where, "shift": f[0]})
        if m: prev = m
    big = [[k, f[0], f[1], f[2]] for k, f in enumerate(fr) if f[0] is not None and abs(f[0]) > 5000]
    crossed = any(f[2] in ("m020.txt",) or (f[2] and f[2] < "m020.txt") for f in fr) or t.probe()["hdr"] <= "m020.txt"
    rec = {"tag": tag, "mode": mode, "i": i, "m020_at_start": m0, "content_moved": content, "scrolltop_moved": -d["st"],
           "max_frame_shift": maxshift, "jumps_gt5k": big[:3], "m020_grows": grows[:6], "crossed": crossed,
           "hdr_after": t.probe()["hdr"], "series": [[f[0], f[1], f[3]] for f in fr]}
    t.log("cross", rec)
    print("RES", tag, mode, i, "crossed", crossed, "content", content, "max", maxshift, "big", len(big),
          "grows", [(g["where"], g["top"], g["h"], g["shift"]) for g in grows][:3], "m0", m0, "hdr", rec["hdr_after"], flush=True)
if __name__ == "__main__":
    if len(sys.argv) < 4 or sys.argv[1] in ("-h", "--help"): sys.exit(__doc__)
    tag, mode, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
    for i in range(n):
        try: burst(tag, mode, i)
        except Exception as e: print("ERR", i, e, flush=True)
