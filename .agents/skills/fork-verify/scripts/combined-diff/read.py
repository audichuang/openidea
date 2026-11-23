"""Reading-speed wheel down to the bottom and back up (15 x <delta> px per step, probe after each stop, each way capped
at <cap> s): blank blocks visible at a stop, mounted blocks / CodeMirror editors, rAF frame gaps vs a 3 s idle baseline.
Usage: read.py <tag> [delta=200] [cap_s=300]   ->  read.jsonl"""
import sys, t, lib, time, json
if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"): sys.exit(__doc__)
tag = sys.argv[1]; DELTA = int(sys.argv[2]) if len(sys.argv) > 2 else 200; CAP = float(sys.argv[3]) if len(sys.argv) > 3 else 300
lib.focus(t.T)
# start at the top
t.jsw("document.querySelector('[data-combined-scroll]').scrollTop=0; return 1"); time.sleep(3)
base = lib.idle(t.W, 3.0)
x, y = t.center()
stops = []; lib.probe_start(t.W)
def go(direction):
    t0 = time.time(); prev = None; same = 0
    while time.time() - t0 < CAP:
        lib.wheel(x, y, DELTA * direction, 15, 80)
        time.sleep(0.6)
        p = t.probe()
        if p is None: continue
        stops.append({"dir": direction, "t": round(time.time() - t0, 1), "top": p["top"], "h": p["h"], "hdr": p["hdr"], "empty": p["emptyVisible"], "cm": p["cm"], "mounted": p["mounted"]})
        end = (p["top"] + p["ch"] >= p["h"] - 2) if direction > 0 else p["top"] <= 0
        same = same + 1 if end else 0
        if same >= 2: return True, round(time.time() - t0, 1)
    return False, round(time.time() - t0, 1)
down = go(1); up = go(-1)
d = lib.probe_stop(t.W, timeout=120)
s = lib.frame_stats(d); b = lib.frame_stats(base)
g = d["gaps"]
rec = {"tag": tag, "delta": DELTA, "idle": b, "op": s, "share_gt33": round(sum(x > 33 for x in g) / max(1, len(g)) * 100, 2),
       "idle_share_gt33": round(sum(x > 33 for x in base["gaps"]) / max(1, len(base["gaps"])) * 100, 2),
       "down": down, "up": up, "stops": len(stops), "stops_with_empty": [st for st in stops if st["empty"]],
       "cm_max": max(st["cm"] for st in stops), "mounted_max": max(st["mounted"] for st in stops),
       "files_seen": len(set(st["hdr"] for st in stops))}
t.log("read", rec)
