"""Per-frame content displacement during wheel-up bursts (slow 5x100 px, fast 15x600 px) from where the view is now.
Each frame: take the block (section) under the viewport middle from the previous frame, measure how far it moved
on screen (dy), then pick the block under the middle again. Sum(dy) = what the user saw move; a frame whose dy is
larger than one wheel step (+slack) is a jump. A tracked block that got unmounted counts as 'lost'.
Usage: jump2.py <tag> <mode-label> [rounds]   (goto.py first; mode-label e.g. split/unified)  ->  jump2.jsonl"""
import sys, t, lib, time, json
START = r"""
const s=document.querySelector('[data-combined-scroll]'); const r=s.getBoundingClientRect();
const pick=()=>{const e=document.elementFromPoint(r.left+r.width*0.25, r.top+r.height*0.5); return e&&e.closest('[data-combined-block]');};
const st={frames:[], lost:0, run:true}; let cur=pick(), y=cur?cur.getBoundingClientRect().top:0, top=s.scrollTop;
const f=()=>{ if(!st.run) return; let dy=null, name=cur&&cur.dataset.combinedBlock.split('/').pop();
  if(cur&&cur.isConnected){ const ny=cur.getBoundingClientRect().top; dy=ny-y; } else if(cur) st.lost++;
  const nt=s.scrollTop; st.frames.push([performance.now()|0, dy===null?null:Math.round(dy*10)/10, Math.round(top-nt), name]); top=nt;
  cur=pick(); y=cur?cur.getBoundingClientRect().top:0; requestAnimationFrame(f); };
requestAnimationFrame(f); window.__jt=st; return true"""
STOP = "const st=window.__jt; st.run=false; return {frames:st.frames, lost:st.lost}"
def burst(tag, mode, delta, count, interval, label, step_slack=60):
    p0 = t.probe(); x, y = t.center(); lib.focus(t.T)
    t.jsw(START); time.sleep(0.2)
    lib.wheel(x, y, -delta, count, interval); time.sleep(2.5)
    d = t.jsw(STOP); p1 = t.probe()
    fr = [f for f in d["frames"] if f[1] is not None]
    total = round(sum(f[1] for f in fr)); scrolled = sum(f[2] for f in d["frames"])
    jumps = [f for f in fr if abs(f[1]) > delta + step_slack]
    # content movement not caused by scrollTop change (layout shift of the tracked block)
    shifts = [f for f in fr if abs(f[1] - f[2]) > 30]
    rec = {"tag": tag, "mode": mode, "label": label, "wheel": [delta, count, interval], "expected_px": delta * count,
           "content_moved_px": total, "scrolltop_moved_px": scrolled, "excess_px": total - delta * count,
           "max_frame_dy": max((abs(f[1]) for f in fr), default=0), "jump_frames": jumps[:8], "n_jump_frames": len(jumps),
           "layout_shift_frames": len(shifts), "layout_shift_px": round(sum(f[1] - f[2] for f in shifts)),
           "shift_samples": shifts[:6], "lost": d["lost"], "frames": len(d["frames"]),
           "hdr": [p0["hdr"], p1["hdr"]], "top": [p0["top"], p1["top"]], "a": [p0["a"], p1["a"]], "emptyVisible": p1["emptyVisible"]}
    t.log("jump2", rec)
    return rec
if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] in ("-h", "--help"): sys.exit(__doc__)
    tag, mode = sys.argv[1], sys.argv[2]; n = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    for i in range(n): burst(tag, mode, 100, 5, 60, f"{mode}-slow-{i}")
    for i in range(n): burst(tag, mode, 600, 15, 30, f"{mode}-fast-{i}")
    t.shot(f"{tag}-jump2-{mode}")
